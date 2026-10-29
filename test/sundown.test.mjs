// Tests for Sundown. Run with:  node --test test/*.test.mjs
//
// Every test gets its own temporary SUNDOWN_DIR and fake "now" (SUNDOWN_NOW), so the
// tests never touch your real ~/.sundown and give the same result at any time of day.
// Hooks are run exactly as Claude Code runs them: a child process with JSON on stdin.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Repo root, so tests can find scripts/ and bin/ whatever the working directory is.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Path to a hook script, e.g. script("gate.mjs").
const script = (name) => path.join(ROOT, "scripts", name);
// The command-line tool a person runs in their terminal.
const BIN = path.join(ROOT, "bin", "sundown");

// Make a throwaway folder in the OS temp dir. Every test uses fresh ones so tests can't affect each other.
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A fresh world: state dir, project dir, and an empty Claude config dir.
// The default config is a 21:00 cutoff and 08:00 morning, so most tests share the same clock maths.
function world(config = { cutoff: "21:00", morning: "08:00" }) {
  // SUNDOWN_DIR points here: Sundown's state (config, lock, passes, events) lives in this folder.
  const state = tmp("sd-state-");
  // A pretend project folder: where TOMORROW.md is read and written.
  const project = tmp("sd-proj-");
  // A pretend ~/.claude: holds settings.json and the session logs that report reads.
  const claude = tmp("sd-claude-");
  // Write the config first so Sundown sees a set-up install (no first-run welcome note).
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  return { state, project, claude };
}

// Run a hook script synchronously, like Claude Code does.
// nowIso becomes SUNDOWN_NOW, the fake clock. The hook sees that moment as "now", so results don't depend on when the test runs.
function hook(w, name, input, nowIso) {
  // Same shape as Claude Code: the hook is a child process, the event arrives as JSON on stdin.
  const r = spawnSync("node", [script(name)], {
    // Default session id is sess1 and cwd is the fake project; a test can override either through input.
    input: JSON.stringify({ session_id: "sess1", cwd: w.project, ...input }),
    // CLAUDE_CONFIG_DIR keeps the real ~/.claude out of the test.
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude },
    encoding: "utf8",
  });
  // code is the exit status (2 means Claude Code drops the prompt), out is stdout (JSON for Claude Code), err is stderr (shown to the user).
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Run bin/sundown like a person would. The default fake time, 15:00, is mid-afternoon, so Sundown is not active.
function cli(w, args, nowIso = "2026-10-29T15:00:00") {
  const r = spawnSync("node", [BIN, ...args], {
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Read the event log as text. Missing file means nothing was logged, so return an empty string.
const events = (w) => {
  try { return fs.readFileSync(path.join(w.state, "events.log"), "utf8"); } catch { return ""; }
};

// ---------------------------------------------------------------------------
// Time logic
// ---------------------------------------------------------------------------

// Protects the core time rule: quiet from the cutoff through the night until morning, and an empty cutoff turns it off.
// If this broke, Sundown would block at the wrong hour or never unblock.
test("quiet hours cross midnight and an empty cutoff means never quiet", async () => {
  // isQuiet decides if a moment falls in quiet hours. nextMorningAfter finds when quiet hours end.
  const { isQuiet, nextMorningAfter } = await import(script("lib.mjs"));
  // 21:00 cutoff, 08:00 morning: quiet runs 21:00 to 08:00 across midnight.
  const cfg = { cutoff: "21:00", morning: "08:00" };
  // One minute before the cutoff is still open.
  assert.equal(isQuiet(new Date("2026-10-29T20:59:00"), cfg), false);
  // The cutoff minute itself is quiet.
  assert.equal(isQuiet(new Date("2026-10-29T21:00:00"), cfg), true);
  // 02:00 is after midnight but still inside last night's quiet window.
  assert.equal(isQuiet(new Date("2026-10-30T02:00:00"), cfg), true);
  // 08:00 is the morning time, so quiet ends exactly then.
  assert.equal(isQuiet(new Date("2026-10-30T08:00:00"), cfg), false);
  // An empty cutoff means no quiet hours at all, even at 23:00.
  assert.equal(isQuiet(new Date("2026-10-29T23:00:00"), { cutoff: "", morning: "08:00" }), false);
  // Shutting down at 18:00 lasts until 08:00 the next day; at 02:00, until 08:00 the same day.
  // 18:00 is before the cutoff, so the next morning is the 30th.
  assert.equal(nextMorningAfter(new Date("2026-10-29T18:00:00"), cfg).getDate(), 30);
  // 02:00 on the 30th is already past midnight, so the next morning is that same day, the 30th.
  assert.equal(nextMorningAfter(new Date("2026-10-30T02:00:00"), cfg).getDate(), 30);
});

// Protects the state folder: the session id becomes a file name, so a hostile id like ../../etc/passwd must never be usable as a path.
test("session ids that could escape ~/.sundown are refused", async () => {
  const { safeId } = await import(script("lib.mjs"));
  // Letters, digits, dash and underscore are fine and returned unchanged.
  assert.equal(safeId("abc-123_X"), "abc-123_X");
  // Each bad id returns null: path traversal, a slash, empty, not a string, a number, and an id of 200 characters (too long).
  for (const bad of ["../../etc/passwd", "a/b", "", null, 42, "x".repeat(200)]) assert.equal(safeId(bad), null);
});

// ---------------------------------------------------------------------------
// gate.mjs (UserPromptSubmit)
// ---------------------------------------------------------------------------

// Protects the main promise: prompts pass during the day and are dropped after the cutoff.
test("gate: lets prompts through in the day, blocks after the cutoff", () => {
  const w = world();
  // 15:00 is before the 21:00 cutoff: exit 0 lets the prompt through.
  assert.equal(hook(w, "gate.mjs", { prompt: "add a test" }, "2026-10-29T15:00:00").code, 0);
  // 22:00 is after the cutoff.
  const night = hook(w, "gate.mjs", { prompt: "one more thing" }, "2026-10-29T22:00:00");
  // Exit code 2 is how Claude Code knows to drop the prompt.
  assert.equal(night.code, 2);
  // The message shown to the user names the cutoff time. The regex matches "after your 21:00 cutoff".
  assert.match(night.err, /after your 21:00 cutoff/);
  // The block is recorded in the event log as type "blocked" (the regex looks for that JSON field), which the report uses.
  assert.match(events(w), /"type":"blocked"/);
});

// Privacy promise: the text you type must never be written to disk, even when it is blocked or overridden.
test("gate: never stores the prompt text", () => {
  const w = world();
  // A blocked prompt (22:00 is after the cutoff) carrying a secret string.
  hook(w, "gate.mjs", { prompt: "SECRET-PROMPT-TEXT" }, "2026-10-29T22:00:00");
  // Same secret again behind the override prefix, which takes a different code path.
  hook(w, "gate.mjs", { prompt: "override: SECRET-PROMPT-TEXT" }, "2026-10-29T22:00:00");
  // Gather the contents of every file under the state folder, including subfolders such as passes/, into one string.
  const all = fs.readdirSync(w.state, { recursive: true })
    .map((f) => path.join(w.state, f)).filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, "utf8")).join("\n");
  // The secret must not appear anywhere in it.
  assert.doesNotMatch(all, /SECRET-PROMPT-TEXT/);
});

// Protects the escape hatch: "override:" lets one message through after the cutoff, is counted, and starts a short pass for the session.
test("gate: override: goes through, is logged, and gives a pass", () => {
  const w = world();
  // 22:00 is after the cutoff, so without the prefix this would be blocked.
  const r = hook(w, "gate.mjs", { prompt: "override: fix the typo" }, "2026-10-29T22:00:00");
  // Exit 0: the prompt goes through.
  assert.equal(r.code, 0);
  // stdout is added to Claude's context and mentions the override, so Claude keeps the work small.
  assert.match(r.out, /override/);
  // The override is logged, so the report can count it.
  assert.match(events(w), /"type":"override"/);
  // The pass is a file named after the session id (sess1); later messages check for it.
  assert.ok(fs.existsSync(path.join(w.state, "passes", "sess1")));
});

// Protects the manual lock: /sundown:shutdown starts it, /sundown:wake ends it, and status-type commands always work.
test("gate: /sundown:shutdown sets the lock, /sundown:wake clears it, other /sundown: commands pass at night", () => {
  const w = world();
  // 18:00 is before the cutoff, so only the explicit command can cause the lock.
  const s = hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // Exit 0: the command itself is not blocked.
  assert.equal(s.code, 0);
  // stdout tells Claude the exact time. 08:00 is the next morning, reported in the message.
  assert.match(s.out, /lock is now ON until 08:00/);
  // The lock file exists on disk, which is what the pause hook looks for.
  assert.ok(fs.existsSync(path.join(w.state, "lock")));
  // While locked, normal prompts are blocked even before the cutoff...
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T18:30:00").code, 2);
  // ...but status still works.
  // /sundown:status passes at 18:30 even though the lock is on.
  assert.equal(hook(w, "gate.mjs", { prompt: "/sundown:status" }, "2026-10-29T18:30:00").code, 0);
  // Wake at 18:40.
  const k = hook(w, "gate.mjs", { prompt: "/sundown:wake" }, "2026-10-29T18:40:00");
  // The wake command itself is let through.
  assert.equal(k.code, 0);
  // The lock file is gone.
  assert.ok(!fs.existsSync(path.join(w.state, "lock")));
  // Awake until the next cutoff (21:00), then quiet hours apply again.
  // 19:00 is before the cutoff and the user is awake, so the prompt passes.
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T19:00:00").code, 0);
  // 21:30 is after the 21:00 cutoff, so it is blocked again.
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T21:30:00").code, 2);
});

// Protects the fail-open rule: if the hook receives garbage, it must let the prompt through so a Sundown bug never locks anyone out of Claude Code.
test("gate: broken input fails open", () => {
  const w = world();
  // Spawn the script directly with invalid JSON on stdin instead of using hook().
  const r = spawnSync("node", [script("gate.mjs")], {
    input: "not json", env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T15:00:00" }, encoding: "utf8",
  });
  // Exit 0 means the prompt was allowed.
  assert.equal(r.status, 0);
});

// ---------------------------------------------------------------------------
// pause.mjs (PreToolUse)
// ---------------------------------------------------------------------------

// Protects against Sundown interfering in the pause hook when no shutdown happened: late at night alone is not a reason to stop tools.
test("pause: does nothing without a lock, even late at night", () => {
  const w = world();
  // 23:00 is after the cutoff but nobody ran /sundown:shutdown, so there is no lock.
  const r = hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T23:00:00");
  // Exit 0 with empty stdout means the tool call is allowed unchanged.
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

// Protects the shutdown flow end to end: Claude is told to write the handoff, only reads and the handoff are allowed, and once the handoff exists the run stops.
test("pause: while locked, denies work, allows reading and the handoff, then stops", () => {
  const w = world();
  // The lock is set from a different session ("other"), so the session used below (sess1) has no pass.
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");

  // A real work command (npm test) is denied; the output is a JSON permission decision.
  const deny = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, "2026-10-29T18:01:00").out);
  // The decision is "deny".
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  // The reason tells Claude to write TOMORROW.md, which is how the agent knows what to do instead.
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /TOMORROW\.md/);

  // Read is a read-only tool: allowed, so Claude can look at its work to write an accurate handoff. Empty output means allow.
  assert.equal(hook(w, "pause.mjs", { tool_name: "Read", tool_input: { file_path: "a.js" } }, "2026-10-29T18:01:00").out, "");
  // The handoff file for this project.
  const handoff = path.join(w.project, "TOMORROW.md");
  // Writing the project's own TOMORROW.md is allowed.
  assert.equal(hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: handoff } }, "2026-10-29T18:01:00").out, "");
  // Writing any other file (app.js) is denied, so non-empty output.
  assert.notEqual(hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: path.join(w.project, "app.js") } }, "2026-10-29T18:01:00").out, "");

  // Claude writes the handoff (we set its time to 18:02, after the lock).
  // Claude writes the handoff (we set its time to 18:02, after the lock).
  // The three-line handoff format Claude is asked for.
  fs.writeFileSync(handoff, "Stopped at: x\nFirst step tomorrow: y\nOpen question: none\n");
  // File times are real clock time; the lock stores both the fake and the real clock, so a file touched at a fake 18:02 counts as after the lock at 18:00.
  const t = new Date("2026-10-29T18:02:00");
  fs.utimesSync(handoff, t, t);
  // Any further tool call at 18:03 now finds the handoff newer than the lock.
  const stop = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, "2026-10-29T18:03:00").out);
  // continue:false stops the agent for good instead of just refusing one tool.
  assert.equal(stop.continue, false);
  // The stop message tells the user when work resumes (08:00).
  assert.match(stop.stopReason, /paused until 08:00/);
});

