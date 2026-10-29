# Changelog

## 1.1.2

Fixes for problems found by six test agents that exercised every feature, including a run in real Claude Code.

### Fixed
- **A stopped agent still ran the tool call that triggered the stop.** `pause.mjs` now denies that call as well as stopping the run (checked in real Claude Code: the command no longer executes).
- **`install-statusline` could overwrite someone else's status line** if its command merely contained the word "sundown". It now only recognises its own command.
- **Claude could loosen Sundown from its shell.** While Sundown is on, `config cutoff|morning|daysOff|overrideMinutes` refuse to run inside Claude's shell, like `wake` and `shutdown`. The README no longer overstates this.
- **`sundown config <key>` with no value silently cleared the setting.** It now asks for a value; use `off` to clear. A bad number shows what you typed instead of `NaN`.
- **Shutdown on a day off said "back 08:00"** while the next day was also off. Shutdown now lasts to the next working morning and says so ("Mon 08:00").
- **Loose permissions:** an existing `~/.sundown` or `config.json` with open permissions is tightened to owner-only.
- **"Typical finish" is now the median**, so one very late night doesn't skew it.
- **A non-text `cwd`** in hook input no longer lets a blocked prompt through.
- **The handoff can be written with `MultiEdit`**, and a `TOMORROW.md` that is a symlink is not written through.
- **First-run nudge no longer hides the shutdown reminder** when both apply.
- Smaller: `install-statusline` only mentions a backup when it made one; `sundown wake` says so when Sundown wasn't on; an unknown command exits 1; a short ntfy topic gets a warning; `sundown config` shows `off`/`none` instead of empty text.

### Tests
- 43 tests (was 30): one or more for every fix above.

## 1.1.1

### Fixed
- **The shutdown handoff was blank on current Claude Code.** Newer versions have no Glob/Grep tool and search files through Bash, which Sundown blocked during shutdown, so Claude couldn't see the project and wrote "nothing in progress". Plain read-only commands (`ls`, `grep`, `find`, `git log`...) are now allowed; anything that chains, redirects, deletes or writes is still blocked.
- **The status line ignored `wrapUpMinutes`** and always switched to "time to wrap up" at 30 minutes.

## 1.1.0

### Added
- **Days off.** `sundown config daysOff sat,sun` keeps whole days quiet, from that morning to the next. A Friday evening says "until Mon 08:00". `/sundown:setup` asks about it.
- **Wrap-up note.** Once a day, `wrapUpMinutes` (default 30) before your cutoff, you see a short note saying it's a good moment to land the task. Claude is told to prefer a clean stopping point. `sundown config wrapUpMinutes off` turns it off.
- **First-run nudge.** A fresh install says once: run `/sundown:setup`.
- **Report trends.** The report now shows evenings off and your typical finish time, both compared with the period before. It also shows days off kept and how many mornings started from `TOMORROW.md`.
- **CI.** GitHub Actions runs the tests on Linux and macOS with Node 18, 20 and 22. The README shows the badge.
- **README.** New sections cover the problem (compression burnout), who Sundown is for, a one-minute walkthrough using `SUNDOWN_NOW`, and a table of every setting.

### Fixed
- **Claude could switch Sundown off.** `sundown wake` and `sundown shutdown` now refuse to run inside Claude's own shell (`CLAUDECODE=1`). Only you can wake or shut down.
- **The report miscounted evenings when the cutoff was after midnight** (e.g. 01:00). It now uses the same rule as the gate.
- **Re-running `install-statusline` overwrote the backup** of your original `settings.json`. The backup is now kept.
- **During shutdown, any file named `TOMORROW.md` could be written.** Now only the project's own handoff can be.
- **`sundown` didn't start on Node 18.** `bin/sundown` has no file extension, and `package.json` didn't say it's an ES module, so only Node 20+ guessed right. `package.json` now declares `"type": "module"`. CI covers Node 18, 20 and 22 so this can't come back.
- **With a faked clock (`SUNDOWN_NOW`), the agent wasn't stopped after writing its handoff.** The lock now also records the real time.

### Tests
- 28 tests (was 18), covering every change above.
