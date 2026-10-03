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

export default {
  async fetch(req, env) {
    const [, kind, key] = new URL(req.url).pathname.split("/");
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
    if (!tab) return text((url.searchParams.get("off") || "🎮 This game isn't running right now. Check back when the stream starts it!").slice(0, 400));

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
