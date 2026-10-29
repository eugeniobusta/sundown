---
name: override
description: Grant this Claude Code session a short pass to send messages even when Sundown is active. Only runs when the user types /sundown:override [5m|15m|30m|1h]. Default is 15 minutes if no duration is given.
disable-model-invocation: true
---

Sundown's hook already granted the pass when the user sent this command, and told you how long it lasts (default 15 minutes).

Reply with one short line, for example: "Override granted for 15 minutes. One task, then back to the plan." Do nothing else — don't start new work, don't suggest more.
