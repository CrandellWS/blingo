/* Chat Play relay — a dumb pipe between ANY chat bot's URL fetch and the streamer's open game tab.
   Drop-in superset of blingo-relay (same routes, same /lb), plus multi-bot input and abuse limits.

   GET /c/XXXXX-XXXXX?user=..&p=..&q=..   the bot hits this; the tab answers in plain text (<= 400 chars).
       BotRix     fetch[<relay>/c/XXXXX-XXXXX?user=$(urlencode $(sender))&p=$(platform)&q=$(urlencode $(v1 join))]
       Slot Tools $(urlfetch <relay>/c/XXXXX-XXXXX?user=$(user)&q=$(query))            (MyPrize; unchanged)
       The viewer's words always go last and encoded; a request naming a field twice is refused (empty body).
       others     see streamer-games chat/BOTS.md (or the bot picker on the page)
   GET /ws/<key>                     the game tab connects here (WebSocket).

   <key> is a random secret the tab generates (XXXXX-XXXXX). One key = one room (a Durable Object).
   GET /ws/<key>?owner=<token> claims a new-format key for that page; another owner is refused (close 4001).
   Legacy 16-64 char keys work exactly as on the old relay (no claim). Key rules: bots.js.
   Limits: per-room join/other buckets + per-viewer gap (Room), per-IP buckets (isolate memory), a global daily
   cap (Counter DO, env DAILY_CAP), at most 30 socket connects per room per minute (close 4003), and an
   optional Origin allow-list for sockets (env ALLOWED_ORIGINS).
   No tab connected => a short "not running" line (override with &off=...); no answer inside 3.5s => empty body.
   Over the rate limit => empty body. The relay holds no game state; all logic lives in the page.        */

import { readRequest, safeReply, Limiter, IpLimiter, normalizeKey, decideClaim, IDLE_MS, CLAIM_TTL_MS } from "./bots.js";

const WAIT_MS = 3500;              // Slot Tools gives up at 5s; StreamElements at 15s
const text = (body, status = 200) => new Response(body, {
  status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
});

/* GET /lb?room=RelatableShayla[&n=3] -> top N of that room's active MyPrize leaderboard mission, plain text.
   Public data only (myprize.us/api/missions). Hidden players show as "1st place winner". Cached 60s. */
