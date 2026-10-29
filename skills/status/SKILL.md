---
name: status
description: Show whether Sundown is on, how long until the user's evening cutoff, and their settings. Use when the user asks if Sundown is on, when their cutoff is, or how long they have left today.
allowed-tools: Bash(sundown *)
---

## Current state

!`sundown status`

Tell the user the state above in one or two plain sentences. If no cutoff is set, mention that `/sundown:setup` sets one. Don't add advice.
