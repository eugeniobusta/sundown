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

// Node built-ins only: fs for the state files, os for the home folder, path for
// building file paths. No third-party packages, so there is nothing to audit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Defaults used when ~/.sundown/config.json doesn't exist or a value is invalid.
// Frozen so nothing can change a default by accident; readConfig copies it.
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
// Order matters: getDay() returns 0 for Sunday, so DAY_NAMES[date.getDay()] is the name.
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Each setting has a validator, so a typo in config.json can never break a hook.
// One validator per setting, keyed by the setting's name.
const VALID = {
  // Empty (no cutoff) or 24h "HH:MM". The regex takes hours 00-19 or 20-23, a colon,
  // then minutes 00-59, and nothing before or after.
  cutoff: (v) => v === "" || (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)),
  // Same "HH:MM" check, but empty is not allowed: a day has to start somewhere.
  morning: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  // ntfy topic names: letters, digits, _ and -, up to 64 chars. Empty = off.
  // The {0,64} lets the empty string through, which means pushes are off.
  ntfyTopic: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(v),
  // Plain http(s)://host with an optional path. The host cannot contain spaces or a
  // slash and the path cannot contain spaces, so the value is one clean URL.
  ntfyServer: (v) => typeof v === "string" && /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v),
  // Only the two documented modes.
  pushDetail: (v) => v === "none" || v === "folder",
  // A whole number from 0 to 86400 (seconds in a day: 24 * 60 * 60).
  minTurnSeconds: (v) => Number.isInteger(v) && v >= 0 && v <= 86400,
  // A whole number of minutes, 1 to 240 (4 hours), so an override can't become
  // an all-night pass.
  overrideMinutes: (v) => Number.isInteger(v) && v >= 1 && v <= 240,
  // Comma-separated day names, no repeats, at least one working day left.
  daysOff: (v) => {
    // Empty means no days off.
    if (v === "") return true;
    // Anything that isn't text is invalid.
    if (typeof v !== "string") return false;
    // One entry per day name.
    const days = v.split(",");
    // Fewer than 7 entries (so one working day is always left), no repeats (a Set drops
    // duplicates, so its size would shrink), and every entry is a known day name.
    return days.length < 7 && new Set(days).size === days.length && days.every((d) => DAY_NAMES.includes(d));
  },
  // A whole number from 0 (off) to 120 minutes.
  wrapUpMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 120,
};

// True only for known keys. hasOwnProperty stops names like "constructor" or
// "__proto__" from reaching VALID through the prototype chain.
export function isValidSetting(key, value) {
  // Known key only; run its validator on the value.
  return Object.prototype.hasOwnProperty.call(VALID, key) && VALID[key](value);
}

// Where state lives. Created with owner-only permissions (0700).
export function stateDir() {
  // SUNDOWN_DIR wins when set (the tests use it); otherwise ~/.sundown.
  const dir = process.env.SUNDOWN_DIR || path.join(os.homedir(), ".sundown");
  // Create the folder (and parents) if missing. 0o700 = owner can read/write/enter,
  // nobody else can.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Also fix a folder that already existed with looser permissions.
  tighten(dir, 0o700);
  // Hand the path back to the caller.
  return dir;
}

// "mode" only applies to things we create. If the folder or file already existed with
// looser permissions (older install, or made by hand), make it private. Only ever
// touches things you own.
function tighten(target, mode) {
  // A missing or unreadable target must not crash a hook, so everything is in try.
  try {
    // Look up the current permissions and owner.
    const st = fs.statSync(target);
    // 0o077 selects the group and other permission bits. If any is set, and the file is
    // ours (uid matches the current user), restrict it to the given mode.
    if ((st.mode & 0o077) && st.uid === process.getuid()) fs.chmodSync(target, mode);
  } catch { /* nothing to tighten */ }
}

