/* Bot-agnostic request handling for the Chat Play relay.
   Every chat bot that can fetch a URL (BotRix, Slot Tools, StreamElements, Fossabot, Nightbot, KickBot,
   Streamer.bot) hits GET /c/<key>?user=..&q=..&p=..  but each fills those in differently. This file turns
   whatever arrived into one clean { user, q, platform } and makes the reply safe to hand back to any bot. */

// A template the bot failed to fill in, e.g. "$(v1 join)", "${sender}", "{{sender.username}}", "%rawInput%".
const UNFILLED = /^\s*(\$\(|\$\{|\{\{|%[A-Za-z][\w.]*%$)/;

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

/* Read user, query and platform from the URL first, then from the headers some bots attach. */
export function readRequest(url, headers) {
  const sp = url.searchParams;
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

/* Make a reply inert for every bot. A viewer can pick a name or type a word that the game echoes back; it must
   never be read as a bot variable ($(addPoints ...), fetch[...], {{request(...)}}, <ifKick>...), and never ping. */
export function safeReply(text) {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\$\s*([({])/g, "$\u200b$1")                         // $( and ${  -> broken by a zero-width space
    .replace(/\b(fetch|earlyFetch|Rand|RandomList)\s*\[/gi, "$1\u200b[")
    .replace(/\{\{/g, "{\u200b{").replace(/%(\w+)%/g, "%\u200b$1%")
    .replace(/<\/?\s*(if[a-z]+|hideText)\b[^>]*>/gi, "")
    .replace(/^\s*[!\/]+/, "")                                     // a reply must not itself start a bot command
    .slice(0, 400);
}

/* Token bucket per key (protects the free quota if a key leaks) and a short per-viewer cooldown (spam).
   Over the limit the relay answers with an empty body: most bots then post nothing.                        */
export class Limiter {
  constructor({ rate = 3, burst = 30, userGapMs = 1500 } = {}) {
    Object.assign(this, { rate, burst, userGapMs, tokens: burst, at: 0, users: new Map() });
  }
  allow(user, now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - (this.at || now)) / 1000) * this.rate);
    this.at = now;
    const k = String(user || "").toLowerCase();
    if (k) {
      if (this.users.has(k) && now - this.users.get(k) < this.userGapMs) return false;
      this.users.set(k, now);
      if (this.users.size > 2000) this.users.clear();
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/* ---------- room keys ----------
   New keys: 10 crypto-random characters from an alphabet with no 0/O/1/I/L, shown as XXXXX-XXXXX (~49 bits).
   Legacy keys (16-64 of [A-Za-z0-9_-], e.g. RelatableShayla's Blingo key) keep working unchanged.
   A key is CLAIMED by the first page that connects with its owner token (a second random secret that never
   leaves that browser's localStorage, or the OBS link). Another page with a different owner token is refused
   while the claim is fresh, so a key copied from someone else's screen or docs cannot join their game.
   A claim expires after 24h with no page connected; the key is then free again.                            */
export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const NEW_KEY_RE = /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/;
export const LEGACY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const OWNER_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const IDLE_MS = 24 * 3600 * 1000;

/* Canonical form of a key from a URL path, or null. New keys are case-insensitive; placeholders are refused. */
export function normalizeKey(raw) {
  const k = String(raw || "");
  const up = k.toUpperCase();
  if (NEW_KEY_RE.test(up)) return /^(.)\1{4}-\1{5}$/.test(up) ? null : up;   // XXXXX-XXXXX and friends
  return LEGACY_KEY_RE.test(k) ? k : null;
}

/* Who may hold the room. stored = { owner, seen } from storage (or undefined). */
export function decideClaim({ key, owner, stored, live, now }) {
  const legacy = !NEW_KEY_RE.test(key);
  if (!owner) return legacy && !stored?.owner ? "legacy" : "refuse";   // old Blingo page: no owner token
  if (!OWNER_RE.test(owner)) return "refuse";
  if (!stored?.owner || stored.owner === owner) return "claim";
  return !live && now - (stored.seen || 0) >= IDLE_MS ? "claim" : "refuse";
}
