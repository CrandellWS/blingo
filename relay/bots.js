/* Bot-agnostic request handling for the Chat Play relay.
   Every chat bot that can fetch a URL (BotRix, Slot Tools, StreamElements, Fossabot, Nightbot, KickBot,
   Streamer.bot) hits GET /c/<key>?user=..&p=..&h=..&q=..  but each fills those in differently. This file turns
   whatever arrived into one clean { user, q, platform, h } and makes the reply safe to hand back to any bot.
   Identity headers (Nightbot-User, x-fossabot-*) are trusted as sent: they are only a fallback name, never a
   permission. Nothing here grants rights from a header or a name (audit #12).                                 */

// A template the bot failed to fill in, e.g. "$(v1 join)", "${sender}", "{{sender.username}}", "%rawInput%".
const UNFILLED = /^\s*(\$\(|\$\{|\{\{|%[A-Za-z][\w.]*%$)/;
// Every name a bot could use for one of our fields. A field given twice means someone typed "&user=..." into
// their message and the bot did not encode it: refuse the whole request (audit #2).
const FIELDS = ["user", "sender", "u", "q", "query", "args", "p", "platform", "h"];

/* Clean one query value: drop unfilled templates and the literal "null"/"undefined" some bots send for empty input. */
function clean(v) {
  const s = String(v ?? "").trim();
  if (!s || UNFILLED.test(s) || /^(null|undefined)$/i.test(s)) return "";
  return s;
}

/* Nightbot sends "Nightbot-User: name=..&displayName=..&provider=..&providerId=..&userLevel=.." */
function nightbotUser(h) {
  const raw = h.get("nightbot-user");
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  return { user: p.get("displayName") || p.get("name") || "", platform: p.get("provider") || "" };
}

/* Read user, query, platform and host token. Returns { reject: true } for a request with a repeated field. */
export function readRequest(url, headers) {
  const sp = url.searchParams;
  if (FIELDS.some(f => sp.getAll(f).length > 1)) return { reject: true, user: "", q: "", platform: "", h: "" };
  let user = clean(sp.get("user") ?? sp.get("sender") ?? sp.get("u"));
  const q = clean(sp.get("q") ?? sp.get("query") ?? sp.get("args"));
  let platform = clean(sp.get("p") ?? sp.get("platform")).toLowerCase();

  const nb = nightbotUser(headers);
  if (nb) { user ||= clean(nb.user); platform ||= nb.platform.toLowerCase(); }
  user ||= clean(headers.get("x-fossabot-message-userdisplayname") || headers.get("x-fossabot-message-userlogin"));
  if (!platform && headers.get("x-fossabot-channelprovider")) platform = headers.get("x-fossabot-channelprovider").toLowerCase();

  user = user.replace(/^@+/, "").slice(0, 40);
  // h = the streamer's host token, only present in their own mods-only commands; the page checks it.
  const h = clean(sp.get("h")).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return { user, q: q.slice(0, 120), platform: platform.replace(/[^a-z0-9]/g, "").slice(0, 16), h };
}

/* Make a reply inert for every bot (audit #7). A viewer picks their own name and some words the game echoes back;
   they must never be read as a bot variable ($(addPoints ...), xfetch[...], {{request(...)}}, <ifKick>...), never
   start a bot command, and never mass-ping. Lookalike full-width characters keep the text readable.            */
const MAX = 400;
export function safeReply(text) {
  let s = String(text ?? "").normalize("NFKC")
    .replace(/\p{Cf}/gu, "")                                        // zero-width and other invisible format chars
    .replace(/[\s\u0085\u2028\u2029]+/gu, " ")                      // every kind of line break or odd space
    .replace(/\$\s*([({])/g, "＄$1")                                 // $( and ${
    .replace(/(fetch|rand|randomlist)\s*\[/gi, "$1［")               // any token ending in fetch[ (myfetch[, earlyFetch[) and Rand[
    .replace(/\{\s*\{/g, "｛｛").replace(/%(\w+)%/g, "％$1％")
    .replace(/<\/?\s*(if[a-z]+|hideText)\b[^>]*>/gi, "")
    .replace(/@/g, "＠");                                           // no @everyone / @here / @name pings
  for (let prev; prev !== s;) { prev = s; s = s.replace(/^[\s!\/.\\]+/, ""); }   // never starts a command, however disguised
  // Cut on a code point boundary so an emoji is never split, staying within 400 UTF-16 units.
  let out = "";
  for (const ch of s) { if (out.length + ch.length > MAX) break; out += ch; }
  return out.trim();
}

/* Per-room limits: a generous bucket for joins (an entry rush must not lose names, audit #5), a tight bucket for
   everything else, and a per-viewer cooldown. The viewer map evicts its oldest entries (audit #8).
   Over a limit the relay answers with an empty body: most bots then post nothing.                              */
const JOIN_WORDS = new Set(["", "join", "enter", "in"]);
class Bucket {
  constructor(rate, burst) { Object.assign(this, { rate, burst, tokens: burst, at: null }); }
  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - (this.at ?? now)) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}
export class Limiter {
  constructor({ joinRate = 20, joinBurst = 200, rate = 3, burst = 30, userGapMs = 1500, maxUsers = 2000 } = {}) {
    Object.assign(this, { join: new Bucket(joinRate, joinBurst), other: new Bucket(rate, burst), userGapMs, maxUsers, users: new Map() });
  }
  allow(user, q = "", now = Date.now()) {
    const k = String(user || "").toLowerCase();
    if (k) {
      const last = this.users.get(k);
      if (last !== undefined && now - last < this.userGapMs) return false;
      this.users.delete(k); this.users.set(k, now);                 // re-insert: Map order = oldest first
      while (this.users.size > this.maxUsers) this.users.delete(this.users.keys().next().value);
    }
    const first = String(q || "").trim().toLowerCase().split(/\s+/)[0] || "";
    return (JOIN_WORDS.has(first) ? this.join : this.other).take(now);
  }
}

/* Per-client-IP buckets kept in the Worker isolate (best effort, no extra requests; audit #4). The /c route is
   generous because one bot service (all BotRix channels) calls from a few IPs; /ws is strict (browsers).      */
export class IpLimiter {
  constructor({ rate, burst, max = 5000 }) { Object.assign(this, { rate, burst, max, map: new Map() }); }
  allow(ip, now = Date.now()) {
    if (!ip) return true;
    let b = this.map.get(ip);
    if (!b) { b = new Bucket(this.rate, this.burst); this.map.set(ip, b); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
    return b.take(now);
  }
}

/* ---------- room keys ----------
   New keys: 10 crypto-random characters from an alphabet with no 0/O/1/I/L, shown as XXXXX-XXXXX (~49 bits).
   A new key is CLAIMED by the first page that connects with its owner token (a second random secret that only
   lives in that browser's localStorage and its OBS link). Any other owner is refused (4001).
   After 24h with no page the room's data is wiped, but the owner binding is kept for 30 days, so only the
   original page can bring an idle key back (no hijack of a streamer who took a day off; audit #6).
   Legacy keys (16-64 of [A-Za-z0-9_-], e.g. RelatableShayla's Blingo key) behave EXACTLY like the live relay:
   no claim is ever stored, owner tokens are ignored, the newest page wins (audit #3). Moving to a new key is
   the streamer's explicit choice (New key); nothing rotates a legacy key automatically.                    */
export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const NEW_KEY_RE = /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/;
export const LEGACY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const OWNER_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const IDLE_MS = 24 * 3600 * 1000;
export const CLAIM_TTL_MS = 30 * 24 * 3600 * 1000;

/* Canonical form of a key from a URL path, or null. New keys are case-insensitive; placeholders are refused. */
export function normalizeKey(raw) {
  const k = String(raw || "");
  const up = k.toUpperCase();
  if (NEW_KEY_RE.test(up)) return /^(.)\1{4}-\1{5}$/.test(up) ? null : up;   // XXXXX-XXXXX and friends
  return LEGACY_KEY_RE.test(k) ? k : null;
}

/* Who may hold the room. stored = { owner, seen } from storage (or undefined). */
export function decideClaim({ key, owner, stored, live, now }) {
  if (!NEW_KEY_RE.test(key)) return "legacy";                          // never claimed, never refused
  if (!owner || !OWNER_RE.test(owner)) return "refuse";                // new keys always need an owner
  if (!stored?.owner || stored.owner === owner) return "claim";
  return !live && now - (stored.seen || 0) >= CLAIM_TTL_MS ? "claim" : "refuse";
}