// Read config.json and keep only valid values; anything else falls back to the default.
export function readConfig() {
  // Start from a copy of the defaults so the frozen original is never modified.
  const cfg = { ...DEFAULTS };
  // Any failure below (no file, bad JSON) just leaves the defaults in place.
  try {
    // The config file inside the state folder.
    const file = path.join(stateDir(), "config.json");
    // Make an older config file private (0o600 = owner read/write only).
    tighten(file, 0o600);
    // Parse the file. A broken file throws and lands in the catch below.
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    // Only look at settings we know about, so extra keys in the file are ignored.
    for (const key of Object.keys(DEFAULTS)) {
      // Take the value only if it's present and valid; otherwise the default stays.
      if (key in raw && isValidSetting(key, raw[key])) cfg[key] = raw[key];
    }
  // Missing, unreadable or broken file: fall through to the defaults.
  } catch {
    // no file yet, or unreadable: defaults are fine
  }
  // Always return a complete config, whether or not the file was usable.
  return cfg;
}

// Change one setting. Throws a readable error if the value isn't allowed.
export function setConfig(key, value) {
  // Refuse names that aren't real settings, and list the real ones in the error.
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(DEFAULTS).join(", ")}`);
  // Refuse values the validator rejects.
  if (!isValidSetting(key, value)) throw new Error(`"${value}" is not a valid value for ${key}.`);
  // The config file inside the state folder.
  const file = path.join(stateDir(), "config.json");
  // Start empty so a missing or broken file simply becomes a new one.
  let current = {};
  // Keep the other settings already in the file; a failed read means there are none.
  try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new file */ }
  // Change just the one setting.
  current[key] = value;
  // Write pretty JSON with a trailing newline. mode 0o600 = owner read/write only.
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600); // "mode" only applies to new files; make an older file private too
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// "Now". SUNDOWN_NOW lets tests and the live demo pretend it's another time,
// e.g. SUNDOWN_NOW=2026-10-30T08:30:00 to show "tomorrow morning".
export function now() {
  // Read the override from the environment (empty or unset means use the real clock).
  const fake = process.env.SUNDOWN_NOW;
  // Only try a fake time if one was given.
  if (fake) {
    // Parse it as a date.
    const d = new Date(fake);
    // A garbage value gives an invalid date (NaN time); ignore it and fall through to the real clock.
    if (!Number.isNaN(d.getTime())) return d;
  }
  // The real current time.
  return new Date();
}

// "19:30" -> 1170 (minutes after midnight)
export function toMinutes(hhmm) {
  // Split "HH:MM" on the colon and turn both parts into numbers.
  const [h, m] = hhmm.split(":").map(Number);
  // Hours times 60 (minutes in an hour) plus the minutes.
  return h * 60 + m;
}

// Minutes after local midnight for a Date.
export function minuteOfDay(date) {
  // Hours times 60 plus minutes, in the machine's local time zone.
  return date.getHours() * 60 + date.getMinutes();
}

// Is this moment inside quiet hours (between cutoff and morning)?
// Handles the normal case where quiet hours cross midnight (19:30 -> 08:00).
export function isQuiet(date, cfg) {
  if (!cfg.cutoff) return false;           // no cutoff chosen yet: never quiet
  // Current minute of the day.
  const m = minuteOfDay(date);
  // Cutoff as minutes after midnight.
  const c = toMinutes(cfg.cutoff);
  // Morning as minutes after midnight.
  const mo = toMinutes(cfg.morning);
  if (c === mo) return false;              // cutoff == morning means "never quiet"
  if (c < mo) return m >= c && m < mo;     // e.g. 01:00 -> 08:00 (same night)
  return m >= c || m < mo;                 // e.g. 19:30 -> 08:00 (crosses midnight)
}

// The workday a moment belongs to: before your morning time it's still "yesterday",
// so 01:10 on Saturday is part of Friday evening. Returns a Date at noon that day.
function workdayNoon(date, cfg) {
  // Copy the date so the caller's Date is not modified.
  const d = new Date(date);
  // Before the morning time we are still in the previous day's evening, so step back one day.
  if (minuteOfDay(d) < toMinutes(cfg.morning)) d.setDate(d.getDate() - 1);
  // Pin to 12:00:00.000 so adding or removing an hour at a daylight-saving change can't
  // move the date into a neighbouring day.
  d.setHours(12, 0, 0, 0);
  // Hand back the noon Date.
  return d;
}

// That workday as "YYYY-MM-DD".
export function workdayKey(date, cfg) {
  // Work from the workday's noon, so the date is the workday and not the calendar day.
  const d = workdayNoon(date, cfg);
  // Two digits with a leading zero ("7" becomes "07").
  const pad = (n) => String(n).padStart(2, "0");
  // getMonth() counts from 0, so add 1. Result looks like 2026-10-29.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Is this moment part of one of your days off (from that morning to the next)?
export function isDayOff(date, cfg) {
  // No days off configured: nothing to check.
  if (!cfg.daysOff) return false;
  // Find the workday's weekday name and see whether it's in the days-off list.
  return cfg.daysOff.split(",").includes(DAY_NAMES[workdayNoon(date, cfg).getDay()]);
}

// The next "morning" time strictly after the given moment.
export function nextMorningAfter(date, cfg) {
  // Morning as minutes after midnight.
  const mo = toMinutes(cfg.morning);
  // Copy the date so the caller's Date is not modified.
  const d = new Date(date);
  // Set the clock to the morning time on that same day (hours = whole hours, minutes = the remainder; seconds and milliseconds zero).
  d.setHours(Math.floor(mo / 60), mo % 60, 0, 0);
  // If that time has already passed (or is right now), use tomorrow's instead: "strictly after".
  if (d <= date) d.setDate(d.getDate() + 1);
  // Hand back the Date.
  return d;
}

// The next morning that starts a working day (skips your days off).
export function nextWorkMorningAfter(date, cfg) {
  // The very next morning, which may be a day off.
  let d = nextMorningAfter(date, cfg);
  // Keep stepping to the following morning while it is a day off. The i < 7 limit stops
  // an endless loop; daysOff always leaves at least one working day, so 7 steps always suffice.
  for (let i = 0; i < 7 && isDayOff(d, cfg); i++) d = nextMorningAfter(d, cfg);
  // Hand back the first working morning.
  return d;
}

// The next cutoff time strictly after the given moment.
// With no cutoff chosen, "the end of today" (23:59) is used instead.
export function nextCutoffAfter(date, cfg) {
  // No cutoff set: use 23:59 so "the end of today" is still a sensible time.
  const c = toMinutes(cfg.cutoff || "23:59");
  // Copy the date so the caller's Date is not modified.
  const d = new Date(date);
  // Set the clock to the cutoff time on that same day (whole hours, then the remainder minutes; seconds and ms zero).
  d.setHours(Math.floor(c / 60), c % 60, 0, 0);
  // If the cutoff already passed (or is right now), use tomorrow's instead: "strictly after".
  if (d <= date) d.setDate(d.getDate() + 1);
  // Hand back the Date.
  return d;
}

// 08:00-style local time for messages.
export function hhmm(date) {
  // Pad hours and minutes to two digits each, e.g. 08:05.
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Lock (set by /sundown:shutdown, ends automatically at the next morning)
// ---------------------------------------------------------------------------

// Read and parse a JSON file; a missing or broken file gives null, never an error.
function readJsonFile(file) {
  // The try/catch turns any read or parse failure into null.
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// Start the lock: note when it began and when it ends.
export function lockOn(date, cfg) {
  // setAtReal is the real clock, for comparing with file times when SUNDOWN_NOW fakes "now".
  // until is the next morning that starts a working day, so a Friday-night shutdown runs through a weekend day off.
  const lock = { setAt: date.toISOString(), setAtReal: new Date().toISOString(), until: nextWorkMorningAfter(date, cfg).toISOString() };
  // Write the lock file (owner read/write only, 0o600), one JSON line.
  fs.writeFileSync(path.join(stateDir(), "lock"), JSON.stringify(lock) + "\n", { mode: 0o600 });
  // Shutting down cancels any earlier "wake" and every override pass still running.
  // Remove the "awake" marker. force: true means no error if it isn't there.
  fs.rmSync(path.join(stateDir(), "awake"), { force: true });
  // Remove all override passes. recursive is needed because passes is a folder.
  fs.rmSync(path.join(stateDir(), "passes"), { recursive: true, force: true });
  // Hand back the lock so the caller can show when it ends.
  return lock;
}

export function lockOff() {
  // Delete the lock file. force: true means no error if there is none.
  fs.rmSync(path.join(stateDir(), "lock"), { force: true });
}

// null when there is no lock; otherwise { setAt, setAtReal, until, active } where
// active = the lock hasn't reached its morning yet.
export function lockState(date) {
  // Read the lock file (null if missing or broken).
  const lock = readJsonFile(path.join(stateDir(), "lock"));
  // No lock, or one missing a field we need: treat as no lock.
  if (!lock || !lock.setAt || !lock.until) return null;
  // When the lock began.
  const setAt = new Date(lock.setAt);
  // When the lock ends.
  const until = new Date(lock.until);
  // Unparseable dates mean a damaged file: treat as no lock.
  if (Number.isNaN(setAt.getTime()) || Number.isNaN(until.getTime())) return null;
  // Real-clock start time. Older lock files don't have it, which gives an invalid date.
  const real = new Date(lock.setAtReal);
  // Older files without a real-clock time fall back to setAt. active is true while now is before the end.
  return { setAt, setAtReal: Number.isNaN(real.getTime()) ? setAt : real, until, active: date < until };
}

// /sundown:wake: "I'm working early today" — ignores the lock and quiet hours
// until the next cutoff.
export function wake(date, cfg) {
  // A shutdown and an early wake can't both be on, so remove the lock first.
  lockOff();
  // The wake lasts until the next cutoff.
  const until = nextCutoffAfter(date, cfg);
  // Write the awake marker (owner read/write only, 0o600).
  fs.writeFileSync(path.join(stateDir(), "awake"), JSON.stringify({ until: until.toISOString() }) + "\n", { mode: 0o600 });
  // Hand back the end time so the caller can show it.
  return until;
}

function awakeUntil(date) {
  // Read the marker file (null if missing or broken).
  const a = readJsonFile(path.join(stateDir(), "awake"));
  // No marker, or one without an end time: not awake.
  if (!a || !a.until) return null;
  // When the early wake ends.
  const until = new Date(a.until);
  // Return the end time only if it's a valid date and still in the future; otherwise null.
  return !Number.isNaN(until.getTime()) && date < until ? until : null;
}

// The one question every hook asks: is Sundown active right now, and why?
// Returns { why: "lock" | "quiet" | null, until: Date | null }.
export function sundownState(date, cfg) {
  // An early wake beats everything else: Sundown is off for now.
  if (awakeUntil(date)) return { why: null, until: null };
  // Look at the shutdown lock.
  const lock = lockState(date);
  // A shutdown still running: on until its morning.
  if (lock && lock.active) return { why: "lock", until: lock.until };
  // A day off: on until the next working morning.
  if (isDayOff(date, cfg)) return { why: "dayoff", until: nextWorkMorningAfter(date, cfg) };
  // Inside the nightly quiet hours: on until the next working morning.
  if (isQuiet(date, cfg)) return { why: "quiet", until: nextWorkMorningAfter(date, cfg) };
  // None of the above: Sundown is off.
  return { why: null, until: null };
}

// Why Sundown is on, as the end of a sentence: "☾ Sundown: <reason>."
export function reasonText(state, cfg) {
  // The lock was set by /sundown:shutdown.
  if (state.why === "lock") return `you shut down for today (until ${dayAndTime(state.until)})`;
  // A day off.
  if (state.why === "dayoff") return `it's your day off (until ${dayAndTime(state.until)})`;
  // Anything else is the nightly cutoff.
  return `it's after your ${cfg.cutoff} cutoff (until ${dayAndTime(state.until)})`;
}

