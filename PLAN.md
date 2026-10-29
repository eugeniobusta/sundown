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

## Status: ALL COMPLETE ✓

All gaps closed. 31 tests passing, zero dependencies, clean README.

## What was built (in order)
1. **Daily prompt limit** — `dailyLimit: 50` default; atomic per-workday count files in `~/.sundown/counts/<YYYY-MM-DD>` (concurrent-safe via POSIX O_APPEND). Gate blocks when count ≥ limit.
2. **`/sundown:recap`** — `scripts/recap.mjs` builds a markdown recap from `git log --oneline --since` + `git diff --stat` + `TOMORROW.md`. Saved at `~/.sundown/recap.md` on every `/sundown:shutdown`. `/sundown:recap` skill reads it back. "No git repo" and "no history" cases say so plainly.
3. **`/sundown:override [5m|15m|30m|1h]`** — recognized in `gate.mjs`. Defaults to 15m. Grants a session-scoped, timestamp-based pass that survives close/reopen. Does not reset count or schedule.
4. **`/sundown:schedule shutdown HH:MM | wake HH:MM | limit N | list`** — handled in `gate.mjs` (deterministic script, not model reasoning). Works even during a shutdown lock.
5. **Tests** — 31 tests: limit before shutdown, shutdown before limit, cross-midnight, next-morning reopen, override active + expired (incl. survived close/reopen), schedule change during shutdown, concurrent increments from 4 sessions, recap with no git history, recap with real git repo, repeated shutdown/wake. All pass with `node --test test/sundown.test.mjs`.
6. **README** — framed around compression burnout, who it's for, 2-command install, 60-second walkthrough, what counts as a prompt, how enforcement works, honest limits, how to run tests.

## Fixes applied post-brief-alignment
- `gate.mjs`: added `prompt_text` fallback (Claude Code hook field) alongside legacy `prompt`
- `morning.mjs`: updated recovery hint from `"override:"` to `/sundown:override`
- `bin/sundown statusline`: added `"limit"` branch (was silently falling through to cutoff display)
