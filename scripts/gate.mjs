// gate.mjs — UserPromptSubmit hook. Runs every time YOU press Enter in Claude Code,
// before Claude sees the message. It does four jobs, in this order:
//
//   1. Remembers when this turn started (push.mjs uses it to say "finished after 14 min").
//   2. Handles the two commands that change Sundown's state:
//        /sundown:shutdown  -> switches the lock ON (until your morning time)
//        /sundown:wake      -> switches the lock OFF and ignores quiet hours until your next cutoff
//      They are handled HERE, not by Claude, on purpose: this hook only runs for
//      messages a person typed, so Claude can never shut itself down or wake itself up.
//   3. Lets every other /sundown:... command through (status, report, setup), even at night.
//   4. Shortly before your cutoff (wrapUpMinutes, once a day): one gentle note so you
//      can land the current task instead of hitting the wall mid-way.
//   5. While Sundown is active (lock on, after your cutoff, or on a day off):
//        - a message starting with "override:" goes through, gets a short pass
//          (overrideMinutes) and is counted in your report;
//        - while that pass lasts, the same session's messages go through too;
//        - anything else is blocked: exit code 2 tells Claude Code to drop the
//          message and show our text (from stderr) to you instead.
//
// Privacy: the message text is only compared with the patterns above. It is never
// stored, logged or sent anywhere.
//
// Fail-open: if anything unexpected goes wrong, exit 0 (let the message through), so a
// bug in Sundown can never lock you out of Claude Code.

import fs from "node:fs";
import path from "node:path";
import {
  readHookInput, readConfig, now, sundownState, recordTurnStart,
  grantPass, hasPass, logEvent, hhmm, lockOn, wake, projectDir,
  reasonText, minutesToCutoff, claimWrapUp, dayAndTime,
} from "./lib.mjs";

const REASON_NAME = { lock: "after the user's shutdown", quiet: "after the user's evening cutoff", dayoff: "the user's day off" };

try {
  const input = await readHookInput();
  const date = now();
  const cfg = readConfig();
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";

  // 1. Turn start time (only the time, never the text).
  recordTurnStart(input.session_id, date);

  // 2. State-changing commands. Plain stdout from this hook is added to Claude's
  //    context, which is how the skill learns the exact times.
  if (/^\/sundown:shutdown\b/i.test(prompt)) {
    const lock = lockOn(date, cfg);
    logEvent("shutdown");
    console.log(`Sundown: the shutdown lock is now ON until ${dayAndTime(new Date(lock.until))}.`);
    process.exit(0);
  }
  if (/^\/sundown:wake\b/i.test(prompt)) {
    const until = wake(date, cfg);
    logEvent("wake");
    console.log(`Sundown: switched OFF. Quiet hours are ignored until ${hhmm(until)}.`);
    process.exit(0);
  }

  // 3. Other Sundown commands always work, so you can check status or run setup at night.
  if (/^\/sundown:/i.test(prompt)) process.exit(0);

  // 4. The wrap-up note. "systemMessage" is shown to you; "additionalContext" tells
  //    Claude, so it can suggest a clean stopping point rather than start something big.
  const left = minutesToCutoff(date, cfg);
  if (left !== null && left <= cfg.wrapUpMinutes && claimWrapUp(date, cfg)) {
    logEvent("wrapup");
    console.log(JSON.stringify({
      systemMessage: `◐ Sundown: ${left} min to your ${cfg.cutoff} cutoff. A good moment to land this task; /sundown:shutdown saves tomorrow's first step.`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `Sundown: the user's evening cutoff (${cfg.cutoff}) is in ${left} minutes. ` +
          "Do what they asked, but prefer a clean stopping point over starting anything large, " +
          "and don't suggest follow-up work for tonight.",
      },
    }));
    process.exit(0);
  }

  // 5. The gate itself.
  const state = sundownState(date, cfg);
  if (!state.why) process.exit(0);

  // A session that overrode a few minutes ago keeps working until its pass runs out,
  // so you don't have to type "override:" on every message of one quick fix.
  if (hasPass(input.session_id, date)) process.exit(0);

  if (/^override:/i.test(prompt)) {
    grantPass(input.session_id, date, cfg.overrideMinutes);
    logEvent("override", { reason: state.why });
    console.log(
      `Sundown: it's ${REASON_NAME[state.why]} and they chose to override it ` +
      `for this request (about ${cfg.overrideMinutes} minutes). Do only what this message asks, keep it short, and don't suggest follow-up work.`,
    );
    process.exit(0);
  }

  logEvent("blocked", { reason: state.why });
  const why = reasonText(state, cfg);
  // Only point at TOMORROW.md if this project actually has one.
  const hasHandoff = fs.existsSync(path.join(projectDir(input), "TOMORROW.md"));
  process.stderr.write(
    `☾ Sundown: ${why}.${hasHandoff ? " Your next step is waiting in TOMORROW.md." : ""}\n` +
    `Really need this now? Start the message with "override:". Working early? Run /sundown:wake.\n`,
  );
  process.exit(2);
} catch {
  process.exit(0);
}
