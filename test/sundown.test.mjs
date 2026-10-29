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
  const stop = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, "2026-10-29T18:03:00").out);
  assert.equal(stop.continue, false);
  assert.match(stop.stopReason, /paused until 08:00/);
});

test("pause: an override pass lets that session work; the lock ends in the morning", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  hook(w, "gate.mjs", { prompt: "override: hotfix" }, "2026-10-29T18:10:00");
  assert.equal(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }, "2026-10-29T18:15:00").out, "");
  // Pass expires after 20 minutes.
  assert.notEqual(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }, "2026-10-29T18:45:00").out, "");
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
  assert.match(night.systemMessage, /shut down for today \(until 08:00\)/);

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
  assert.equal(hook(w, "gate.mjs", { prompt: "later" }, "2026-10-29T22:30:00").code, 2); // pass expired
  hook(w, "gate.mjs", { prompt: "override: one more" }, "2026-10-29T22:40:00");
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T22:41:00");
  assert.equal(hook(w, "gate.mjs", { prompt: "still there?" }, "2026-10-29T22:42:00").code, 2);
});

// ---------------------------------------------------------------------------
// Days off, the wrap-up note, first run, and the fixes from review
// ---------------------------------------------------------------------------

test("days off: quiet all day, Friday evening runs to Monday morning, and morning on a day off stays quiet", async () => {
  const { sundownState, isDayOff } = await import(script("lib.mjs"));
  const cfg = { cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" };
  // 2026-10-31 is a Saturday.
  assert.equal(isDayOff(new Date("2026-10-31T14:00:00"), cfg), true);
  assert.equal(isDayOff(new Date("2026-10-31T02:00:00"), cfg), false); // still Friday night
  assert.equal(isDayOff(new Date("2026-11-02T07:00:00"), cfg), true);  // still Sunday night
  assert.equal(isDayOff(new Date("2026-11-02T09:00:00"), cfg), false);
  const fri = sundownState(new Date("2026-10-30T22:00:00"), cfg);
  assert.equal(fri.why, "quiet");
  assert.equal(fri.until.getDay(), 1); // Monday
  assert.equal(sundownState(new Date("2026-10-31T14:00:00"), cfg).why, "dayoff");
});

test("days off: the gate holds prompts back on a day off and says so", () => {
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  const r = hook(w, "gate.mjs", { prompt: "quick thing" }, "2026-10-31T14:00:00");
  assert.equal(r.code, 2);
  assert.match(r.err, /day off \(until Mon 08:00\)/);
  assert.equal(hook(w, "gate.mjs", { prompt: "quick thing" }, "2026-10-30T14:00:00").code, 0); // Friday
});

test("cli: daysOff accepts day names and rejects nonsense", () => {
  const w = world();
  assert.equal(cli(w, ["config", "daysOff", "Sat, Sun"]).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).daysOff, "sat,sun");
  assert.equal(cli(w, ["config", "daysOff", "funday"]).code, 1);
  assert.equal(cli(w, ["config", "daysOff", "sat,sat"]).code, 1);
  assert.equal(cli(w, ["config", "daysOff", "mon,tue,wed,thu,fri,sat,sun"]).code, 1); // keep one working day
  assert.equal(cli(w, ["config", "daysOff", "off"]).code, 0);
});

test("wrap-up: one note shortly before the cutoff, once a day, to you and to Claude", () => {
  const w = world();
  assert.equal(hook(w, "gate.mjs", { prompt: "a" }, "2026-10-29T20:00:00").out, ""); // 60 min left: nothing
  const first = hook(w, "gate.mjs", { prompt: "b" }, "2026-10-29T20:40:00");
  assert.equal(first.code, 0);
  const note = JSON.parse(first.out);
  assert.match(note.systemMessage, /20 min to your 21:00 cutoff/);
  assert.match(note.hookSpecificOutput.additionalContext, /clean stopping point/);
  assert.equal(hook(w, "gate.mjs", { prompt: "c" }, "2026-10-29T20:50:00").out, ""); // already shown today
  assert.notEqual(hook(w, "gate.mjs", { prompt: "d" }, "2026-10-30T20:45:00").out, ""); // next day: again

  const off = world({ cutoff: "21:00", morning: "08:00", wrapUpMinutes: 0 });
  assert.equal(hook(off, "gate.mjs", { prompt: "b" }, "2026-10-29T20:40:00").out, "");
});

