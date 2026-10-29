---
name: shutdown
description: End the workday. Writes tomorrow's first step to TOMORROW.md and pauses Claude Code (including running agents) until the morning. Only runs when the user types /sundown:shutdown.
disable-model-invocation: true
---

The user is done for today. Sundown switched the shutdown lock on the moment they sent this command (the hook told you until when). While the lock is on, only reading files and writing TOMORROW.md are allowed; every other tool is blocked.

Do exactly this, then stop:

1. Work out where things stand from this conversation. If the conversation has nothing to go on (a fresh session), take a quick look at the project with Read, Glob or Grep: TODO/FIXME comments and the files that look most recently worked on. Keep it to a few reads.
2. Write `TOMORROW.md` in the project root (replace it if it exists) with exactly these three lines, concrete enough that a tired person can start in two minutes tomorrow:

   ```
   Stopped at: <what was being done, which file/function, what is half-finished>
   First step tomorrow: <one small, specific action>
   Open question: <the one thing that is unresolved, or "none">
   ```

3. Reply with one line: "TOMORROW.md is saved. Sundown is on until <time>. See you tomorrow." The hook already saved a recap (git log + diff + TOMORROW.md) to `~/.sundown/recap.md`; the user can view it with `/sundown:recap`.

Don't start, finish or fix anything else. Don't suggest more work. Don't run commands.
