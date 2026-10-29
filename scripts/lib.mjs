// lib.mjs — shared helpers used by every Sundown script.
//
// Everything Sundown remembers lives in ONE folder on your machine:
//   ~/.sundown/            (or $SUNDOWN_DIR, which the tests use)
//     config.json          your settings: cutoff, morning, phone pushes
//     lock                 exists while you're "shut down" for the night
//     awake                exists after /sundown:wake (lets you work early)
//     wrapup               the day the "time to wrap up" note was last shown
//     welcomed             exists once the first-run "run /sundown:setup" note was shown
//     events.log           one JSON line per block / override / push / pause
//     turns/<session>      when you last sent a prompt in that session
//     passes/<session>     a short "override" pass for that session
//     report.html          the latest weekly report
//
// Nothing here talks to the network. Only push.mjs does, and only if you
// configured a phone topic.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Defaults used when ~/.sundown/config.json doesn't exist or a value is invalid.
export const DEFAULTS = Object.freeze({
  cutoff: "",               // when your evening starts (24h, local time). "" = no evening cutoff
                            // until you choose one in /sundown:setup (so installing never blocks you)
  morning: "08:00",         // when your day starts again
  ntfyTopic: "",            // phone pushes are OFF until you set a topic
  ntfyServer: "https://ntfy.sh",
  pushDetail: "none",       // "none" = generic text; "folder" = include the project folder name
  minTurnSeconds: 60,       // only push "Claude finished" after turns at least this long
  overrideMinutes: 20,      // how long one "override:" lets that session work
  daysOff: "",              // whole days Sundown keeps quiet, e.g. "sat,sun". "" = none
  wrapUpMinutes: 30,        // one gentle "time to wrap up" note this long before the cutoff. 0 = off
});

// Day names as used in daysOff, indexed like Date.getDay() (0 = Sunday).
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Each setting has a validator, so a typo in config.json can never break a hook.
const VALID = {
  cutoff: (v) => v === "" || (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)),
  morning: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  // ntfy topic names: letters, digits, _ and -, up to 64 chars. Empty = off.
  ntfyTopic: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(v),
  ntfyServer: (v) => typeof v === "string" && /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v),
  pushDetail: (v) => v === "none" || v === "folder",
  minTurnSeconds: (v) => Number.isInteger(v) && v >= 0 && v <= 86400,
  overrideMinutes: (v) => Number.isInteger(v) && v >= 1 && v <= 240,
  // Comma-separated day names, no repeats, at least one working day left.
  daysOff: (v) => {
    if (v === "") return true;
    if (typeof v !== "string") return false;
    const days = v.split(",");
    return days.length < 7 && new Set(days).size === days.length && days.every((d) => DAY_NAMES.includes(d));
  },
  wrapUpMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 120,
};

export function isValidSetting(key, value) {
  return Object.prototype.hasOwnProperty.call(VALID, key) && VALID[key](value);
}

// Where state lives. Created with owner-only permissions (0700).
export function stateDir() {
  const dir = process.env.SUNDOWN_DIR || path.join(os.homedir(), ".sundown");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
  return dir;
}

// "mode" only applies to things we create. If the folder or file already existed with
// looser permissions (older install, or made by hand), make it private. Only ever
// touches things you own.
function tighten(target, mode) {
  try {
    const st = fs.statSync(target);
    if ((st.mode & 0o077) && st.uid === process.getuid()) fs.chmodSync(target, mode);
  } catch { /* nothing to tighten */ }
}

// Read config.json and keep only valid values; anything else falls back to the default.
export function readConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const file = path.join(stateDir(), "config.json");
    tighten(file, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of Object.keys(DEFAULTS)) {
      if (key in raw && isValidSetting(key, raw[key])) cfg[key] = raw[key];
    }
  } catch {
    // no file yet, or unreadable: defaults are fine
  }
  return cfg;
}