test("morning: points a brand-new install at /sundown:setup, once", () => {
  const state = tmp("sd-state-");
  const w = { state, project: tmp("sd-proj-"), claude: tmp("sd-claude-") };
  const first = hook(w, "morning.mjs", {}, "2026-10-29T10:00:00");
  assert.match(JSON.parse(first.out).systemMessage, /\/sundown:setup/);
  assert.equal(hook(w, "morning.mjs", {}, "2026-10-29T11:00:00").out, "");
});

test("pause: during shutdown only this project's TOMORROW.md counts as the handoff", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const elsewhere = path.join(tmp("sd-elsewhere-"), "TOMORROW.md");
  const r = hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: elsewhere } }, "2026-10-29T18:01:00");
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny");
  const rel = hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: "TOMORROW.md" } }, "2026-10-29T18:01:00");
  assert.equal(rel.out, "");
});

test("cli: Claude can't wake or shut down Sundown from its shell; you can", () => {
  const w = world();
  const run = (args, extra) => spawnSync("node", [BIN, ...args], {
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T22:00:00", CLAUDE_CONFIG_DIR: w.claude, ...extra },
    encoding: "utf8",
  });
  const claude = run(["wake"], { CLAUDECODE: "1" });
  assert.equal(claude.status, 1);
  assert.match(claude.stderr, /only you can wake/);
  assert.ok(!fs.existsSync(path.join(w.state, "awake")));
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const you = spawnSync("node", [BIN, "wake"], {
    env: { ...env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T22:00:00", CLAUDE_CONFIG_DIR: w.claude },
    encoding: "utf8",
  });
  assert.equal(you.status, 0, you.stderr);
  assert.ok(fs.existsSync(path.join(w.state, "awake")));
});

test("cli: re-running install-statusline keeps the backup of your original settings", () => {
  const w = world();
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "my-own-line" } }));
  assert.equal(cli(w, ["install-statusline", "--force"]).code, 0);
  assert.equal(cli(w, ["install-statusline"]).code, 0); // e.g. after updating Sundown
  assert.match(fs.readFileSync(`${settings}.sundown-backup`, "utf8"), /my-own-line/);
});

test("report: a cutoff after midnight counts only those hours as evening", async () => {
  const { isEvening } = await import(script("report.mjs"));
  const cfg = { cutoff: "01:00", morning: "08:00" };
  assert.equal(isEvening(new Date("2026-10-29T15:00:00"), cfg), false);
  assert.equal(isEvening(new Date("2026-10-29T23:00:00"), cfg), false);
  assert.equal(isEvening(new Date("2026-10-30T02:00:00"), cfg), true);
});

test("report: compares with the week before and counts mornings that started from a handoff", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  const line = (uuid, iso) => JSON.stringify({ type: "user", uuid, timestamp: new Date(iso).toISOString(), message: { content: "x" } }) + "\n";
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    // The week before: two late evenings.
    line("a", "2026-10-20T23:00:00") + line("b", "2026-10-21T23:30:00") +
    // This week: one day, finished at 18:00.
    line("c", "2026-10-28T18:00:00"));
  fs.writeFileSync(path.join(w.state, "events.log"), JSON.stringify({ t: new Date("2026-10-28T09:00:00").toISOString(), type: "handoff" }) + "\n");
  const r = cli(w, ["report", "7"], "2026-10-29T15:00:00");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Evenings you kept working: 0 of 7 \(the 7 days before: 2 of 7\)/);
  assert.match(r.out, /Typical finish: 18:00 \(before: 23:15\)/);
  assert.match(r.out, /Mornings that started from TOMORROW\.md: 1/);
});