const MEDALS = ["🥇", "🥈", "🥉"];
const ORD = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const sc = cents => (Number(cents || 0) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " SC";
async function leaderboard(url, ctx) {
  const room = (url.searchParams.get("room") || "").trim().toLowerCase();
  const n = Math.min(5, Math.max(1, +url.searchParams.get("n") || 3));
  if (!room) return text("🏆 Add ?room=YourRoomName to the command");
  // Room slug -> id -> only that room's missions (MyPrize filters by room_id, so no paging).
  const get = async (path, ttl) => {
    const cache = caches.default, ck = new Request("https://lb.cache/" + path);
    let res = await cache.match(ck);
    if (!res) {
      let live;
      try { live = await fetch("https://myprize.us/api/" + path, { headers: { accept: "application/json" } }); } catch { return null; }
      if (!live.ok) return null;
      res = new Response(await live.text(), { headers: { "cache-control": `max-age=${ttl}`, "content-type": "application/json" } });
      ctx.waitUntil(cache.put(ck, res.clone()));
    }
    return res.json();
  };
  const info = await get(`rooms/slug/${encodeURIComponent(room)}`, 3600);
  if (!info || !info.id) return text("🏆 Couldn't find that MyPrize room");
  const list = await get(`missions?room_id=${info.id}`, 60);
  if (!list) return text("🏆 Leaderboard is unavailable right now");
  const now = Date.now();
  const missions = (list.results || []).filter(m => m.type === "leaderboard" && new Date(m.end_date).getTime() > now);
  const m = missions[0];
  if (!m) return text("🏆 No active leaderboard for that room right now");
  const places = (m.details && m.details.places) || [];
  const prize = rank => { const p = places.find(x => rank >= x.start && rank <= (x.end ?? x.start)); return p ? p.rewards?.mission_promo_amounts?.SC?.amount : 0; };
  const board = m.leaderboard || [];
  const name = (e, r) => !e.username || e.username === "Hidden" ? `${ORD(r)} place winner` : e.username;

  // &show=prizes: the payout ranges in one short line, e.g. "1st 100 · 2nd 75 · 4th-10th 25 each".
  if (url.searchParams.get("show") === "prizes") {
    if (!places.length) return text(`🏆 ${m.name}: no paid places listed`);
    const sorted = [...places].sort((x, y) => x.start - y.start);
    let pool = 0, paid = 0;
    const parts = sorted.map(p => {
      const end = p.end ?? p.start, amt = p.rewards?.mission_promo_amounts?.SC?.amount || 0, cnt = end - p.start + 1;
      pool += amt * cnt; paid = Math.max(paid, end);
      return end === p.start ? `${ORD(p.start)} ${sc(amt)}` : `${ORD(p.start)}-${ORD(end)} ${sc(amt)} each`;
    });
    const ends = new Date(m.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
    return text(`🏆 ${m.name}: ${parts.join(" · ")} · top ${paid} paid, ${sc(pool)} total, ends ${ends}`.slice(0, 400));
  }

  // &show=bar: the bottom paid rung, i.e. what you have to beat to get paid.
  if (url.searchParams.get("show") === "bar") {
    const paid = places.reduce((n, p) => Math.max(n, p.end ?? p.start), 0);
    if (!paid) return text(`🏆 ${m.name}: no paid places listed`);
    if (board.length < paid) return text(`🏆 ${m.name}: ${paid} places pay and only ${board.length} on the board. Any wager gets you paid! (last spot wins ${sc(prize(paid))})`);
    const e = board[paid - 1];
    return text(`🏆 ${m.name}: the bar is ${ORD(paid)} place at ${sc(e.score)} wagered (wins ${sc(prize(paid))}). Beat ${sc(e.score)} to get paid 💰`);
  }

  const rows = board.slice(0, n).map((e, i) => `${MEDALS[i] || (i + 1) + "."} ${name(e, i + 1)} ${sc(e.score)}`);
  if (!rows.length) return text(`🏆 ${m.name}: nobody on the board yet`);
  return text(`🏆 ${m.name} · ${rows.join(" · ")}`.slice(0, 400));
}

/* ---------- limits that sit in front of every room (audit #4) ---------- */
const IP_C = new IpLimiter({ rate: 30, burst: 600 });     // bot services share IPs across many channels
const IP_WS = new IpLimiter({ rate: 0.5, burst: 20 });    // a browser reconnecting now and then
const daily = { day: "", total: 0, pending: 0, flushedAt: 0 };
/* Global requests-per-day cap. Each isolate counts locally and adds its count to one Counter object every 50
   requests or 20 s, so the cap costs about 2% extra requests. Over the cap: bots get an empty body.          */
function overDailyCap(env, ctx, now) {
  if (!env.COUNTER) return false;
  const cap = +env.DAILY_CAP || 90000, day = new Date(now).toISOString().slice(0, 10);
  if (daily.day !== day) Object.assign(daily, { day, total: 0, pending: 0, flushedAt: now });
  daily.pending++;
  if (daily.pending >= 50 || now - daily.flushedAt > 20000) {
    const n = daily.pending; daily.pending = 0; daily.flushedAt = now;
    const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
    ctx.waitUntil(stub.fetch(`https://counter/add?day=${day}&n=${n}`).then(r => r.text())
      .then(t => { if (daily.day === day) daily.total = Math.max(daily.total, +t || 0); }).catch(() => {}));
    daily.total += n;
  }
  return daily.total + daily.pending > cap;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), now = Date.now();
    if (url.pathname === "/lb") return leaderboard(url, ctx);
    const [, kind, raw] = url.pathname.split("/");
    if (kind !== "c" && kind !== "ws") return text("chat play relay", 404);
    const ip = req.headers.get("cf-connecting-ip") || "";
    const ws = kind === "ws";
    if (!(ws ? IP_WS : IP_C).allow(ip, now) || overDailyCap(env, ctx, now)) return ws ? text("busy", 429) : text("");
    if (ws && env.ALLOWED_ORIGINS) {                              // audit #11: only our own pages may hold a room
      const origin = req.headers.get("origin") || "";
      if (!env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).includes(origin)) return text("origin not allowed", 403);
    }
    const key = normalizeKey(raw);
    // 200, not 404: most bots only post a reply from a successful response (audit #13).
    if (!key) return ws ? text("bad key", 404) : text("🎮 That game key isn't valid. Copy the command again from your game page.");
    const fwd = new Request(req); fwd.headers.set("x-room-key", key);
    return env.ROOM.get(env.ROOM.idFromName(key)).fetch(fwd);
  },
};