// Protects the override for already-running agents: a session with a recent override can keep working for a limited time, and everything resumes after the morning.
test("pause: an override pass lets that session work; the lock ends in the morning", () => {
  const w = world();
  // Lock set at 18:00 by a different session.
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // This session (sess1) overrides at 18:10, which grants a pass.
  hook(w, "gate.mjs", { prompt: "override: hotfix" }, "2026-10-29T18:10:00");
  // 18:15 is inside the pass: Bash is allowed.
  assert.equal(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T18:15:00").out, "");
  // Pass expires after 20 minutes.
  // 18:45 is 35 minutes after the override, past the default 20-minute pass, so it is denied again.
  assert.notEqual(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, "2026-10-29T18:45:00").out, "");
  // Next morning: allowed again.
  // 08:01 the next morning is after the lock's end time (08:00), so the lock no longer applies.
  assert.equal(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-30T08:01:00").out, "");
});

// ---------------------------------------------------------------------------
// morning.mjs (SessionStart)
// ---------------------------------------------------------------------------

// Protects the morning greeting: yesterday's handoff is shown to the user and passed to Claude as context, and an expired lock is cleaned up.
test("morning: shows a fresh TOMORROW.md to you and to Claude, and clears an expired lock", () => {
  const w = world();
  // Lock at 18:00 (until 08:00 next day).
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const handoff = path.join(w.project, "TOMORROW.md");
  // A handoff file in the project, as Claude would have written it.
  fs.writeFileSync(handoff, "Stopped at: parser\nFirst step tomorrow: fix test 3\nOpen question: none\n");
  // Make its modified time 18:02 on the 29th, so it is fresh when morning comes.
  const t = new Date("2026-10-29T18:02:00");
  fs.utimesSync(handoff, t, t);

  // 23:00 is still shut down, so the session start only says so and doesn't show the handoff yet.
  const night = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T23:00:00").out);
  // The message includes the end time, 08:00.
  assert.match(night.systemMessage, /shut down for today \(until 08:00\)/);

  // 09:00 next day is after the lock ended.
  const r = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-30T09:00:00").out);
  // systemMessage is what the user sees.
  assert.match(r.systemMessage, /Good morning/);
  // additionalContext is what Claude gets; it must include the handoff text ("fix test 3").
  assert.match(r.hookSpecificOutput.additionalContext, /fix test 3/);
  // The expired lock file is deleted.
  assert.ok(!fs.existsSync(path.join(w.state, "lock")));
});

// Protects against showing junk: with no handoff nothing is printed, and a handoff older than 4 days is ignored.
test("morning: ignores a stale handoff and prints nothing without one", () => {
  // No TOMORROW.md at all: empty output.
  const w = world();
  assert.equal(hook(w, "morning.mjs", {}, "2026-10-30T09:00:00").out, "");
  // A file whose content isn't important; only its age is.
  const handoff = path.join(w.project, "TOMORROW.md");
  // Stamp it Oct 1, almost a month before the fake now (Oct 30), so it is stale (over 4 days).
  fs.writeFileSync(handoff, "old");
  const t = new Date("2026-10-01T18:00:00");
  fs.utimesSync(handoff, t, t);
  // Still nothing to print.
  assert.equal(hook(w, "morning.mjs", {}, "2026-10-30T09:00:00").out, "");
});

// ---------------------------------------------------------------------------
// push.mjs (Notification + Stop)
// ---------------------------------------------------------------------------

// Protects privacy of push notifications: by default the text never names the project, only the duration; folder names appear only if the user opts in.
test("push: message text is generic unless pushDetail is folder", async () => {
  // buildMessage makes the notification title and body. It is imported directly, no network involved.
  const { buildMessage } = await import(script("push.mjs"));
  // Stop event, pushDetail none, a secret folder name, 14 minutes.
  const a = buildMessage("Stop", { pushDetail: "none" }, { folder: "secret-project", minutes: 14 });
  // The secret folder name must not be in the body.
  assert.doesNotMatch(a.body, /secret-project/);
  // The duration is still given, as "14 min".
  assert.match(a.body, /14 min/);
  // A Notification event with pushDetail "folder" and zero minutes.
  const b = buildMessage("Notification", { pushDetail: "folder" }, { folder: "my-app", minutes: 0 });
  // With the folder option on, the folder name appears in the body.
  assert.match(b.body, /my-app/);
});

// Run push.mjs against a local fake ntfy server and collect what it receives.
// Run push.mjs for real, with a fake ntfy server on localhost so nothing leaves the machine. Returns the requests the server received.
async function pushRun(w, input, nowIso) {
  // Every request the fake server sees, as url, title header and body.
  const received = [];
  // The fake server records the topic path, the Title header and the request body.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push({ url: req.url, title: req.headers.title, body }); res.end("ok"); });
  });
  // Port 0 lets the OS pick a free port, so tests can't clash.
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // Point the config's ntfyServer at the fake server; the other settings stay.
  const cfg = JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8"));
  cfg.ntfyServer = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(w.state, "config.json"), JSON.stringify(cfg));
  // Wait until the child process exits, so every request has been sent before we look.
  await new Promise((resolve) => {
    // NO_PROXY keeps a developer's proxy settings from intercepting requests to localhost.
    const child = spawn("node", [script("push.mjs")], {
      env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    });
    // Send the hook event on stdin like Claude Code does, then close stdin.
    child.stdin.end(JSON.stringify({ session_id: "sess1", cwd: w.project, ...input }));
    child.on("exit", resolve);
  });
  server.close();
  return received;
}

