# Blingo 💎

Relatable bingo for streamers. Drop in a chat name list, hit start — Blingo builds the boards, auto-draws names and numbers, marks squares with diamonds, and crowns winners when lines complete. One HTML file, zero dependencies, GitHub Pages ready.

## How it plays

- Paste names (one per line, or commas — duplicates are dropped)
- Boards are classic 5×5 B-I-N-G-O with a FREE diamond center. Up to 24 names per board; more names deal evenly across extra boards
- Every few seconds a name or number is called with a gem-flip animation; matching squares get a diamond
- When any row, column, or diagonal completes, the line pulses red/blue and the viewer **names** in it become winners (numbers and FREE don't win)
- Draws continue until the winners target (default 5) is hit, then a full-screen winners celebration
- Streamer controls: pause/resume, draw now, new game

## Deep links

Everything can be preloaded in the URL hash:

```
index.html#n=Alice,Bob,Cleo&w=5&s=4        preload the setup form
index.html#n=Alice,Bob,Cleo&w=5&s=4&go=1   skip setup and start immediately
```

`n` = comma-separated names, `w` = winners target, `s` = seconds between draws, `go=1` = autostart. Starting a game writes this link to the address bar, so a running setup can be bookmarked and rerun.

## Retheming

All colors, glows, and fonts live in one commented `THEME` block at the top of the `<style>` tag — edit those custom properties and the whole page follows. Game rules (names per board, number ranges, marker emoji, history length) live in the `CONFIG` object at the top of the `<script>` tag. The three JS entry points are `makeBoards()` (card generation), `drawOne()` (the game loop), and `checkWins()` (line detection).

Fonts load from Google Fonts with system fallbacks, so the page still works fully offline — it just falls back to system type.

## License

MIT. Go make someone's chat sparkle.
