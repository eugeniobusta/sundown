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
//      So is DREAM.md in the same folder, while the "dream" setting is on: that's the
//      dream, a proposal to tidy Claude's memory. It is written BEFORE the handoff,
//      because the handoff ends the session. Nothing else can be written, so the
//      dream can only propose changes to memory, never make them.
//      (Only the ones in the project root, not any file that happens to share the name.)
//   4. Once TOMORROW.md has been written since the lock was set, the next tool
//      call stops the agent completely ({"continue": false}).
//   5. Anything else is denied, with a reason that tells Claude exactly what to do.
//
// Fail-open: on any unexpected error, allow the tool call.

// Node built-ins: fs reads file information, path builds and compares file locations.
import fs from "node:fs";
import path from "node:path";
// Hook input, time, lock and pass state, the project folder, the event log, the time formatter and the read-only shell check all come from lib.mjs, shared with the other hooks.
import {
  readHookInput, readConfig, now, lockState, hasPass, projectDir, logEvent, dayAndTime, isReadOnlyBash, DREAM_FILE, projectKey,
} from "./lib.mjs";

// Tools that only look at files. Allowed during the lock so Claude can write an
// accurate handoff.
// A set gives a fast yes/no check on the tool name.
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS"]);

// Tools that may write the handoff (and the dream).
// The three tools that write files; only allowed on TOMORROW.md and, when dreaming is on, DREAM.md (checked below).
const HANDOFF_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// Same file? Compares folders with symlinks resolved (/tmp vs /private/tmp on macOS).
// Returns true when a and b are the same file location, even when one spelling goes through a symlink.
function samePath(a, b) {
  // Different file names can never be the same file.
  if (path.basename(a) !== path.basename(b)) return false;
  // Same folder spelled the same way: same file, no need to touch the disk.
  if (path.dirname(a) === path.dirname(b)) return true;
  // Otherwise resolve symlinks in both folders and compare. If a folder doesn't exist, realpathSync throws, so answer false.
  try { return fs.realpathSync(path.dirname(a)) === fs.realpathSync(path.dirname(b)); } catch { return false; }
}