/* One object, name "global": { day, count }. GET /add?day=YYYY-MM-DD&n=N -> new total for that day. */
export class Counter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const u = new URL(req.url), day = u.searchParams.get("day") || "", n = Math.max(0, Math.min(10000, +u.searchParams.get("n") || 0));
    const cur = (await this.state.storage.get("c")) || { day, count: 0 };
    const next = cur.day === day ? { day, count: cur.count + n } : { day, count: n };
    await this.state.storage.put("c", next);
    return new Response(String(next.count));
  }
}

export class Room {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    this.limit = new Limiter();       // in memory: resets when the object sleeps, which is fine for spam control
    this.connects = [];               // socket connect times, for the 30-per-minute cap
    // Keepalive pings from the tab are answered without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") === "websocket") {
      const now = Date.now();
      const { 0: client, 1: server } = new WebSocketPair();
      const refuse = (code, why) => { server.accept(); server.close(code, why); return new Response(null, { status: 101, webSocket: client }); };
      this.connects = this.connects.filter(t => now - t < 60000);
      if (this.connects.length >= 30) return refuse(4003, "too many connects, retry in a minute");   // no storage writes
      this.connects.push(now);
      const owner = new URL(req.url).searchParams.get("owner") || "";
      const key = req.headers.get("x-room-key") || "";
      const stored = await this.state.storage.get("claim");
      const live = this.state.getWebSockets().length > 0;
      const verdict = decideClaim({ key, owner, stored, live, now });
      // Close code the page understands: a new-format key owned by another page. Never sent for legacy keys.
      if (verdict === "refuse") return refuse(4001, "key belongs to another page");
      for (const old of this.state.getWebSockets()) old.close(4000, "replaced by a newer tab");
      if (verdict === "claim" && (stored?.owner !== owner || now - (stored.seen || 0) > 3600000)) await this.state.storage.put("claim", { owner, seen: now });
      if (verdict === "claim") await this.state.storage.setAlarm(now + IDLE_MS);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(req.url);
    const { user, q, platform, h, reject } = readRequest(url, req.headers);
    if (reject || !this.limit.allow(user, q)) return text("");
    const tab = this.state.getWebSockets()[0];
    // No page open: say so instead of posting nothing. A command can override it with &off=<text>.
    if (!tab) return text(safeReply(url.searchParams.get("off") || "🎮 This game isn't live right now."));

    const id = crypto.randomUUID();
    const reply = new Promise(resolve => {
      this.pending.set(id, resolve);
      setTimeout(() => { this.pending.delete(id); resolve(""); }, WAIT_MS);
    });
    try {
      tab.send(JSON.stringify({ id, user, q, platform, h }));
    } catch { return text(""); }
    return text(await reply);
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > 4096) return;     // audit #10
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (!m || typeof m !== "object" || typeof m.id !== "string") return;
    const resolve = this.pending.get(m.id);
    if (!resolve) return;
    this.pending.delete(m.id);
    resolve(safeReply(m.text));
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
    const claim = await this.state.storage.get("claim");
    if (!claim) return;                                          // legacy keys store nothing
    await this.state.storage.put("claim", { ...claim, seen: Date.now() });
    await this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /* 24h after the last page left: wipe the room, keep only the owner binding (so nobody else can take the key).
     30 days after that: forget the key entirely.                                                              */
  async alarm() {
    const now = Date.now();
    if (this.state.getWebSockets().length) return this.state.storage.setAlarm(now + IDLE_MS);
    const claim = await this.state.storage.get("claim");
    if (!claim) return this.state.storage.deleteAll();
    const idle = now - (claim.seen || 0);
    if (idle < IDLE_MS) return this.state.storage.setAlarm(claim.seen + IDLE_MS);
    if (idle < CLAIM_TTL_MS) {
      await this.state.storage.deleteAll();
      await this.state.storage.put("claim", { owner: claim.owner, seen: claim.seen, idle: true });
      return this.state.storage.setAlarm(claim.seen + CLAIM_TTL_MS);
    }
    await this.state.storage.deleteAll();
  }
}
