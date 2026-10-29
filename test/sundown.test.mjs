// Tests for Sundown. Run with:  node --test test/
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => path.join(ROOT, "scripts", name);
const BIN = path.join(ROOT, "bin", "sundown");

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A fresh world: state dir, project dir, and an empty Claude config dir.
function world(config = { cutoff: "21:00", morning: "08:00" }) {
  const state = tmp("sd-state-");
  const project = tmp("sd-proj-");
  const claude = tmp("sd-claude-");
  fs.writeFileSync(path.join(state, "config.json"), JSON.stringify(config));
  return { state, project, claude };
}

// Run a hook script synchronously, like Claude Code does.
function hook(w, name, input, nowIso) {
  const r = spawnSync("node", [script(name)], {
    input: JSON.stringify({ session_id: "sess1", cwd: w.project, ...input }),
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function cli(w, args, nowIso = "2026-10-29T15:00:00") {
  const r = spawnSync("node", [BIN, ...args], {
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const events = (w) => {
  try { return fs.readFileSync(path.join(w.state, "events.log"), "utf8"); } catch { return ""; }
};

// ---------------------------------------------------------------------------
// Time logic
// ---------------------------------------------------------------------------

test("quiet hours cross midnight and an empty cutoff means never quiet", async () => {
  const { isQuiet, nextMorningAfter } = await import(script("lib.mjs"));
  const cfg = { cutoff: "21:00", morning: "08:00" };
  assert.equal(isQuiet(new Date("2026-10-29T20:59:00"), cfg), false);
  assert.equal(isQuiet(new Date("2026-10-29T21:00:00"), cfg), true);
  assert.equal(isQuiet(new Date("2026-10-30T02:00:00"), cfg), true);
  assert.equal(isQuiet(new Date("2026-10-30T08:00:00"), cfg), false);
  assert.equal(isQuiet(new Date("2026-10-29T23:00:00"), { cutoff: "", morning: "08:00" }), false);
  // Shutting down at 18:00 lasts until 08:00 the next day; at 02:00, until 08:00 the same day.
  assert.equal(nextMorningAfter(new Date("2026-10-29T18:00:00"), cfg).getDate(), 30);
  assert.equal(nextMorningAfter(new Date("2026-10-30T02:00:00"), cfg).getDate(), 30);
});

test("session ids that could escape ~/.sundown are refused", async () => {
  const { safeId } = await import(script("lib.mjs"));
  assert.equal(safeId("abc-123_X"), "abc-123_X");
  for (const bad of ["../../etc/passwd", "a/b", "", null, 42, "x".repeat(200)]) assert.equal(safeId(bad), null);
});

// ---------------------------------------------------------------------------
// gate.mjs (UserPromptSubmit)
// ---------------------------------------------------------------------------

test("gate: lets prompts through in the day, blocks after the cutoff", () => {
  const w = world();
  assert.equal(hook(w, "gate.mjs", { prompt: "add a test" }, "2026-10-29T15:00:00").code, 0);
  const night = hook(w, "gate.mjs", { prompt: "one more thing" }, "2026-10-29T22:00:00");
  assert.equal(night.code, 2);
  assert.match(night.err, /after your 21:00 cutoff/);
  assert.match(events(w), /"type":"blocked"/);
});

test("gate: never stores the prompt text", () => {
  const w = world();
  hook(w, "gate.mjs", { prompt: "SECRET-PROMPT-TEXT" }, "2026-10-29T22:00:00");
  hook(w, "gate.mjs", { prompt: "override: SECRET-PROMPT-TEXT" }, "2026-10-29T22:00:00");
  const all = fs.readdirSync(w.state, { recursive: true })
    .map((f) => path.join(w.state, f)).filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, "utf8")).join("\n");
  assert.doesNotMatch(all, /SECRET-PROMPT-TEXT/);
});

test("gate: override: goes through, is logged, and gives a pass", () => {
  const w = world();
  const r = hook(w, "gate.mjs", { prompt: "override: fix the typo" }, "2026-10-29T22:00:00");
  assert.equal(r.code, 0);
  assert.match(r.out, /override/);
  assert.match(events(w), /"type":"override"/);
  assert.ok(fs.existsSync(path.join(w.state, "passes", "sess1")));
});

test("gate: /sundown:shutdown sets the lock, /sundown:wake clears it, other /sundown: commands pass at night", () => {
  const w = world();
  const s = hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  assert.equal(s.code, 0);
  assert.match(s.out, /lock is now ON until 08:00/);
  assert.ok(fs.existsSync(path.join(w.state, "lock")));
  // While locked, normal prompts are blocked even before the cutoff...
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T18:30:00").code, 2);
  // ...but status still works.
  assert.equal(hook(w, "gate.mjs", { prompt: "/sundown:status" }, "2026-10-29T18:30:00").code, 0);
  const k = hook(w, "gate.mjs", { prompt: "/sundown:wake" }, "2026-10-29T18:40:00");
  assert.equal(k.code, 0);
  assert.ok(!fs.existsSync(path.join(w.state, "lock")));
  // Awake until the next cutoff (21:00), then quiet hours apply again.
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T19:00:00").code, 0);
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T21:30:00").code, 2);
});

test("gate: broken input fails open", () => {
  const w = world();
  const r = spawnSync("node", [script("gate.mjs")], {
    input: "not json", env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T15:00:00" }, encoding: "utf8",
  });
  assert.equal(r.status, 0);
});

// ---------------------------------------------------------------------------
// pause.mjs (PreToolUse)
// ---------------------------------------------------------------------------

test("pause: does nothing without a lock, even late at night", () => {
  const w = world();
  const r = hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T23:00:00");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("pause: while locked, denies work, allows reading and the handoff, then stops", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");

  const deny = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, "2026-10-29T18:01:00").out);
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /TOMORROW\.md/);

  assert.equal(hook(w, "pause.mjs", { tool_name: "Read", tool_input: { file_path: "a.js" } }, "2026-10-29T18:01:00").out, "");
  const handoff = path.join(w.project, "TOMORROW.md");
  assert.equal(hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: handoff } }, "2026-10-29T18:01:00").out, "");
  assert.notEqual(hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: path.join(w.project, "app.js") } }, "2026-10-29T18:01:00").out, "");

  // Claude writes the handoff (we set its time to 18:02, after the lock).
  fs.writeFileSync(handoff, "Stopped at: x\nFirst step tomorrow: y\nOpen question: none\n");
  const t = new Date("2026-10-29T18:02:00");
  fs.utimesSync(handoff, t, t);
  const stop = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T18:03:00").out);
  assert.equal(stop.continue, false);
  assert.match(stop.stopReason, /paused until 08:00/);
});