// Protects the phone alert rules: it fires after a long turn and on notifications, and never without a topic or for a short turn.
test("push: sends after a long turn and on notifications; never without a topic or after a short turn", async () => {
  // ntfyTopic is the channel to publish to; minTurnSeconds is 60, so only turns of a minute or more are reported.
  const w = world({ cutoff: "21:00", morning: "08:00", ntfyTopic: "sundown-test-topic", minTurnSeconds: 60 });
  // The gate hook records when the turn started (15:00:00); push uses it to compute duration.
  hook(w, "gate.mjs", { prompt: "big refactor" }, "2026-10-29T15:00:00");

  // Stop at 15:00:30 is only 30 seconds after the start, below the 60-second limit.
  const short = await pushRun(w, { hook_event_name: "Stop" }, "2026-10-29T15:00:30");
  // Nothing was sent.
  assert.equal(short.length, 0);

  // Stop at 15:14:00 is 14 minutes after the start.
  const long = await pushRun(w, { hook_event_name: "Stop" }, "2026-10-29T15:14:00");
  // Exactly one request was sent.
  assert.equal(long.length, 1);
  // It went to the configured topic.
  assert.equal(long[0].url, "/sundown-test-topic");
  // The body says how long the turn took.
  assert.match(long[0].body, /finished after 14 min/);

  // A Notification event (Claude is waiting for the user) is sent regardless of turn length.
  const note = await pushRun(w, { hook_event_name: "Notification" }, "2026-10-29T15:20:00");
  // Its title is the fixed text for that case.
  assert.equal(note[0].title, "Claude needs you");

  // A world with no ntfyTopic configured, which is the default.
  const off = world();
  // Without a topic, nothing is sent.
  assert.equal((await pushRun(off, { hook_event_name: "Notification" }, "2026-10-29T15:20:00")).length, 0);
});

// ---------------------------------------------------------------------------
// report.mjs and the CLI
// ---------------------------------------------------------------------------

// Protects the report's privacy and counting rules: it counts only real human prompts by time, ignores machine messages, never prints the prompt text.
test("report: counts only human prompts by time, never shows their text", () => {
  const w = world();
  // The Claude session logs are JSON-lines files under projects/<folder>.
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  // One JSON line per log entry.
  const line = (o) => JSON.stringify(o) + "\n";
  // Timestamps in the log are UTC ISO strings; this converts the local fake time to that.
  const at = (iso) => new Date(iso).toISOString();
  // Entries, in order: a daytime prompt (14:00), an evening one (22:30), one at 01:10 after midnight, the same uuid repeated as a duplicate (must be counted once), a meta entry (skill text, not typed by the user), a tool_result (a machine reply), and an assistant message. Only the first three prompts are real.
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    line({ type: "user", uuid: "1", timestamp: at("2026-10-28T14:00:00"), message: { content: "PRIVATE day prompt" } }) +
    line({ type: "user", uuid: "2", timestamp: at("2026-10-28T22:30:00"), message: { content: "PRIVATE late prompt" } }) +
    line({ type: "user", uuid: "3", timestamp: at("2026-10-29T01:10:00"), message: { content: "PRIVATE very late" } }) +
    line({ type: "user", uuid: "3", timestamp: at("2026-10-29T01:10:00"), message: { content: "duplicate" } }) +
    line({ type: "user", uuid: "4", timestamp: at("2026-10-28T23:00:00"), isMeta: true, message: { content: "skill text" } }) +
    line({ type: "user", uuid: "5", timestamp: at("2026-10-28T23:00:00"), message: { content: [{ type: "tool_result", content: "x" }] } }) +
    line({ type: "assistant", uuid: "6", timestamp: at("2026-10-28T23:00:00"), message: { content: "answer" } }));

  // Report for the last 3 days, with now at 15:00 on the 29th.
  const r = cli(w, ["report", "3"], "2026-10-29T15:00:00");
  // It ran without error.
  assert.equal(r.code, 0, r.err);
  // No prompt text anywhere in the output.
  assert.doesNotMatch(r.out, /PRIVATE/);
  // Wed 28 Oct: 3 prompts, 2 in the evening, last one at 01:10 (after midnight still counts as Wednesday).
  // The row for Wed 28 Oct: 3 prompts, 2 in the evening (after the 21:00 cutoff), last at 01:10. The regex allows any amount of spaces between columns.
  assert.match(r.out, /Wed 28 Oct\s+3\s+2\s+01:10/);
  // The latest finish is 01:10, counted as part of the 28th's working day.
  assert.match(r.out, /Latest finish: 01:10/);
  // The HTML report is also written to the state folder.
  const html = fs.readFileSync(path.join(w.state, "report.html"), "utf8");
  // The HTML must not contain prompt text either.
  assert.doesNotMatch(html, /PRIVATE/);
});

// Protects config safety: bad values are rejected with exit 1 and nothing is half-saved, and the generated ntfy topic is random so strangers can't subscribe.
test("cli: config validates input and generates an unguessable topic", () => {
  const w = world();
  // 25:00 is not a valid time.
  assert.equal(cli(w, ["config", "cutoff", "25:00"]).code, 1);
  // A file:// URL is not an allowed ntfy server (only http/https).
  assert.equal(cli(w, ["config", "ntfyServer", "file:///etc/passwd"]).code, 1);
  // A setting that doesn't exist.
  assert.equal(cli(w, ["config", "nope", "1"]).code, 1);
  // "off" is valid for the cutoff.
  assert.equal(cli(w, ["config", "cutoff", "off"]).code, 0);
  // "generate" makes a random topic.
  const g = cli(w, ["config", "ntfyTopic", "generate"]);
  // The topic is "sundown-" plus 24 hex characters, which is hard to guess.
  assert.match(g.out, /sundown-[0-9a-f]{24}/);
  // Read back the saved config.
  const saved = JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8"));
  // "off" was stored as an empty cutoff.
  assert.equal(saved.cutoff, "");
  // State files are private to you (owner read/write only).
  assert.equal(fs.statSync(path.join(w.state, "config.json")).mode & 0o777, 0o600);
});

// Protects other tools' settings: Sundown never replaces someone else's status line unless forced, and a forced install keeps the other settings.
test("cli: install-statusline never overwrites someone else's status line without --force", () => {
  const w = world();
  // settings.json in the fake Claude config folder, already holding another status line command and an unrelated theme.
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "my-own-line" }, theme: "dark" }));
  // Without --force it refuses (exit 1).
  assert.equal(cli(w, ["install-statusline"]).code, 1);
  // The user's own command is still in the file.
  assert.match(fs.readFileSync(settings, "utf8"), /my-own-line/);
  // With --force it replaces the status line.
  assert.equal(cli(w, ["install-statusline", "--force"]).code, 0);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  // The new command points at sundown.
  assert.match(after.statusLine.command, /sundown/);
  // The theme setting was not touched.
  assert.equal(after.theme, "dark"); // other settings kept
  // A backup copy of the original file was made.
  assert.ok(fs.existsSync(`${settings}.sundown-backup`));
});

// Protects the pass rules: a pass covers only the session that overrode, only for a limited time, and a shutdown cancels it.
test("gate: an override pass covers that session's next messages, and shutdown cancels it", () => {
  const w = world();
  // Session sess1 overrides at 22:00 (after the cutoff).
  hook(w, "gate.mjs", { prompt: "override: quick fix" }, "2026-10-29T22:00:00");
  // 5 minutes later the same session is let through without the prefix.
  assert.equal(hook(w, "gate.mjs", { prompt: "and the test" }, "2026-10-29T22:05:00").code, 0);
  // A different session has no pass and is blocked.
  assert.equal(hook(w, "gate.mjs", { session_id: "someone-else", prompt: "hi" }, "2026-10-29T22:05:00").code, 2);
  // 30 minutes later the 20-minute pass has expired.
  assert.equal(hook(w, "gate.mjs", { prompt: "later" }, "2026-10-29T22:30:00").code, 2); // pass expired
  // A fresh override at 22:40 gives a new pass.
  hook(w, "gate.mjs", { prompt: "override: one more" }, "2026-10-29T22:40:00");
  // Another session runs /sundown:shutdown at 22:41.
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T22:41:00");
  // The shutdown cancels all passes, so sess1 is blocked again.
  assert.equal(hook(w, "gate.mjs", { prompt: "still there?" }, "2026-10-29T22:42:00").code, 2);
});

// ---------------------------------------------------------------------------
// Days off, the wrap-up note, first run, and the fixes from review
// ---------------------------------------------------------------------------

