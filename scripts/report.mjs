// report.mjs — "Where did my evenings go?" Builds the weekly report.
//
// Two sources, both already on your machine:
//   1. Claude Code's own session logs (~/.claude/projects/*/*.jsonl).
//      We read ONLY the timestamp of each message YOU typed. The text of your
//      prompts, Claude's answers and your code are never read into the report.
//   2. Sundown's events.log (blocks, overrides, shutdowns, pushes, mornings that
//      started from a TOMORROW.md handoff).
//
// Each number is compared with the period before it ("4 of 7, was 1 of 7"), so you
// can see whether the evenings are actually coming back.
//
// A late-night message belongs to the day it continues: 01:10 on Friday counts as
// part of Thursday evening (anything before your morning time).
//
// Output: plain text (shown in Claude Code) and ~/.sundown/report.html. Nothing is
// uploaded anywhere.

// Node built-ins: fs reads files and folders, path joins paths, readline reads a file one line at a time.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
// Shared helpers from lib.mjs: where Claude's logs live, the events log, time maths and the same
// quiet-hours rules the gate uses, so the report and the gate can't disagree about what counts as evening.
import {
  claudeProjectsDir, readEvents, toMinutes, minuteOfDay, stateDir, hhmm,
  workdayKey, isQuiet, isDayOff,
} from "./lib.mjs";

// Used for the "evening" column when you haven't chosen a cutoff yet.
export const DEFAULT_EVENING = "19:30";

// Day and month names, indexed by Date.getDay() (0 = Sunday) and Date.getMonth() (0 = January),
// used only for the row labels like "Mon 3 Oct".
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The calendar day a moment belongs to, as "YYYY-MM-DD" (before morning = yesterday).
export function workday(date, cfg) {
  // Delegate to the shared rule in lib.mjs so the report and the gate can't disagree about which day a moment belongs to.
  return workdayKey(date, cfg);
}

// Is this moment in the evening (from the cutoff until the morning)? Same rule as the
// gate, including a cutoff after midnight (01:00 -> 08:00).
export function isEvening(date, cfg) {
  // Fill in the default cutoff when none is set. Without it isQuiet() always says false and every prompt would count as daytime.
  return isQuiet(date, { ...cfg, cutoff: cfg.cutoff || DEFAULT_EVENING });
}

// Minutes since the start of the workday, so 01:10 sorts AFTER 23:50.
function lateness(date, cfg) {
  // Subtract the morning time so the workday starts at 0. Adding 1440 (minutes in a day) before % 1440
  // keeps the result positive, so a time before morning wraps to the end of the day instead of going negative.
  return (minuteOfDay(date) - toMinutes(cfg.morning) + 1440) % 1440;
}

// Is this log line a message a person typed? (Not a tool result, not a skill's
// injected text, not a subagent, not the output of a local command like /plugin.)
export function isHumanPrompt(entry) {
  // Reject anything that isn't a plain user entry: wrong type, marked meta (injected by the system)
  // or from a subagent (sidechain). None of those were typed by you.
  if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  // The message body. The && guards against entries that have no message at all.
  const content = entry.message && entry.message.content;
  // String content is a typed prompt, except the output of local commands like /plugin,
  // which Claude Code logs with a "<local-command" prefix.
  if (typeof content === "string") return !content.startsWith("<local-command");
  // Array content is used when a prompt has several parts (for example text plus an image).
  if (Array.isArray(content)) {
    // A real prompt has at least one part and none of them is a tool_result (tool results are also logged as user entries).
    return content.length > 0 && content.every((part) => part && part.type !== "tool_result");
  }
  // Any other shape (missing or unknown content) is not a prompt.
  return false;
}

