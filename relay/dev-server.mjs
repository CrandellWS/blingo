/* Local stand-in for Cloudflare: runs the REAL worker.js + Room over real WebSockets, and serves static pages.
   For testing only; production is the Worker. Needs the `ws` package (any copy):
     WS_MODULE=/path/to/node_modules/ws node relay/dev-server.mjs [port] [static-root]
   Then open http://127.0.0.1:8787/chat/?relay=http://127.0.0.1:8787                                     */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
               ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json" };

export async function startDevServer({ port = 8787, root = path.join(here, ".."), mounts = {}, vars = {} } = {}) {
  const { WebSocketServer } = createRequire(import.meta.url)(process.env.WS_MODULE || "ws");

  // Workers runtime shims: 101 responses, WebSocketPair, auto ping/pong pairs.
  const RealResponse = globalThis.Response;
  globalThis.Response = function (body, init = {}) {
    return init.status === 101 ? { status: 101, webSocket: init.webSocket } : new RealResponse(body, init);
  };
  globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { this.req = req; this.res = res; } };
  globalThis.WebSocketPair = function () {
    const server = { ws: null, queue: [], accept() {}, send(d) { this.ws ? this.ws.send(d) : this.queue.push(["send", d]); },
                     close(c, r) { this.ws ? this.ws.close(c, r) : this.queue.push(["close", c, r]); } };
    return { 0: { server }, 1: server };
  };

  const { default: worker, Room } = await import("./worker.js");
  const rooms = new Map();
  const env = { ...vars, ROOM: { idFromName: n => n, get: name => {
    if (!rooms.has(name)) {
      const sockets = [], disk = new Map(), ref = {};
      const state = {
        auto: null, sockets,
        setWebSocketAutoResponse(pair) { this.auto = pair; },
        getWebSockets: tag => tag ? sockets.filter(s => s.tags?.includes(tag)) : sockets,
        acceptWebSocket: (s, tags = []) => { s.ref = ref; s.tags = tags; sockets.push(s); },
        storage: { get: async k => disk.get(k), put: async (k, v) => { disk.set(k, v); }, deleteAll: async () => disk.clear(),
                   setAlarm: async () => {} },
      };
      Object.assign(ref, { room: new Room(state), state });
      rooms.set(name, ref);
    }
    const r = rooms.get(name);
    return { fetch: req => r.room.fetch(req) };
  } } };

  const toRequest = req => new Request(`http://127.0.0.1:${port}${req.url}`, { headers: Object.entries(req.headers).filter(([k]) => !/^(connection|upgrade|sec-websocket-.*|host)$/i.test(k)).concat(req.headers.upgrade ? [["upgrade", req.headers.upgrade]] : []) });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (/^\/(c|ws)\//.test(u.pathname) || u.pathname === "/lb") {
      const r = await worker.fetch(toRequest(req), env, { waitUntil() {} });
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
    }
    // static files: /<mount>/... from a mounted folder, everything else from root
    let base = root, rel = u.pathname;
    for (const [m, dir] of Object.entries(mounts)) if (rel.startsWith("/" + m + "/")) { base = dir; rel = rel.slice(m.length + 1); }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(base, path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[\/\\])+/, ""));
    try { const body = await readFile(file); res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end("not found"); }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const r = await worker.fetch(toRequest(req), env, { waitUntil() {} });
    if (r.status !== 101) { socket.end(`HTTP/1.1 ${r.status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }   // like Cloudflare: a real status
    const srv = r.webSocket.server;
    wss.handleUpgrade(req, socket, head, ws => {
      srv.ws = ws;
      for (const [op, a, b] of srv.queue) op === "send" ? ws.send(a) : ws.close(a, b);
      if (!srv.ref) return;                                    // refused (4001): never joins a room
      const { room, state } = srv.ref;
      ws.on("message", (data, isBinary) => {
        const msg = isBinary ? data : data.toString();
        if (state.auto && msg === state.auto.req) return ws.send(state.auto.res);
        room.webSocketMessage(srv, msg);
      });
      ws.on("close", code => {
        const i = state.sockets.indexOf(srv); if (i >= 0) state.sockets.splice(i, 1);
        room.webSocketClose({ close() {} }, code);
      });
    });
  });

  await new Promise(ok => server.listen(port, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(ok => { wss.close(); server.close(ok); server.closeAllConnections?.(); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startDevServer({ port: +process.argv[2] || 8787, root: process.argv[3] || undefined });
  console.log("dev relay + static on", s.url);
}
