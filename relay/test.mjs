// cd relay && node test.mjs   (Node 18+; relay/package.json makes these ES modules)
// No Cloudflare needed: mocks the Durable Object state, the game tab and the Worker env.
// "audit #N" tests are regressions for ~/plans/drafts/relay-audit-2026-10-07.md.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;   // Workers and Node 19+ have it built in; Node 18 does not
import { readRequest, safeReply, Limiter, IpLimiter, normalizeKey, decideClaim, IDLE_MS, CLAIM_TTL_MS } from "./bots.js";

const H = (o = {}) => new Headers(o);
const R = (qs, h) => readRequest(new URL("https://relay.test/c/k?" + qs), H(h));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("ok -", name); };
const okA = async (name, fn) => { await fn(); n++; console.log("ok -", name); };

/* ---------- what each bot actually sends ---------- */
ok("BotRix: user first, platform, encoded word, encoded YouTube name", () =>
  assert.deepEqual(R("user=Big%20Shay%20%F0%9F%92%8E&p=youtube&q=rock"), { user: "Big Shay 💎", q: "rock", platform: "youtube", h: "" }));
ok("BotRix: fallback word when the viewer typed nothing", () =>
  assert.deepEqual(R("user=shayla&p=kick&q=join"), { user: "shayla", q: "join", platform: "kick", h: "" }));
ok("BotRix $(optionalvariable) style null is empty", () => assert.equal(R("user=a&q=null").q, ""));
ok("Slot Tools (unchanged command)", () =>
  assert.deepEqual(R("user=RelatableShayla&q=count"), { user: "RelatableShayla", q: "count", platform: "", h: "" }));
ok("StreamElements: empty $(1) left unfilled", () => assert.equal(R("user=x&p=se&q=$(1)").q, ""));
ok("Nightbot: user and platform from the Nightbot-User header", () =>
  assert.deepEqual(R("q=heads", { "Nightbot-User": "name=bob&displayName=Bob&provider=youtube&providerId=1&userLevel=everyone" }),
    { user: "Bob", q: "heads", platform: "youtube", h: "" }));
ok("Fossabot: user from x-fossabot header, querystring + encoding", () =>
  assert.deepEqual(R("p=fossabot&q=pick+rock", { "x-fossabot-message-userlogin": "ann" }), { user: "ann", q: "pick rock", platform: "fossabot", h: "" }));
ok("KickBot / Streamer.bot unfilled templates dropped", () => {
  assert.equal(R("user={{sender.username}}").user, "");
  assert.equal(R("user=%userName%&q=%rawInputUrlEncoded%").q, "");
});
ok("streamer command: host token passed through, junk stripped", () => {
  assert.equal(R("user=mod&h=abcDEF123_-x&q=start").h, "abcDEF123_-x");
  assert.equal(R("user=mod&h=a%3Cb%3E&q=start").h, "ab");
});
ok("leading @ stripped", () => assert.equal(R("user=@@zed").user, "zed"));

/* ---------- audit #2: a viewer cannot pick their own name or host token ---------- */
ok("audit #2: typed '&user=X' / '&h=..' (unencoded word) makes a repeated field: whole request refused", () => {
  // what an un-encoding bot would send for "!play join&user=StreamerMod" with the OLD order (q before user)
  assert.equal(R("p=kick&q=join&user=StreamerMod&user=viewer").reject, true);
  // and with the NEW order (user first, q last), an unencoded word still repeats a field
  assert.equal(R("user=viewer&p=kick&q=join&user=StreamerMod").reject, true);
  assert.equal(R("user=viewer&p=kick&q=start&h=guess").reject, undefined);       // a lone h is just an unknown token
  assert.equal(R("user=viewer&p=kick&h=a&q=x&h=b").reject, true);
  assert.equal(R("user=viewer&p=kick&q=x&sender=Mod").reject, undefined);       // different alias, first one wins
  assert.equal(R("user=viewer&p=kick&q=x&sender=Mod").user, "viewer");
});
ok("audit #2: an ENCODED word stays one value", () => {
  const r = R("user=viewer&p=kick&q=" + encodeURIComponent("join&user=StreamerMod#x"));
  assert.equal(r.user, "viewer"); assert.equal(r.q, "join&user=StreamerMod#x"); assert.equal(r.reject, undefined);
});

