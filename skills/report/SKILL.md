---
name: report
description: Show the user's evening report - how many evenings they kept working, how late, and how often Sundown held a prompt back - built locally from Claude Code's session timestamps. Use when the user asks where their evenings went or how late they've been working.
allowed-tools: Bash(sundown *)
---

## Last 7 days

!`sundown report 7`

Summarise this for the user in at most four short lines:
- how many evenings they kept working and their typical finish, compared with the period before when the report shows it,
- one pattern you can actually see in the table (for example, which day ran latest), only if there is one,
- how many messages Sundown held back and how many they overrode.

State the numbers, don't moralise, and don't invent causes. End with the path of the full HTML report. If the user asked for a different number of days, run `sundown report <days>` (1 to 90) and summarise that instead.
