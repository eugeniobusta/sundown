# Changelog

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

- **The status line ignored `wrapUpMinutes`** and always switched to "time to wrap up" at 30 minutes. It now uses your setting (and never does when it's off).

### Tests
- 29 tests (was 18), covering every change above.
