# Blingo 💎

Relatable bingo for streamers. Drop in a chat name list, hit start — Blingo builds the boards, auto-draws names and numbers, marks squares with diamonds, and crowns winners when lines complete. One HTML file, zero dependencies, GitHub Pages ready.

## How it plays

- Paste names (one per line, or commas — duplicates are dropped)
- Boards are classic 5×5 B-I-N-G-O with a FREE diamond center. Up to 24 names per board; more names deal evenly across extra boards
- Every few seconds a name or number is called with a gem-flip animation; matching squares get a diamond
- Every marked name shows its pick number (#1, #2, ...) so you always know who was drawn first and last in a line
- The history strip is clickable — tap it to open the full draw order (#1..#N, in order) at any point; the list is kept until you start a new game
- The first completed row, column, or diagonal that contains at least one name ends the game; winners come from that line by the mode you choose: **first pick**, **last pick**, **both**, or the **whole line** (numbers and FREE never win)
- Full-screen winners celebration, with a view-the-boards option and a header button to reopen it
- Streamer controls: pause/resume, draw now, new game

## Deep links

Everything can be preloaded in the URL hash:

```
index.html#n=Alice,Bob,Cleo&m=line&s=1        preload the setup form
index.html#n=Alice,Bob,Cleo&m=first&s=1&go=1  skip setup and start immediately
```

`n` = comma-separated names, `m` = winner mode (`first`, `last`, `both`, `line`), `s` = seconds between draws (as low as `0.1` for rapid-fire), `go=1` = autostart. Starting a game writes this link to the address bar, so a running setup can be bookmarked and rerun.

## Retheming

All colors, glows, and fonts live in one commented `THEME` block at the top of the `<style>` tag — edit those custom properties and the whole page follows. Game rules (names per board, number ranges, marker emoji, history length) live in the `CONFIG` object at the top of the `<script>` tag. The three JS entry points are `makeBoards()` (card generation), `drawOne()` (the game loop), and `checkWins()` (line detection).

Fonts load from Google Fonts with system fallbacks, so the page still works fully offline — it just falls back to system type.

## License

MIT. Go make someone's chat sparkle.

## Chat entries (your own chatbot)

Viewers join from chat with `!blingo`, through the bot the streamer already runs: BotRix (Kick, Twitch, YouTube, Trovo),
Slot Tools (MyPrize), StreamElements, Fossabot, Nightbot, KickBot or Streamer.bot. Click **💬 Take entries from chat**,
then **Show bot commands**, pick your bot, and paste the `blingo` line as a command open to everyone. Optional ready-made
lines: `claim`, `blame`, `bs`. `!blingo count`, `!blingo list` and `!blingo status` also work.

Your room key (like `XXXXX-XXXXX`) is made in your browser the first time you open Blingo, kept there, and already
inside every command. Never use a key from a guide or another streamer: the relay refuses a key that belongs to
another browser, and Blingo then makes you a new one. **Copy OBS link** carries your key into an OBS Browser Source.
Keys made before this change keep working. It only answers while the page is open; `relay/` is a Cloudflare Worker
that just passes messages to the page (tests: `cd relay && node test.mjs`, Node 18+).

**Deploy order:** deploy the relay Worker (`relay/`) first, then this page. The current live relay only accepts the old
16-64 character keys, so a page minting `XXXXX-XXXXX` keys before the new relay is live would get "key isn't valid".
