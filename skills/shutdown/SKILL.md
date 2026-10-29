---
name: shutdown
description: End the workday. Writes tomorrow's first step to TOMORROW.md and pauses Claude Code (including running agents) until the morning. Only runs when the user types /sundown:shutdown.
disable-model-invocation: true
---

The user is done for today. Sundown switched the shutdown lock on the moment they sent this command (the hook told you until when). While the lock is on, only reading files (including read-only shell commands like `ls`, `grep`, `git log`) and writing TOMORROW.md are allowed; everything else is blocked.

Do exactly this, then stop:

1. Work out where things stand from this conversation. If the conversation has no work in it (a fresh session), you MUST look at the project before writing anything, using only read-only tools (everything else is blocked): Read, Glob and Grep if you have them, otherwise plain Bash commands such as `ls`, `find . -name '*.py'`, `grep -rnE 'TODO|FIXME' .` or `git log --oneline -5` (no `;`, `&&`, `>` or `$(...)`: those are blocked). See what's there, then Read the one or two files that look most recently worked on. Never write "nothing in progress" or "empty project" without having done this.
2. Write `TOMORROW.md` in the project root (replace it if it exists) with exactly these three lines, concrete enough that a tired person can start in two minutes tomorrow:

   ```
   Stopped at: <what was being done, which file/function, what is half-finished>
   First step tomorrow: <one small, specific action>
   Open question: <the one thing that is unresolved, or "none">
   ```

3. Reply with one line: "TOMORROW.md is saved. Sundown is on until <time>. See you tomorrow."

Don't start, finish or fix anything else. Don't suggest more work. Don't run commands other than the read-only ones above.
