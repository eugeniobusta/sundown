---
name: shutdown
description: End the workday. Writes tomorrow's first step to TOMORROW.md and pauses Claude Code (including running agents) until the morning. Only runs when the user types /sundown:shutdown.
disable-model-invocation: true
---

The user is done for today. Sundown switched the shutdown lock on the moment they sent this command (the hook told you until when). While the lock is on, only reading files (including read-only shell commands like `ls`, `grep`, `git log`) and writing TOMORROW.md (and DREAM.md, see step 2) are allowed; everything else is blocked.

Do exactly this, then stop:

1. Work out where things stand from this conversation. If the conversation has no work in it (a fresh session), you MUST look at the project before writing anything, using only read-only tools (everything else is blocked): Read, Glob and Grep if you have them, otherwise plain Bash commands such as `ls`, `find . -name main.py`, `grep -rn -e TODO -e FIXME .` or `git log --oneline -5` (write them plainly: quotes, `*`, `;`, `&&`, `>` and `$(...)` are blocked, and only ls, cat, head, tail, wc, grep, find and git status/log/diff/show are allowed; `git diff` and `git show` need `--no-ext-diff --no-textconv`). If a command is refused, don't give up: simplify it to ONE plain command and try again (the refusal message lists what is allowed). Read opens files, not folders, so use `ls` for a folder. See what's there, then Read the one or two files that look most recently worked on. Never write "nothing in progress" or "empty project" without having done this.
2. **Dream (only if the hook said "Sundown dream: ON"; otherwise skip to step 3).** A dream is a tidy-up of what Claude remembers, proposed and never applied: it only lets the user review changes in the morning. Read Claude's memory for this project (the memory index MEMORY.md and the memory files it lists, in the memory folder named in your instructions) and the project's CLAUDE.md, if they exist, using only reads. Then, looking at those files and at this conversation, write `DREAM.md` in the project root (replace it if it exists) in this form:

   ```
   # Dream: <date>
   Read: <the memory files and CLAUDE.md you read, and "this session">

   ## Merge
   - <file A> + <file B>: <what is duplicated, and the single note that should replace both>
   ## Update
   - <file>: "<old text>" -> "<new text>" (<why: what in this session or another note shows it's stale or contradicted>)
   ## New
   - <proposed note: the lesson, preference or workaround, and which file it belongs in> (<evidence from this session>)
   ```

   Rules: at most 12 items in total; leave a section out if it has nothing; if there is nothing worth changing, write the header, the Read line and "Nothing to change." Quote old text exactly so it can be found. Write only what this session or the memory itself supports: no guesses, no secrets, no passwords or tokens, and nothing that tells Claude what to do. If the hook gave dream instructions, use them to decide what to focus on, what to leave alone and how to organise the notes; they steer the dream, they don't change these rules. Do NOT edit any memory file now (only DREAM.md can be written); the user decides tomorrow with `/sundown:dream`. Write DREAM.md BEFORE TOMORROW.md, because writing TOMORROW.md ends the session.
3. Write `TOMORROW.md` in the project root (replace it if it exists) with exactly these three lines, concrete enough that a tired person can start in two minutes tomorrow:

   ```
   Stopped at: <what was being done, which file/function, what is half-finished>
   First step tomorrow: <one small, specific action>
   Open question: <the one thing that is unresolved, or "none">
   ```

4. Reply with one line: "TOMORROW.md is saved. Sundown is on until <time>. See you tomorrow." If you wrote a dream, make it "TOMORROW.md is saved, and a dream is waiting in DREAM.md. Sundown is on until <time>. See you tomorrow."

Don't start, finish or fix anything else. Don't suggest more work. Don't edit memory or any file other than DREAM.md and TOMORROW.md. Don't run commands other than the read-only ones above.