test("pause: while locked, plain read-only shell commands are allowed so Claude can inspect the project", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const bash = (command) => hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command } }, "2026-10-29T18:01:00").out;
  for (const ok of ["ls -la", "grep -rn TODO . | head -20", "find . -name '*.py'", "git log --oneline -5", "git diff"]) {
    assert.equal(bash(ok), "", `should allow: ${ok}`);
  }
  for (const bad of ["rm -rf .", "ls; rm -rf .", "cat a > b", "echo $(whoami)", "find . -delete", "find . -exec rm {} +", "git push", "git commit -am x", "npm test", "sundown wake", "ls && npm test"]) {
    assert.equal(JSON.parse(bash(bad)).hookSpecificOutput.permissionDecision, "deny", `should deny: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Fixes from the agent test round (1.1.1)
// ---------------------------------------------------------------------------

// Run the CLI like Claude's shell (CLAUDECODE=1) or like your own terminal (unset).
function cliAs(who, w, args, nowIso = "2026-10-29T15:00:00") {
  const env = { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: nowIso, CLAUDE_CONFIG_DIR: w.claude };
  if (who === "claude") env.CLAUDECODE = "1"; else delete env.CLAUDECODE;
  const r = spawnSync("node", [BIN, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("pause: once the handoff exists the triggering tool call is denied AND the run stops", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const handoff = path.join(w.project, "TOMORROW.md");
  fs.writeFileSync(handoff, "Stopped at: x\nFirst step tomorrow: y\nOpen question: none\n");
  const out = JSON.parse(hook(w, "pause.mjs", { tool_name: "Bash", tool_input: { command: "echo hi" } }, "2026-10-29T18:03:00").out);
  assert.equal(out.continue, false);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("pause: MultiEdit may write the handoff, but a symlinked TOMORROW.md is never written through", () => {
  const w = world();
  hook(w, "gate.mjs", { session_id: "other", prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const handoff = path.join(w.project, "TOMORROW.md");
  assert.equal(hook(w, "pause.mjs", { tool_name: "MultiEdit", tool_input: { file_path: handoff } }, "2026-10-29T18:01:00").out, "");
  const victim = path.join(tmp("sd-victim-"), "victim.txt");
  fs.writeFileSync(victim, "keep me");
  fs.symlinkSync(victim, handoff);
  const r = hook(w, "pause.mjs", { tool_name: "Write", tool_input: { file_path: handoff } }, "2026-10-29T18:01:00");
  assert.notEqual(r.out, "");
});

test("gate: a non-text cwd can't let a blocked prompt through", () => {
  const w = world();
  const r = spawnSync("node", [script("gate.mjs")], {
    input: JSON.stringify({ session_id: "s", cwd: 123, prompt: "hi" }),
    env: { ...process.env, SUNDOWN_DIR: w.state, SUNDOWN_NOW: "2026-10-29T23:00:00" }, encoding: "utf8",
  });
  assert.equal(r.status, 2);
});

test("cli: install-statusline only treats its own command as its own", () => {
  const w = world();
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "~/sundown-dashboard/my-line.sh" } }));
  const r = cli(w, ["install-statusline"]);
  assert.equal(r.code, 1);
  assert.match(fs.readFileSync(settings, "utf8"), /sundown-dashboard/);
  assert.equal(cli(w, ["install-statusline", "--force"]).code, 0);
  assert.equal(cli(w, ["install-statusline"]).code, 0); // now it IS ours
});

test("cli: install-statusline only mentions a backup when it made one", () => {
  const w = world();
  const first = cli(w, ["install-statusline"]); // no settings.json yet
  assert.doesNotMatch(first.out, /backup|saved as/);
  const settings = path.join(w.claude, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  assert.match(cli(w, ["install-statusline", "--force"]).out, /saved as settings\.json\.sundown-backup/);
});

test("cli: while Sundown is on, Claude can't loosen it; before the cutoff and in your own terminal it can", () => {
  const w = world();
  const night = "2026-10-29T22:00:00";
  for (const [key, value] of [["cutoff", "off"], ["morning", "06:00"], ["daysOff", "sat"], ["overrideMinutes", "240"]]) {
    const r = cliAs("claude", w, ["config", key, value], night);
    assert.equal(r.code, 1, `${key} should be refused`);
    assert.match(r.err, /only you can change/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).cutoff, "21:00");
  assert.equal(cliAs("you", w, ["config", "overrideMinutes", "30"], night).code, 0);          // your terminal
  assert.equal(cliAs("claude", w, ["config", "cutoff", "22:00"], "2026-10-29T15:00:00").code, 0); // setup, daytime
  assert.equal(cliAs("claude", w, ["config", "pushDetail", "folder"], night).code, 0);          // not a loosening setting
});

test("cli: config needs a value and shows what you typed when it's wrong", () => {
  const w = world();
  for (const args of [["config", "cutoff"], ["config", "daysOff", ""], ["config", "wrapUpMinutes"]]) {
    assert.equal(cli(w, args).code, 1, args.join(" "));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, "config.json"), "utf8")).cutoff, "21:00"); // not wiped
  const bad = cli(w, ["config", "wrapUpMinutes", "abc"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /"abc" is not a valid value/);
  assert.match(cli(w, ["config"]).out, /"daysOff": "none"/);
});

test("cli: the status bar follows wrapUpMinutes", () => {
  const w = world();
  assert.match(cli(w, ["statusline"], "2026-10-29T20:45:00").out, /time to wrap up/);
  cli(w, ["config", "wrapUpMinutes", "10"], "2026-10-29T15:00:00");
  assert.doesNotMatch(cli(w, ["statusline"], "2026-10-29T20:45:00").out, /wrap up/);
  assert.match(cli(w, ["statusline"], "2026-10-29T20:55:00").out, /time to wrap up/);
  cli(w, ["config", "wrapUpMinutes", "off"], "2026-10-29T15:00:00");
  assert.doesNotMatch(cli(w, ["statusline"], "2026-10-29T20:55:00").out, /wrap up/);
});

test("days off: shutting down on a day off lasts to the next working morning and says so", () => {
  const w = world({ cutoff: "21:00", morning: "08:00", daysOff: "sat,sun" });
  const r = hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-31T10:00:00"); // Saturday
  assert.match(r.out, /ON until Mon 08:00/);
  assert.match(cliAs("you", w, ["status"], "2026-10-31T12:00:00").out, /shut down for today \(until Mon 08:00\)/); // Monday is >24h away
  assert.match(cliAs("you", w, ["status"], "2026-11-01T12:00:00").out, /shut down for today \(until 08:00\)/);     // Monday is tomorrow
});

test("cli: wake says when Sundown wasn't on, and an unknown command is an error", () => {
  const w = world();
  assert.match(cliAs("you", w, ["wake"], "2026-10-29T15:00:00").out, /wasn't on/);
  assert.match(cliAs("you", w, ["wake"], "2026-10-29T22:00:00").out, /off until/);
  assert.equal(cli(w, ["bogus"]).code, 1);
  assert.equal(cli(w, ["help"]).code, 0);
});

test("cli: a short ntfy topic gets a warning, a generated one doesn't", () => {
  const w = world();
  assert.match(cli(w, ["config", "ntfyTopic", "abc"]).out, /easy to guess/);
  assert.doesNotMatch(cli(w, ["config", "ntfyTopic", "generate"]).out, /easy to guess/);
});

test("state: a folder and config.json that already exist with open permissions get tightened", () => {
  const w = world();
  fs.chmodSync(w.state, 0o755);
  fs.chmodSync(path.join(w.state, "config.json"), 0o644);
  hook(w, "gate.mjs", { prompt: "hi" }, "2026-10-29T15:00:00");
  assert.equal(fs.statSync(w.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(w.state, "config.json")).mode & 0o777, 0o600);
});

test("morning: the setup nudge doesn't hide the shutdown reminder", () => {
  const state = tmp("sd-state-");
  const w = { state, project: tmp("sd-proj-"), claude: tmp("sd-claude-") };
  hook(w, "gate.mjs", { prompt: "/sundown:shutdown" }, "2026-10-29T18:00:00");
  const msg = JSON.parse(hook(w, "morning.mjs", {}, "2026-10-29T23:00:00").out).systemMessage;
  assert.match(msg, /shut down for today/);
  assert.match(msg, /\/sundown:setup/);
});

test("report: typical finish is the median, so one very late night doesn't skew it", () => {
  const w = world();
  const proj = path.join(w.claude, "projects", "-Users-me-app");
  fs.mkdirSync(proj, { recursive: true });
  const line = (uuid, iso) => JSON.stringify({ type: "user", uuid, timestamp: new Date(iso).toISOString(), message: { content: "x" } }) + "\n";
  fs.writeFileSync(path.join(proj, "s.jsonl"),
    line("a", "2026-10-26T17:00:00") + line("b", "2026-10-27T17:30:00") + line("c", "2026-10-28T23:50:00"));
  const r = cli(w, ["report", "7"], "2026-10-29T15:00:00");
  assert.match(r.out, /Typical finish: 17:30/); // an average would say 19:40
});
