// push.mjs — Notification + Stop hooks: your phone calls you back, so you can walk away.
//
//   Notification (Claude is waiting for you, or needs a permission)
//       -> "Claude needs you"
//   Stop (Claude finished a turn)
//       -> "Claude finished after N min. Take your time."
//          Only after turns longer than minTurnSeconds, so quick replies don't spam you.
//
// Uses ntfy.sh (free, open source, no account). OFF until you set a topic with
// /sundown:setup. The topic name works like a password: keep it unguessable.
//
// Privacy: by default the message says nothing about your project. With
// pushDetail = "folder" it includes the project FOLDER NAME only. Never code,
// prompts or file contents.
//
// Never blocks: always exits 0, prints nothing, gives up after 3 seconds.

// Node built-ins: fs (to resolve this script's real path), path (to get the folder name),
// url (to turn a file path into a file:// URL).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Shared hook helpers from lib.mjs: read the hook's JSON from stdin, load the config, the current time (can be faked in tests),
// when the turn started, the project folder, and the event log.
import {
  readHookInput, readConfig, now, turnStart, projectDir, logEvent,
} from "./lib.mjs";

// Build the push text. `folder` and `minutes` are passed in, so this stays free of side effects and easy to test.
export function buildMessage(event, cfg, { folder, minutes }) {
  // Add " in <folder>" only if you opted into pushDetail = "folder" and a folder is known.
  // Otherwise the message says nothing about your project.
  const where = cfg.pushDetail === "folder" && folder ? ` in ${folder}` : "";
  // Notification means Claude is waiting for you or needs a permission.
  if (event === "Notification") {
    // tags is the ntfy name for an emoji ("bell"). The body never contains code or prompts.
    return { title: "Claude needs you", body: `Claude is waiting for you${where}.`, tags: "bell" };
  }
  // Mention the length only for turns of a minute or more. Shorter ones say nothing about how long they took.
  const length = minutes >= 1 ? ` after ${minutes} min` : "";
  // Anything that isn't a Notification is a Stop. "crescent_moon" is an ntfy emoji tag.
  return { title: "Sundown", body: `Claude finished${where}${length}. Take your time.`, tags: "crescent_moon" };
}

// Send the push to ntfy. Returns true if the server accepted it and false on any failure. Never throws.
export async function send(cfg, msg) {
  // Lets us cancel the request if it takes too long.
  const controller = new AbortController();
  // Abort after 3000 ms (3 seconds), so a slow network can't hang the hook.
  const timer = setTimeout(() => controller.abort(), 3000);
  // Any network error or abort is handled in the catch below.
  try {
    // POST to <server>/<topic>. The regex /\/+$/ matches one or more slashes at the very end of the server URL and
    // removes them, so a trailing slash can't produce a double slash. Title and Tags are ntfy's header names, the body is
    // the message text, and the signal lets the timer above cancel the request.
    const res = await fetch(`${cfg.ntfyServer.replace(/\/+$/, "")}/${cfg.ntfyTopic}`, {
      method: "POST",
      headers: { Title: msg.title, Tags: msg.tags },
      body: msg.body,
      signal: controller.signal,
    });
    // ok is true for a 2xx response.
    return res.ok;
  // Network error or timeout: report failure instead of throwing, so the hook can't break.
  } catch {
    return false;
  // Always runs, whether the push worked or not.
  } finally {
    // Stop the timer so it can't fire later or keep the process alive.
    clearTimeout(timer);
  }
}

// Only run as a hook when this file is executed directly. The tests import
// buildMessage() and send() without triggering a real push.
// True only when this file is run directly. argv[1] must exist, and this module's URL must equal the script's URL;
// realpathSync resolves symlinks, so a symlinked install still matches.
const runDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

// Hook mode: not reached when a test imports this file.
if (runDirectly) {
  // Any error is swallowed in the catch at the end, so the hook never fails.
  try {
    // The hook's JSON payload, read from stdin.
    const input = await readHookInput();
    // Your Sundown settings.
    const cfg = readConfig();
    // No topic configured: exit silently, so nothing is ever sent without opt-in.
    if (!cfg.ntfyTopic) process.exit(0);          // pushes are opt-in: no topic, no network

    // Treat anything other than a Notification as a Stop.
    const event = input.hook_event_name === "Notification" ? "Notification" : "Stop";
    // The current time.
    const date = now();
    // Turn length in whole minutes. Stays 0 for a Notification, which has no duration.
    let minutes = 0;
    // Only a Stop message depends on how long the turn took.
    if (event === "Stop") {
      // How long did this turn take? (gate.mjs saved the start time.)
      const start = turnStart(input.session_id);
      // No recorded start (the gate didn't run, or the file is gone): the length is unknown, so say nothing.
      if (!start) process.exit(0);
      // Elapsed time in seconds. Subtracting dates gives milliseconds, so divide by 1000.
      const seconds = (date - start) / 1000;
      // A turn shorter than minTurnSeconds is too quick to be worth a push: exit without sending.
      if (seconds < cfg.minTurnSeconds) process.exit(0);
      // Whole minutes, rounded down.
      minutes = Math.floor(seconds / 60);
    }
    // Build the message with the folder NAME only (basename of the project path, never the full path).
    const msg = buildMessage(event, cfg, { folder: path.basename(projectDir(input)), minutes });
    // Send it. ok tells whether the server accepted it.
    const ok = await send(cfg, msg);
    // Record that a push was attempted and whether it worked. The message text is not logged.
    logEvent("push", { event, ok });
  } catch {
    // never fail a hook
  }
  // Exit 0 in every case so the hook never blocks Claude. This also ends the process even if a handle is still open.
  process.exit(0);
}
