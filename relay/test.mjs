// node relay/test.mjs  — no Cloudflare needed: mocks the Durable Object state and the game tab.
import assert from "node:assert/strict";
import { readRequest, safeReply, Limiter, normalizeKey, decideClaim, IDLE_MS } from "./bots.js";

const H = (o = {}) => new Headers(o);
const R = (qs, h) => readRequest(new URL("https://relay.test/c/k?" + qs), H(h));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("ok -", name); };

/* ---------- what each bot actually sends ---------- */
ok("BotRix: platform, single word, urlencoded YouTube name", () =>
  assert.deepEqual(R("p=youtube&q=rock&user=Big%20Shay%20%F0%9F%92%8E"), { user: "Big Shay 💎", q: "rock", platform: "youtube", h: "" }));
ok("BotRix: fallback word when the viewer typed nothing", () =>
  assert.deepEqual(R("p=kick&q=join&user=shayla"), { user: "shayla", q: "join", platform: "kick", h: "" }));
ok("BotRix $(optionalvariable) style null is empty", () => assert.equal(R("q=null&user=a").q, ""));
ok("Slot Tools (unchanged command)", () =>
  assert.deepEqual(R("user=RelatableShayla&q=count"), { user: "RelatableShayla", q: "count", platform: "", h: "" }));
ok("StreamElements: empty $(1) left unfilled", () => assert.equal(R("p=se&q=$(1)&user=x").q, ""));
ok("Nightbot: user and platform from the Nightbot-User header", () =>
  assert.deepEqual(R("q=heads", { "Nightbot-User": "name=bob&displayName=Bob&provider=youtube&providerId=1&userLevel=everyone" }),
    { user: "Bob", q: "heads", platform: "youtube", h: "" }));
ok("Fossabot: user from x-fossabot header, querystring + encoding", () =>
  assert.deepEqual(R("p=fossabot&q=pick+rock", { "x-fossabot-message-userlogin": "ann" }), { user: "ann", q: "pick rock", platform: "fossabot", h: "" }));
ok("KickBot / Streamer.bot unfilled templates dropped", () => {
  assert.equal(R("user={{sender.username}}").user, "");
  assert.equal(R("q=%rawInputUrlEncoded%&user=%userName%").q, "");
});
ok("streamer command: host token passed through, junk stripped", () => {
  assert.equal(R("q=start&h=abcDEF123_-x&user=mod").h, "abcDEF123_-x");
  assert.equal(R("q=start&h=a%3Cb%3E&user=mod").h, "ab");
});
ok("leading @ stripped", () => assert.equal(R("user=@@zed").user, "zed"));