// Protects the days-off feature: whole days are quiet, Friday night carries over to Monday morning, and the morning check on a day off stays quiet.
test("days off: quiet all day, Friday evening runs to Monday morning, and morning on a day off stays quiet", async () => {
  // isDayOff says whether a moment falls on a day off; sundownState gives the reason and the end time.
  const { sundownState, isDayOff } = await import(script("lib.mjs"));
  // Saturday and Sunday are days off.
  const cfg = { cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" };
  // 2026-10-31 is a Saturday.
  // Saturday afternoon.
  assert.equal(isDayOff(new Date("2026-10-31T14:00:00"), cfg), true);
  assert.equal(isDayOff(new Date("2026-10-31T02:00:00"), cfg), false); // still Friday night
  assert.equal(isDayOff(new Date("2026-11-02T07:00:00"), cfg), true);  // still Sunday night
  assert.equal(isDayOff(new Date("2026-11-02T09:00:00"), cfg), false);
  // Friday 22:00 is after the cutoff, so the reason is "quiet", not "dayoff".
  const fri = sundownState(new Date("2026-10-30T22:00:00"), cfg);
  // The reason is quiet hours.
  assert.equal(fri.why, "quiet");
  // Quiet lasts until Monday (getDay 1), because the weekend is off.
  assert.equal(fri.until.getDay(), 1); // Monday
  // Saturday afternoon is a day off all day.
  assert.equal(sundownState(new Date("2026-10-31T14:00:00"), cfg).why, "dayoff");
});

// Protects the user-facing message: on a day off the gate blocks and says when it ends.
test("days off: the gate holds prompts back on a day off and says so", () => {
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  // 2026-10-31 is a Saturday, 14:00, well before any cutoff.
  const r = hook(w, "gate.mjs", { prompt: "quick thing" }, "2026-10-31T14:00:00");
  // Blocked.
  assert.equal(r.code, 2);
  // The message names the day off and the end "Mon 08:00".
  assert.match(r.err, /day off \(until Mon 08:00\)/);
  // Friday afternoon is a normal day, so the prompt passes.
  assert.equal(hook(w, "gate.mjs", { prompt: "quick thing" }, "2026-10-30T14:00:00").code, 0); // Friday
});

// Protects day-name parsing: names are accepted in any case and normalised, while nonsense, duplicates, and an all-days-off week are rejected.
test("cli: daysOff accepts day names and rejects nonsense", () => {
  const w = world();
  // Mixed case and a space are fine.
  assert.equal(cli(w, ["config", "daysOff", "Sat, Sun"]).code, 0);
  // It is saved in the normalised form "sat,sun".
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).daysOff, "sat,sun");
  // Not a day name.
  assert.equal(cli(w, ["config", "daysOff", "funday"]).code, 1);
  // The same day twice.
  assert.equal(cli(w, ["config", "daysOff", "sat,sat"]).code, 1);
  assert.equal(cli(w, ["config", "daysOff", "mon,tue,wed,thu,fri,sat,sun"]).code, 1); // keep one working day
  // "off" clears the setting.
  assert.equal(cli(w, ["config", "daysOff", "off"]).code, 0);
});

// Protects the wrap-up heads-up: one short note before the cutoff, only once per day, shown to the user and told to Claude, and it can be turned off.
test("wrap-up: one note shortly before the cutoff, once a day, to you and to Claude", () => {
  const w = world();
  // 20:00 is 60 minutes before the cutoff, outside the default 20-minute window, so no note.
  assert.equal(hook(w, "gate.mjs", { prompt: "a" }, "2026-10-29T20:00:00").out, ""); // 60 min left: nothing
  // 20:40 is 20 minutes before 21:00, inside the window.
  const first = hook(w, "gate.mjs", { prompt: "b" }, "2026-10-29T20:40:00");
  // The prompt is not blocked.
  assert.equal(first.code, 0);
  // Output is JSON with a message for the user and context for Claude.
  const note = JSON.parse(first.out);
  // The user message says 20 minutes are left.
  assert.match(note.systemMessage, /20 min to your 21:00 cutoff/);
  // Claude is told to prefer a clean stopping point.
  assert.match(note.hookSpecificOutput.additionalContext, /clean stopping point/);
  // 20:50 is still in the window, but the note was already shown today, so nothing.
  assert.equal(hook(w, "gate.mjs", { prompt: "c" }, "2026-10-29T20:50:00").out, ""); // already shown today
  // The next evening the note appears again.
  assert.notEqual(hook(w, "gate.mjs", { prompt: "d" }, "2026-10-30T20:45:00").out, ""); // next day: again

  // wrapUpMinutes 0 turns the note off.
  const off = world({ cutoff: "21:00", morning: "08:00", wrapUpMinutes: 0 });
  // Same time as above that would normally trigger it, but nothing now.
  assert.equal(hook(off, "gate.mjs", { prompt: "b" }, "2026-10-29T20:40:00").out, "");
});

// Protects first-run behaviour: a new install gets one note about /sundown:setup and then stays silent.
test("morning: points a brand-new install at /sundown:setup, once", () => {
  // No config.json is written here, so this is a brand-new install.
  const state = tmp("sd-state-");
  // The world object by hand, since world() would create a config.
  const w = { state, project: tmp("sd-proj-"), claude: tmp("sd-claude-") };
  // First session start.
  const first = hook(w, "morning.mjs", {}, "2026-10-29T10:00:00");
  // The regex matches the literal text "/sundown:setup" (slash escaped).
  assert.match(JSON.parse(first.out).systemMessage, /\/sundown:setup/);
  // A second session start prints nothing.
  assert.equal(hook(w, "morning.mjs", {}, "2026-10-29T11:00:00").out, "");
});

// Protects the handoff rule: only this project's TOMORROW.md is writable during shutdown, not a same-named file elsewhere.
test("pause: during shutdown only this project's TOMORROW.md counts as the handoff", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // A TOMORROW.md in an unrelated temp folder.
  const elsewhere = path.join(tmp("sd-elsewhere-"), "TOMORROW.md");
  // Writing it is denied.
  const r = hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: elsewhere } }, "2026-10-29T18:01:00");
  // The permission decision is "deny".
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny");
  // A relative path resolves against the project folder, so it is the real handoff.
  const rel = hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: "TOMORROW.md" } }, "2026-10-29T18:01:00");
  // Allowed (empty output).
  assert.equal(rel.out, "");
});

// Protects the lock from Claude itself: CLAUDECODE is set in Claude's shell, so wake is refused there, but works in the user's own terminal.
test("cli: Claude can't wake or shut down Sundown from its shell; you can", () => {
  const w = world();
  // Run the CLI with extra environment variables on top of the fake clock (22:00, after the cutoff).
  const run = (args, extra) => spawnSync("node", [BIN, ...args], {
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T22:00:00", CLAUDE_CONFIG_DIR: w.claude, ...extra },
    encoding: "utf8",
  });
  // CLAUDECODE=1 pretends to be Claude's shell.
  const claude = run(["wake"], { CLAUDECODE: "1" });
  // Exit 1: refused.
  assert.equal(claude.status, 1);
  // The error says only the user can wake it.
  assert.match(claude.stderr, /only you can wake/);
  // The awake file was not created, so nothing changed.
  assert.ok(!fs.existsSync(path.join(w.state, "awake")));
  // Copy the environment and remove CLAUDECODE, as in a normal terminal. Needed because the test itself may be running inside Claude Code.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // Same command from the user's terminal.
  const you = spawnSync("node", [BIN, "wake"], {
    env: { ...env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T22:00:00", CLAUDE_CONFIG_DIR: w.claude },
    encoding: "utf8",
  });
  // It succeeds.
  assert.equal(you.status, 0, you.stderr);
  // The awake file now exists.
  assert.ok(fs.existsSync(path.join(w.state, "awake")));
});

// Protects the user's original settings: running install-statusline again must not overwrite the first backup with Sundown's own settings.
test("cli: re-running install-statusline keeps the backup of your original settings", () => {
  const w = world();
  const settings = path.join(w.claude, "settings.json");
  // Start with someone else's status line.
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "my-own-line" } }));
  // First install, forced: makes the backup.
  assert.equal(cli(w, ["install-statusline", "--force"]).code, 0);
  // Second install without --force works because the status line is now Sundown's, and must not redo the backup.
  assert.equal(cli(w, ["install-statusline"]).code, 0); // e.g. after updating Sundown
  // The backup still holds the original command.
  assert.match(fs.readFileSync(`${settings}.sundown-backup`, "utf8"), /my-own-line/);
});

// Protects the report for night owls: with a cutoff after midnight (01:00), only the hours after it count as evening.
test("report: a cutoff after midnight counts only those hours as evening", async () => {
  // isEvening says whether a moment counts as an evening prompt.
  const { isEvening } = await import(script("report.mjs"));
  // Cutoff 01:00 and morning 08:00: evening is 01:00 to 08:00.
  const cfg = { cutoff: "01:00", morning: "08:00" };
  // 15:00 is daytime.
  assert.equal(isEvening(new Date("2026-10-29T15:00:00"), cfg), false);
  // 23:00 is before the 01:00 cutoff, so not evening.
  assert.equal(isEvening(new Date("2026-10-29T23:00:00"), cfg), false);
  // 02:00 is after the cutoff.
  assert.equal(isEvening(new Date("2026-10-30T02:00:00"), cfg), true);
});