// Change one setting. Throws a readable error if the value isn't allowed.
export function setConfig(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(DEFAULTS).join(", ")}`);
  if (!isValidSetting(key, value)) throw new Error(`"${value}" is not a valid value for ${key}.`);
  const file = path.join(stateDir(), "config.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new file */ }
  current[key] = value;
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600); // "mode" only applies to new files; make an older file private too
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// "Now". SUNDOWN_NOW lets tests and the live demo pretend it's another time,
// e.g. SUNDOWN_NOW=2026-10-30T08:30:00 to show "tomorrow morning".
export function now() {
  const fake = process.env.SUNDOWN_NOW;
  if (fake) {
    const d = new Date(fake);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

// "19:30" -> 1170 (minutes after midnight)
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Minutes after local midnight for a Date.
export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Is this moment inside quiet hours (between cutoff and morning)?
// Handles the normal case where quiet hours cross midnight (19:30 -> 08:00).
export function isQuiet(date, cfg) {
  if (!cfg.cutoff) return false;           // no cutoff chosen yet: never quiet
  const m = minuteOfDay(date);
  const c = toMinutes(cfg.cutoff);
  const mo = toMinutes(cfg.morning);
  if (c === mo) return false;              // cutoff == morning means "never quiet"
  if (c < mo) return m >= c && m < mo;     // e.g. 01:00 -> 08:00 (same night)
  return m >= c || m < mo;                 // e.g. 19:30 -> 08:00 (crosses midnight)
}

// The workday a moment belongs to: before your morning time it's still "yesterday",
// so 01:10 on Saturday is part of Friday evening. Returns a Date at noon that day.
function workdayNoon(date, cfg) {
  const d = new Date(date);
  if (minuteOfDay(d) < toMinutes(cfg.morning)) d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d;
}

// That workday as "YYYY-MM-DD".
export function workdayKey(date, cfg) {
  const d = workdayNoon(date, cfg);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Is this moment part of one of your days off (from that morning to the next)?
export function isDayOff(date, cfg) {
  if (!cfg.daysOff) return false;
  return cfg.daysOff.split(",").includes(DAY_NAMES[workdayNoon(date, cfg).getDay()]);
}

// The next "morning" time strictly after the given moment.
export function nextMorningAfter(date, cfg) {
  const mo = toMinutes(cfg.morning);
  const d = new Date(date);
  d.setHours(Math.floor(mo / 60), mo % 60, 0, 0);
  if (d <= date) d.setDate(d.getDate() + 1);
  return d;
}

// The next morning that starts a working day (skips your days off).
export function nextWorkMorningAfter(date, cfg) {
  let d = nextMorningAfter(date, cfg);
  for (let i = 0; i < 7 && isDayOff(d, cfg); i++) d = nextMorningAfter(d, cfg);
  return d;
}

// The next cutoff time strictly after the given moment.
// With no cutoff chosen, "the end of today" (23:59) is used instead.
export function nextCutoffAfter(date, cfg) {
  const c = toMinutes(cfg.cutoff || "23:59");
  const d = new Date(date);
  d.setHours(Math.floor(c / 60), c % 60, 0, 0);
  if (d <= date) d.setDate(d.getDate() + 1);
  return d;
}

// 08:00-style local time for messages.
export function hhmm(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Lock (set by /sundown:shutdown, ends automatically at the next morning)
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function lockOn(date, cfg) {
  // setAtReal is the real clock, for comparing with file times when SUNDOWN_NOW fakes "now".
  const lock = { setAt: date.toISOString(), setAtReal: new Date().toISOString(), until: nextWorkMorningAfter(date, cfg).toISOString() };
  fs.writeFileSync(path.join(stateDir(), "lock"), JSON.stringify(lock) + "\n", { mode: 0o600 });
  // Shutting down cancels any earlier "wake" and every override pass still running.
  fs.rmSync(path.join(stateDir(), "awake"), { force: true });
  fs.rmSync(path.join(stateDir(), "passes"), { recursive: true, force: true });
  return lock;
}

export function lockOff() {
  fs.rmSync(path.join(stateDir(), "lock"), { force: true });
}

// null when there is no lock; otherwise { setAt, setAtReal, until, active } where
// active = the lock hasn't reached its morning yet.
export function lockState(date) {
  const lock = readJsonFile(path.join(stateDir(), "lock"));
  if (!lock || !lock.setAt || !lock.until) return null;
  const setAt = new Date(lock.setAt);
  const until = new Date(lock.until);
  if (Number.isNaN(setAt.getTime()) || Number.isNaN(until.getTime())) return null;
  const real = new Date(lock.setAtReal);
  return { setAt, setAtReal: Number.isNaN(real.getTime()) ? setAt : real, until, active: date < until };
}

// /sundown:wake: "I'm working early today" — ignores the lock and quiet hours
// until the next cutoff.
export function wake(date, cfg) {
  lockOff();
  const until = nextCutoffAfter(date, cfg);
  fs.writeFileSync(path.join(stateDir(), "awake"), JSON.stringify({ until: until.toISOString() }) + "\n", { mode: 0o600 });
  return until;
}

function awakeUntil(date) {
  const a = readJsonFile(path.join(stateDir(), "awake"));
  if (!a || !a.until) return null;
  const until = new Date(a.until);
  return !Number.isNaN(until.getTime()) && date < until ? until : null;
}

// The one question every hook asks: is Sundown active right now, and why?
// Returns { why: "lock" | "quiet" | null, until: Date | null }.
export function sundownState(date, cfg) {
  if (awakeUntil(date)) return { why: null, until: null };
  const lock = lockState(date);
  if (lock && lock.active) return { why: "lock", until: lock.until };
  if (isDayOff(date, cfg)) return { why: "dayoff", until: nextWorkMorningAfter(date, cfg) };
  if (isQuiet(date, cfg)) return { why: "quiet", until: nextWorkMorningAfter(date, cfg) };
  return { why: null, until: null };
}

// Why Sundown is on, as the end of a sentence: "☾ Sundown: <reason>."
export function reasonText(state, cfg) {
  if (state.why === "lock") return `you shut down for today (until ${dayAndTime(state.until)})`;
  if (state.why === "dayoff") return `it's your day off (until ${dayAndTime(state.until)})`;
  return `it's after your ${cfg.cutoff} cutoff (until ${dayAndTime(state.until)})`;
}

