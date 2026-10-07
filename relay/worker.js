/* Chat Play relay — a dumb pipe between ANY chat bot's URL fetch and the streamer's open game tab.
   Drop-in superset of blingo-relay (same routes, same /lb), plus multi-bot input and abuse limits.

   GET /c/XXXXX-XXXXX?user=..&q=..&p=..   the bot hits this; the tab answers in plain text (<= 400 chars).
       BotRix     fetch[<relay>/c/XXXXX-XXXXX?p=$(platform)&q=$(v1 join)&user=$(urlencode $(sender))]
       Slot Tools $(urlfetch <relay>/c/XXXXX-XXXXX?user=$(user)&q=$(query))            (MyPrize; unchanged)
       others     see streamer-games chat/BOTS.md (or the bot picker on the page)
   GET /ws/<key>                     the game tab connects here (WebSocket).

   <key> is a random secret the tab generates (XXXXX-XXXXX). One key = one room (a Durable Object).
   GET /ws/<key>?owner=<token> claims the key for that page; another owner is refused (close 4001)
   until the key has been idle 24h, then the room's storage is wiped by an alarm (see bots.js).
   No tab connected => a short "not running" line (override with &off=...); no answer inside 3.5s => empty body.
   Over the rate limit => empty body. The relay holds no game state; all logic lives in the page.        */

import { readRequest, safeReply, Limiter, normalizeKey, decideClaim, IDLE_MS } from "./bots.js";

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
      const live = await fetch("https://myprize.us/api/" + path, { headers: { accept: "application/json" } });
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/lb") return leaderboard(url, ctx);
    const [, kind, raw] = url.pathname.split("/");
    const key = normalizeKey(raw);
    if (!key || (kind !== "c" && kind !== "ws")) return text(kind === "c" ? "🎮 That game key isn't valid. Copy the command again from your game page." : "chat play relay", 404);
    const fwd = new Request(req); fwd.headers.set("x-room-key", key);
    return env.ROOM.get(env.ROOM.idFromName(key)).fetch(fwd);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    this.limit = new Limiter();       // in memory: resets when the object sleeps, which is fine for spam control
    // Keepalive pings from the tab are answered without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") === "websocket") {
      const owner = new URL(req.url).searchParams.get("owner") || "";
      const stored = await this.state.storage.get("claim");
      const now = Date.now(), live = this.state.getWebSockets().length > 0;
      const verdict = decideClaim({ key: req.headers.get("x-room-key") || "", owner, stored, live, now });
      const { 0: client, 1: server } = new WebSocketPair();
      if (verdict === "refuse") {
        // Accept, then close with a code the page understands: it mints a fresh key and asks for a re-paste.
        server.accept(); server.close(4001, "key belongs to another page");
        return new Response(null, { status: 101, webSocket: client });
      }
      for (const old of this.state.getWebSockets()) old.close(4000, "replaced by a newer tab");
      if (verdict === "claim") await this.state.storage.put("claim", { owner, seen: now });
      await this.state.storage.setAlarm(now + IDLE_MS);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(req.url);
    const { user, q, platform, h } = readRequest(url, req.headers);
    if (!this.limit.allow(user)) return text("");
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
    let m; try { m = JSON.parse(msg); } catch { return; }
    const resolve = this.pending.get(m.id);
    if (!resolve) return;
    this.pending.delete(m.id);
    resolve(safeReply(m.text));
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
    const claim = await this.state.storage.get("claim");
    if (claim) await this.state.storage.put("claim", { ...claim, seen: Date.now() });
    await this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /* 24h after the last page left: forget the key entirely, so it can never be reused by accident. */
  async alarm() {
    const now = Date.now();
    if (this.state.getWebSockets().length) return this.state.storage.setAlarm(now + IDLE_MS);
    const claim = await this.state.storage.get("claim");
    if (claim && now - (claim.seen || 0) < IDLE_MS) return this.state.storage.setAlarm(claim.seen + IDLE_MS);
    await this.state.storage.deleteAll();
  }
}
