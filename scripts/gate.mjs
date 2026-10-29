// gate.mjs — UserPromptSubmit hook. Runs every time YOU press Enter in Claude Code,
// before Claude sees the message. Jobs, in order:
//
//   1. Remember when this turn started (push.mjs uses it to say "finished after 14 min").
//   2. Handle the commands that change Sundown's state directly, so Claude can never
//      shut itself down or wake itself up:
//        /sundown:shutdown                 -> lock ON until the morning time
//        /sundown:wake                     -> lock OFF (only works after wake time
//                                             unless an override is already active)
//        /sundown:override [5m|15m|30m|1h] -> grant this session a pass (default 15m)
//        /sundown:schedule <sub> [args]    -> change cutoff/wake/limit
//   3. Let every other /sundown:... command through (status, recap, report, setup),
//      even during shutdown.
//   4. Count the prompt against today's limit (only prompts that would otherwise
//      consume a turn — not /sundown:* commands, not overrides).
//   5. If Sundown is active (lock on, past cutoff, before wake, or over the daily
//      limit) and this session doesn't hold a pass, BLOCK (exit code 2) with:
//      reason, prompts used, when work resumes, recovery commands.
//
// Privacy: the message text is only pattern-matched against the commands above.
// It is never stored, logged or sent anywhere. The counts file only stores a
// timestamp per prompt.
//
// Fail-open: on any unexpected error, exit 0 so a bug can never lock you out.

import fs from "node:fs";
import path from "node:path";
import {
  readHookInput, readConfig, setConfig, now, sundownState, recordTurnStart,
  grantPass, hasPass, logEvent, hhmm, lockOn, wake, projectDir,
  recordPrompt, todaysCount, turnStart,
} from "./lib.mjs";
import { saveRecap } from "./recap.mjs";

const DEFAULT_OVERRIDE = { label: "15m", minutes: 15 };
const OVERRIDE_DURATIONS = {
  "5m":  { label: "5m",  minutes: 5 },
  "15m": { label: "15m", minutes: 15 },
  "30m": { label: "30m", minutes: 30 },
  "1h":  { label: "1h",  minutes: 60 },
};

function parseOverrideArg(prompt) {
  const m = /^\/sundown:override\b\s*(\S+)?/i.exec(prompt);
  const raw = (m && m[1] ? m[1].toLowerCase() : "").replace(/[.,]+$/, "");
  if (!raw) return DEFAULT_OVERRIDE;
  return OVERRIDE_DURATIONS[raw] || DEFAULT_OVERRIDE;
}

function blockMessage(state, cfg, date) {
  const parts = [];
  if (state.why === "lock") {
    parts.push(`☾ Sundown: you shut down for today. Work resumes at ${hhmm(state.until)}.`);
  } else if (state.why === "quiet") {
    parts.push(`☾ Sundown: it's after your ${cfg.cutoff} cutoff. Work resumes at ${hhmm(state.until)}.`);
  } else if (state.why === "limit") {
    parts.push(`☾ Sundown: you've used ${state.count}/${state.limit} prompts today. Work resumes at ${hhmm(state.until)}.`);
  }
  if (state.why !== "limit" && cfg.dailyLimit > 0) {
    parts.push(`Prompts used today: ${todaysCount(date, cfg)}/${cfg.dailyLimit}.`);
  }
  parts.push(`Recovery: /sundown:override [5m|15m|30m|1h] for one task, /sundown:wake to resume now, /sundown:recap to see where you stopped.`);
  return parts.join("\n") + "\n";
}

