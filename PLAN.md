# PLAN — Sundown brief alignment

## What the existing v1.0.0 already does well
- `~/.sundown/` state with owner-only perms, injectable via `SUNDOWN_DIR`
- Injectable clock via `SUNDOWN_NOW` → every time check derived on-the-fly
- `UserPromptSubmit` hook that blocks after cutoff + handles state-changing commands directly (model can't shut itself down)
- `/sundown:shutdown` writes the lock; `scripts/pause.mjs` (PreToolUse) stops running agents while allowing them to write `TOMORROW.md`
- `SessionStart` hook greets with yesterday's handoff and clears expired lock
- Quiet-hour math handles cross-midnight correctly
- Fail-open everywhere (hook bugs can never lock a user out)
- 18 passing tests, no runtime dependencies

## Gaps against the brief
1. **No daily prompt limit.** Brief defaults to 50/day. Must be enforced across concurrent sessions.
2. **No `/sundown:recap`.** Current `/sundown:report` is a 7-day stats page; brief wants a per-shutdown recap built from `git log` + `git diff --stat` + `TOMORROW.md`.
3. **`/sundown:override` is a prefix (`override:`), not a slash command.** Brief wants `/sundown:override [5m|15m|30m|1h]` with default 15m.
4. **No `/sundown:schedule`.** Brief wants `/sundown:schedule shutdown HH:MM | wake HH:MM | limit N | list`.
5. README needs a rewrite framed around compression burnout, honest limits, and the brief's commands.

## Changes (in priority order)
1. Add `dailyLimit: 50` to `DEFAULTS`. Count real user prompts in `~/.sundown/counts/<YYYY-MM-DD>` (append-only, atomic for small writes → safe across parallel sessions). Gate blocks when today's count ≥ limit; passes/overrides and `/sundown:*` bypass as today.
2. Add `/sundown:recap`. On shutdown, `scripts/recap.mjs` captures `git log --oneline --since` + `git diff --stat` from the project dir and stores it at `~/.sundown/recap.md`. `/sundown:recap` prints it; "no history" case says so plainly.
3. Add `/sundown:override [5m|15m|30m|1h]` to `gate.mjs`. Validate argument, default 15m. Grants a pass of that duration without touching schedule or count.
4. Add `/sundown:schedule <sub> [args]` → wraps `setConfig` for cutoff/morning/dailyLimit, prints a one-line confirmation and current list.
5. Tests: limit before shutdown, shutdown before limit, cross-midnight, next-morning reopen, override active + expired (incl. survived close), schedule change during shutdown, concurrent increments, recap-with-no-history, repeated shutdown/wake.
6. README rewrite + commit.

## Time budget (~2h total; started ~18:21 UTC)
- 18:30 — plan done, start building
- 19:30 — all features in, tests passing
- 19:45 — README done, final commit
- 20:00 — buffer / push / smoke-test
