// morning.mjs — SessionStart hook: greets you with yesterday's handoff.
//
// Runs when a Claude Code session starts, resumes or is cleared.
//   - Still shut down: a one-line reminder (you can still use "override:").
//   - Lock has expired (it's morning): removes it.
//   - After your cutoff: a one-line reminder.
//   - Otherwise, if TOMORROW.md exists in this project and is recent (< 4 days):
//       "systemMessage"      -> shown to YOU at the top of the session
//       "additionalContext"  -> given to CLAUDE so it knows where you stopped
//
// Fail-open: errors print nothing.

import fs from "node:fs";
import path from "node:path";
import {
  readHookInput, readConfig, now, lockState, lockOff, sundownState,
  projectDir, logEvent, hhmm,
} from "./lib.mjs";

const MAX_AGE_DAYS = 4;
const MAX_CHARS = 2000; // never inject a huge file into context

try {
  const input = await readHookInput();
  const date = now();
  const cfg = readConfig();

  const lock = lockState(date);
  if (lock && !lock.active) {
    lockOff();
    logEvent("morning");
  }

  const state = sundownState(date, cfg);
  if (state.why) {
    const msg = state.why === "lock"
      ? `☾ Sundown is on until ${hhmm(state.until)}. Start a message with "override:" if you really need to.`
      : `☾ It's after your ${cfg.cutoff} cutoff. Start a message with "override:" if you really need to.`;
    console.log(JSON.stringify({ systemMessage: msg }));
    process.exit(0);
  }

  const file = path.join(projectDir(input), "TOMORROW.md");
  let stat;
  try { stat = fs.statSync(file); } catch { process.exit(0); }
  if (!stat.isFile()) process.exit(0);
  if (date - stat.mtime > MAX_AGE_DAYS * 86400000) process.exit(0);

  let text = fs.readFileSync(file, "utf8").trim();
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n…";

  console.log(JSON.stringify({
    systemMessage: `☀ Good morning. Last time you stopped here:\n${text}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        "The user's handoff note from their last session (TOMORROW.md in the project root):\n" +
        text +
        "\nIf they ask where to start, begin with the 'First step tomorrow' line.",
    },
  }));
  process.exit(0);
} catch {
  process.exit(0);
}
