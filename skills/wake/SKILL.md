---
name: wake
description: Switch Sundown off early (working early, or the lock was a mistake). Only runs when the user types /sundown:wake.
disable-model-invocation: true
---

Sundown's hook already switched the lock off when the user sent this command, and told you until when quiet hours are ignored.

Reply with one short line, for example: "Sundown is off until 21:00." Mention `TOMORROW.md` ("Your last handoff is in TOMORROW.md if you want it") only if you know the project has one. If the hook says Sundown is off for the rest of today (no cutoff is set), say that instead of naming a time. Do nothing else.