test("pause: an override pass lets that session work; the lock ends in the morning", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  hook(w, "gate.mjs", { prompt: "override: hotfix" }, "2026-10-29T18:10:00");
  assert.equal(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T18:15:00").out, "");
  // Pass expires after 20 minutes.
  assert.notEqual(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T18:45:00").out, "");
  // Next morning: allowed again.
  assert.equal(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-30T08:01:00").out, "");
});

// ---------------------------------------------------------------------------
// morning.mjs (SessionStart)
// ---------------------------------------------------------------------------

test("morning: shows a fresh TOMORROW.md to you and to Claude, and clears an expired lock", () => {
  const w = world();
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const handoff = path.join(w.project, "TOMORROW.md");
  fs.writeFileSync(handoff, "Stopped at: parser\nFirst step tomorrow: fix test 3\nOpen question: none\n");
  const t = new Date("2026-10-29T18:02:00");
  fs.utimesSync(handoff, t, t);

  const night = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T23:00:00").out);
  assert.match(night.systemMessage, /on until 08:00/);

  const r = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-30T09:00:00").out);
  assert.match(r.systemMessage, /Good morning/);
  assert.match(r.hookSpecificOutput.additionalContext, /fix test 3/);
  assert.ok(!fs.existsSync(path.join(w.state, "lock")));
});

test("morning: ignores a stale handoff and prints nothing without one", () => {
  const w = world();
  assert.equal(hook(w, "morning.mjs", {}, "2026-10-30T09:00:00").out, "");
  const handoff = path.join(w.project, "TOMORROW.md");
  fs.writeFileSync(handoff, "old");
  const t = new Date("2026-10-01T18:00:00");
  fs.utimesSync(handoff, t, t);
  assert.equal(hook(w, "morning.mjs", {}, "2026-10-30T09:00:00").out, "");
});

// ---------------------------------------------------------------------------
// push.mjs (Notification + Stop)
// ---------------------------------------------------------------------------

test("push: message text is generic unless pushDetail is folder", async () => {
  const { buildMessage } = await import(script("push.mjs"));
  const a = buildMessage("Stop", { pushDetail: "none" }, { folder: "secret-project", minutes: 14 });
  assert.doesNotMatch(a.body, /secret-project/);
  assert.match(a.body, /14 min/);
  const b = buildMessage("Notification", { pushDetail: "folder" }, { folder: "my-app", minutes: 0 });
  assert.match(b.body, /my-app/);
});

// Run push.mjs against a local fake ntfy server and collect what it receives.
async function pushRun(w, input, nowIso) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push({ url: req.url, title: req.headers.title, body }); res.end("ok"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8"));
  cfg.ntfyServer = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(w.state, "config.json"), JSON.stringify(cfg));
  await new Promise((resolve) => {
    const child = spawn("node", [script("push.mjs")], {
      env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    });
    child.stdin.end(JSON.stringify({ session_id: "sess1", cwd: w.project, ...input }));
    child.on("exit", resolve);
  });
  server.close();
  return received;
}

test("push: sends after a long turn and on notifications; never without a topic or after a short turn", async () => {
  const w = world({ cutoff: "21:00", morning: "08:00", ntfyTopic: "sundown-test-topic", minTurnSeconds: 60 });
  hook(w, "gate.mjs", { prompt: "big refactor" }, "2026-10-29T15:00:00");

  const short = await pushRun(w, { hook_event_name: "Stop" }, "2026-10-29T15:00:30");
  assert.equal(short.length, 0);

  const long = await pushRun(w, { hook_event_name: "Stop" }, "2026-10-29T15:14:00");
  assert.equal(long.length, 1);
  assert.equal(long[0].url, "/sundown-test-topic");
  assert.match(long[0].body, /finished after 14 min/);

  const note = await pushRun(w, { hook_event_name: "Notification" }, "2026-10-29T15:20:00");
  assert.equal(note[0].title, "Claude needs you");

  const off = world();
  assert.equal((await pushRun(off, { hook_event_name: "Notification" }, "2026-10-29T15:20:00")).length, 0);
});

// ---------------------------------------------------------------------------
// report.mjs and the CLI
// ---------------------------------------------------------------------------

test("report: counts only human prompts by time, never shows their text", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o) + "\n";
  const at = (iso) => new Date(iso).toISOString();
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    line({ type: "user", uuid: "1", timestamp: at("2026-10-28T14:00:00"), message: { content: "PRIVATE day prompt" } }) +
    line({ type: "user", uuid: "2", timestamp: at("2026-10-28T22:30:00"), message: { content: "PRIVATE late prompt" } }) +
    line({ type: "user", uuid: "3", timestamp: at("2026-10-29T01:10:00"), message: { content: "PRIVATE very late" } }) +
    line({ type: "user", uuid: "3", timestamp: at("2026-10-29T01:10:00"), message: { content: "duplicate" } }) +
    line({ type: "user", uuid: "4", timestamp: at("2026-10-28T23:00:00"), isMeta: true, message: { content: "skill text" } }) +
    line({ type: "user", uuid: "5", timestamp: at("2026-10-28T23:00:00"), message: { content: [{ type: "tool_result", content: "x" }] } }) +
    line({ type: "assistant", uuid: "6", timestamp: at("2026-10-28T23:00:00"), message: { content: "answer" } }));

  const r = cli(w, ["report", "3"], "2026-10-29T15:00:00");
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /PRIVATE/);
  // Wed 28 Oct: 3 prompts, 2 in the evening, last one at 01:10 (after midnight still counts as Wednesday).
  assert.match(r.out, /Wed 28 Oct\s+3\s+2\s+01:10/);
  assert.match(r.out, /Latest finish: 01:10/);
  const html = fs.readFileSync(path.join(w.state, "report.html"), "utf8");
  assert.doesNotMatch(html, /PRIVATE/);
});