// "08:00", or "Mon 08:00" when it isn't tomorrow morning (after a day off).
export function dayAndTime(date, from = now()) {
  return date - from > 86400000 ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]} ${hhmm(date)}` : hhmm(date);
}

// Minutes left before today's cutoff, or null when there is no cutoff or Sundown is
// already on. Used for the one "time to wrap up" note.
export function minutesToCutoff(date, cfg) {
  if (!cfg.cutoff || sundownState(date, cfg).why) return null;
  return Math.ceil((nextCutoffAfter(date, cfg) - date) / 60000);
}

// Show the wrap-up note at most once per workday. Returns true the first time.
export function claimWrapUp(date, cfg) {
  const file = path.join(stateDir(), "wrapup");
  const key = workdayKey(date, cfg);
  try { if (fs.readFileSync(file, "utf8").trim() === key) return false; } catch { /* first time */ }
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  return true;
}

// The first-run "run /sundown:setup" note, shown once if setup was never run.
export function claimWelcome() {
  const dir = stateDir();
  if (fs.existsSync(path.join(dir, "config.json")) || fs.existsSync(path.join(dir, "welcomed"))) return false;
  fs.writeFileSync(path.join(dir, "welcomed"), new Date().toISOString() + "\n", { mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------------------
// Per-session files (turn start times and override passes)
// ---------------------------------------------------------------------------

// Session ids come from Claude Code, but we still refuse anything that isn't a
// plain id, so a strange value can never write outside ~/.sundown.
export function safeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function sessionFile(kind, sessionId) {
  const id = safeId(sessionId);
  if (!id) return null;
  const dir = path.join(stateDir(), kind);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, id);
}

export function recordTurnStart(sessionId, date) {
  const f = sessionFile("turns", sessionId);
  if (f) fs.writeFileSync(f, date.toISOString() + "\n", { mode: 0o600 });
}

export function turnStart(sessionId) {
  const f = sessionFile("turns", sessionId);
  if (!f) return null;
  try {
    const d = new Date(fs.readFileSync(f, "utf8").trim());
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function grantPass(sessionId, date, minutes) {
  const f = sessionFile("passes", sessionId);
  if (f) fs.writeFileSync(f, new Date(date.getTime() + minutes * 60000).toISOString() + "\n", { mode: 0o600 });
}

export function hasPass(sessionId, date) {
  const f = sessionFile("passes", sessionId);
  if (!f) return false;
  try {
    const until = new Date(fs.readFileSync(f, "utf8").trim());
    return date < until;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read-only shell commands (allowed while shut down, so Claude can write the handoff)
// ---------------------------------------------------------------------------

// Commands that only look. No shell features that could chain, redirect or run
// something else are allowed: a command is one or more of these joined by "|" and
// nothing more.
const READ_ONLY_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "pwd", "stat", "file", "sort", "uniq"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "ls-files"]);
// Flags that turn an otherwise read-only command into one that writes or runs things.
const DANGEROUS_FLAG = /^(-exec|-execdir|-ok|-okdir|-delete|-fprint\w*|-fls|--output(=.*)?|-o)$/;

export function isReadOnlyBash(command) {
  if (typeof command !== "string" || !command.trim() || command.length > 500) return false;
  if (/[;&<>`\n\r\\]|\$\(|\$\{/.test(command)) return false; // chaining, redirects, substitution, escapes
  return command.split("|").every((segment) => {
    const words = segment.trim().split(/\s+/);
    const [cmd, sub] = words;
    if (cmd === "git") return READ_ONLY_GIT.has(sub) && !words.some((w) => DANGEROUS_FLAG.test(w));
    return READ_ONLY_CMDS.has(cmd) && !words.some((w) => DANGEROUS_FLAG.test(w));
  });
}

// ---------------------------------------------------------------------------
// Event log (never contains prompt text, file contents or code)
// ---------------------------------------------------------------------------

export function logEvent(type, fields = {}) {
  try {
    const line = JSON.stringify({ t: now().toISOString(), type, ...fields });
    fs.appendFileSync(path.join(stateDir(), "events.log"), line + "\n", { mode: 0o600 });
  } catch {
    // logging must never break a hook
  }
}

export function readEvents() {
  try {
    return fs.readFileSync(path.join(stateDir(), "events.log"), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hook plumbing
// ---------------------------------------------------------------------------

// Claude Code sends each hook a JSON object on stdin. Returns {} if it's missing or broken.
export async function readHookInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// The project folder the hook is about.
export function projectDir(input) {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// Where Claude Code keeps session transcripts (respects CLAUDE_CONFIG_DIR).
export function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}
