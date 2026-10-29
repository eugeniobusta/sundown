---
name: schedule
description: Change Sundown's schedule without the interactive setup - set the shutdown time, wake time or daily prompt limit directly. Only runs when the user types /sundown:schedule.
disable-model-invocation: true
---

Sundown's hook already applied the change when the user sent this command, and printed the new state. Repeat it back in one short line, for example: "Shutdown now at 22:30. Daily limit stays at 50."

Usage reminders if the user asks:

- `/sundown:schedule shutdown HH:MM` or `shutdown off`
- `/sundown:schedule wake HH:MM`
- `/sundown:schedule limit N` (0 = unlimited)
- `/sundown:schedule list` to see everything

Do nothing else.