try {
  const input = await readHookInput();
  const date = now();
  const cfg = readConfig();
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";

  // 1. Turn start time (only the time, never the text).
  recordTurnStart(input.session_id, date);

  // 2. State-changing commands. Plain stdout from this hook is added to Claude's
  //    context, which is how the matching skill learns the exact times.
  if (/^\/sundown:shutdown\b/i.test(prompt)) {
    const lock = lockOn(date, cfg);
    // Build the recap from REAL data (git log + diff + TOMORROW.md if present).
    // Session start is a good "since": commits made this working day usually
    // land after it. If we don't know, saveRecap falls back to the last 12h.
    saveRecap({ projectDir: projectDir(input), since: turnStart(input.session_id) || date, date });
    logEvent("shutdown");
    console.log(
      `Sundown: the shutdown lock is now ON until ${hhmm(new Date(lock.until))}. ` +
      `Recap saved to ~/.sundown/recap.md (view with /sundown:recap).`,
    );
    process.exit(0);
  }
  if (/^\/sundown:wake\b/i.test(prompt)) {
    // Manual wake before the morning time only works when a session already
    // overrode — otherwise the "pause and sleep" promise would be too easy to
    // click through at 03:00. The user can always type /sundown:override.
    const beforeWake = sundownState(date, cfg).why === "quiet";
    if (beforeWake && !hasPass(input.session_id, date)) {
      process.stderr.write(
        `☾ Sundown: it's before your wake time (${cfg.morning}). ` +
        `Use /sundown:override [15m] to send one message now; /sundown:wake works after ${cfg.morning}.\n`,
      );
      process.exit(2);
    }
    const until = wake(date, cfg);
    logEvent("wake");
    console.log(`Sundown: switched OFF. Quiet hours are ignored until ${hhmm(until)}.`);
    process.exit(0);
  }
  if (/^\/sundown:override\b/i.test(prompt)) {
    const { label, minutes } = parseOverrideArg(prompt);
    grantPass(input.session_id, date, minutes);
    logEvent("override", { minutes });
    console.log(
      `Sundown: override granted for this session for about ${label}. ` +
      `This does not reset the daily count or the schedule. Do only what the next request asks.`,
    );
    process.exit(0);
  }
  if (/^\/sundown:schedule\b/i.test(prompt)) {
    const args = prompt.replace(/^\/sundown:schedule\s*/i, "").trim().split(/\s+/).filter(Boolean);
    try {
      const [sub, value] = args;
      if (!sub || sub === "list") {
        console.log(`Sundown schedule: shutdown=${cfg.cutoff || "off"}, wake=${cfg.morning}, limit=${cfg.dailyLimit}.`);
      } else if (sub === "shutdown") {
        setConfig("cutoff", value === "off" ? "" : value);
        console.log(`Sundown: shutdown time set to ${value === "off" ? "off" : value}.`);
      } else if (sub === "wake") {
        setConfig("morning", value);
        console.log(`Sundown: wake time set to ${value}.`);
      } else if (sub === "limit") {
        setConfig("dailyLimit", Number(value));
        console.log(`Sundown: daily prompt limit set to ${value}.`);
      } else {
        console.log(`Sundown: unknown subcommand "${sub}". Try: shutdown HH:MM | wake HH:MM | limit N | list.`);
      }
    } catch (err) {
      console.log(`Sundown: couldn't apply schedule change: ${err.message}`);
    }
    process.exit(0);
  }

  // 3. Other Sundown commands always work (status, recap, report, setup).
  if (/^\/sundown:/i.test(prompt)) process.exit(0);

  // Preserve the "override:" prefix as a shorthand so muscle memory keeps working.
  if (/^override:/i.test(prompt)) {
    grantPass(input.session_id, date, cfg.overrideMinutes);
    logEvent("override", { minutes: cfg.overrideMinutes });
    console.log(
      `Sundown: override granted for this session for about ${cfg.overrideMinutes} minutes. ` +
      `Do only what this message asks; the daily count isn't reset.`,
    );
    process.exit(0);
  }

  // 4. The gate itself.
  const state = sundownState(date, cfg);

  // A session that overrode a few minutes ago keeps working until its pass runs out.
  // Still counts the prompt — overrides don't reset the daily counter.
  if (hasPass(input.session_id, date)) {
    recordPrompt(date, cfg);
    process.exit(0);
  }

  if (state.why) {
    logEvent("blocked", { reason: state.why });
    const hasHandoff = fs.existsSync(path.join(projectDir(input), "TOMORROW.md"));
    const extra = hasHandoff ? "Your next step is waiting in TOMORROW.md.\n" : "";
    process.stderr.write(blockMessage(state, cfg, date) + extra);
    process.exit(2);
  }

  // Not blocked — count the prompt against today's limit.
  recordPrompt(date, cfg);
  process.exit(0);
} catch {
  process.exit(0);
}