// Every prompt timestamp since `since`, de-duplicated (resumed sessions copy lines).
export async function collectPrompts(since, root = claudeProjectsDir()) {
  // Keys of the prompts already counted, so lines copied into a resumed session aren't counted twice.
  const seen = new Set();
  // The result: timestamps only, never any text.
  const times = [];
  // Project folders under the root. Starts empty so that a failed read below leaves an empty list.
  let projects = [];
  // List the project folders. If the root is missing or unreadable (Claude Code never ran here),
  // return no prompts instead of crashing.
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return times; }

  // Visit each project folder.
  for (const project of projects) {
    // Full path of this project's folder.
    const dir = path.join(root, project.name);
    // Session logs in this project. Starts empty so that a failed read leaves nothing to visit.
    let files = [];
    // List the .jsonl session logs. If the folder can't be read, skip this project.
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    // Visit each session log.
    for (const file of files) {
      // Full path of this log file.
      const full = path.join(dir, file);
      // Wrapped in try so a file that vanishes or can't be inspected skips only itself, not the whole report.
      try {
        // File metadata, used to decide whether the file is worth reading.
        const st = fs.statSync(full);
        // Skip anything that isn't a regular file, and files not modified since `since`: they can't contain newer prompts.
        if (!st.isFile() || st.mtime < since) continue; // a folder named x.jsonl, or untouched since then: skip
      } catch { continue; }

      // Read the file as a stream, one line at a time, so large logs are never loaded whole.
      // crlfDelay: Infinity makes \r\n count as a single line break.
      const lines = readline.createInterface({ input: fs.createReadStream(full, "utf8"), crlfDelay: Infinity });
      // Guards the loop below: a read error mid-file is caught at the matching catch, so only this file is lost.
      try {
      // Go through the file line by line.
      for await (const line of lines) {
        // Cheap text check first, so we only JSON-parse the few lines that can matter.
        // Skip lines that don't contain this exact text, so JSON.parse only runs on possible user messages.
        // The pattern allows spaces around the colon, so a differently formatted log still counts.
        if (!/"type"\s*:\s*"user"/.test(line)) continue;
        // The parsed line. Declared outside the try so it can be used after it.
        let entry;
        // Parse the line. A partial or corrupt line is skipped instead of aborting.
        try { entry = JSON.parse(line); } catch { continue; }
        // Skip anything that wasn't typed by a person.
        if (!isHumanPrompt(entry)) continue;
        // When the prompt was sent.
        const t = new Date(entry.timestamp);
        // Skip entries with an unreadable timestamp (NaN) or older than the period being reported.
        if (Number.isNaN(t.getTime()) || t < since) continue;
        // Identity of this prompt: its uuid, or session id plus timestamp when there is no uuid.
        const key = entry.uuid || `${entry.sessionId}|${entry.timestamp}`;
        // Already counted (a resumed session copied the line): skip.
        if (seen.has(key)) continue;
        // Remember this prompt as counted.
        seen.add(key);
        // Store the timestamp itself and nothing else from the entry.
        times.push(t); // ONLY the time is kept
      }
      } catch { /* unreadable or deleted mid-read: skip this file, keep the rest of the report */ }
    }
  }
  // Hand back all the prompt timestamps found.
  return times;
}