/* ---------- audit #7: replies can never become bot code, a command, or a ping ---------- */
ok("bot variables neutralised", () => {
  for (const evil of ["$(addPoints 9999)", "${customapi.x}", "fetch[https://x]", "{{request('x')}}", "%userName%", "Rand[1,9]", "RandomList[a;b]"]) {
    const out = safeReply("🎮 " + evil + " you're in!");
    assert.ok(!/\$\(|\$\{|fetch\[|\{\{|%userName%|Rand\[|RandomList\[/i.test(out), out);
  }
});
ok("audit #7: myfetch[ / earlyFetch[ / zero-width tricks / @everyone / odd line breaks", () => {
  assert.ok(!/fetch\[/i.test(safeReply("🎮 myfetch[https://x] earlyFetch[https://y]")));
  assert.ok(!/\$\(/.test(safeReply("🎮 $\u200b(addPoints 5)")));               // zero-width between $ and (
  assert.equal(safeReply("\u200b!ban bob"), "ban bob");
  assert.equal(safeReply("! /ban bob"), "ban bob");
  assert.equal(safeReply(" . \\ ! /timeout x"), "timeout x");
  assert.ok(!safeReply("🎮 hi @everyone @here").includes("@"));
  assert.equal(safeReply("a\u2028b\u2029c\u0085d\u00a0e"), "a b c d e");
  assert.ok(!/\$\(/.test(safeReply("🎮 ＄(addPoints 5)")));
});
ok("audit #7: cut at 400 never splits an emoji; platform tags removed; no leading !", () => {
  const out = safeReply("x".repeat(399) + "💎💎");
  assert.ok(out.length <= 400 && !/[\uD800-\uDBFF]$/.test(out), out.length);
  assert.equal(safeReply("a<ifKick>b</ifKick>\nc"), "ab c");
  assert.equal(safeReply("🎮 Spin Wheel: !play to get on"), "🎮 Spin Wheel: !play to get on");
});

/* ---------- limits ---------- */
ok("per-viewer cooldown and the tight bucket for non-join commands", () => {
  const L = new Limiter({ rate: 1, burst: 3, userGapMs: 1000 });
  assert.equal(L.allow("a", "count", 0), true);
  assert.equal(L.allow("A", "count", 500), false);   // same viewer too fast (case-insensitive)
  assert.equal(L.allow("b", "count", 600), true);
  assert.equal(L.allow("c", "count", 700), true);
  assert.equal(L.allow("d", "count", 800), false);   // bucket empty
  assert.equal(L.allow("d", "count", 2900), true);   // refilled
});
ok("audit #5: a 200-viewer join rush in one second all gets in; other commands stay tight", () => {
  const L = new Limiter();
  let joined = 0; for (let i = 0; i < 200; i++) if (L.allow("viewer" + i, i % 2 ? "" : "join", 1000 + i * 5)) joined++;
  assert.equal(joined, 200);
  let other = 0; for (let i = 0; i < 60; i++) if (L.allow("talker" + i, "list", 3000)) other++;
  assert.equal(other, 30);
});
ok("audit #8: flooding fake names evicts the oldest only; a recent real viewer keeps their cooldown", () => {
  const L = new Limiter({ maxUsers: 100 });
  for (let i = 0; i < 99; i++) L.allow("old" + i, "join", 0);
  L.allow("real", "join", 10);
  for (let i = 0; i < 50; i++) L.allow("spam" + i, "join", 20);
  assert.equal(L.users.size, 100);
  assert.equal(L.allow("real", "join", 500), false, "real viewer's cooldown survived the flood");
});
ok("audit #4: per-IP bucket", () => {
  const ip = new IpLimiter({ rate: 1, burst: 2 });
  assert.equal(ip.allow("1.1.1.1", 0), true); assert.equal(ip.allow("1.1.1.1", 0), true); assert.equal(ip.allow("1.1.1.1", 0), false);
  assert.equal(ip.allow("2.2.2.2", 0), true); assert.equal(ip.allow("1.1.1.1", 1500), true);
});

/* ---------- unique room keys ---------- */
ok("key format: new XXXXX-XXXXX, case-insensitive; legacy kept; placeholders and junk refused", () => {
  assert.equal(normalizeKey("k7m3p-q9rtw"), "K7M3P-Q9RTW");
  assert.equal(normalizeKey("XXXXX-XXXXX"), null);
  assert.equal(normalizeKey("ZZZZZ-ZZZZZ"), null);
  assert.equal(normalizeKey("K0M3P-Q9RTW"), null);              // 0 is not in the alphabet
  assert.equal(normalizeKey("legacy_shaped_key_123456"), "legacy_shaped_key_123456");
  assert.equal(normalizeKey("short"), null);
});
ok("claim rules: first owner claims, a copier is refused, new keys need an owner", () => {
  const key = "K7M3P-Q9RTW", A = "ownerAAAAAAAAAAAAAAA", B = "ownerBBBBBBBBBBBBBBB", now = 1e12;
  assert.equal(decideClaim({ key, owner: A, stored: undefined, live: false, now }), "claim");
  assert.equal(decideClaim({ key, owner: A, stored: { owner: A, seen: now }, live: true, now }), "claim");
  assert.equal(decideClaim({ key, owner: B, stored: { owner: A, seen: now - 1000 }, live: false, now }), "refuse");
  assert.equal(decideClaim({ key, owner: "", stored: undefined, live: false, now }), "refuse");
});
ok("audit #6: a streamer idle for 25 hours keeps their key; only after 30 days can another page take it", () => {
  const key = "K7M3P-Q9RTW", A = "ownerAAAAAAAAAAAAAAA", B = "ownerBBBBBBBBBBBBBBB", now = 1e12;
  assert.equal(decideClaim({ key, owner: B, stored: { owner: A, seen: now - IDLE_MS - 3600e3 }, live: false, now }), "refuse");
  assert.equal(decideClaim({ key, owner: A, stored: { owner: A, seen: now - IDLE_MS - 3600e3, idle: true }, live: false, now }), "claim");
  assert.equal(decideClaim({ key, owner: B, stored: { owner: A, seen: now - CLAIM_TTL_MS }, live: false, now }), "claim");
});
ok("audit #3: legacy keys are never claimed or refused, with or without an owner token", () => {
  const key = "legacy_shaped_key_123456", now = 1e12;
  for (const owner of ["", "ownerAAAAAAAAAAAAAAA"])
    assert.equal(decideClaim({ key, owner, stored: { owner: "ownerBBBBBBBBBBBBBBB", seen: now }, live: true, now }), "legacy");
});

/* ---------- the Worker's Room and front door, with fakes ---------- */
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
const RealResponse = Response;   // Node refuses status 101; Workers needs it for WebSocket upgrades
globalThis.Response = function (body, init = {}) { return init.status === 101 ? { status: 101, webSocket: init.webSocket } : new RealResponse(body, init); };
const fakeWs = () => ({ closed: null, accept() {}, close(c) { this.closed = c; }, send() {} });
const pairs = [];   // every pair the Room makes, so tests can read the server-side close code
globalThis.WebSocketPair = function () { const c = fakeWs(), s = fakeWs(); pairs.push(s); return { 0: c, 1: s }; };
const { default: worker, Room, Counter } = await import("./worker.js");

function makeRoom() {
  const sockets = [], disk = new Map(), st = { alarmAt: null };
  const storage = { get: async k => disk.get(k), put: async (k, v) => { disk.set(k, v); }, deleteAll: async () => disk.clear(),
                    setAlarm: async t => { st.alarmAt = t; } };
  const room = new Room({ setWebSocketAutoResponse() {}, getWebSockets: () => sockets, storage, acceptWebSocket: ws => sockets.push(ws) });
  return { room, sockets, disk, st };
}
const wsReq = (key, owner) => new Request(`https://relay.test/ws/${key}${owner ? "?owner=" + owner : ""}`,
  { headers: { Upgrade: "websocket", "x-room-key": key } });
const A = "ownerAAAAAAAAAAAAAAA", B = "ownerBBBBBBBBBBBBBBB", NEWKEY = "K7M3P-Q9RTW", LEGACY = "legacy_shaped_key_123456";

await okA("Room: first page claims the key, a second owner is closed with 4001 and kept out", async () => {
  const { room, sockets, disk, st } = makeRoom();
  await room.fetch(wsReq(NEWKEY, A));
  assert.equal(disk.get("claim").owner, A); assert.equal(sockets.length, 1); assert.ok(st.alarmAt > Date.now());
  const bad = await room.fetch(wsReq(NEWKEY, B));
  assert.equal(bad.status, 101); assert.equal(sockets.length, 1);
});
await okA("audit #6: the 24h alarm wipes the room but keeps the owner; the 30-day alarm forgets it", async () => {
  const { room, sockets, disk } = makeRoom();
  await room.fetch(wsReq(NEWKEY, A));
  await room.webSocketClose(sockets.pop(), 1000);
  await room.alarm();
  assert.equal(disk.get("claim").owner, A, "not idle long enough: claim kept");
  disk.set("claim", { owner: A, seen: Date.now() - IDLE_MS - 1 }); disk.set("junk", 1);
  await room.alarm();
  assert.equal(disk.get("claim").owner, A); assert.equal(disk.get("claim").idle, true); assert.equal(disk.has("junk"), false);
  await room.fetch(wsReq(NEWKEY, B));
  assert.equal(pairs.at(-1).closed, 4001); assert.equal(sockets.length, 0, "a stranger still can't take an idle key");
  disk.set("claim", { owner: A, seen: Date.now() - CLAIM_TTL_MS - 1 });
  await room.alarm();
  assert.equal(disk.size, 0);
});
await okA("audit #3: legacy key with an owner token stores no claim; the old owner-less page still connects", async () => {
  const { room, sockets, disk } = makeRoom();
  await room.fetch(wsReq(LEGACY, A));
  assert.equal(disk.size, 0); assert.equal(sockets.length, 1);
  await room.fetch(wsReq(LEGACY, ""));
  assert.equal(sockets.length, 2, "accepted (the newer page takes over, exactly as on the live relay)");
  assert.equal(sockets[0].closed, 4000);
  await room.webSocketClose(sockets.pop(), 1000);
  assert.equal(disk.size, 0, "closing a legacy page writes nothing");
});
await okA("audit #4: more than 30 socket connects a minute to one room are refused with 4003, before any storage write", async () => {
  const { room, disk } = makeRoom();
  for (let i = 0; i < 30; i++) { await room.fetch(wsReq(LEGACY, "")); assert.notEqual(pairs.at(-1).closed, 4003); }
  await room.fetch(wsReq(LEGACY, ""));
  assert.equal(pairs.at(-1).closed, 4003);
  await room.fetch(wsReq(NEWKEY, A));
  assert.equal(pairs.at(-1).closed, 4003); assert.equal(disk.size, 0, "no claim written while over the connect cap");
});

const { room, sockets } = makeRoom();
const get = (qs, h) => room.fetch(new Request("https://relay.test/c/key?" + qs, { headers: h })).then(r => r.text());
await okA("no tab: not-live line", async () => assert.equal(await get("user=a&q=join"), "🎮 This game isn't live right now."));
let seen;
sockets.push({ send(raw) { seen = JSON.parse(raw);
  queueMicrotask(() => room.webSocketMessage(null, JSON.stringify({ id: seen.id, text: `🎮 ${seen.user} you're in! (${seen.platform})` })));
} });
await okA("tab answers through the relay; a $(...) name never reaches the game", async () => {
  const reply = await get("user=%24(addPoints%209999)&p=kick&q=join");
  assert.equal(seen.platform, "kick"); assert.equal(seen.user, ""); assert.ok(!reply.includes("$("), reply);
});
await okA("echoed {{...}} defused; same viewer again within 1.5s gets an empty body", async () => {
  const echo = await get("user=Spammy%7B%7Bx%7D%7D&p=kick&q=join");
  assert.ok(!echo.includes("{{"), echo);
  assert.equal(await get("user=Spammy%7B%7Bx%7D%7D&p=kick&q=join"), "");
});
await okA("audit #2: an impersonation attempt never reaches the tab", async () => {
  seen = null;
  assert.equal(await get("user=viewer2&p=kick&q=join&user=StreamerMod"), "");
  assert.equal(seen, null);
});
await okA("audit #10: odd socket messages ('null', non-objects, >4 KB) are ignored without throwing", async () => {
  for (const m of ["null", "42", '"x"', "[]", "{}", "{\"id\":1}", "x".repeat(5000), new ArrayBuffer(8)]) room.webSocketMessage(null, m);
});

/* ---------- front door: Worker fetch ---------- */
const rooms = new Map();
const env = { ROOM: { idFromName: k => k, get: k => { if (!rooms.has(k)) rooms.set(k, makeRoom().room); return rooms.get(k); } } };
const ctx = { waitUntil: p => p };
const door = (path, h = {}) => worker.fetch(new Request("https://relay.test" + path, { headers: h }), env, ctx);
await okA("audit #13: a malformed key gets a 200 plain-text line a bot will post; /ws gets 404", async () => {
  const r = await door("/c/XXXXX-XXXXX?user=a&q=join");
  assert.equal(r.status, 200); assert.match(await r.text(), /isn't valid/);
  assert.equal((await door("/ws/nope")).status, 404);
});
await okA("audit #11: with ALLOWED_ORIGINS set, a socket from another site is refused", async () => {
  env.ALLOWED_ORIGINS = "https://homeofficestudios.com,https://crandellws.github.io";
  assert.equal((await door("/ws/" + NEWKEY + "?owner=" + A, { Upgrade: "websocket", Origin: "https://evil.example" })).status, 403);
  assert.equal((await door("/ws/" + NEWKEY + "?owner=" + A, { Upgrade: "websocket", Origin: "https://homeofficestudios.com" })).status, 101);
  delete env.ALLOWED_ORIGINS;
});
await okA("audit #4: one IP hammering /c with random keys is cut off; the daily cap silences bots", async () => {
  let blank = 0;
  for (let i = 0; i < 700; i++) {
    const t = await (await door(`/c/legacy_random_key_${String(i).padStart(6, "0")}?user=u${i}&q=join`, { "cf-connecting-ip": "9.9.9.9" })).text();
    if (t === "") blank++;
  }
  assert.ok(blank >= 90, `blank=${blank}`);                           // burst 600 per IP
  const disk = new Map();
  env.COUNTER = { idFromName: n => n, get: () => new Counter({ storage: { get: async k => disk.get(k), put: async (k, v) => disk.set(k, v) } }) };
  env.DAILY_CAP = "40";
  let silent = 0;
  for (let i = 0; i < 80; i++) if ((await (await door(`/c/${LEGACY}?user=v${i}&q=join`, { "cf-connecting-ip": "8.8.8." + (i % 200) })).text()) === "") silent++;
  assert.ok(silent >= 30, `silent=${silent}`);
  delete env.COUNTER; delete env.DAILY_CAP;
});
await okA("audit #15: /lb survives a network error from MyPrize", async () => {
  const realFetch = globalThis.fetch; globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async () => { throw new Error("offline"); };
  try { const r = await door("/lb?room=someroom"); assert.equal(r.status, 200); assert.match(await r.text(), /Couldn't find|unavailable/); }
  finally { globalThis.fetch = realFetch; }
});

console.log(`\n${n} passed`);