/* ---------- replies can never become bot code ---------- */
ok("bot variables neutralised", () => {
  for (const evil of ["$(addPoints 9999)", "${customapi.x}", "fetch[https://x]", "{{request('x')}}", "%userName%", "Rand[1,9]"]) {
    const out = safeReply("🎮 " + evil + " you're in!");
    assert.ok(!/\$\(|\$\{|fetch\[|\{\{|%userName%|Rand\[/.test(out), out);
  }
});
ok("platform tags removed, newlines flattened, 400 cap, no leading !", () => {
  assert.equal(safeReply("a<ifKick>b</ifKick>\nc"), "ab c");
  assert.equal(safeReply("x".repeat(900)).length, 400);
  assert.equal(safeReply("!ban someone"), "ban someone");
  assert.equal(safeReply("🎮 Spin Wheel: !play to get on"), "🎮 Spin Wheel: !play to get on");
});

/* ---------- limits ---------- */
ok("per-viewer cooldown and per-key bucket", () => {
  const L = new Limiter({ rate: 1, burst: 3, userGapMs: 1000 });
  assert.equal(L.allow("a", 0), true);
  assert.equal(L.allow("A", 500), false);          // same viewer too fast (case-insensitive)
  assert.equal(L.allow("b", 600), true);
  assert.equal(L.allow("c", 700), true);
  assert.equal(L.allow("d", 800), false);           // bucket empty
  assert.equal(L.allow("d", 2900), true);           // refilled
});

/* ---------- unique room keys ---------- */
ok("key format: new XXXXX-XXXXX, case-insensitive; legacy kept; placeholders and junk refused", () => {
  assert.equal(normalizeKey("k7m3p-q9rtw"), "K7M3P-Q9RTW");
  assert.equal(normalizeKey("XXXXX-XXXXX"), null);
  assert.equal(normalizeKey("ZZZZZ-ZZZZZ"), null);
  assert.equal(normalizeKey("K0M3P-Q9RTW"), null);              // 0 is not in the alphabet
  assert.equal(normalizeKey("shaylawm_legacy_key_1234"), "shaylawm_legacy_key_1234");
  assert.equal(normalizeKey("short"), null);
});
ok("claim rules: first owner claims, a copier is refused, idle 24h frees the key, old Blingo page still works", () => {
  const key = "K7M3P-Q9RTW", A = "ownerAAAAAAAAAAAAAAA", B = "ownerBBBBBBBBBBBBBBB", now = 1e12;
  assert.equal(decideClaim({ key, owner: A, stored: undefined, live: false, now }), "claim");
  assert.equal(decideClaim({ key, owner: A, stored: { owner: A, seen: now }, live: true, now }), "claim");
  assert.equal(decideClaim({ key, owner: B, stored: { owner: A, seen: now - 1000 }, live: false, now }), "refuse");
  assert.equal(decideClaim({ key, owner: B, stored: { owner: A, seen: now - IDLE_MS }, live: true, now }), "refuse");
  assert.equal(decideClaim({ key, owner: B, stored: { owner: A, seen: now - IDLE_MS }, live: false, now }), "claim");
  assert.equal(decideClaim({ key, owner: "", stored: undefined, live: false, now }), "refuse");   // new keys need an owner
  assert.equal(decideClaim({ key: "shaylawm_legacy_key_1234", owner: "", stored: undefined, live: false, now }), "legacy");
});

/* ---------- the Worker's Room, end to end with a fake tab ---------- */
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
const RealResponse = Response;   // Node refuses status 101; Workers needs it for WebSocket upgrades
globalThis.Response = function (body, init = {}) { return init.status === 101 ? { status: 101, webSocket: init.webSocket } : new RealResponse(body, init); };
const fakeWs = () => ({ closed: null, accept() {}, close(c) { this.closed = c; }, send() {} });
globalThis.WebSocketPair = function () { return { 0: fakeWs(), 1: fakeWs() }; };
const { Room } = await import("./worker.js");
const sockets = [], disk = new Map(); let alarmAt = null;
const storage = { get: async k => disk.get(k), put: async (k, v) => { disk.set(k, v); }, deleteAll: async () => disk.clear(),
                  setAlarm: async t => { alarmAt = t; } };
const room = new Room({ setWebSocketAutoResponse() {}, getWebSockets: () => sockets, storage,
                        acceptWebSocket: ws => sockets.push(ws) });
const connect = owner => room.fetch(new Request("https://relay.test/ws/K7M3P-Q9RTW?owner=" + owner,
  { headers: { Upgrade: "websocket", "x-room-key": "K7M3P-Q9RTW" } }));

const A = "ownerAAAAAAAAAAAAAAA", B = "ownerBBBBBBBBBBBBBBB";
await connect(A);
assert.equal(disk.get("claim").owner, A); assert.equal(sockets.length, 1); assert.ok(alarmAt > Date.now());
const bad = await connect(B);
assert.equal(bad.status, 101); assert.equal(sockets.length, 1, "copier never joins the room");
n++; console.log("ok - Room: first page claims the key, a second owner is closed with 4001 and kept out");
await room.webSocketClose(sockets.pop(), 1000);
await room.alarm();
assert.equal(disk.get("claim").owner, A, "not idle long enough: claim kept");
disk.set("claim", { owner: A, seen: Date.now() - IDLE_MS - 1 });
await room.alarm();
assert.equal(disk.size, 0);
n++; console.log("ok - Room: idle alarm wipes the claim after 24h, not before");
const get = (qs, h) => room.fetch(new Request("https://relay.test/c/key?" + qs, { headers: h })).then(r => r.text());

assert.equal(await get("user=a&q=join"), "🎮 This game isn't live right now.");
n++; console.log("ok - no tab: not-live line");

let seen;
sockets.push({ send(raw) { seen = JSON.parse(raw);
  // the page echoes a viewer-chosen name back; the relay must defuse it
  queueMicrotask(() => room.webSocketMessage(null, JSON.stringify({ id: seen.id, text: `🎮 ${seen.user} you're in! (${seen.platform})` })));
} });
const reply = await get("p=kick&q=join&user=%24(addPoints%209999)");
assert.equal(seen.platform, "kick");
assert.ok(!reply.includes("$("), reply);
n++; console.log("ok - tab answers through the relay, reply defused:", JSON.stringify(reply));

assert.equal(seen.user, "", "a $(...) name is treated as an unfilled template, never passed to the game");
const echo = await get("p=kick&q=join&user=Spammy%7B%7Bx%7D%7D");
assert.ok(!echo.includes("{{"), echo);
assert.equal(await get("p=kick&q=join&user=Spammy%7B%7Bx%7D%7D"), "");
n++; console.log("ok - echoed {{...}} defused; same viewer again within 1.5s gets an empty body");

console.log(`\n${n} passed`);
