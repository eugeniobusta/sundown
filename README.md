# Sundown

[![test](https://github.com/eugeniobusta/sundown/actions/workflows/test.yml/badge.svg)](https://github.com/eugeniobusta/sundown/actions/workflows/test.yml)

**A Claude Code plugin that gives your evenings back.**

## The problem: compression burnout

AI coding tools made each task faster, and the day got longer anyway. The time AI saves doesn't come back to you; it gets filled with more work. There is always one more prompt, and an agent is always still running, so the evening quietly becomes part of the workday. That's **compression burnout**: the same pressure, packed into more hours.

**Who it's for:** developers who use Claude Code every day and keep finding themselves at the terminal at 22:00, "just finishing one thing."

**What it is:** the *shutdown command* (one command that saves your open work, writes tomorrow's list and pauses your agents until morning), plus the rest of the evening built around it, and a report that shows whether the time went back to you.

## What it does

Sundown builds the end of the day into Claude Code:

- **After your cutoff, new prompts are held back.** You can still send one with `override:`, and every override shows up in your report.
- **`/sundown:shutdown` ends the day.** Any agent still running is paused at its next step and writes a three-line handoff to `TOMORROW.md`.
- **Half an hour before your cutoff,** one short note says it's a good moment to land the task. Claude is told the same thing, so it doesn't start anything big. Once a day, never more.
- **Days off stay off** (optional). Choose days such as `sat,sun` and Sundown keeps them quiet from morning to morning.
- **The next morning,** your first session opens with that handoff, so you start in two minutes instead of twenty.
- **You can leave the desk while an agent runs** (optional). Instead of watching the terminal, you get one phone push when Claude needs you or finishes a long task. It's off by default, and short turns never send anything.
- **`/sundown:report`** shows whether your evenings are coming back: evenings off, your typical finish time, both compared with the week before, and how many mornings started from a handoff. Built locally from Claude Code's session timestamps.

It adds no work to your day: nothing to fill in, and nothing to check. It stays out of the way until the evening, then makes stopping the default.

Sundown doesn't help you do more. It helps you stop.

## Install

```
/plugin marketplace add eugeniobusta/sundown
/plugin install sundown@sundown
```

Restart Claude Code (or run `/reload-plugins`), then run `/sundown:setup`. Your first session after installing reminds you. Until you choose a cutoff, Sundown never blocks anything; only `/sundown:shutdown` does.

Requirements: Claude Code with plugin support, and Node.js 18 or newer on your PATH (check with `node --version`; the native Claude Code installer does not include it). Nothing to `npm install`: Sundown has no dependencies.

## Try it in a minute (no need to wait for the evening)

`SUNDOWN_NOW` fakes the clock and `SUNDOWN_DIR` uses a throwaway settings folder, so this doesn't touch your real setup. After installing, in a terminal inside any project:

```
export SUNDOWN_DIR="$(mktemp -d)"
echo '{"cutoff":"21:00","morning":"08:00"}' > "$SUNDOWN_DIR/config.json"
SUNDOWN_NOW=2026-10-29T22:00:00 claude
```

1. Type `hello`. It's held back: *"☾ Sundown: it's after your 21:00 cutoff…"*
2. Type `override: say hi`. It goes through, and is counted in the report.
3. Type `/sundown:shutdown`. Claude writes `TOMORROW.md` (three lines) and stops. Exit Claude Code.
4. "Next morning": `SUNDOWN_NOW=2026-10-30T08:30:00 claude`. The session opens with *"☀ Good morning. Last time you stopped here: …"*
5. Run `/sundown:report` to see the override and the held-back message.

To see the wrap-up note instead, start at `SUNDOWN_NOW=2026-10-29T20:40:00` and send any message.

## Commands

| Command | What it does |
|---|---|
| `/sundown:setup` | Choose your cutoff, morning time and days off, connect your phone (optional), add the countdown to the status line (optional). |
| `/sundown:shutdown` | End the day now. Writes `TOMORROW.md` and pauses Claude Code until your morning time. |
| `/sundown:wake` | Switch Sundown off until your next cutoff (working early, or a mistake). |
| `/sundown:status` | Is Sundown on, and how long until your cutoff? |
| `/sundown:report` | Your last 7 days: evenings worked, typical and latest finish (compared with the week before), days off kept, mornings started from a handoff, prompts held back, overrides. Also writes `~/.sundown/report.html`. |
| `override: <message>` | Send one message anyway. That session keeps working for 20 minutes (configurable). |

The same things work from a terminal: `node <plugin folder>/bin/sundown status | shutdown | wake | config | report | test-push`.

Settings (`sundown config <key> <value>`, or ask `/sundown:setup`):

| Setting | Default | Meaning |
|---|---|---|
| `cutoff` | off | When your evening starts, e.g. `21:00`. `off` = only `/sundown:shutdown` ends the day. |
| `morning` | `08:00` | When the day starts again. |
| `daysOff` | none | Whole days kept quiet, e.g. `sat,sun`. `off` = none. |
| `wrapUpMinutes` | `30` | The one "time to wrap up" note, this long before the cutoff. `off` = no note. |
| `overrideMinutes` | `20` | How long one `override:` lets that session keep working. |
| `ntfyTopic` | off | Phone pushes. `generate` makes a private topic. |
| `pushDetail` | `none` | `folder` adds the project folder name to pushes. |
| `minTurnSeconds` | `60` | Only push "Claude finished" after turns at least this long. |
| `ntfyServer` | `https://ntfy.sh` | Your own ntfy server, if you have one. |

## How it works

Sundown is five small Node scripts attached to Claude Code hooks:

| Hook | Script | Job |
|---|---|---|
| `UserPromptSubmit` | `scripts/gate.mjs` | Holds back prompts after the cutoff, on a day off or during shutdown; handles `override:`, `/sundown:shutdown` and `/sundown:wake`; shows the once-a-day wrap-up note. |
| `PreToolUse` | `scripts/pause.mjs` | During shutdown only: denies every tool call except reading files and writing the project's `TOMORROW.md`, then stops the agent once the handoff exists. |
| `SessionStart` | `scripts/morning.mjs` | Shows yesterday's `TOMORROW.md` to you and to Claude; clears the lock when morning comes; points a fresh install at `/sundown:setup` once. |
| `Notification`, `Stop` | `scripts/push.mjs` | Phone pushes, only if you set a topic. |

`scripts/lib.mjs` holds the shared logic (settings, time, lock, state files), `scripts/report.mjs` builds the report, and `bin/sundown` is the command-line tool the skills call.

Shutdown and wake are handled by the hook that only runs on messages a person typed. The command-line `sundown wake` and `sundown shutdown` refuse to run inside Claude's own shell (Claude Code marks it with `CLAUDECODE=1`), so Claude can't switch Sundown off to keep working.

## Privacy

- **Everything stays on your machine** in `~/.sundown/`, with owner-only permissions (folder 0700, files 0600).
- **Your prompts are never stored.** The gate only checks whether a message starts with `override:` or `/sundown:`. The event log records the time and type of each event (blocked, override, shutdown, pause, push, wrap-up, handoff shown) and nothing else.
- **The report reads only timestamps** from Claude Code's session logs. It never reads prompt text, answers or code into the report.
- **Phone pushes are off by default.** When you turn them on, the message says "Claude finished after 14 min" and nothing about your project. You can choose to include the project folder name (`sundown config pushDetail folder`). Code, prompts and file contents are never sent.
- **The only network call** is the push to ntfy.sh (or your own ntfy server: `sundown config ntfyServer https://your.server`).

## Security notes

- Hooks **fail open**: if a script hits an unexpected error, it lets Claude Code carry on. A bug in Sundown can't lock you out.
- **No shell is ever spawned.** Session ids are checked against `^[A-Za-z0-9_-]{1,128}$` before they're used in a file name, so a strange id can't write outside `~/.sundown`.
- **Every setting is validated**, both when you set it and when it's read, so a typo in `config.json` falls back to the default instead of breaking a hook.
- The **ntfy topic works like a password**: anyone who knows it can read and send your pushes. `sundown config ntfyTopic generate` makes a random 96-bit one. Don't share it or commit it.
- `install-statusline` edits `~/.claude/settings.json`. It keeps a backup of your original (running it again doesn't overwrite that backup), keeps every other setting, and refuses to replace a status line that isn't Sundown's unless you pass `--force`.
- The skills that run commands are limited to `Bash(sundown *)`.

## Limits (be honest about them)

- **It's a commitment device, not a lock.** You can always type `override:`, run `/sundown:wake` or disable the plugin. The point is that stopping becomes the default and continuing becomes a choice you can see in your report.
- **It only covers Claude Code.** Other editors and terminals are untouched.
- **A running agent stops at its next tool call.** A single long command that has already started (a ten-minute build) runs to the end.
- **One cutoff for every working day.** Days off can be whole days, but there's no separate cutoff per weekday yet.
- **Claude can't switch Sundown off, but it isn't sandboxed.** The `CLAUDECODE` check stops it running `sundown wake`; something deliberately written to get around that could. It's a commitment device for you, not a security boundary against Claude.
- **The report counts prompts, not hours.** It's a picture of when you were working, not a timesheet.
- `pause.mjs` starts Node on every tool call, which adds roughly 50 ms per call.
- The status line points at the installed copy of the plugin. Run `sundown install-statusline` again after updating Sundown.

## Development

```
node --test test/*.test.mjs        # 28 tests, no dependencies (also run by CI on Linux and macOS, Node 18/20/22)
claude --plugin-dir .              # try the plugin without installing it
claude plugin validate --strict .
```

`SUNDOWN_DIR` moves the state folder and `SUNDOWN_NOW` fakes the current time (both used by the tests and handy for demos):

```
SUNDOWN_NOW=2026-10-30T08:30:00 claude --plugin-dir .
```

## License

MIT
