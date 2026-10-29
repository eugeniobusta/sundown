---
name: recap
description: Show the user's latest shutdown recap - what shipped today (git log + diff) and tomorrow's list. Built from real data on disk; never from guesses. Use when the user asks what they did today or wants to see where they stopped.
allowed-tools: Bash(sundown *)
---

## Latest recap

!`sundown recap`

Show this to the user as-is, or at most trim to three or four lines if they asked for a short version. Don't invent anything; if the recap says there is no git history or no commits, say so plainly.
