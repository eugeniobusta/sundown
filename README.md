# Sundown

**A Claude Code plugin that gives developers back the hours Claude keeps giving them "one more task" to spend.**

For developers using Claude Code who keep working late. Every task is faster now, so you take on more; the breaks go first, then the evenings. Sundown implements the "shutdown command" idea: one command that **saves your open work, writes tomorrow's list, and pauses your agents until morning** — and a daily prompt limit that holds the line even on days nothing else does.

Sundown doesn't help you do more. It helps you stop.

## Install

**Requirements:** Claude Code, Node.js 18+ on your PATH (`node --version`). No `npm install` — zero dependencies.

**Option A — load from a local clone (always works):**

```bash
git clone https://github.com/eugeniobusta/sundown
claude --plugin-dir ./sundown
```

**Option B — Claude Code plugin marketplace:**

```
/plugin marketplace add eugeniobusta/sundown
/plugin install sundown@sundown
```

Either way, Sundown is live immediately with zero-config defaults: **50 prompts/day**, shutdown at **22:30**, wake at **08:00**. Change anything with `/sundown:schedule` (below).

## 60-second walkthrough

```text
# You've been going since 09:00. It's 22:35. You press enter:
you> add a dark-mode toggle to the settings page

☾ Sundown: it's after your 22:30 cutoff. Work resumes at 08:00.
Prompts used today: 47/50.
Recovery: /sundown:override [5m|15m|30m|1h] for one task,
          /sundown:wake to resume now, /sundown:recap to see where you stopped.

# A one-off thing that really can't wait? One command grants a 15-minute pass:
you> /sundown:override
Sundown: override granted for this session for about 15m. Do only what the
next request asks.

# Or just end the day cleanly — this saves a handoff and pauses any agent:
you> /sundown:shutdown
TOMORROW.md is saved. Sundown is on until 08:00. See you tomorrow.
Recap saved to ~/.sundown/recap.md (view with /sundown:recap).

# Next morning Claude Code greets you with yesterday's handoff:
☀ Good morning. Last time you stopped here:
Stopped at: dark-mode toggle (SettingsPage.tsx:142) — the toggle renders
First step tomorrow: wire the toggle to localStorage.setItem('theme', …)
Open question: should the toggle default to system or to dark?
```

## Commands

| Command | What it does |
|---|---|
| `/sundown:shutdown` | End the day now. Pauses any running agent at its next step, prompts it to write `TOMORROW.md` in the project root, and saves a recap of today's git activity. |
| `/sundown:wake` | Stop treating today as "over". Works after your wake time; before it, use `/sundown:override` first. |
| `/sundown:override [5m\|15m\|30m\|1h]` | Grant this session a short pass to send messages even while Sundown is active. Default `15m`. Doesn't reset the daily count or the schedule. |
| `/sundown:recap` | Show the recap from your last shutdown (git log + diff + tomorrow's list). Built from real data on disk, never guesses. |
| `/sundown:schedule shutdown HH:MM \| wake HH:MM \| limit N \| list` | Change the schedule without the interactive setup. `shutdown off` to disable the time-based cutoff; `limit 0` for unlimited. |
| `/sundown:status` | One line: is Sundown active, when does work resume. |
| `/sundown:setup` | Guided first-time setup (optional — defaults work). |
| `/sundown:report` | Weekly stats: evenings worked, latest finish, prompts held back. |

Every command runs the same way from a terminal, with `node <plugin folder>/bin/sundown <command>`.

## What counts as a prompt

Anything you type in Claude Code that would otherwise cost a turn. **Not counted:** `/sundown:*` commands, `override:` messages, messages sent while a pass is active (those still happen, but the counter was already paid once). Tool calls Claude makes on its own don't count — only your typed prompts.

## How enforcement works

- Every real prompt is counted in `~/.sundown/counts/<YYYY-MM-DD>` with a single-line append (atomic for small writes on POSIX, so parallel Claude Code sessions share one counter without corruption).
- The `UserPromptSubmit` hook (`scripts/gate.mjs`) checks three things on every prompt: is a shutdown lock active, is it after your cutoff or before your wake time, is today's count already at the limit. If any is true and no override is active, the prompt is blocked (exit code 2) with the recovery line.
- The `PreToolUse` hook (`scripts/pause.mjs`) handles the "pauses your agents" part: while shut down, every tool call is denied except reading files and writing `TOMORROW.md`. Once `TOMORROW.md` is written, the next tool call stops the agent (`{"continue": false}`).
- The `SessionStart` hook (`scripts/morning.mjs`) clears an expired lock and shows yesterday's handoff.
- All time checks are computed on the fly from the wall clock, never from an in-process timer — so overrides, locks and the wake time survive Claude Code being closed and reopened.

## How it gives time back

- **Zero configuration.** Install and go. Defaults match the brief (50 prompts/day, 22:30 shutdown, 08:00 wake).
- **Quiet.** No notifications, no popups, no nagging. Sundown says nothing unless you crossed a line.
- **Protects evenings.** The three gates — cutoff time, prompt limit, manual shutdown — all converge on the same answer: "that was today's work; the rest is tomorrow's."
- **Protects mornings too.** You open Claude Code and get the one line you need to start. No "where was I?" rummaging.
- **Doesn't add work.** No new file to maintain, no stats to beat, no streak to keep. `TOMORROW.md` is three lines written at shutdown by an agent that already knows the context.

## Privacy

- **Everything stays on your machine** in `~/.sundown/`, owner-only (dir `0700`, files `0600`).
- **Your prompts are never stored.** The gate only pattern-matches commands and the `override:` prefix. The counts file stores one timestamp per prompt, nothing more. The event log stores event type (`blocked`, `override`, `shutdown`, `wake`) and a reason, nothing else.
- **The recap reads only git state** (`git log --oneline`, `git diff --stat`) and your own `TOMORROW.md`. It never reads prompt text, Claude's answers, or file contents into the recap.
- **Phone pushes are off by default.** When you enable them (`/sundown:setup`), the message is generic ("Claude finished after 14 min") unless you opt in to including the project folder name.

## Honest limits

- **It's a commitment device, not a lock.** `/sundown:override`, `/sundown:wake` and uninstalling the plugin all exist. The point is: continuing is a choice you can see in your report, not the default path.
- **Only covers Claude Code.** Other editors and terminals are untouched.
- **A running agent stops at its next tool call.** A single long command that already started (a ten-minute build) runs to the end.
- **One cutoff for every day.** No separate weekend schedule yet.
- **The recap uses `git` to find real work.** In a non-git project it says so plainly, instead of making something up.
- **`pause.mjs` starts Node on every tool call** while a lock is active — adds about 50 ms per tool call. Doesn't run outside shutdown.

## Tests

```
node --test test/*.test.mjs
```

31 tests, no dependencies, clock injected via `SUNDOWN_NOW` and state dir via `SUNDOWN_DIR`. Covers: limit before shutdown time, shutdown time before limit, cross-midnight, next-morning reopen, override active + expired (incl. surviving a close), schedule change during shutdown, concurrent increments from parallel sessions, recap with and without git history, repeated shutdown/wake, prompt text never persisted.

To try the plugin without installing it:

```
claude --plugin-dir .
```

To fake the clock for a live demo:

```
SUNDOWN_NOW=2026-10-30T08:30:00 claude --plugin-dir .
```

## License

MIT