// Protects the comparison section of the report: this period versus the one before, and a count of mornings that began with a handoff.
test("report: compares with the week before and counts mornings that started from a handoff", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  // Builds one log line for a plain user prompt at the given local time.
  const line = (uuid, iso) => JSON.stringify({ type: "user", uuid, timestamp: new Date(iso).toISOString(), message: { content: "x" } }) + "\n";
  // Log file with three prompts. The comments inside the call explain which is which.
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    // The week before: two late evenings.
    line("a", "2026-10-20T23:00:00") + line("b", "2026-10-21T23:30:00") +
    // This week: one day, finished at 18:00.
    line("c", "2026-10-28T18:00:00"));
  // An event log entry saying a handoff was shown on the 28th, which is inside the 7-day window.
  fs.writeFileSync(path.join(w.state, "events.log"), JSON.stringify({ t: new Date("2026-10-28T09:00:00").toISOString(), type: "handoff" }) + "\n");
  // Seven-day report, now is the 29th at 15:00.
  const r = cli(w, ["report", "7"], "2026-10-29T15:00:00");
  assert.equal(r.code, 0, r.err);
  // This week none of the days ran into the evening (the 18:00 finish is before the 21:00 cutoff), while the week before had 2 evenings.
  assert.match(r.out, /Evenings you kept working: 0 of 7 \(the 7 days before: 2 of 7\)/);
  // Typical finish this week is 18:00; before it is the median of 23:00 and 23:30, which is 23:15.
  assert.match(r.out, /Typical finish: 18:00 \(before: 23:15\)/);
  // One handoff event in the window.
  assert.match(r.out, /Mornings that started from TOMORROW\.md: 1/);
});

