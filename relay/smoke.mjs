/* Deploy-day smoke test against a REAL relay, with throwaway keys only (never a streamer's key).
     WS_MODULE=/path/to/node_modules/ws node relay/smoke.mjs https://blingo-relay.floral-meadow-2593.workers.dev
   It plays the game page itself (a WebSocket with an allowed Origin) and the bot (plain GETs), then checks:
   bad key, fresh key round trip, a copier refused (4001), no &off= echo, repeated field refused,
   page closed = fixed line, and a legacy-shaped key with no owner token. Prints keys masked.               */
import { createRequire } from "node:module";
import { webcrypto as crypto } from "node:crypto";
const WebSocket = createRequire(import.meta.url)(process.env.WS_MODULE || "ws");
const BASE = (process.argv[2] || "").replace(/\/$/, "");
const ORIGIN = process.env.ORIGIN || "https://homeofficestudios.com";
if (!/^https?:\/\//.test(BASE)) { console.error("usage: node smoke.mjs https://<relay>"); process.exit(2); }
const A = "23456789ABCDEFGHJKMNPQRSTUVWXYZ", pick = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => A[b % 31]).join("");
const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
const mask = k => k.replace(/[A-Za-z0-9]/g, "X");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (name, cond, got) => { console.log((cond ? "ok   - " : "FAIL - ") + name + (cond ? "" : "  got: " + JSON.stringify(got))); if (!cond) fails++; };
const get = async qs => (await fetch(BASE + qs)).text();

function page(key, owner) {   // a fake game page that answers every command
  const q = owner ? "?owner=" + owner : "";
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws/" + key + q, { origin: ORIGIN });
  ws.on("message", raw => { try { const m = JSON.parse(String(raw)); ws.send(JSON.stringify({ id: m.id, text: `smoke ok: ${m.user} ${m.q}` })); } catch {} });
  // A refused socket is accepted and then closed at once (4001/4002/4003), so wait a moment before calling it open.
  return new Promise(res => {
    let opened = false;
    ws.on("open", () => { opened = true; setTimeout(() => res({ ws, open: ws.readyState === 1 }), 700); });
    ws.on("close", code => { if (!opened) res({ ws, open: false, code }); else res({ ws, open: false, code }); });
    ws.on("error", () => {});
  }).then(r => ({ ...r, code: r.code ?? ws._closeCode }));
}

const bad = await fetch(BASE + "/c/XXXXX-XXXXX?user=a&q=join");
check("bad/placeholder key answers 200 with the 'isn't valid' line", bad.status === 200 && /isn't valid/.test(await bad.text()), bad.status);

const key = pick(5) + "-" + pick(5), owner = tok();
console.log("fresh key", mask(key));
const p = await page(key, owner);
check("fresh key: page socket opens (Origin allowed, owner claims)", p.open, p.code);
await sleep(300);
check("fresh key: bot request reaches the page and the reply comes back", (await get(`/c/${key}?user=SmokeA&p=kick&q=join`)) === "smoke ok: SmokeA join");
const copier = await page(key, tok());
check("a second owner on the same key is refused with 4001", !copier.open && copier.code === 4001, copier.code);
check("the real page still answers after the copier", (await get(`/c/${key}?user=SmokeB&p=kick&q=count`)) === "smoke ok: SmokeB count");
check("a repeated field (typed &user=) is refused with an empty body", (await get(`/c/${key}?user=SmokeC&p=kick&q=join&user=Mod`)) === "");
p.ws.close(1000); await sleep(800);
const off = await get(`/c/${key}?user=SmokeD&q=join&off=EVIL%20TEXT`);
check("page closed: fixed 'not live' line, &off= never echoed", /isn't live/.test(off) && !off.includes("EVIL"), off);

const legacy = "smoke_" + tok().slice(0, 18);
const L = await page(legacy, "");
check("legacy-shaped key with no owner token connects", L.open, L.code);
await sleep(300);
{ const t = await get(`/c/${legacy}?user=SmokeE&q=`); check("legacy key round trip (Slot Tools shape)", t.startsWith("smoke ok: SmokeE"), t); }
L.ws.close(1000);
const wrongOrigin = await new Promise(res => { const w = new WebSocket(BASE.replace(/^http/, "ws") + "/ws/" + pick(5) + "-" + pick(5) + "?owner=" + tok(), { origin: "https://not-allowed.example" });
  w.on("open", () => { w.close(); res("open"); }); w.on("unexpected-response", (_, r) => res(r.statusCode)); w.on("error", () => res("error")); });
check("a socket from a site not in ALLOWED_ORIGINS is refused (403; 'open' means the allow-list is off)", wrongOrigin === 403, wrongOrigin);

console.log(fails ? `\n${fails} FAILED` : "\nall smoke checks passed"); process.exit(fails ? 1 : 0);