// Everything runs inside try so any unexpected error reaches the catch at the bottom, which allows the tool call.
try {
  // Claude Code sends the hook a JSON object on stdin; this reads it ({} if missing or broken).
  const input = await readHookInput();
  // "Now" is taken once for the whole run (tests can fake it with SUNDOWN_NOW).
  const date = now();
  // The shutdown lock saved by /sundown:shutdown, or null if there is none.
  const lock = lockState(date);
  // No lock, or the lock already reached its morning: never interfere.
  // Exit code 0 = allow the tool call. With no lock, or one past its morning, this hook does nothing.
  if (!lock || !lock.active) process.exit(0);
  // Exit 0 = allow: this session overrode recently, so it works normally.
  if (hasPass(input.session_id, date)) process.exit(0);

  // Name of the tool Claude is about to use, forced to a string so later comparisons can't throw.
  const tool = String(input.tool_name || "");
  // The tool's arguments, but only if they are an object; otherwise an empty object so reading fields can't throw.
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};

  // Where this project's handoff file must live: TOMORROW.md in the project root.
  const handoff = path.join(projectDir(input), "TOMORROW.md");
  // The file the tool wants to touch, or "" if there isn't one.
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
  // A TOMORROW.md or DREAM.md that is itself a symlink could point anywhere: don't write through it.
  // True when writing to `file` could land somewhere else: it is a symlink (lstat looks at the file itself without following it), or a hard link shared with another name (nlink above 1, so writing in place would change that other file too). A missing file throws, which means "fine".
  const isLink = (file) => { try { const st = fs.lstatSync(file); return st.isSymbolicLink() || st.nlink > 1; } catch { return false; } };
  // The file this tool wants to write, resolved against the project folder so relative paths work.
  const target = filePath ? path.resolve(projectDir(input), filePath) : "";
  // Has the handoff already been written since the lock was set? Assume no until the file's time proves it.
  let handoffWritten = false;
  // Try to read when TOMORROW.md was last modified. If the file doesn't exist this throws and the answer stays false.
  try {
    // Last-modified time of the handoff.
    const written = fs.statSync(handoff).mtime;
    // Written after the lock was set, judged by either the (possibly faked) clock or the real clock. Two clocks are compared because tests fake "now" but file times are always real.
    handoffWritten = written >= lock.setAt || written >= lock.setAtReal;
  } catch { /* no handoff yet */ }

  // The handoff exists and is fresh: time to stop the agent for good.
  if (handoffWritten) {
    // Record the pause in the local event log.
    logEvent("paused", { tool });
    // Stop the run AND deny this call. "continue: false" alone stops the run but still
    // lets the tool call that triggered it execute (seen in real Claude Code).
    // JSON on stdout is read by Claude Code as instructions to it. continue:false stops the whole run; the permissionDecision "deny" blocks this one tool call; stopReason is what you see.
    console.log(JSON.stringify({
      continue: false,
      stopReason: `☾ Sundown: paused until ${dayAndTime(lock.until)}. Handoff saved in TOMORROW.md.`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Sundown has paused this agent for the day. The handoff is saved in TOMORROW.md. Do not run this.",
      },
    }));
    // Exit 0 = the hook itself succeeded. The deny and stop are carried by the JSON above, not by the exit code.
    process.exit(0);
  }

  // Not stopped yet, so the handoff and the dream may still be written. (This comes AFTER the stop above: once the handoff exists nothing else is allowed, so an agent can't keep rewriting files after it has been told to stop.)
  // Allow only if: the tool is a writing tool, a path was given, and that path is the handoff or (dreaming on) the dream, neither being a symlink.
  if (HANDOFF_TOOLS.has(tool) && target) {
    // The dream file lives next to the handoff, and is only writable while the setting is on.
    const dream = path.join(projectDir(input), DREAM_FILE);
    if ((samePath(target, handoff) && !isLink(handoff)) ||
        (readConfig().dream === "on" && samePath(target, dream) && !isLink(dream))) {
      // Remember, without the folder path, that Sundown let a dream be written for this project. The morning greeting only announces a DREAM.md it can match to this record, so a file from a cloned repo is never presented as last night's dream.
      if (samePath(target, dream)) logEvent("dream-writing", { project: projectKey(projectDir(input)) });
      // Exit 0 = allow: this is Claude writing the handoff or the dream.
      process.exit(0);
    }
  }
  // The handoff is not written yet, so reading is still fine: Claude needs to look around to write it.
  // Exit 0 = allow: reading files cannot change anything.
  if (READ_ONLY.has(tool)) process.exit(0);
  // Exit 0 = allow: a shell command that is only reading (ls, grep, git log...) is judged safe by isReadOnlyBash.
  if (tool === "Bash" && isReadOnlyBash(toolInput.command)) process.exit(0);

  // Handoff not written yet: record that the agent was asked to pause.
  logEvent("pause-requested", { tool });
  // A refused shell command is the common case: Claude writes quotes, "*", "&&" or ";" and gives up.
  // Say exactly what is allowed, with examples that work, so it retries with one plain command instead.
  const shellHelp = tool === "Bash"
    ? "That shell command was refused, but looking around is still allowed: use ONE plain read-only command at a time " +
      "(ls, cat, head, tail -n 20, wc, grep, find with -name/-type, git status, git log, or git diff --no-ext-diff --no-textconv), " +
      "optionally piped into head. No quotes, no * globs, no && or ;, no > or 2>/dev/null, no $(...). " +
      "Examples that work: `ls -la`, `grep -rn -e TODO -e FIXME .`, `find . -type f -name main.py`, `git log --oneline -5`. " +
      "Read opens files, not folders (use ls for a folder). If you still can't tell where things stand, write the handoff from what you do know and say what you couldn't check. "
    : "";
  // Deny this tool call. The reason is shown to Claude, so it says exactly what to do next: write TOMORROW.md in three lines, then end the turn. Writing it is allowed (checked above), so the next tool call after that triggers the full stop.
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `The user has shut down for the day (Sundown, until ${dayAndTime(lock.until)}). Don't continue the task. ` +
        shellHelp +
        "Write a short handoff to TOMORROW.md in the project root with exactly three lines: " +
        "\"Stopped at: …\", \"First step tomorrow: …\", \"Open question: …\" " +
        "(be concrete: files, functions, what's half-done). Then stop and end your turn." +
        (readConfig().dream === "on"
          ? ` If you have not yet written the dream, write DREAM.md first (proposals only, as the shutdown skill says); the handoff comes last because it ends the session.`
          : ""),
    },
  }));
  // Exit 0 = the hook succeeded; the deny is carried by the JSON above.
  process.exit(0);
} catch {
  // Fail open: any unexpected error allows the tool call, so a bug in Sundown can't lock Claude out of working.
  // Exit 0 = allow.
  process.exit(0);
}
