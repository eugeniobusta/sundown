// pause.mjs — PreToolUse hook: pauses agents that are still running after you shut down.
//
// Runs before EVERY tool call Claude makes, in every session, while the plugin is on.
// It only acts when the shutdown LOCK is on (not just because it's late), so it
// never surprises you in the middle of the day.
//
// While locked:
//   1. A session with an override pass works normally.
//   2. Read-only tools (Read, Glob, Grep, LS) are allowed, and so are plain read-only
//      shell commands (ls, grep, find, git log...: see isReadOnlyBash), because newer
//      Claude Code versions search files through Bash. Claude needs to look at what it
//      was doing to write an accurate handoff.
//   3. Writing or editing THIS project's TOMORROW.md is allowed: that's the handoff.
//      (Only the one in the project root, not any file that happens to share the name.)
//   4. Once TOMORROW.md has been written since the lock was set, the next tool
//      call stops the agent completely ({"continue": false}).
//   5. Anything else is denied, with a reason that tells Claude exactly what to do.
//
// Fail-open: on any unexpected error, allow the tool call.

import fs from "node:fs";
import path from "node:path";
import {
  readHookInput, now, lockState, hasPass, projectDir, logEvent, hhmm, isReadOnlyBash,
} from "./lib.mjs";

// Tools that only look at files. Allowed during the lock so Claude can write an
// accurate handoff.
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS"]);

// Same file? Compares folders with symlinks resolved (/tmp vs /private/tmp on macOS).
function samePath(a, b) {
  if (path.basename(a) !== path.basename(b)) return false;
  if (path.dirname(a) === path.dirname(b)) return true;
  try { return fs.realpathSync(path.dirname(a)) === fs.realpathSync(path.dirname(b)); } catch { return false; }
}

try {
  const input = await readHookInput();
  const date = now();
  const lock = lockState(date);
  // No lock, or the lock already reached its morning: never interfere.
  if (!lock || !lock.active) process.exit(0);
  if (hasPass(input.session_id, date)) process.exit(0);

  const tool = String(input.tool_name || "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (READ_ONLY.has(tool)) process.exit(0);
  if (tool === "Bash" && isReadOnlyBash(toolInput.command)) process.exit(0);

  const handoff = path.join(projectDir(input), "TOMORROW.md");
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
  if ((tool === "Write" || tool === "Edit") && filePath && samePath(path.resolve(projectDir(input), filePath), handoff)) {
    process.exit(0);
  }
  let handoffWritten = false;
  try {
    const written = fs.statSync(handoff).mtime;
    handoffWritten = written >= lock.setAt || written >= lock.setAtReal;
  } catch { /* no handoff yet */ }

  if (handoffWritten) {
    logEvent("paused", { tool });
    console.log(JSON.stringify({
      continue: false,
      stopReason: `☾ Sundown: paused until ${hhmm(lock.until)}. Handoff saved in TOMORROW.md.`,
    }));
    process.exit(0);
  }

  logEvent("pause-requested", { tool });
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `The user has shut down for the day (Sundown, until ${hhmm(lock.until)}). Don't continue the task. ` +
        "Write a short handoff to TOMORROW.md in the project root with exactly three lines: " +
        "\"Stopped at: …\", \"First step tomorrow: …\", \"Open question: …\" " +
        "(be concrete: files, functions, what's half-done). Then stop and end your turn.",
    },
  }));
  process.exit(0);
} catch {
  process.exit(0);
}
