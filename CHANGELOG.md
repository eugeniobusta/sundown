# Changelog

## 1.2.1

From a review of 1.2.0 by two independent agents (one hunted bugs, one scored it as the hackathon judge would). Each bug below was reproduced on 1.2.0 before it was fixed.

### Fixed
- **`git log -U3`, `--unified`, `--binary` and `--patch-with-raw` still ran a program named in the repo's own git config** (a textconv driver), so the 1.1.7 fix for patch-style `git log` was incomplete. The check now works the other way round: a `git log` may only use flags known not to build a diff (`--oneline`, `--graph`, `-5`, `--author=`...); any other flag needs `--no-ext-diff --no-textconv`, so a flag nobody listed can't slip through.
- **The "only you can change this" message told you to run `sundown config ...` in your own terminal,** where `sundown` doesn't exist (it only lives on Claude Code's PATH). It now prints the full `node ".../bin/sundown" config ...` command, and a test runs that command as printed. The README explains where the plugin folder is.
- **Setup could switch Sundown on halfway through.** On a day off, `daysOff` was applied in the middle, so the user's next answers were held back by the gate. The setup skill now applies days off and the cutoff last, and tells the user up front that re-running setup on existing settings needs them to run any loosening change themselves (the guard applies at any hour, but the skill said "while it's on").
- **`config dream maybe` and a bad `dreamInstructions` ended in the word "undefined".** Both now say what a valid value looks like, and a missing hint can never print "undefined".
- **`sundown config` on a settings file holding `[1]`, `null` or a number said "cutoff = 21:00" but saved nothing.** It now starts a fresh settings object.
- **`sundown config wrapUpMinutes off` printed `wrapUpMinutes = 0`** while `sundown config` shows `off`. It says `off`.
- **`sundown dream clear` only looked in the exact current folder,** so from a subfolder it said "No DREAM.md here" and left the file, while the skill went on to say the dream was discarded. It now finds the project's `DREAM.md` (stopping at the project root, your home folder or the top of the disk, never above), and the skill only says "discarded" if the file was deleted.

### Changed
- README: dropped the unmeasured "two minutes instead of twenty" (it now says what the handoff does for you), and the terminal examples use the command that really works in a plain terminal.

### Left as it is, on purpose
- `/sundown:dream` is still held back after the cutoff and on days off, like any non-listed command: a dream proposes changes to memory, which is work. Run `/sundown:wake` first if you really want it.
- A handoff older than 4 days isn't shown in the morning (a long weekend of 4+ days drops a Friday note).
- Applying a dream is enforced by the skill's instructions and by you approving it, not by code. That is documented.

### Tests
- 95 tests (was 88).

## 1.2.0