// Protects the shutdown lock against shell tricks: only plain read-only commands run while locked, and quoting, redirects, chaining, expansions and writer flags are all denied.
test("pause: while locked, only plain read-only shell commands are allowed (no quoting tricks)", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // Runs a Bash command through the pause hook and returns its stdout. Empty means allowed.
  const bash = (command) => hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command } }, "2026-10-29T18:01:00").out;
  // Plain read-only commands: listing, searching, git history and diffs, and a simple pipe into head.
  for (const ok of ["ls -la", "grep -rn -e TODO -e FIXME .", "find . -name main.py", "git log --oneline -5", "git status", "git diff --no-ext-diff --no-textconv", "cat a.txt | head -20"]) {
    // Allowed means no output.
    assert.equal(bash(ok), "", `should allow: ${ok}`);
  }
  // Everything here must be denied. They fall into groups: deleting or writing, command chaining (; && ||), redirects and substitutions, find actions, git writes, other commands that run things, then tricks that hide a flag from a simple text match (quotes, braces), then programs with flags that write files or run commands, then odd syntax (globs, ~, a dangling pipe). Comments at the end of some lines are the existing ones.
  const bad = [
    "rm -rf .", "ls; rm -rf .", "cat a > b", "echo $(whoami)", "find . -delete", "find . -exec rm {} +", "git push",
    "git commit -am x", "npm test", "sundown wake", "ls && npm test", "ls || npm test",
    "find . -ex''ec touch pwn {} +", "find . -d\"\"elete", "find . -{delete,}", "find . -fprint out", // quoting and brace tricks
    "sort -ofile in", "uniq in out", "rg --pre sh x .", "tree -o f", "tail -f log",                       // programs that can write or run things
    "git diff --output=x", "git log --ext-diff", "git diff", "git show HEAD", "git log -p", "ls *.py", "cat ~/secret", "ls |",
  ];
  // Each one must produce a deny decision.
  for (const command of bad) {
    // The command is in the failure message so a regression shows which one slipped through.
    assert.equal(JSON.parse(bash(command)).hookSpecificOutput.permissionDecision, "deny", `should deny: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// Fixes from the agent test round (1.1.1)
// ---------------------------------------------------------------------------

// Run the CLI like Claude's shell (CLAUDECODE=1) or like your own terminal (unset).
// Run the CLI like Claude's shell (CLAUDECODE=1) or like your own terminal (unset).
function cliAs(who, w, args, nowIso = "2026-10-29T15:00:00") {
  const env = { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude };
  if (who === "claude") env.CLAUDECODE = "1"; else delete env.CLAUDECODE;
  const r = spawnSync("node", [BIN, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Protects the stop mechanism: after the handoff exists, the tool call is denied as well as the run stopped. Stopping alone still let that call run in real Claude Code.
test("pause: once the handoff exists the triggering tool call is denied AND the run stops", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // The handoff is written right away, so its time is later than the lock.
  const handoff = path.join(w.project, "TOMORROW.md");
  // Valid three-line handoff.
  fs.writeFileSync(handoff, "Stopped at: x\nFirst step tomorrow: y\nOpen question: none\n");
  // A tool call at 18:03 after the handoff exists.
  const out = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "echo hi" } }, "2026-10-29T18:03:00").out);
  // The run is stopped.
  assert.equal(out.continue, false);
  // And this very call is denied.
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

// Protects two things: MultiEdit may write the handoff, but if TOMORROW.md is a symlink the hook refuses, so Claude can't write to another file through it.
test("pause: MultiEdit may write the handoff, but a symlinked TOMORROW.md is never written through", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const handoff = path.join(w.project, "TOMORROW.md");
  // MultiEdit on the handoff, with no file yet, is allowed.
  assert.equal(hook(w, "pause.mjs", { tool_name: "MultiEdit", tool_input: { file_path: handoff } }, "2026-10-29T18:01:00").out, "");
  // A file elsewhere standing in for something that must not be overwritten.
  const victim = path.join(tmp("sd-victim-"), "victim.txt");
  fs.writeFileSync(victim, "keep me");
  // Make TOMORROW.md a symlink to it.
  fs.symlinkSync(victim, handoff);
  // A Write to the symlink path now.
  const r = hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: handoff } }, "2026-10-29T18:01:00");
  // Not allowed: output is not empty (a deny).
  assert.notEqual(r.out, "");
});

// Protects the gate against a malformed cwd: a number instead of text must not crash the hook into fail-open, which would let a blocked prompt through.
test("gate: a non-text cwd can't let a blocked prompt through", () => {
  const w = world();
  // Spawned directly because hook() always sets a text cwd.
  const r = spawnSync("node", [script("gate.mjs")], {
    // 23:00 is after the cutoff.
    input: JSON.stringify({ session_id: "s", cwd: 123, prompt: "hi" }),
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T23:00:00" }, encoding: "utf8",
  });
  // Still blocked with exit 2.
  assert.equal(r.status, 2);
});

// Protects other people's status lines: a command that only contains the word "sundown" in a path is not treated as Sundown's own.
test("cli: install-statusline only treats its own command as its own", () => {
  const w = world();
  // A custom script in a folder whose name contains sundown.
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "~/sundown-dashboard/my-line.sh" } }));
  // Without --force it is refused.
  const r = cli(w, ["install-statusline"]);
  // Exit 1.
  assert.equal(r.code, 1);
  // The user's file is intact.
  assert.match(fs.readFileSync(settings, "utf8"), /sundown-dashboard/);
  // Forced install replaces it.
  assert.equal(cli(w, ["install-statusline", "--force"]).code, 0);
  // Now the command is Sundown's own, so a plain re-run is accepted.
  assert.equal(cli(w, ["install-statusline"]).code, 0); // now it IS ours
});

// Protects honest output: the install message mentions a backup only if one was made.
test("cli: install-statusline only mentions a backup when it made one", () => {
  const w = world();
  // With no existing settings.json there is nothing to back up.
  const first = cli(w, ["install-statusline"]); // no settings.json yet
  // The output says nothing about a backup.
  assert.doesNotMatch(first.out, /backup|saved as/);
  const settings = path.join(w.claude, "settings.json");
  // An existing settings file with no status line.
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  // Now the output says where the backup went.
  assert.match(cli(w, ["install-statusline", "--force"]).out, /saved as settings\.json\.sundown-backup/);
});

// Protects the lock from being loosened by Claude: while Sundown is active, Claude's shell can't change the settings that would loosen it. The user's terminal and daytime setup still work.
test("cli: while Sundown is on, Claude can't loosen it; before the cutoff and in your own terminal it can", () => {
  const w = world();
  // 22:00 on a Thursday is after the 21:00 cutoff, so Sundown is active.
  const night = "2026-10-29T22:00:00"; // Thursday
  // You (not Claude) make Friday a day off, so tonight's quiet time now lasts until Saturday 08:00.
  assert.equal(cliAs("you", w, ["config", "daysOff", "fri"]).code, 0); // Friday is off, so the night lasts to Sat 08:00
  // Each of these would loosen Sundown: switch it off, move the cutoff later, move the morning earlier, remove the day off, lengthen the override.
  for (const [key, value] of [["cutoff", "off"], ["cutoff", "23:59"], ["morning", "06:00"], ["daysOff", "off"], ["overrideMinutes", "240"]]) {
    // Try each one from Claude's shell.
    const r = cliAs("claude", w, ["config", key, value], night);
    // Exit code 1 means it was refused.
    assert.equal(r.code, 1, `${key} ${value} should be refused`);
    assert.match(r.err, /only you can change/);
    assert.match(r.err, new RegExp(`sundown config ${key} ${value}`)); // tells you the command to run yourself
  }
  // Config on disk is unchanged.
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).cutoff, "21:00");
  assert.equal(cliAs("you", w, ["config", "overrideMinutes", "30"], night).code, 0);          // your terminal
  assert.equal(cliAs("claude", w, ["config", "cutoff", "22:00"], "2026-10-29T15:00:00").code, 0); // setup, daytime
  assert.equal(cliAs("claude", w, ["config", "pushDetail", "folder"], night).code, 0);          // not a loosening setting
});

// Protects the config command against missing values wiping a setting, and against unclear errors.
test("cli: config needs a value and shows what you typed when it's wrong", () => {
  const w = world();
  // Each of these has no usable value.
  for (const args of [["config", "cutoff"], ["config", "daysOff", ""], ["config", "wrapUpMinutes"]]) {
    // Exit 1: refused.
    assert.equal(cli(w, args).code, 1, args.join(" "));
  }
  // The cutoff is still 21:00.
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).cutoff, "21:00"); // not wiped
  // abc is not a number.
  const bad = cli(w, ["config", "wrapUpMinutes", "abc"]);
  // Exit 1.
  assert.equal(bad.code, 1);
  // The error shows the value the user typed.
  assert.match(bad.err, /"abc" is not a valid value/);
  // Printing the config shows daysOff as the text "none" when no days are set.
  assert.match(cli(w, ["config"]).out, /"daysOff": "none"/);
});

// Protects the status bar: it shows "time to wrap up" in the same window as the wrap-up note, and not when that is off.
test("cli: the status bar follows wrapUpMinutes", () => {
  const w = world();
  // 20:45 is 15 minutes before the cutoff, inside the default 20-minute window.
  assert.match(cli(w, ["statusline"], "2026-10-29T20:45:00").out, /time to wrap up/);
  // Change the window to 10 minutes.
  cli(w, ["config", "wrapUpMinutes", "10"], "2026-10-29T15:00:00");
  // 15 minutes left is now outside it.
  assert.doesNotMatch(cli(w, ["statusline"], "2026-10-29T20:45:00").out, /wrap up/);
  // 5 minutes left is inside.
  assert.match(cli(w, ["statusline"], "2026-10-29T20:55:00").out, /time to wrap up/);
  // Turn it off.
  cli(w, ["config", "wrapUpMinutes", "off"], "2026-10-29T15:00:00");
  // Even 5 minutes before the cutoff shows nothing.
  assert.doesNotMatch(cli(w, ["statusline"], "2026-10-29T20:55:00").out, /wrap up/);
});

// Protects shutdown on a weekend: it lasts until the next working morning, and the status message is right about whether that is tomorrow or later.
test("days off: shutting down on a day off lasts to the next working morning and says so", () => {
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  // Shutdown on a Saturday at 10:00.
  const r = hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-31T10:00:00"); // Saturday
  // The lock ends Monday 08:00, and the output names the day.
  assert.match(r.out, /ON until Mon 08:00/);
  // Saturday noon: Monday is more than a day away, so the day name is included.
  assert.match(cliAs("you", w, ["status"], "2026-10-31T12:00:00").out, /shut down for today \(until Mon 08:00\)/); // Monday is >24h away
  // Sunday noon: Monday is tomorrow, so just the time.
  assert.match(cliAs("you", w, ["status"], "2026-11-01T12:00:00").out, /shut down for today \(until 08:00\)/);     // Monday is tomorrow
});

// Protects the wake command's honesty and the CLI's error handling.
test("cli: wake says when Sundown wasn't on, and an unknown command is an error", () => {
  const w = world();
  // At 15:00 Sundown wasn't active, so wake says so.
  assert.match(cliAs("you", w, ["wake"], "2026-10-29T15:00:00").out, /wasn't on/);
  // At 22:00 it is active, so wake says the off-time.
  assert.match(cliAs("you", w, ["wake"], "2026-10-29T22:00:00").out, /off until/);
  // An unknown command fails.
  assert.equal(cli(w, ["bogus"]).code, 1);
  // help works.
  assert.equal(cli(w, ["help"]).code, 0);
});

// Protects the user from weak topics: ntfy topics are public by name, so a short one is flagged.
test("cli: a short ntfy topic gets a warning, a generated one doesn't", () => {
  const w = world();
  // A 3-character topic is warned about.
  assert.match(cli(w, ["config", "ntfyTopic", "abc"]).out, /easy to guess/);
  // A generated one is long enough, so no warning.
  assert.doesNotMatch(cli(w, ["config", "ntfyTopic", "generate"]).out, /easy to guess/);
});

// Protects privacy on existing installs: if the folder and config already exist with loose permissions, Sundown fixes them on its next run.
test("state: a folder and config.json that already exist with open permissions get tightened", () => {
  const w = world();
  // Make the folder world-readable (755), and the config too (644).
  fs.chmodSync(w.state, 0o755);
  fs.chmodSync(path.join(w.state, "config.json"), 0o644);
  // Any hook run triggers the check.
  hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T15:00:00");
  // The folder is now owner-only (700).
  assert.equal(fs.statSync(w.state).mode & 0o777, 0o700);
  // The config is owner read/write only (600).
  assert.equal(fs.statSync(path.join(w.state, "config.json")).mode & 0o777, 0o600);
});

// Protects the shutdown warning: on a brand-new install the setup note is added to it, not shown instead of it.
test("morning: the setup nudge doesn't hide the shutdown reminder", () => {
  const state = tmp("sd-state-");
  // Fresh install: no config yet.
  const w = { state, project: tmp("sd-proj-"), claude: tmp("sd-claude-") };
  // Shutdown at 18:00.
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // Session start at 23:00.
  const msg = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T23:00:00").out).systemMessage;
  // Still tells about the shutdown.
  assert.match(msg, /shut down for today/);
  // And also mentions setup.
  assert.match(msg, /\/sundown:setup/);
});

// Protects the report from one outlier: the typical finish uses the median, not the average.
test("report: typical finish is the median, so one very late night doesn't skew it", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  // Builds a log line for a plain prompt at the given local time.
  const line = (uuid, iso) => JSON.stringify({ type: "user", uuid, timestamp: new Date(iso).toISOString(), message: { content: "x" } }) + "\n";
  // Last prompt of three days: 17:00, 17:30, and 23:50. The first two are normal, the third is an outlier.
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    line("a", "2026-10-26T17:00:00") + line("b", "2026-10-27T17:30:00") + line("c", "2026-10-28T23:50:00"));
  // Seven-day report as of the 29th.
  const r = cli(w, ["report", "7"], "2026-10-29T15:00:00");
  // The median finish is 17:30.
  assert.match(r.out, /Typical finish: 17:30/); // an average would say 19:40
});

// ---------------------------------------------------------------------------
// Fixes from the independent review (1.1.3)
// ---------------------------------------------------------------------------

// Protects the gate from a trick: only the bare read-only commands pass at night. If extra text is allowed after them, a task could be smuggled through.
test("gate: /sundown:status (or report, setup) lets only the bare command through; trailing text is a task and is held back", () => {
  const w = world();
  // 23:00 is after the cutoff.
  const night = "2026-10-29T23:00:00";
  // Bare commands, and report with a number of days, pass.
  for (const ok of ["/sundown:status", "/sundown:setup", "/sundown:report", "/sundown:report 30"]) {
    // Exit 0 for each. The command is the failure message.
    assert.equal(hook(w, "gate.mjs", { prompt: ok }, night).code, 0, ok);
  }
  // Each one has extra text or a lookalike name (wakeup, other), so each must be blocked.
  for (const sneaky of ["/sundown:status now write me a feature", "/sundown:report 7 and also refactor", "/sundown:wakeup", "/sundown:other"]) {
    // Exit 2 for each.
    assert.equal(hook(w, "gate.mjs", { prompt: sneaky }, night).code, 2, sneaky);
  }
});

// Protects secrets: if TOMORROW.md is a symlink to another file, its content must never be pasted into a session.
test("morning: a TOMORROW.md that is a symlink is never read into the session", () => {
  const w = world();
  // A secret file elsewhere.
  const secret = path.join(tmp("sd-secret-"), "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET");
  // The project's TOMORROW.md points at it.
  fs.symlinkSync(secret, path.join(w.project, "TOMORROW.md"));
  // 12:00 is in the daytime, so nothing else prints.
  const r = hook(w, "morning.mjs", {}, "2026-10-29T12:00:00");
  // No output at all, so the secret wasn't read.
  assert.equal(r.out, "");
});

// Protects against prompt injection: Claude is told the handoff is notes, not commands.
test("morning: the handoff is given to Claude as notes, not instructions", () => {
  const w = world();
  fs.writeFileSync(path.join(w.project, "TOMORROW.md"), "Stopped at: a\nFirst step tomorrow: b\nOpen question: none\n");
  // Take the text Claude receives.
  const ctx = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T12:00:00").out).hookSpecificOutput.additionalContext;
  // It says the content must never be treated as instructions.
  assert.match(ctx, /never as instructions/);
});

// Protects the Claude-only checks: CLAUDECODE set to an empty string still counts (it's a presence check), and Claude can never change where pushes go, even in the day.
test("cli: an empty CLAUDECODE still counts as Claude's shell, and Claude can't repoint pushes", () => {
  const w = world();
  // Runs the CLI with CLAUDECODE set but empty.
  const run = (args, nowIso) => spawnSync("node", [BIN, ...args], {
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude, CLAUDECODE: "" }, encoding: "utf8",
  });
  // Wake is refused.
  assert.equal(run(["wake"], "2026-10-29T22:00:00").status, 1);
  // Config cutoff off at 22:00 (active) is refused.
  assert.equal(run(["config", "cutoff", "off"], "2026-10-29T22:00:00").status, 1);
  // Setting a push server to an arbitrary host is refused at any time of day, since it could leak notifications.
  assert.equal(run(["config", "ntfyServer", "http://evil.example"], "2026-10-29T15:00:00").status, 1); // even by day
  // The user's terminal is allowed to set a valid https server.
  assert.equal(cliAs("you", w, ["config", "ntfyServer", "https://ntfy.example.org"]).code, 0);          // you can
});

// Protects the report from crashing on odd files in the Claude log folder.
test("report: a folder or unreadable file named *.jsonl doesn't break the report", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  // A directory whose name ends in .jsonl: reading it as a file would fail.
  fs.mkdirSync(path.join(proj, "x.jsonl"), { recursive: true }); // a folder, not a file
  // Seven-day report.
  const r = cli(w, ["report", "7"], "2026-10-29T15:00:00");
  // It still exits 0.
  assert.equal(r.code, 0);
  // And prints the report title.
  assert.match(r.out, /Sundown report/);
});

// Protects the report when the morning time is after noon: the day boundary moves with it, so a 15:00 prompt is still counted for that day.
test("report: today's prompts are counted when the morning time is after noon", () => {
  // No cutoff, morning at 14:00.
  const w = world({ cutoff: "", morning: "14:00" });
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  // One prompt at 15:00 on the 29th.
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    JSON.stringify({ type: "user", uuid: "a", timestamp: new Date("2026-10-29T15:00:00").toISOString(), message: { content: "x" } }) + "\n");
  // Report at 16:00 the same day mentions "Prompts in the evening: N of 1". \d+ matches any number, so it only checks the prompt was counted (1) and not dropped.
  assert.match(cli(w, ["report", "3"], "2026-10-29T16:00:00").out, /Prompts in the evening: 0 of 1 /);
});

// A blank value must be rejected, not saved as 0 (Number(" ") is 0).
test("cli: a blank number is rejected instead of being saved as 0", () => {
  const w = world();
  // A whitespace-only value for a numeric setting is an error (exit code 1).
  assert.equal(cli(w, ["config", "minTurnSeconds", " "]).code, 1);
  // The existing config was not touched: there is still no minTurnSeconds saved.
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).minTurnSeconds, undefined);
});

// ---------------------------------------------------------------------------
// Setup guard (1.1.4) and the read-only shell allowlist
// ---------------------------------------------------------------------------

test("setup: finishes even when run in the evening, in either order", () => {
  // The order the setup skill uses now: morning, days off, then the cutoff last.
  const a = world({});
  const evening = "2026-10-29T22:30:00";
  for (const args of [["morning", "07:00"], ["daysOff", "sat,sun"], ["wrapUpMinutes", "15"], ["cutoff", "21:00"]]) {
    const r = cliAs("claude", a, ["config", ...args], evening);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
  }
  // Even with the cutoff first (which switches Sundown on), the changes that don't loosen it
  // still work: this is the reported bug. An EARLIER morning shortens the night, so that one
  // needs you, and the error says which command to run.
  const b = world({});
  for (const args of [["cutoff", "21:00"], ["daysOff", "sat,sun"], ["morning", "09:00"]]) {
    const r = cliAs("claude", b, ["config", ...args], evening);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
  }
  const early = cliAs("claude", world({}), ["config", "morning", "07:00"], evening);
  assert.equal(early.code, 0, "no cutoff yet, so Sundown is off and nothing is loosened");
  const c = world({});
  cliAs("claude", c, ["config", "cutoff", "21:00"], evening);
  const refused = cliAs("claude", c, ["config", "morning", "07:00"], evening);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /sundown config morning 07:00/);
  const saved = JSON.parse(fs.readFileSync(path.join(b.state, "config.json"), "utf8"));
  assert.equal(saved.morning, "09:00");
  assert.equal(saved.daysOff, "sat,sun");
});

test("guard: re-running setup at night can lengthen the night but not shorten it", () => {
  const w = world(); // cutoff 21:00, morning 08:00
  const night = "2026-10-29T22:30:00";
  assert.equal(cliAs("claude", w, ["config", "morning", "09:00"], night).code, 0);  // later morning: stricter
  assert.equal(cliAs("claude", w, ["config", "daysOff", "sat,sun"], night).code, 0); // extra days off: stricter
  assert.equal(cliAs("claude", w, ["config", "morning", "08:00"], night).code, 1);  // earlier again: loosens
  assert.equal(cliAs("claude", w, ["config", "morning", "22:31"], night).code, 1);  // the one-minute-night trick
  assert.equal(cliAs("claude", w, ["config", "overrideMinutes", "10"], night).code, 0); // shorter overrides: stricter
});

test("guard: an invalid value still gets the normal error, not the guard's", () => {
  const w = world();
  const r = cliAs("claude", w, ["config", "cutoff", "25:00"], "2026-10-29T22:30:00");
  assert.equal(r.code, 1);
  assert.match(r.err, /not a valid value/);
});

test("setup skill: applies the cutoff last and says what to do if a change is refused", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills", "setup", "SKILL.md"), "utf8");
  const cutoffCommand = skill.indexOf("sundown config cutoff <HH:MM>");
  assert.ok(cutoffCommand > skill.indexOf("sundown config morning"), "cutoff command comes after morning");
  assert.ok(cutoffCommand > skill.indexOf("sundown config daysOff"), "cutoff command comes after daysOff");
  assert.match(skill, /only you can change/);
  assert.match(skill, /own terminal/);
});

test("shutdown shell allowlist: refuses programs that run other programs, allows plain reading", async () => {
  const { isReadOnlyBash } = await import(script("lib.mjs"));
  for (const bad of [
    "rg --pre=sh x .", "rg --pre sh x .", "sort --compress-program=sh f", "git diff --ext-diff",
    "git log --ext-diff", "git diff --output=out", "find . -exec rm {} +", "find . -delete",
    "cat a > b", "ls; rm -rf .", "echo hi", "node -e 0", "tail -f log", "grep -r x . | sh",
  ]) assert.equal(isReadOnlyBash(bad), false, bad);
  for (const good of ["cat README.md", "ls -la", "git status", "git log --oneline", "grep -rn -e TODO -e FIXME .", "find . -name x -type f | head"]) {
    assert.equal(isReadOnlyBash(good), true, good);
  }
});

// ---------------------------------------------------------------------------
// Fixes from the second independent review (1.1.5)
// ---------------------------------------------------------------------------

// Run the CLI as Claude's shell and return only the exit code and error text.
function asClaude(w, args, nowIso) {
  // Same helper as above, kept short for the table of cases below.
  return cliAs("claude", w, args, nowIso);
}

// Protects tomorrow's evening: while tonight's lock is on, Claude must not loosen the regular schedule either.
test("cli: while locked, Claude can't loosen the schedule for tomorrow (cutoff, morning, days off)", () => {
  // A weekday with a 21:00 cutoff, 08:00 morning and the weekend off.
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  // You shut down at 14:00 on a Thursday: the lock is on until the next morning.
  assert.equal(cliAs("you", w, ["shutdown"], "2026-10-29T14:00:00").code, 0);
  // Each of these would leave the lock alone tonight but weaken every evening after it.
  for (const args of [["config", "cutoff", "off"], ["config", "cutoff", "23:59"], ["config", "morning", "06:00"], ["config", "daysOff", "off"], ["config", "daysOff", "sat"]]) {
    // Run it as Claude, still during the lock.
    const r = asClaude(w, args, "2026-10-29T14:30:00");
    // Exit code 1 means it was refused.
    assert.equal(r.code, 1, args.join(" "));
  }
  // Changes that keep or tighten the schedule are still fine: an earlier cutoff, a later morning, an extra day off.
  for (const args of [["config", "cutoff", "20:00"], ["config", "morning", "09:00"], ["config", "daysOff", "fri,sat,sun"]]) {
    // Run it as Claude during the lock.
    assert.equal(asClaude(w, args, "2026-10-29T14:30:00").code, 0, args.join(" "));
  }
});

// Protects the same thing at night and on a day off, where "tonight" does not change either.
test("cli: at night or on a day off, Claude can't push the cutoff later or remove it", () => {
  // Weekend off, 21:00 cutoff.
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  // 02:00 on a Friday is still Thursday's quiet time: a later cutoff would weaken tomorrow evening.
  assert.equal(asClaude(w, ["config", "cutoff", "23:59"], "2026-10-30T02:00:00").code, 1);
  // Saturday afternoon is a day off: removing the cutoff must be refused too.
  assert.equal(asClaude(w, ["config", "cutoff", "off"], "2026-10-31T14:00:00").code, 1);
  // An earlier cutoff only tightens, so it is allowed even at 02:00.
  assert.equal(asClaude(w, ["config", "cutoff", "20:00"], "2026-10-30T02:00:00").code, 0);
});

// Protects the promise "stopped at its next tool call": reading is allowed until the handoff exists, not after.
test("pause: once the handoff exists even a read stops the agent", () => {
  // Start a shutdown.
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // Before the handoff, a Read is allowed so Claude can look around.
  assert.equal(hook(w, "pause.mjs", { tool_name: "Read", tool_input: { file_path: "a.js" } }, "2026-10-29T18:01:00").out, "");
  // Claude writes the handoff.
  fs.writeFileSync(path.join(w.project, "TOMORROW.md"), "Stopped at: x\nFirst step tomorrow: y\nOpen question: none\n");
  // Now a plain Read ends the run (continue:false) instead of letting Claude carry on reading.
  const out = JSON.parse(hook(w, "pause.mjs", { tool_name: "Read", tool_input: { file_path: "a.js" } }, "2026-10-29T18:02:00").out);
  assert.equal(out.continue, false);
});

// Protects the time label: "tomorrow 08:00" must not get a weekday just because DST made the day 25 hours long.
test("lib: dayAndTime adds a weekday only for times two or more calendar days away", async () => {
  // Import the helper directly; it is a pure function.
  const { dayAndTime } = await import(path.join(ROOT, "scripts", "lib.mjs"));
  // Thursday 07:00 -> Friday 08:00 is tomorrow: no weekday.
  assert.equal(dayAndTime(new Date("2026-10-30T08:00:00"), new Date("2026-10-29T07:00:00")), "08:00");
  // Saturday 12:00 -> Monday 08:00 is two days away: weekday shown.
  assert.equal(dayAndTime(new Date("2026-11-02T08:00:00"), new Date("2026-10-31T12:00:00")), "Mon 08:00");
});

// Protects the shell allowlist: shortened spellings of --follow (GNU tail accepts them) must not get through.
test("pause: tail only takes a few explicit flags", () => {
  // Start a shutdown.
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  // Helper: run a Bash command through the pause hook and return its output.
  const bash = (command) => hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command } }, "2026-10-29T18:01:00").out;
  // Normal uses are allowed.
  for (const ok of ["tail -n 20 app.log", "tail -20 app.log"]) assert.equal(bash(ok), "", ok);
  // Following (also shortened) is denied because it would never end.
  for (const bad of ["tail -f app.log", "tail --fol app.log", "tail --follow app.log"]) {
    assert.equal(JSON.parse(bash(bad)).hookSpecificOutput.permissionDecision, "deny", bad);
  }
});

// ---------------------------------------------------------------------------
// Handoff reliability, honest wording and tool robustness (1.1.6)
// ---------------------------------------------------------------------------

test("pause: a refused shell command says what IS allowed, so Claude retries instead of giving up", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const reason = (input) => JSON.parse(hook(w, "pause.mjs", input, "2026-10-29T18:01:00").out).hookSpecificOutput.permissionDecisionReason;
  const bash = reason({ tool_name: "Bash", tool_input: { command: "ls; find . -name \"*.py\" | head" } });
  assert.match(bash, /shell command was refused/);
  assert.match(bash, /ONE plain read-only command/);
  assert.match(bash, /grep -rn -e TODO -e FIXME \./); // an example that really works
  assert.match(bash, /no \* globs/);
  assert.match(bash, /TOMORROW\.md/); // still tells it to write the handoff
  // Other refused tools get the plain message, without shell advice.
  assert.doesNotMatch(reason({ tool_name: "WebFetch", tool_input: {} }), /shell command/);
  // And every example the message gives is genuinely allowed by the check.
});

test("shell allowlist: every example in the refusal message is allowed", async () => {
  const { isReadOnlyBash } = await import(script("lib.mjs"));
  for (const ex of ["ls -la", "grep -rn -e TODO -e FIXME .", "find . -type f -name main.py", "git log --oneline -5", "git diff --no-ext-diff --no-textconv", "git status", "tail -n 20 x"]) {
    assert.equal(isReadOnlyBash(ex), true, ex);
  }
});

test("shell allowlist: git builds a diff only with both safe flags (repo config can name programs)", async () => {
  const { isReadOnlyBash } = await import(script("lib.mjs"));
  for (const bad of ["git diff", "git show HEAD", "git log -p", "git log --stat", "git log -Sfoo", "git diff --no-ext-diff", "git diff --no-textconv", "git diff --output=x --no-ext-diff --no-textconv", "git log --ext-diff"]) {
    assert.equal(isReadOnlyBash(bad), false, bad);
  }
  for (const good of ["git status", "git log --oneline -5", "git ls-files", "git diff --no-ext-diff --no-textconv", "git show --no-ext-diff --no-textconv HEAD", "git log -p --no-ext-diff --no-textconv"]) {
    assert.equal(isReadOnlyBash(good), true, good);
  }
});

test("status: always shows the cutoff, including on a day off", () => {
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  const out = cliAs("you", w, ["status"], "2026-10-31T14:00:00").out; // Saturday
  assert.match(out, /day off/);
  assert.match(out, /Cutoff: 21:00/);
  assert.match(cliAs("you", world({}), ["status"]).out, /Cutoff: none/);
});

test("wake: with no cutoff set it says so instead of naming 23:59", () => {
  const w = world({});
  assert.match(cliAs("you", w, ["wake"], "2026-10-29T15:00:00").out, /haven't set a cutoff, so nothing changes/);
  assert.doesNotMatch(cliAs("you", w, ["wake"], "2026-10-29T15:00:00").out, /23:59/);
  const lock = hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  assert.match(lock.out, /ON until 08:00/);
  const woke = hook(w, "gate.mjs", { prompt: "/sundown:wake" }, "2026-10-29T18:10:00");
  assert.match(woke.out, /rest of today/);
  assert.doesNotMatch(woke.out, /23:59/);
});

test("morning: after noon the greeting says 'Welcome back', not 'Good morning'", () => {
  const w = world();
  const handoff = path.join(w.project, "TOMORROW.md");
  fs.writeFileSync(handoff, "Stopped at: x\nFirst step tomorrow: y\nOpen question: none\n");
  const am = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T10:00:00").out).systemMessage;
  assert.match(am, /Good morning/);
  const pm = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T18:32:00").out).systemMessage;
  assert.match(pm, /Welcome back/);
  assert.doesNotMatch(pm, /Good morning/);
});

test("cli: install-statusline refuses a settings file that isn't a JSON object, and accepts an empty one", () => {
  for (const content of ["[]", "null", "42", '"text"']) {
    const w = world();
    const settings = path.join(w.claude, "settings.json");
    fs.writeFileSync(settings, content);
    const r = cli(w, ["install-statusline"]);
    assert.equal(r.code, 1, `${content} should be refused`);
    assert.match(r.err, /JSON object/);
    assert.equal(fs.readFileSync(settings, "utf8"), content); // untouched
  }
  const w = world();
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, "");
  assert.equal(cli(w, ["install-statusline"]).code, 0);
  assert.match(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command, /sundown/);
});

test("cli: a wrong setting value says what a right one looks like", () => {
  const w = world();
  assert.match(cli(w, ["config", "daysOff", "saturday"]).err, /three-letter day names.*sat,sun/);
  assert.match(cli(w, ["config", "cutoff", "9pm"]).err, /24-hour time like 21:00/);
  assert.match(cli(w, ["config", "overrideMinutes", "999"]).err, /1 to 240/);
  assert.match(cli(w, ["config", "pushDetail", "all"]).err, /none or folder/);
});

test("report: a session log with spaces around the colon still counts", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    '{"type": "user", "uuid": "1", "timestamp": "' + new Date("2026-10-28T22:30:00").toISOString() + '", "message": {"content": "x"}}\n');
  const r = cli(w, ["report", "3"], "2026-10-29T15:00:00");
  assert.match(r.out, /Prompts in the evening: 1 of 1/);
});

test("shutdown skill: tells Claude what to do when a command is refused", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills", "shutdown", "SKILL.md"), "utf8");
  assert.match(skill, /refused/);
  assert.match(skill, /ONE plain command/);
  assert.match(skill, /--no-ext-diff --no-textconv/);
  const wake = fs.readFileSync(path.join(ROOT, "skills", "wake", "SKILL.md"), "utf8");
  assert.match(wake, /only if you know the project has one/);
});
