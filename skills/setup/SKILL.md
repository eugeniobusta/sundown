---
name: setup
description: Set up Sundown - choose the evening cutoff, morning time and days off, optionally connect phone notifications (ntfy), and optionally add the countdown to Claude Code's status line. Only runs when the user types /sundown:setup.
disable-model-invocation: true
allowed-tools: Bash(sundown *)
---

## Current settings

!`sundown status`

Set Sundown up with the user. Ask before changing anything, one step at a time, and keep each message short.

Order matters: ask the questions in the order below, but apply the cutoff **last** (step 6), after morning and days off. Setting the cutoff can switch Sundown on straight away when it's already evening, and while it's on, settings that would loosen it can only be changed by the user. If any `sundown config` command answers "only you can change", don't retry it or look for another way: show the user the exact command it printed and ask them to run it in their own terminal.

1. **Evening cutoff.** Ask what time they want to stop working in the evening (24-hour, e.g. 21:00; it applies every day), or "none" to only use /sundown:shutdown by hand. Remember the answer; you'll apply it in step 6.
2. **Morning.** Ask when their day starts (default 08:00). Run `sundown config morning <HH:MM>`.
3. **Days off (optional).** Ask if there are whole days Sundown should keep quiet, for example the weekend. If yes, run `sundown config daysOff <days>` with three-letter names separated by commas (e.g. `sat,sun`). Mention that 30 minutes before the cutoff they'll get one short "time to wrap up" note; if they'd rather not, run `sundown config wrapUpMinutes off`.
4. **Phone notifications (optional).** Explain in one sentence: when Claude finishes a long task or needs an answer, their phone buzzes, so they can leave the desk instead of watching the terminal. It uses ntfy.sh (free, no account; the app is "ntfy" on iOS and Android). If they want it:
   - run `sundown config ntfyTopic generate` and show them the topic it prints;
   - tell them to open the ntfy app, tap +, and subscribe to exactly that topic. The topic works like a password, so they shouldn't share it;
   - when they say they've subscribed, run `sundown test-push` and ask if it arrived.
   By default the notification text never mentions the project. If they want the project folder name included, run `sundown config pushDetail folder`.
5. **Status line (optional).** Offer to show the countdown ("☀ 2h 05m to sundown") at the bottom of Claude Code. This edits their ~/.claude/settings.json, so ask first. If yes, run `sundown install-statusline`. If it says a status line already exists, tell them and don't use --force unless they explicitly say to replace theirs.
6. **Apply the cutoff.** Now run `sundown config cutoff <HH:MM>` (or `sundown config cutoff off`) with the time from step 1.
7. Finish with `sundown status` and a two-line summary: what happens at their cutoff, and that `/sundown:shutdown` ends the day early, `override:` sends one message anyway, and `/sundown:wake` switches it off.

Don't change settings the user didn't agree to.