// "08:00", or "Mon 08:00" when it isn't tomorrow morning (after a day off).
export function dayAndTime(date, from = now()) {
  // 86400000 ms = one day (24 * 60 * 60 * 1000). If the end is more than a day away, include
  // the weekday name; the array is indexed by getDay() (0 = Sunday).
  return date - from > 86400000 ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]} ${hhmm(date)}` : hhmm(date);
}

// Minutes left before today's cutoff, or null when there is no cutoff or Sundown is
// already on. Used for the one "time to wrap up" note.
export function minutesToCutoff(date, cfg) {
  // No cutoff, or Sundown already on: there is nothing to count down to.
  if (!cfg.cutoff || sundownState(date, cfg).why) return null;
  // The difference is in milliseconds; divide by 60000 (ms per minute) and round up so 29.2 minutes shows as 30.
  return Math.ceil((nextCutoffAfter(date, cfg) - date) / 60000);
}

// Show the wrap-up note at most once per workday. Returns true the first time.
export function claimWrapUp(date, cfg) {
  // The file remembers which workday the note was last shown.
  const file = path.join(stateDir(), "wrapup");
  // Today's workday as YYYY-MM-DD.
  const key = workdayKey(date, cfg);
  // If the file already holds today's workday, the note was shown: return false. A missing file throws and means first time.
  try { if (fs.readFileSync(file, "utf8").trim() === key) return false; } catch { /* first time */ }
  // Record that it's now been shown.
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  // First time today: the caller may show the note.
  return true;
}

// The first-run "run /sundown:setup" note, shown once if setup was never run.
export function claimWelcome() {
  // The state folder.
  const dir = stateDir();
  // If setup ran (config.json exists) or the note was already shown (welcomed exists), don't show it.
  if (fs.existsSync(path.join(dir, "config.json")) || fs.existsSync(path.join(dir, "welcomed"))) return false;
  // Remember that it was shown, with the time for reference.
  fs.writeFileSync(path.join(dir, "welcomed"), new Date().toISOString() + "\n", { mode: 0o600 });
  // First time: the caller may show the note.
  return true;
}

// ---------------------------------------------------------------------------
// Per-session files (turn start times and override passes)
// ---------------------------------------------------------------------------

// Session ids come from Claude Code, but we still refuse anything that isn't a
// plain id, so a strange value can never write outside ~/.sundown.
export function safeId(id) {
  // A string of 1 to 128 letters, digits, _ or - and nothing else (no slashes or dots, so no path
  // tricks such as "../"). Anything else gives null.
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function sessionFile(kind, sessionId) {
  // An unsafe id means no file at all.
  const id = safeId(sessionId);
  if (!id) return null;
  // The kind folder ("turns" or "passes") inside the state folder.
  const dir = path.join(stateDir(), kind);
  // Create it if missing, owner-only (0o700).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One file per session, named by the checked id.
  return path.join(dir, id);
}

export function recordTurnStart(sessionId, date) {
  // Records when this session's latest prompt was sent.
  const f = sessionFile("turns", sessionId);
  // Only write when the id was safe (otherwise f is null). Owner read/write only (0o600).
  if (f) fs.writeFileSync(f, date.toISOString() + "\n", { mode: 0o600 });
}

export function turnStart(sessionId) {
  // Find the file for this session.
  const f = sessionFile("turns", sessionId);
  // Unsafe id: no known start time.
  if (!f) return null;
  // A missing file or bad date shouldn't crash a hook.
  try {
    // Parse the stored time.
    const d = new Date(fs.readFileSync(f, "utf8").trim());
    // A damaged file gives an invalid date: return null instead.
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    // Missing file: no known start time.
    return null;
  }
}

export function grantPass(sessionId, date, minutes) {
  // Find the file for this session.
  const f = sessionFile("passes", sessionId);
  // Only write when the id was safe. The pass ends `minutes` from now (60000 ms per minute). Owner-only file (0o600).
  if (f) fs.writeFileSync(f, new Date(date.getTime() + minutes * 60000).toISOString() + "\n", { mode: 0o600 });
}

export function hasPass(sessionId, date) {
  // Find the file for this session.
  const f = sessionFile("passes", sessionId);
  // Unsafe id: no pass.
  if (!f) return false;
  // A missing file shouldn't crash a hook.
  try {
    // Parse the stored end time.
    const until = new Date(fs.readFileSync(f, "utf8").trim());
    // The pass is valid while now is before its end. A garbage date compares false, so it counts as no pass.
    return date < until;
  } catch {
    // No file: no pass.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read-only shell commands (allowed while shut down, so Claude can write the handoff)
// ---------------------------------------------------------------------------

// Shell commands Claude may run while you are shut down, so it can look at the project
// and write an accurate handoff. This is an ALLOWLIST: a command passes only if every
// part of it is known to be safe. (An earlier denylist of "bad flags" was bypassed with
// quoting tricks like find -ex''ec.)
//
// Rule 1: no shell features at all. Quotes, globs, braces, $, backticks, ~, ;, &, <, >,
//         ( ) and newlines are refused, so what you read is exactly what the shell runs.
//         The only operator allowed is "|", to pipe one allowed command into another.
// Rule 2: the program must be on the list below, and every flag must be on its list.
// Anything matching this is refused. The character class lists: ; & < > ` \ $ ( ) { } [ ] * ? ~ ! ' " and
// newline, carriage return and tab. They cover chaining, redirection, substitution, globbing,
// quoting and history expansion, so the text we check is exactly what the shell would run.
const SHELL_FEATURES = /[;&<>`\\$(){}\[\]*?~!'"\n\r\t]/;

// Flags that are fine for most listing and reading commands: short flags such as -la or
// -rn, and plain long flags such as --oneline. (Quotes are refused above, so a flag can
// never hide a second word.)
// Matches either a short flag (a dash then letters or digits, like -la or -n5) or a long flag
// (two dashes, a lowercase name with dashes, optionally =value made of letters, digits, _ . , / -).
// A flag with spaces, quotes or other symbols does not match.
const PLAIN_FLAG = /^(-[A-Za-z0-9]+|--[a-z][a-z-]*(=[A-Za-z0-9_.,\/-]+)?)$/;

// find is the dangerous one (-exec, -delete, -fprint...), so it gets an exact flag list.
// The only find flags allowed: name and path matching, type, depth limits, time and size tests,
// and not / or / and. Everything else (-exec, -delete, -fprint...) is refused.
const FIND_FLAGS = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-newer", "-mtime", "-size", "-not", "-o", "-a"]);

// git subcommands that only read. Flags that can write a file or run a program are refused.
// The only git subcommands allowed; all of them just read.
const GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "ls-files"]);
// Flag names containing any of these words are refused: they can write a file, start a pager or
// external program, or compare files outside the repository.
const GIT_BAD_FLAG = /output|exec|ext-diff|textconv|open-files-in-pager|pager|no-index/;

// One command word + its arguments: is it safe?
function segmentIsReadOnly(words) {
  // The program name, and everything after it.
  const [cmd, ...rest] = words;
  // Every argument that looks like a flag.
  const flags = rest.filter((w) => w.startsWith("-"));
  // Decide per program.
  switch (cmd) {
    // Plain listing and reading commands: safe as long as their flags are plain.
    case "ls": case "cat": case "head": case "wc": case "pwd": case "grep":
      return flags.every((f) => PLAIN_FLAG.test(f));
    // tail is allowed but not in follow mode.
    case "tail":
      return flags.every((f) => PLAIN_FLAG.test(f) && !/^-[A-Za-z0-9]*[fF]/.test(f) && !/^--follow/.test(f)); // -f never ends
    // find is checked against its own exact flag list.
    case "find":
      // Every word that starts with "-" must be on the list (so -exec and -delete never pass).
      return flags.every((f) => FIND_FLAGS.has(f));
    // git is allowed only for the read-only subcommands, with plain flags that don't write files or run programs.
    case "git":
      return GIT_SUBCOMMANDS.has(rest[0]) && flags.every((f) => PLAIN_FLAG.test(f) && !GIT_BAD_FLAG.test(f));
    // Any other program is refused.
    default:
      return false; // anything not named above (sort, uniq, rg, tree, sed, rm, node...) is refused
  }
}

export function isReadOnlyBash(command) {
  // Empty, not text, or suspiciously long: refuse.
  if (typeof command !== "string" || !command.trim() || command.length > 500) return false;
  // Rule 1: refuse every shell feature except the pipe.
  if (SHELL_FEATURES.test(command)) return false;
  // Rule 2: every piped part must be a safe command. "||" leaves an empty part, which fails.
  return command.split("|").every((part) => {
    // Split on runs of whitespace into words.
    const words = part.trim().split(/\s+/);
    // An empty first word means an empty part (e.g. from "||" or a trailing pipe): refuse. Otherwise the part must be a safe command.
    return words[0] !== "" && segmentIsReadOnly(words);
  });
}

// ---------------------------------------------------------------------------
// Event log (never contains prompt text, file contents or code)
// ---------------------------------------------------------------------------

export function logEvent(type, fields = {}) {
  // Never lose a hook to a logging failure, so everything is in try.
  try {
    // One JSON object per line: time, event type, then the caller's extra fields (never prompt text).
    const line = JSON.stringify({ t: now().toISOString(), type, ...fields });
    // Append (creating the file if needed) with owner-only permissions (0o600).
    fs.appendFileSync(path.join(stateDir(), "events.log"), line + "\n", { mode: 0o600 });
  } catch {
    // logging must never break a hook
  }
}

export function readEvents() {
  // Missing file means no events.
  try {
    return fs.readFileSync(path.join(stateDir(), "events.log"), "utf8")
      // Split into lines and drop empty ones.
      .split("\n").filter(Boolean)
      // Parse each line; a damaged line becomes null, and the next step drops it.
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      // Keep only the lines that parsed.
      .filter(Boolean);
  } catch {
    // No log yet: no events.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hook plumbing
// ---------------------------------------------------------------------------

// Claude Code sends each hook a JSON object on stdin. Returns {} if it's missing or broken.
export async function readHookInput() {
  // Collect the whole stdin text.
  let raw = "";
  // stdin is async: append each chunk as it arrives until the stream ends.
  for await (const chunk of process.stdin) raw += chunk;
  // Parse the text; empty or broken input throws and lands in the catch.
  try {
    const parsed = JSON.parse(raw);
    // Only a real object counts (not null, number or string); otherwise use {}.
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or broken input: an empty object.
    return {};
  }
}

// The project folder the hook is about.
export function projectDir(input) {
  // Prefer the folder Claude Code reported for this hook, if it's non-empty text.
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  // Otherwise the project env variable, and finally the current folder.
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// Where Claude Code keeps session transcripts (respects CLAUDE_CONFIG_DIR).
export function claudeProjectsDir() {
  // CLAUDE_CONFIG_DIR overrides the folder; otherwise ~/.claude.
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  // Transcripts are kept in a "projects" subfolder.
  return path.join(base, "projects");
}