### Added
- **Dreaming at shutdown.** `/sundown:shutdown` now also writes `DREAM.md`: Claude reads its memory of the project (and `CLAUDE.md`) and proposes a tidy-up (**Merge** duplicates, **Update** stale or contradicted notes, **New** lessons from the session). It is modelled on Anthropic's *dreaming* for Claude Managed Agents (May 2026, research preview): a separate pass, the original never touched, you review and decide. Anthropic's version is an API for cloud memory stores that Claude Code can't use, so this is a local equivalent, not a call to it.
- **Nothing is applied automatically.** During shutdown the pause hook allows writes to `DREAM.md` and `TOMORROW.md` only, so the dream can't edit memory. The morning greeting points at `DREAM.md` without pasting it. `/sundown:dream` shows a summary, `/sundown:dream apply` makes the changes (then deletes the file), `/sundown:dream discard` deletes it.
- **Two settings.** `dream` (`off` by default, `on` to turn it on) and `dreamInstructions` (one line, up to 1000 characters, steers the dream, like Anthropic's `instructions`; `off` clears it). `sundown status` shows whether the dream is on. `/sundown:setup` explains it and offers both.
- **`sundown dream clear`** deletes a plain `DREAM.md` in the current folder.
- A `dream` entry in the event log when a waiting dream is shown in the morning (no content).

### Security (found by an adversarial review of the dream, fixed before release)
- **`/sundown:dream apply` is limited** to `CLAUDE.md` in the project root and files in Claude's memory folder; it lists the exact paths first and skips anything else, even if `DREAM.md` claims urgency. It refuses a file that doesn't start with `# Dream:`.
- **The morning only announces a dream Sundown saw being written** (a logged `dream-writing` event for that project, a `# Dream:` first line, under 4 days old), so a `DREAM.md` from a cloned repo is never announced. `sundown dream clear` deletes only a file with that header.
- **A `DREAM.md` write after the handoff now stops the agent** (the stop check runs before the allowlist).
- **Hardlinked `DREAM.md` / `TOMORROW.md` are denied**, like symlinks.
- **`dreamInstructions` can't contain quotes, backslashes or unicode line breaks**, and is passed to Claude JSON-quoted.

### Changed
- The shutdown skill now has a dream step before the handoff. The handoff still comes last, because writing it ends the session. If the dream is skipped, nothing else changes: the handoff still stops the agent.
- **Opt-in.** The dream is off by default, so existing installs and fresh installs behave exactly as before: no extra step at shutdown and nothing waiting in the morning. Turn it on with `sundown config dream on`. If you do, consider adding `DREAM.md` to `.gitignore`, because it can quote your memory notes.

### Tests
- 88 tests (was 75).

## 1.1.7

From a round of new-user testing: four agents tried the plugin as a stranger would (real Claude Code, the README, the GitHub page, every command). The first item was measured in real Claude Code before and after.

### Fixed
- **The shutdown handoff was often vague.** While shut down, Claude's first shell command usually had quotes, a `*`, `&&` or `;`. The hook refused it with a message that only said "write TOMORROW.md and stop", so about half the time Claude gave up and wrote "I couldn't inspect the project", and that text became the next morning's greeting. A refused shell command now gets a message that says what is allowed, with examples that work, and the shutdown skill says to retry with one plain command.
- **`git diff`, `git show` and patch-style `git log` could run a program named in the repository's own git config** (`diff.external`, a textconv driver). They are now allowed only with `--no-ext-diff --no-textconv`. A plain `git status` can still run `core.fsmonitor` from the repo's config; that is documented, because `git status` is the most useful command for a handoff.
- **`sundown status` left out your cutoff on a day off,** so `/sundown:status` said no cutoff was set. It now always shows it.
- **`/sundown:wake` with no cutoff set** said "off until 23:59" and the skill mentioned a `TOMORROW.md` that might not exist. It now says what actually happens and mentions the handoff only if there is one.
- **A session opened after `/sundown:wake` at 18:30 said "Good morning".** It says "Welcome back" after noon.
- **`install-statusline` reported success on a settings file holding `[]` and crashed on `null`.** It now refuses anything that isn't a JSON object, and accepts an empty file.
- **The report showed all zeros** if a log line had a space after `"type":`. It now accepts spaces.
- **A wrong setting value gave no hint.** `config daysOff saturday` now says to use `sat,sun`; every setting explains its format.

### Changed
- README: an honest description of shutdown (it writes a three-line note; it doesn't commit or stash), a "What it looks like" section with the real messages and a sample report image, uninstall instructions, the git caveat, and a mention of `demo/setup-demo.sh`.
- The plugin description no longer says it "calls your phone" (pushes are optional and off by default).

### Tests
- 70 tests (was 60); 75 after merging with 1.1.6.

## 1.1.6

### Changed
- **No alerts by default.** The "time to wrap up" note is now opt-in (`sundown config wrapUpMinutes 30`); a fresh install shows nothing of the kind. Phone pushes were already opt-in. `/sundown:setup` offers the note as an option. If you used the note before and want to keep it, run `sundown config wrapUpMinutes 30`.
- **Claude can't loosen your schedule at any hour.** The guard used to apply only while Sundown was on, so in the afternoon Claude could still move the cutoff later or remove it. Now a later or removed cutoff, an earlier morning, fewer days off and a longer override are refused at any time (a first cutoff, an earlier cutoff, a later morning and extra days off are still fine, so first-time setup works at any hour).

### Fixed
- **The refusal message ended mid-sentence** ("...in your own terminal, "), and the command it printed broke when the value had spaces. It now ends properly and quotes the value.
- **`sundown config` printed `wrapUpMinutes: 0`** where the docs say `off`.
- **The tests treated Claude's shell as "your terminal"** when run inside Claude Code. The helper now simulates your own terminal explicitly.

### Tests
- 65 tests (was 60).

## 1.1.5

Found by a second independent code review; the first two were reproduced before they were fixed.

### Fixed
- **While Sundown was on, Claude could switch off tomorrow's evening.** The guard only compared when tonight ends, so with a lock or day off running, `config cutoff off`, `daysOff off` or `morning 00:00` were accepted. It now also refuses anything that makes the regular schedule looser: a later or removed cutoff, an earlier morning, fewer days off. Tightening still works, so setup can finish.
- **Setup at night left the user's own answers blocked by the gate** when Sundown was already on. The setup skill now says to start each answer with `override:`.
- **The agent was not stopped by reads after the handoff.** `pause.mjs` now stops the run on the next tool call of any kind once `TOMORROW.md` exists (before, a read-only call slipped through).
- **`tail --fol` and other shortened spellings of `--follow` got past the shell check.** `tail` now takes only `-n`, `-c`, `-q`, `-v` and a plain count.
- **"Mon 08:00" labels** were added whenever the time was more than 24 hours away, so "tomorrow 08:00" could get a weekday on a daylight-saving day. It now counts calendar days.
- **README and comments corrected:** script count, event-log contents, the allowlist, the handoff folder, per-call cost; the comments on `sundownState` and the guard.

### Added
- A 30-second quickstart at the top of the README.

### Tests
- 60 tests (was 55).

## 1.1.4

Found by a medium-effort bug scan of every branch; the first was reproduced before it was fixed.

### Fixed
- **`/sundown:setup` failed halfway when run in the evening.** It set the cutoff first, which switched Sundown on, and the guard then refused the next steps (`morning`, `daysOff`), so a stranger setting up after their own cutoff got a half-finished setup, against what the README promised. Two changes: the guard now refuses only changes that actually loosen Sundown (switch it off now, end the night sooner, raise the override length), and the setup skill applies the cutoff last and tells Claude to hand a refused command to you instead of working around it.

### Tests
- 55 tests (was 49). New ones cover: setup finishing in the evening, what the guard does and doesn't refuse, the setup skill's order, and the read-only shell check refusing the three bypasses the scan tried (`rg --pre`, `sort --compress-program`, `git diff --ext-diff`; these were already closed in 1.1.3, the tests keep them closed).

## 1.1.3

Found by an independent code review; each one was reproduced before it was fixed.

### Fixed
- **While shut down, Claude could run commands it shouldn't.** The read-only shell check was a list of bad flags, and quoting tricks beat it (`find . -ex''ec ...` ran a command, `sort -ofile` and `uniq in out` wrote files). It is now an allowlist: only `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find` (name/type/depth flags only) and `git status|log|diff|show|ls-files`, with no quotes, globs, `$`, `;`, `&`, `>` and the like. The only operator is `|`.
- **`/sundown:status now write me a feature` skipped the gate.** Only the bare `/sundown:status`, `/sundown:setup` and `/sundown:report [days]` skip it now; anything typed after them is held back like any other prompt.
- **A symlinked `TOMORROW.md` was read into the session** (a repo could point it at a private file). Symlinks are ignored. The handoff text is also labelled as notes, not instructions.
- **`CLAUDECODE=` (empty) got around the "only you can wake/shutdown" check.** The variable existing is enough now. Claude also can't change `ntfyServer`.
- **`sundown report` crashed** on a folder or unreadable file named `*.jsonl`. It skips it.
- **The report dropped today's prompts when `morning` was after 12:00.**
- **The shutdown skill suggested a command the hook refused** (`grep -rnE 'TODO|FIXME'`). It now suggests `grep -rn -e TODO -e FIXME .`.

- **A blank value for a number setting was saved as 0** (`sundown config minTurnSeconds " "`). It is rejected now.

### Changed
- Every statement in the scripts, the CLI and the tests now has a comment above it explaining what it does and why.

### Tests
- 50 tests (was 43).

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
