/* Blingo relay — a dumb pipe between Slot Tools $(urlfetch) and the streamer's open Blingo tab.

   GET /c/<key>?user=$(user)&q=$(query)   Slot Tools hits this; the tab answers in plain text.
   GET /ws/<key>                          the Blingo tab connects here (WebSocket).

   <key> is a random secret the tab generates. One key = one room (a Durable Object).
   No tab connected => a short "not running" line (override with &off=...); no answer inside 3.5s => empty body.
   The relay holds no game state; all logic lives in index.html.                        */

const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const WAIT_MS = 3500;              // Slot Tools gives up at 5s
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
  const cache = caches.default, ck = new Request("https://lb.cache/missions");
  let res = await cache.match(ck);
  if (!res) {
    // The list is paged (default 20): read every page so no room falls off the end.
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const live = await fetch(`https://myprize.us/api/missions?page=${page}&page_size=100`, { headers: { accept: "application/json" } });
      if (!live.ok) { if (page === 1) return text("🏆 Leaderboard is unavailable right now"); break; }
      const batch = (await live.json()).results || [];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    res = new Response(JSON.stringify({ results: all }), { headers: { "cache-control": "max-age=60", "content-type": "application/json" } });
    ctx.waitUntil(cache.put(ck, res.clone()));
  }
  const now = Date.now();
  const missions = ((await res.json()).results || []).filter(m =>
    m.type === "leaderboard" && String(m.room_name || "").toLowerCase() === room && new Date(m.end_date).getTime() > now);
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
    const [, kind, key] = url.pathname.split("/");
    if (!KEY_RE.test(key || "") || (kind !== "c" && kind !== "ws")) return text("blingo relay", 404);
    return env.ROOM.get(env.ROOM.idFromName(key)).fetch(req);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    // Keepalive pings from the tab are answered without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") === "websocket") {
      for (const old of this.state.getWebSockets()) old.close(4000, "replaced by a newer tab");
      const { 0: client, 1: server } = new WebSocketPair();
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(req.url);
    const tab = this.state.getWebSockets()[0];
    // No page open: say so instead of posting nothing. A command can override it with &off=<text>.
    if (!tab) return text((url.searchParams.get("off") || "🎮 This game isn't live right now.").slice(0, 400));

    const id = crypto.randomUUID();
    const reply = new Promise(resolve => {
      this.pending.set(id, resolve);
      setTimeout(() => { this.pending.delete(id); resolve(""); }, WAIT_MS);
    });
    try {
      tab.send(JSON.stringify({ id, user: url.searchParams.get("user") || "", q: url.searchParams.get("q") || "" }));
    } catch { return text(""); }
    return text(await reply);
  }

  webSocketMessage(ws, msg) {
    let m; try { m = JSON.parse(msg); } catch { return; }
    const resolve = this.pending.get(m.id);
    if (!resolve) return;
    this.pending.delete(m.id);
    resolve(String(m.text ?? "").slice(0, 400));
  }

  webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
}
