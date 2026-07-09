# Blingo — Guaranteed Single Winning Line

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan

## Problem

Blingo ends the game on the first completed line, but a single draw can
complete more than one line at once. A newly marked square sits on one row,
one column, and at most one diagonal, so up to **three** lines can finish on the
same call on a single board — and with multiple boards, different boards can
finish lines on the same called value too.

Today `checkWins()` iterates lines in a fixed order (rows, then columns, then
the two diagonals) and honors the *first* complete line it finds, silently
skipping any others that finished on the same draw. That produces the observed
bug: a fully-marked diagonal is ignored because a column earlier in the list
"won" on the same call. The choice of winning line is therefore arbitrary and
unexplained to viewers.

## Goal

Every game resolves to **exactly one winning line**, chosen fairly (winners are
still effectively random — no player is favored). The rare case where a single
line is genuinely impossible must never hang the game.

## Non-Goals

- No runoff / playoff sub-game, no forced N-winner target, no per-board
  highlight colors, no changes to the B/I/N/G/O call format. These were
  explored and cut.
- No change to the winner **modes** (`first`, `last`, `both`, `line`) or to the
  visual game, animations, timing, history strip, or deep links.

## Approach: Pre-compute and reroll

Because Blingo generates the boards and the draw order itself, the entire game
can be simulated in memory — instantly, before anything is shown — and any
outcome that would produce a tie is discarded and re-rolled. This is rejection
sampling: we keep a *random* outcome drawn from the set of outcomes whose first
completed draw finishes exactly one line, which preserves fairness.

### Flow

1. On **Start**, instead of dealing boards and drawing live, call
   `planGame(names)`.
2. `planGame` repeatedly:
   - Deals boards and shuffles a draw order (the existing deal + shuffle logic).
   - Simulates the full draw order headlessly, marking cells in a plain data
     model (no DOM), and finds the **first draw index** at which one or more
     lines complete across all boards.
   - Counts the lines completing on that draw. If exactly **one**, accept and
     return the plan. Otherwise reroll.
3. The accepted plan is installed as the game's fixed boards and fixed draw
   order, then **played back** through the existing timer loop with all normal
   animation, timing, history, and winner-mode logic.

### Plan object

`planGame` returns:

- `boards` — the accepted board layout.
- `order` — the full ordered list of calls (names and numbers) to play back.
- `winDraw` — index into `order` of the winning draw.
- `winLine` — `{ boardIndex, lineIndex }` identifying the single winning line.
- `forced` — `false` normally; `true` if the fallback fired (see below).

### Playback changes

- `drawOne()` consumes `order[i++]` instead of popping a random `pool` entry.
  Marking, gem animation, history, and the call display are unchanged.
- `checkWins()` no longer scans for "the first line in list order." On the
  winning draw it honors **only** `winLine`, so playback matches the simulation
  exactly and no coincidental extra line is highlighted. Winner names come from
  that one line via the existing mode logic.

### Fairness

Every reroll is an independent fresh deal + shuffle. Discarding tie outcomes and
keeping a random survivor yields a uniform distribution over single-line
outcomes — no player, square, or line is weighted. Winners remain random.

### Fallback (safety net, effectively never fires)

With many boards sharing called numbers, a single-line outcome can be
theoretically impossible. So `planGame` caps rerolls at `PLAN_ATTEMPTS`
(e.g. 2000 — each attempt is sub-millisecond in-memory work). If no single-line
outcome is found within the cap, it accepts the best attempt, sets
`forced: true`, and picks **one** winning line at random among the tied lines on
that draw. This guarantees the game always resolves and never hangs. Expected
usage is 50–100 entries (≈3–5 boards), where a clean outcome is found in the
first few attempts.

## Components

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `dealBoards(names)` | Existing board generation, factored to return data (no DOM). | `CONFIG`, `shuffle` |
| `buildPool(names, boards)` | Existing pool construction, factored to return data. | `shuffle` |
| `simulate(boards, order)` | Pure: replay `order`, return `{ winDraw, tiedLines }` for the first completing draw. No DOM. | `LINES` |
| `planGame(names)` | Reroll loop over deal + shuffle + `simulate`; returns the plan. | above |
| `begin(names)` | Install plan, render boards, start playback timer. | `planGame` |
| `drawOne()` | Play back `order[i++]`; mark, animate, render. | plan |
| `checkWins()` | Honor `winLine` on `winDraw`; end game, select winners by mode. | plan |

The pure `simulate` and the DOM `drawOne`/`checkWins` must share one definition
of "a line is complete" (the `LINES` table and a marked check) so simulation and
playback can never disagree.

## Testing

- **Unit (headless `simulate`):** feed crafted board + order fixtures where a
  known draw completes 1, 2, and 3 lines; assert `tiedLines` count and
  `winDraw`.
- **`planGame`:** with a fixture forced to tie, assert it rerolls and returns a
  single-line plan; with an impossible fixture and a tiny attempt cap, assert
  `forced: true` and exactly one `winLine`.
- **Fairness smoke:** over many `planGame` runs on the same name list, confirm
  winners vary and aren't skewed to a fixed player/line.
- **Playback parity:** assert the line highlighted and winners produced during
  playback match the plan's `winLine` and mode selection.
- **Regression:** existing modes, deep-link autostart, history recall, and
  New game reset still work.

## Rollout

Single self-contained `index.html`. No new dependencies. Ship, then confirm the
Pages deploy is green.
