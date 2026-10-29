// gate.mjs — UserPromptSubmit hook. Runs every time YOU press Enter in Claude Code,
// before Claude sees the message. It does five jobs, in this order:
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

// Node built-ins: fs checks whether TOMORROW.md exists, path builds its location.
import fs from "node:fs";
import path from "node:path";
// Everything about state (config, lock, passes, time) comes from lib.mjs, so every hook applies the same rules.
import {
  readHookInput, readConfig, now, sundownState, recordTurnStart,
  grantPass, hasPass, logEvent, hhmm, lockOn, wake, projectDir,
  reasonText, minutesToCutoff, claimWrapUp, dayAndTime,
} from "./lib.mjs";

// How each reason is worded to Claude in the override note: lock = shutdown, quiet = after cutoff, dayoff = day off.
const REASON_NAME = { lock: "after the user's shutdown", quiet: "after the user's evening cutoff", dayoff: "the user's day off" };

// Everything runs inside try so that any unexpected error reaches the catch at the bottom, which lets the message through.
try {
  // Claude Code sends the hook a JSON object on stdin; this reads it ({} if it is missing or broken).
  const input = await readHookInput();
  // "Now" is taken once for the whole run (tests can fake it with SUNDOWN_NOW).
  const date = now();
  // Saved settings with defaults filled in.
  const cfg = readConfig();
  // The text you typed, trimmed of surrounding whitespace. If the field isn't a string, use "" so the regexes below can't throw.
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";

  // 1. Turn start time (only the time, never the text).
  // Save only the start time of this turn for this session.
  recordTurnStart(input.session_id, date);

  // 2. State-changing commands. Plain stdout from this hook is added to Claude's
  //    context, which is how the skill learns the exact times.
  // Regex: the message must start (^) with /sundown:shutdown, followed by a whitespace character (\s) or the end of the text ($), so "/sundown:shutdownx" does not match. The i flag ignores upper/lower case.
  if (/^\/sundown:shutdown(\s|$)/i.test(prompt)) {
    // Write the lock file, which lasts until your next work morning.
    const lock = lockOn(date, cfg);
    // Record the shutdown in the local event log (no message text).
    logEvent("shutdown");
    // This line goes to Claude as context (plain stdout from this hook), so the skill can quote the exact time.
    console.log(`Sundown: the shutdown lock is now ON until ${dayAndTime(new Date(lock.until))}.`);
    // Tell Claude whether to dream (write DREAM.md before the handoff) and any steering the user saved. The instructions are quoted as the user's own words about what to focus on.
    console.log(cfg.dream === "on"
      ? `Sundown dream: ON. Write DREAM.md before TOMORROW.md, as the shutdown skill says.${cfg.dreamInstructions ? ` The user's dream instructions: "${cfg.dreamInstructions}"` : ""}`
      : "Sundown dream: OFF. Do not write DREAM.md; only TOMORROW.md.");
    // Exit 0 means allow the prompt. It is allowed through so Claude can write the handoff, and no other code in this hook runs.
    process.exit(0);
  }
  // Same pattern as above, for /sundown:wake.
  if (/^\/sundown:wake(\s|$)/i.test(prompt)) {
    // Remove the lock and ignore quiet hours until the next cutoff; this returns that cutoff time.
    const until = wake(date, cfg);
    // Record the wake in the local event log.
    logEvent("wake");
    // Tell Claude (and so you) when quiet hours start applying again.
    console.log(`Sundown: switched OFF. Quiet hours are ignored until ${hhmm(until)}.`);
    // Exit 0 means allow the prompt.
    process.exit(0);
  }

  // 3. The read-only Sundown commands always work, so you can check status or run setup at
  //    night. Only the bare command (report may take a number of days): text after it
  //    would reach Claude as a task, so "/sundown:status now write a feature" is held back.
  // Regex, anchored at both ends (^ and $, i = any case): /sundown: then status, setup, or report optionally followed by whitespace and one or two digits (a number of days), then only trailing whitespace. A command with anything else after it does not match and goes on to the gate. A match exits 0 = allow, so these work at night.
  if (/^\/sundown:(status|setup|report(\s+\d{1,2})?)\s*$/i.test(prompt)) process.exit(0);

  // 4. The wrap-up note. "systemMessage" is shown to you; "additionalContext" tells
  //    Claude, so it can suggest a clean stopping point rather than start something big.
  // Minutes until today's cutoff, or null if there is no cutoff or Sundown is already on.
  const left = minutesToCutoff(date, cfg);
  // Show the note only if a cutoff exists, it is within wrapUpMinutes, and this is the first time today (claimWrapUp records that, so the note appears once).
  if (left !== null && left <= cfg.wrapUpMinutes && claimWrapUp(date, cfg)) {
    // Record the note in the local event log.
    logEvent("wrapup");
    // JSON on stdout is read by Claude Code as instructions, not as plain text: systemMessage is shown to you, hookSpecificOutput.additionalContext is given to Claude.
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
    // Exit 0 means allow the prompt. The wrap-up note is advice only, nothing is blocked.
    process.exit(0);
  }

  // 5. The gate itself.
  // Is Sundown on right now, and why (lock, quiet, dayoff, or nothing)?
  const state = sundownState(date, cfg);
  // Not active (no why): nothing to enforce, so exit 0 = allow the prompt.
  if (!state.why) process.exit(0);

  // A session that overrode a few minutes ago keeps working until its pass runs out,
  // so you don't have to type "override:" on every message of one quick fix.
  // Exit 0 = allow: this session overrode recently and its pass hasn't run out.
  if (hasPass(input.session_id, date)) process.exit(0);

  // Regex: the message starts with "override:" in any case. This is the only way a person gets through while Sundown is on.
  if (/^override:/i.test(prompt)) {
    // Give this session a short pass of overrideMinutes, so the following messages need no prefix.
    grantPass(input.session_id, date, cfg.overrideMinutes);
    // Record the override with the reason, so it shows in the report.
    logEvent("override", { reason: state.why });
    // Plain stdout is added to Claude's context. It tells Claude that this is an override and to keep the work small.
    console.log(
      `Sundown: it's ${REASON_NAME[state.why]} and they chose to override it ` +
      `for this request (about ${cfg.overrideMinutes} minutes). Do only what this message asks, keep it short, and don't suggest follow-up work.`,
    );
    // Exit 0 = allow the prompt.
    process.exit(0);
  }

  // No pass and no override: the message will be blocked. Record that for the report.
  logEvent("blocked", { reason: state.why });
  // Reason text, e.g. "it's after your 21:00 cutoff (until 08:00)".
  const why = reasonText(state, cfg);
  // Only point at TOMORROW.md if this project actually has one.
  // True if this project has a TOMORROW.md. projectDir comes from the hook input, falling back to Claude's project folder or the current folder.
  const hasHandoff = fs.existsSync(path.join(projectDir(input), "TOMORROW.md"));
  // Stderr is what Claude Code shows you when a prompt is blocked. Line one says why (plus the handoff hint if it applies), line two says how to get through.
  process.stderr.write(
    `☾ Sundown: ${why}.${hasHandoff ? " Your next step is waiting in TOMORROW.md." : ""}\n` +
    `Really need this now? Start the message with "override:". Working early? Run /sundown:wake.\n`,
  );
  // Exit 2 = block the prompt: Claude Code drops the message, Claude never sees it, and the stderr text is shown to you.
  process.exit(2);
} catch {
  // Fail open: if anything above threw, exit 0 (allow) so a bug in Sundown can't lock you out of Claude Code.
  // Exit 0 = allow the prompt.
  process.exit(0);
}