test("cli: config validates input and generates an unguessable topic", () => {
  const w = world();
  assert.equal(cli(w, ["config", "cutoff", "25:00"]).code, 1);
  assert.equal(cli(w, ["config", "ntfyServer", "file:///etc/passwd"]).code, 1);
  assert.equal(cli(w, ["config", "nope", "1"]).code, 1);
  assert.equal(cli(w, ["config", "cutoff", "off"]).code, 0);
  const g = cli(w, ["config", "ntfyTopic", "generate"]);
  assert.match(g.out, /sundown-[0-9a-f]{24}/);
  const saved = JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8"));
  assert.equal(saved.cutoff, "");
  // State files are private to you (owner read/write only).
  assert.equal(fs.statSync(path.join(w.state, "config.json")).mode & 0o777, 0o600);
});

test("cli: install-statusline never overwrites someone else's status line without --force", () => {
  const w = world();
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "my-own-line" }, theme: "dark" }));
  assert.equal(cli(w, ["install-statusline"]).code, 1);
  assert.match(fs.readFileSync(settings, "utf8"), /my-own-line/);
  assert.equal(cli(w, ["install-statusline", "--force"]).code, 0);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.match(after.statusLine.command, /sundown/);
  assert.equal(after.theme, "dark"); // other settings kept
  assert.ok(fs.existsSync(`${settings}.sundown-backup`));
});