// Turn timestamps + events into one row per day.
export function summarise({ prompts, events, date, cfg, days }) {
  // The evening cutoff shown in the report, falling back to the default when none is set.
  const evening = cfg.cutoff || DEFAULT_EVENING;
  // One row per day, oldest first.
  const rows = [];
  // Lookup from a day's key ("YYYY-MM-DD") to its row, so each prompt and event finds its row without searching.
  const index = new Map();
  // Walk from `days - 1` days ago down to 0 (today), so the rows run oldest to newest.
  for (let i = days - 1; i >= 0; i--) {
    // Copy of the reference date, so the caller's date isn't changed.
    const d = new Date(date);
    // Step back i days. setDate handles month and year rollover.
    d.setDate(d.getDate() - i);
    d.setHours(23, 59, 0, 0); // late in the day, so the key is this calendar day even if morning is after noon
    // The key of the workday this date belongs to.
    const key = workday(d, cfg);
    // One row per day. Starts at zero: prompts (all), evening (after the cutoff), last (time of the day's
    // last prompt, null if none), blocked and overrides (from events.log), dayOff (is a configured day off)
    // and handoff (the morning started from a TOMORROW.md handoff). label is e.g. "Mon 3 Oct".
    const row = {
      key, label: `${DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`,
      prompts: 0, evening: 0, last: null, blocked: 0, overrides: 0,
      dayOff: isDayOff(d, cfg), handoff: false,
    };
    // Add the row to the ordered list.
    rows.push(row);
    // Register the row for lookup by key.
    index.set(key, row);
  }

  // Give each prompt to its day's row.
  for (const t of prompts) {
    // Find the row by workday key. A message at 01:10 belongs to the previous day.
    const row = index.get(workday(t, cfg));
    // A prompt outside the days being reported has no row: ignore it.
    if (!row) continue;
    // Count the prompt for that day.
    row.prompts++;
    // Also count it as an evening prompt if it was after the cutoff.
    if (isEvening(t, cfg)) row.evening++;
    // Keep the day's latest prompt, compared by lateness rather than clock time so 01:10 beats 23:50.
    if (!row.last || lateness(t, cfg) > lateness(row.last, cfg)) row.last = t;
  }
  // Go through the logged events (blocks, overrides, handoffs).
  for (const e of events) {
    // The event's time. e.t is an ISO string written by logEvent().
    const t = new Date(e.t);
    // Skip events with an unreadable time.
    if (Number.isNaN(t.getTime())) continue;
    // Find the row of the event's workday.
    const row = index.get(workday(t, cfg));
    // Event outside the days being reported: ignore it.
    if (!row) continue;
    // A message Sundown held back.
    if (e.type === "blocked") row.blocked++;
    // A time you overrode Sundown.
    if (e.type === "override") row.overrides++;
    // A morning that started from a TOMORROW.md handoff (a flag, not a count).
    if (e.type === "handoff") row.handoff = true;
  }

  // Days with at least one prompt.
  const active = rows.filter((r) => r.prompts > 0);
  // Total prompts over all days, adding up each row with reduce (starting from 0).
  const totalPrompts = rows.reduce((s, r) => s + r.prompts, 0);
  // Total evening prompts over all days.
  const totalEvening = rows.reduce((s, r) => s + r.evening, 0);
  // The row with the latest finish. Stays null until one is found.
  let latest = null;
  // Replace `latest` with this row if it has a last prompt and it is later (by lateness) than the current one.
  for (const r of rows) if (r.last && (!latest || lateness(r.last, cfg) > lateness(latest.last, cfg))) latest = r;

  // Typical finish: the MEDIAN time of each active day's last prompt, so one very late
  // night doesn't drag it. Counted from the morning, so 23:00 and 01:00 give midnight.
  // Stays null when no day had any prompt.
  let typicalFinish = null;
  // Only compute when there is at least one active day.
  if (active.length) {
    // Each active day's lateness, sorted ascending (the comparison function makes the sort numeric, not alphabetical).
    const sorted = active.map((r) => lateness(r.last, cfg)).sort((a, b) => a - b);
    // Middle position. For an even count this is the upper of the two middle values.
    const mid = Math.floor(sorted.length / 2);
    // Median in minutes: odd count takes the middle value, even count averages the two middle ones. Rounded to whole minutes.
    const median = Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    // Turn lateness back into minutes since midnight by adding the morning time. % 1440 wraps past midnight.
    const m = (median + toMinutes(cfg.morning)) % 1440;
    // Format as HH:MM: whole hours (m / 60 rounded down) and the remaining minutes (m % 60), each padded to two digits.
    typicalFinish = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  // The days that fall on a configured day off.
  const daysOff = rows.filter((r) => r.dayOff);

  // The summary. days, evening and rows are passed through. activeDays: days with prompts. eveningsWorked: days with
  // at least one evening prompt. eveningShare: evening prompts as a whole-number percentage of all prompts (x100, 0 when
  // there are none, to avoid dividing by zero). latest: time and label of the latest finish, or null. typicalFinish: the
  // median finish. handoffMornings: days that started from a handoff. daysOff and daysOffWorked: days off, and those with
  // prompts. blocked and overrides: totals of those counters over all rows.
  return {
    days, evening, rows,
    activeDays: active.length,
    eveningsWorked: rows.filter((r) => r.evening > 0).length,
    totalPrompts, totalEvening,
    eveningShare: totalPrompts ? Math.round((totalEvening / totalPrompts) * 100) : 0,
    latest: latest ? { time: hhmm(latest.last), label: latest.label } : null,
    typicalFinish,
    handoffMornings: rows.filter((r) => r.handoff).length,
    daysOff: daysOff.length,
    daysOffWorked: daysOff.filter((r) => r.prompts > 0).length,
    blocked: rows.reduce((s, r) => s + r.blocked, 0),
    overrides: rows.reduce((s, r) => s + r.overrides, 0),
  };
}

// Turn the summary into the plain text shown in Claude Code. `htmlPath`, when given, is mentioned on the last line.
export function renderText(s, htmlPath) {
  // Output lines, joined with newlines at the end.
  const out = [];
  // Title line, then an empty line.
  out.push(`Sundown report: last ${s.days} days (evening = after ${s.evening})`, "");
  // Column headings. Their spacing matches the padding of the rows below.
  out.push("Day          Prompts  Evening  Last prompt  Held back  Overrides");
  // One line per day.
  for (const r of s.rows) {
    // Pad each value to a fixed width so the columns line up: label 12, prompts 7, evening 7, last prompt 11
    // ("-" if none), held back 9, overrides 9. The string is split over two lines with +.
    out.push(
      `${r.label.padEnd(12)} ${String(r.prompts).padStart(7)}  ${String(r.evening).padStart(7)}  ` +
      `${(r.last ? hhmm(r.last) : "-").padStart(11)}  ${String(r.blocked).padStart(9)}  ${String(r.overrides).padStart(9)}`,
    );
  }
  // Empty line before the totals.
  out.push("");
  // The previous period, only if it had prompts. Otherwise null, so we never print a misleading "before: 0".
  const p = s.previous && s.previous.totalPrompts ? s.previous : null;
  // Evenings with at least one prompt, with the previous period in parentheses when there is one.
  out.push(`Evenings you kept working: ${s.eveningsWorked} of ${s.days}${p ? ` (the ${s.days} days before: ${p.eveningsWorked} of ${s.days})` : ""}`);
  // Evening prompts out of all prompts, with the percentage.
  out.push(`Prompts in the evening: ${s.totalEvening} of ${s.totalPrompts} (${s.eveningShare}%)`);
  // Typical finish, if there is one, with the previous period's when available.
  if (s.typicalFinish) out.push(`Typical finish: ${s.typicalFinish}${p && p.typicalFinish ? ` (before: ${p.typicalFinish})` : ""}`);
  // Latest finish, if there is one.
  if (s.latest) out.push(`Latest finish: ${s.latest.time} (${s.latest.label})`);
  // Only when the period has days off: how many of them had no prompts.
  if (s.daysOff) out.push(`Days off you kept off: ${s.daysOff - s.daysOffWorked} of ${s.daysOff}`);
  // Only when at least one morning started from a handoff.
  if (s.handoffMornings) out.push(`Mornings that started from TOMORROW.md: ${s.handoffMornings}`);
  // Always shown: messages held back and times you overrode.
  out.push(`Sundown held back ${s.blocked} message(s); you overrode it ${s.overrides} time(s).`);
  // Point at the HTML report if one was written.
  if (htmlPath) out.push(`Full report: ${htmlPath}`);
  // Join the lines into one string.
  return out.join("\n");
}

// Only numbers and our own labels go into the page, but escape anyway.
// Replace each of the five characters & < > " ' (the regex is a character class matching any one of them)
// with its HTML entity, looked up in the object, so a value can't be read as markup.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Build the HTML page. The CSS and HTML inside the template string below are explained here, since a comment
// can't go inside the string: the :root variables hold the colours (a second set under prefers-color-scheme:dark
// swaps them for dark mode), body and main centre a 760px column, .stats is a responsive grid of tiles,
// .row is a three-column grid (96px label, flexible bar, 170px text), .bar draws the two segments, .d is the daytime
// colour and .e the evening colour, and the max-width:520px rule drops the text under the bar on narrow screens.
// The six tiles are: evenings off (days minus evenings worked), typical finish, evening share, latest finish,
// messages held back and handoff mornings. "(before: ...)" appears only when the previous period had prompts.
export function renderHtml(s) {
  // The busiest day's prompt count, which sets the full bar width. At least 1, so we never divide by zero.
  const max = Math.max(1, ...s.rows.map((r) => r.prompts));
  // One HTML row per day.
  const bars = s.rows.map((r) => {
    // Width of the daytime segment: the day's non-evening prompts as a percentage of the busiest day (x100), rounded.
    const day = Math.round(((r.prompts - r.evening) / max) * 100);
    // Width of the evening segment, worked out the same way.
    const eve = Math.round((r.evening / max) * 100);
    // One row: the day label, a bar with a daytime and an evening segment whose widths are the percentages above,
    // and text with the evening count and last prompt time (each part left out when empty). Text is escaped.
    return `<div class="row"><span class="lbl">${esc(r.label)}</span>
      <span class="bar"><i class="d" style="width:${day}%"></i><i class="e" style="width:${eve}%"></i></span>
      <span class="num">${r.evening ? `${r.evening} after ${esc(s.evening)}` : ""}${r.last ? ` · last ${esc(hhmm(r.last))}` : ""}</span></div>`;
  }).join("\n");
  // The whole page. After the head and CSS come the heading, a line saying how the report was built and the six
  // stat tiles, then the day rows (${bars}). Every inserted value is a number or goes through esc().
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sundown report</title>
<style>
:root{--bg:#F4EFE6;--ink:#14182B;--muted:#5b5f70;--day:#c9c2b4;--eve:#A84A17}
@media (prefers-color-scheme:dark){:root{--bg:#14182B;--ink:#F4EFE6;--muted:#a3a7b8;--day:#3a3f5a;--eve:#F08A4B}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:28px;margin:0 0 4px}p{color:var(--muted);margin:0 0 24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.stat{border:1px solid var(--day);border-radius:10px;padding:12px}.stat b{display:block;font-size:26px}
.row{display:grid;grid-template-columns:96px 1fr 170px;gap:10px;align-items:center;margin:6px 0}
.bar{display:flex;height:14px;background:transparent}.bar i{display:block;height:100%}
.d{background:var(--day)}.e{background:var(--eve)}.lbl,.num{font-size:13px;color:var(--muted)}
@media (max-width:520px){.row{grid-template-columns:80px 1fr}.num{grid-column:2}}
</style></head><body><main>
<h1>Where did my evenings go?</h1>
<p>Last ${s.days} days · evening starts at ${esc(s.evening)} · built locally from Claude Code's session timestamps (no prompt text)</p>
<div class="stats">
<div class="stat"><b>${s.days - s.eveningsWorked} / ${s.days}</b>evenings off${s.previous && s.previous.totalPrompts ? ` (before: ${s.days - s.previous.eveningsWorked})` : ""}</div>
<div class="stat"><b>${s.typicalFinish ? esc(s.typicalFinish) : "-"}</b>typical finish${s.previous && s.previous.typicalFinish ? ` (before: ${esc(s.previous.typicalFinish)})` : ""}</div>
<div class="stat"><b>${s.eveningShare}%</b>of prompts in the evening</div>
<div class="stat"><b>${s.latest ? esc(s.latest.time) : "-"}</b>latest finish${s.latest ? ` (${esc(s.latest.label)})` : ""}</div>
<div class="stat"><b>${s.blocked}</b>messages Sundown held back</div>
<div class="stat"><b>${s.handoffMornings}</b>mornings started from TOMORROW.md</div>
</div>
${bars}
</main></body></html>`;
}

// Build everything and write the HTML file. Returns { summary, text, htmlPath }.
export async function buildReport({ date, cfg, days = 7 }) {
  // Read twice the period, so this week can be compared with the week before.
  // Start of the window to read. Copy of the date, so the caller's date isn't changed.
  const since = new Date(date);
  // Go back 2 * days + 1 days: this period, the one before it for the comparison, and one extra day so the first evening is complete.
  since.setDate(since.getDate() - 2 * days - 1); // one extra day so the first evening is complete
  // All prompt timestamps since then (only timestamps, never text).
  const prompts = await collectPrompts(since);
  // All events from events.log.
  const events = readEvents();
  // The summary for the current period.
  const summary = summarise({ prompts, events, date, cfg, days });
  // The reference date of the previous period: `days` earlier. Copy first, so `date` isn't changed.
  const before = new Date(date);
  // Step back `days` days.
  before.setDate(before.getDate() - days);
  // Summarise the previous period from the same prompts and events.
  const prev = summarise({ prompts, events, date: before, cfg, days });
  // Keep only the three previous-period figures the text and HTML compare against.
  summary.previous = { eveningsWorked: prev.eveningsWorked, typicalFinish: prev.typicalFinish, totalPrompts: prev.totalPrompts };
  // Where the report goes, inside the Sundown state folder.
  const htmlPath = path.join(stateDir(), "report.html");
  // Write the HTML. Mode 0o600 (octal) lets only you read and write it.
  fs.writeFileSync(htmlPath, renderHtml(summary), { mode: 0o600 });
  // Hand back the summary, the text version (which links to the HTML file) and the HTML path.
  return { summary, text: renderText(summary, htmlPath), htmlPath };
}
