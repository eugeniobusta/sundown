# Sundown

**A Claude Code plugin that gives your evenings back.**

AI coding tools made each task faster, and the day got longer anyway: there is always one more prompt, and an agent is always still running. Sundown builds the end of the day into Claude Code:

- **After your cutoff, new prompts are held back.** You can still send one with `override:`, and every override shows up in your report.
- **`/sundown:shutdown` ends the day.** Any agent still running is paused at its next step and writes a three-line handoff to `TOMORROW.md`.
- **The next morning,** your first session opens with that handoff, so you start in two minutes instead of twenty.
- **Your phone can call you back** (optional). You get a push when Claude needs you or finishes a long task, so you can leave the desk instead of watching the terminal.
- **`/sundown:report`** shows where your evenings went, built locally from Claude Code's session timestamps.

Sundown doesn't help you do more. It helps you stop.

## Install

```
/plugin marketplace add eugeniobusta/sundown
/plugin install sundown@sundown
```

Then run `/sundown:setup`. Until you choose a cutoff, Sundown never blocks anything; only `/sundown:shutdown` does.

Requirements: Claude Code with plugin support, and Node.js 18 or newer on your PATH (check with `node --version`; the native Claude Code installer does not include it). Nothing to `npm install`: Sundown has no dependencies.

## Commands

| Command | What it does |
|---|---|
| `/sundown:setup` | Choose your cutoff and morning time, connect your phone (optional), add the countdown to the status line (optional). |
| `/sundown:shutdown` | End the day now. Writes `TOMORROW.md` and pauses Claude Code until your morning time. |
| `/sundown:wake` | Switch Sundown off until your next cutoff (working early, or a mistake). |
| `/sundown:status` | Is Sundown on, and how long until your cutoff? |
| `/sundown:report` | Your last 7 days: evenings worked, latest finish, prompts held back, overrides. Also writes `~/.sundown/report.html`. |
| `override: <message>` | Send one message anyway. That session keeps working for 20 minutes (configurable). |

The same things work from a terminal: `node <plugin folder>/bin/sundown status | shutdown | wake | config | report | test-push`.

## How it works

Sundown is five small Node scripts attached to Claude Code hooks:

| Hook | Script | Job |
|---|---|---|
| `UserPromptSubmit` | `scripts/gate.mjs` | Holds back prompts after the cutoff or during shutdown; handles `override:`, `/sundown:shutdown` and `/sundown:wake`. |
| `PreToolUse` | `scripts/pause.mjs` | During shutdown only: denies every tool call except reading files and writing `TOMORROW.md`, then stops the agent once the handoff exists. |
| `SessionStart` | `scripts/morning.mjs` | Shows yesterday's `TOMORROW.md` to you and to Claude; clears the lock when morning comes. |
| `Notification`, `Stop` | `scripts/push.mjs` | Phone pushes, only if you set a topic. |

`scripts/lib.mjs` holds the shared logic (settings, time, lock, state files), `scripts/report.mjs` builds the report, and `bin/sundown` is the command-line tool the skills call.

Shutdown and wake are handled by the hook that only runs on messages a person typed, so Claude can't shut itself down or wake itself up.

## Privacy

- **Everything stays on your machine** in `~/.sundown/`, with owner-only permissions (folder 0700, files 0600).
- **Your prompts are never stored.** The gate only checks whether a message starts with `override:` or `/sundown:`. The event log records the time and type of each event (blocked, override, shutdown, pause, push) and nothing else.
- **The report reads only timestamps** from Claude Code's session logs. It never reads prompt text, answers or code into the report.
- **Phone pushes are off by default.** When you turn them on, the message says "Claude finished after 14 min" and nothing about your project. You can choose to include the project folder name (`sundown config pushDetail folder`). Code, prompts and file contents are never sent.
- **The only network call** is the push to ntfy.sh (or your own ntfy server: `sundown config ntfyServer https://your.server`).

## Security notes

- Hooks **fail open**: if a script hits an unexpected error, it lets Claude Code carry on. A bug in Sundown can't lock you out.
- **No shell is ever spawned.** Session ids are checked against `^[A-Za-z0-9_-]{1,128}$` before they're used in a file name, so a strange id can't write outside `~/.sundown`.
- **Every setting is validated**, both when you set it and when it's read, so a typo in `config.json` falls back to the default instead of breaking a hook.
- The **ntfy topic works like a password**: anyone who knows it can read and send your pushes. `sundown config ntfyTopic generate` makes a random 96-bit one. Don't share it or commit it.
- `install-statusline` edits `~/.claude/settings.json`. It keeps a backup, keeps every other setting, and refuses to replace a status line that isn't Sundown's unless you pass `--force`.
- The skills that run commands are limited to `Bash(sundown *)`.

## Limits (be honest about them)

- **It's a commitment device, not a lock.** You can always type `override:`, run `/sundown:wake` or disable the plugin. The point is that stopping becomes the default and continuing becomes a choice you can see in your report.
- **It only covers Claude Code.** Other editors and terminals are untouched.
- **A running agent stops at its next tool call.** A single long command that has already started (a ten-minute build) runs to the end.
- **One cutoff for every day.** No separate weekend schedule yet.
- **The report counts prompts, not hours.** It's a picture of when you were working, not a timesheet.
- `pause.mjs` starts Node on every tool call, which adds roughly 50 ms per call.
- The status line points at the installed copy of the plugin. Run `sundown install-statusline` again after updating Sundown.

## Development

```
node --test test/*.test.mjs        # 18 tests, no dependencies
claude --plugin-dir .              # try the plugin without installing it
claude plugin validate --strict .
```

`SUNDOWN_DIR` moves the state folder and `SUNDOWN_NOW` fakes the current time (both used by the tests and handy for demos):

```
SUNDOWN_NOW=2026-10-30T08:30:00 claude --plugin-dir .
```

## License

MIT