test("gate: an override pass covers that session's next messages, and shutdown cancels it", () => {
  const w = world();
  hook(w, "gate.mjs", { prompt: "override: quick fix" }, "2026-10-29T22:00:00");
  assert.equal(hook(w, "gate.mjs", { prompt: "and the test" }, "2026-10-29T22:05:00").code, 0);
  assert.equal(hook(w, "gate.mjs", { session_id: "someone-else", prompt: "hi" }, "2026-10-29T22:05:00").code, 2);
  // Default override is 15m now, so a pass granted at 22:00 is dead by 22:30.
  assert.equal(hook(w, "gate.mjs", { prompt: "later" }, "2026-10-29T22:30:00").code, 2);
  hook(w, "gate.mjs", { prompt: "override: one more" }, "2026-10-29T22:40:00");
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T22:41:00");
  assert.equal(hook(w, "gate.mjs", { prompt: "still there?" }, "2026-10-29T22:42:00").code, 2);
});

// ---------------------------------------------------------------------------
// Daily prompt limit
// ---------------------------------------------------------------------------

test("gate: hitting the daily limit blocks before the cutoff, and clears next morning", () => {
  // Low limit so we can hit it quickly. No cutoff at all, so the only reason
  // to be blocked is the limit itself.
  const w = world({ cutoff: "", morning: "08:00", dailyLimit: 3 });
  for (let i = 0; i < 3; i++) {
    const r = hook(w, "gate.mjs", { prompt: `turn ${i}` }, "2026-10-29T14:00:00");
    assert.equal(r.code, 0, `prompt ${i} should pass`);
  }
  const blocked = hook(w, "gate.mjs", { prompt: "one more" }, "2026-10-29T14:05:00");
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /3\/3 prompts today/);
  assert.match(blocked.err, /\/sundown:override/);
  // Next morning (= next workday): the counter is scoped to the workday key.
  const next = hook(w, "gate.mjs", { prompt: "fresh day" }, "2026-10-30T09:00:00");
  assert.equal(next.code, 0);
});

test("gate: schedule changes are picked up immediately — shutdown time first vs. limit first", () => {
  const w = world({ cutoff: "22:30", morning: "08:00", dailyLimit: 50 });
  // Not past cutoff yet, below limit: works.
  assert.equal(hook(w, "gate.mjs", { prompt: "x" }, "2026-10-29T22:00:00").code, 0);
  // Past 22:30 cutoff but limit not hit: blocked by cutoff.
  const r = hook(w, "gate.mjs", { prompt: "x" }, "2026-10-29T22:45:00");
  assert.equal(r.code, 2);
  assert.match(r.err, /after your 22:30 cutoff/);
  // Change the limit to 1 (we already recorded one prompt above), and move the
  // cutoff out of the way: now the limit is what trips.
  hook(w, "gate.mjs", { prompt: "/sundown:schedule limit 1" }, "2026-10-29T15:00:00");
  hook(w, "gate.mjs", { prompt: "/sundown:schedule shutdown off" }, "2026-10-29T15:01:00");
  const r2 = hook(w, "gate.mjs", { prompt: "x" }, "2026-10-29T15:05:00");
  assert.equal(r2.code, 2);
  assert.match(r2.err, /prompts today/);
});

