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

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  readHookInput, readConfig, now, turnStart, projectDir, logEvent,
} from "./lib.mjs";

export function buildMessage(event, cfg, { folder, minutes }) {
  const where = cfg.pushDetail === "folder" && folder ? ` in ${folder}` : "";
  if (event === "Notification") {
    return { title: "Claude needs you", body: `Claude is waiting for you${where}.`, tags: "bell" };
  }
  const length = minutes >= 1 ? ` after ${minutes} min` : "";
  return { title: "Sundown", body: `Claude finished${where}${length}. Take your time.`, tags: "crescent_moon" };
}

export async function send(cfg, msg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${cfg.ntfyServer.replace(/\/+$/, "")}/${cfg.ntfyTopic}`, {
      method: "POST",
      headers: { Title: msg.title, Tags: msg.tags },
      body: msg.body,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Only run as a hook when this file is executed directly. The tests import
// buildMessage() and send() without triggering a real push.
const runDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (runDirectly) {
  try {
    const input = await readHookInput();
    const cfg = readConfig();
    if (!cfg.ntfyTopic) process.exit(0);          // pushes are opt-in: no topic, no network

    const event = input.hook_event_name === "Notification" ? "Notification" : "Stop";
    const date = now();
    let minutes = 0;
    if (event === "Stop") {
      // How long did this turn take? (gate.mjs saved the start time.)
      const start = turnStart(input.session_id);
      if (!start) process.exit(0);
      const seconds = (date - start) / 1000;
      if (seconds < cfg.minTurnSeconds) process.exit(0);
      minutes = Math.floor(seconds / 60);
    }
    const msg = buildMessage(event, cfg, { folder: path.basename(projectDir(input)), minutes });
    const ok = await send(cfg, msg);
    logEvent("push", { event, ok });
  } catch {
    // never fail a hook
  }
  process.exit(0);
}