test("gate: concurrent increments from two sessions share one count", async () => {
  const w = world({ cutoff: "", morning: "08:00", dailyLimit: 1000 });
  // Fire 20 prompts in parallel from 4 session ids. Each append is atomic, so
  // every one should land in the counts file.
  const sessions = ["a", "b", "c", "d"];
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(new Promise((resolve) => {
      const child = spawn("node", [script("gate.mjs")], {
        env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T15:00:00" },
      });
      child.stdin.end(JSON.stringify({ session_id: sessions[i % sessions.length], cwd: w.project, prompt: `t${i}` }));
      child.on("exit", resolve);
    }));
  }
  await Promise.all(promises);
  const file = fs.readFileSync(path.join(w.state, "counts", "2026-10-29"), "utf8");
  assert.equal(file.split("\n").filter(Boolean).length, 20);
});

// ---------------------------------------------------------------------------
// /sundown:override (slash command)
// ---------------------------------------------------------------------------

test("gate: /sundown:override [duration] gives a pass of the right length", () => {
  const w = world();
  // Default (no arg) = 15m.
  hook(w, "gate.mjs", { prompt: "/sundown:override" }, "2026-10-29T22:00:00");
  assert.equal(hook(w, "gate.mjs", { prompt: "x" }, "2026-10-29T22:10:00").code, 0);
  assert.equal(hook(w, "gate.mjs", { prompt: "x" }, "2026-10-29T22:16:00").code, 2);
  // 30m explicit.
  hook(w, "gate.mjs", { session_id: "s2", prompt: "/sundown:override 30m" }, "2026-10-29T22:20:00");
  assert.equal(hook(w, "gate.mjs", { session_id: "s2", prompt: "x" }, "2026-10-29T22:45:00").code, 0);
  assert.equal(hook(w, "gate.mjs", { session_id: "s2", prompt: "x" }, "2026-10-29T22:55:00").code, 2);
  // 1h explicit.
  hook(w, "gate.mjs", { session_id: "s3", prompt: "/sundown:override 1h" }, "2026-10-29T22:00:00");
  assert.equal(hook(w, "gate.mjs", { session_id: "s3", prompt: "x" }, "2026-10-29T22:55:00").code, 0);
});

test("gate: an override pass survives Claude Code being closed and reopened", () => {
  const w = world();
  hook(w, "gate.mjs", { prompt: "/sundown:override 30m" }, "2026-10-29T22:00:00");
  // Simulate close/reopen by using the same session id; nothing is in-memory,
  // the pass lives on disk under ~/.sundown/passes/.
  assert.equal(hook(w, "gate.mjs", { prompt: "still here?" }, "2026-10-29T22:20:00").code, 0);
  assert.equal(hook(w, "gate.mjs", { prompt: "and now?" }, "2026-10-29T22:35:00").code, 2);
});

// ---------------------------------------------------------------------------
// /sundown:schedule (slash command)
// ---------------------------------------------------------------------------

test("gate: /sundown:schedule applies changes and 'list' prints the current state", () => {
  const w = world({ cutoff: "21:00", morning: "08:00", dailyLimit: 50 });
  const list = hook(w, "gate.mjs", { prompt: "/sundown:schedule list" }, "2026-10-29T15:00:00");
  assert.match(list.out, /shutdown=21:00/);
  assert.match(list.out, /wake=08:00/);
  assert.match(list.out, /limit=50/);
  hook(w, "gate.mjs", { prompt: "/sundown:schedule shutdown 22:30" }, "2026-10-29T15:00:00");
  hook(w, "gate.mjs", { prompt: "/sundown:schedule wake 09:00" }, "2026-10-29T15:00:00");
  hook(w, "gate.mjs", { prompt: "/sundown:schedule limit 30" }, "2026-10-29T15:00:00");
  const after = JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8"));
  assert.equal(after.cutoff, "22:30");
  assert.equal(after.morning, "09:00");
  assert.equal(after.dailyLimit, 30);
});

test("gate: /sundown:schedule works during a shutdown too (bypasses the lock)", () => {
  const w = world();
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const r = hook(w, "gate.mjs", { prompt: "/sundown:schedule limit 10" }, "2026-10-29T18:05:00");
  assert.equal(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8"));
  assert.equal(cfg.dailyLimit, 10);
});

// ---------------------------------------------------------------------------
// Manual /sundown:wake before wake time requires an override
// ---------------------------------------------------------------------------

test("gate: /sundown:wake before the wake time is refused without an active override", () => {
  const w = world({ cutoff: "22:30", morning: "08:00" });
  // 03:00 is in the quiet window and there is no lock. Wake should be refused.
  const refused = hook(w, "gate.mjs", { prompt: "/sundown:wake" }, "2026-10-30T03:00:00");
  assert.equal(refused.code, 2);
  assert.match(refused.err, /before your wake time/);
  // After the user overrides, wake works.
  hook(w, "gate.mjs", { prompt: "/sundown:override 5m" }, "2026-10-30T03:01:00");
  const ok = hook(w, "gate.mjs", { prompt: "/sundown:wake" }, "2026-10-30T03:02:00");
  assert.equal(ok.code, 0);
});

// ---------------------------------------------------------------------------
// Repeated shutdown/wake, cross-midnight, next-morning reopen
// ---------------------------------------------------------------------------

test("gate: repeated shutdown/wake cycles are idempotent, and the lock crosses midnight", () => {
  const w = world({ cutoff: "22:30", morning: "08:00" });
  // Shut down, wake, shut down again — each one takes effect.
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  hook(w, "gate.mjs", { prompt: "/sundown:wake" }, "2026-10-29T18:10:00");
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:20:00");
  // Still shut down well past midnight.
  assert.equal(hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-30T02:00:00").code, 2);
  // After the morning time, the lock clears automatically — morning hook does it.
  const morn = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-30T08:30:00").out || "{}");
  // Even without a handoff, the lock is gone.
  assert.ok(!fs.existsSync(path.join(w.state, "lock")));
  assert.equal(hook(w, "gate.mjs", { prompt: "fresh start" }, "2026-10-30T08:30:00").code, 0);
  // morn might be {} (no handoff), that's fine.
  void morn;
});

// ---------------------------------------------------------------------------
// Recap built from REAL data (and the "no data" case)
// ---------------------------------------------------------------------------

test("recap: no git history → the recap says so plainly, never invents commits", async () => {
  const { buildRecap } = await import(script("recap.mjs"));
  const tmpProj = tmp("sd-norepo-");
  const md = buildRecap({ projectDir: tmpProj, since: new Date("2026-10-29T09:00:00"), date: new Date("2026-10-29T18:00:00") });
  assert.match(md, /isn't a git repository/);
  // Nothing invented — no bullet list of fake commits, no diffstat, no commit SHAs.
  assert.doesNotMatch(md, /^[0-9a-f]{7} /m);
  assert.doesNotMatch(md, /\|\s+\d+ \+/); // git diff --stat format
});

test("recap: with a real tiny git repo, lists today's commits and the diff — and no prompt text", async () => {
  const { buildRecap } = await import(script("recap.mjs"));
  const proj = tmp("sd-repo-");
  spawnSync("git", ["init", "-q", "-b", "main", proj], { encoding: "utf8" });
  spawnSync("git", ["-C", proj, "config", "user.email", "t@test"], { encoding: "utf8" });
  spawnSync("git", ["-C", proj, "config", "user.name", "T"], { encoding: "utf8" });
  fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");
  spawnSync("git", ["-C", proj, "add", "a.txt"], { encoding: "utf8" });
  spawnSync("git", ["-C", proj, "commit", "-q", "-m", "feat: add a"], { encoding: "utf8" });
  fs.writeFileSync(path.join(proj, "a.txt"), "hello world\n"); // dirty working tree
  const md = buildRecap({ projectDir: proj, since: new Date(Date.now() - 60 * 1000), date: new Date(), tomorrow: "- finish parser\n" });
  assert.match(md, /feat: add a/);
  assert.match(md, /a\.txt/);
  assert.match(md, /finish parser/);
  // Nothing user-typed makes it in.
  assert.doesNotMatch(md, /SECRET/);
});

test("cli: shutdown saves a recap; sundown recap reads it back", () => {
  const w = world();
  // No project git repo — the "no git history" branch runs. Still writes a file.
  const sd = cli(w, ["shutdown"], "2026-10-29T18:00:00");
  assert.equal(sd.code, 0);
  assert.match(sd.out, /Recap saved/);
  const r = cli(w, ["recap"], "2026-10-29T18:05:00");
  assert.equal(r.code, 0);
  assert.match(r.out, /Sundown recap/);
});

test("cli: sundown recap with no history yet tells the user what to do", () => {
  const w = world();
  const r = cli(w, ["recap"], "2026-10-29T15:00:00");
  assert.equal(r.code, 0);
  assert.match(r.out, /No recap yet/);
});
