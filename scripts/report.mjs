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

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  claudeProjectsDir, readEvents, toMinutes, minuteOfDay, stateDir, hhmm,
  workdayKey, isQuiet, isDayOff,
} from "./lib.mjs";

// Used for the "evening" column when you haven't chosen a cutoff yet.
export const DEFAULT_EVENING = "19:30";

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The calendar day a moment belongs to, as "YYYY-MM-DD" (before morning = yesterday).
export function workday(date, cfg) {
  return workdayKey(date, cfg);
}

// Is this moment in the evening (from the cutoff until the morning)? Same rule as the
// gate, including a cutoff after midnight (01:00 -> 08:00).
export function isEvening(date, cfg) {
  return isQuiet(date, { ...cfg, cutoff: cfg.cutoff || DEFAULT_EVENING });
}

// Minutes since the start of the workday, so 01:10 sorts AFTER 23:50.
function lateness(date, cfg) {
  return (minuteOfDay(date) - toMinutes(cfg.morning) + 1440) % 1440;
}

// Is this log line a message a person typed? (Not a tool result, not a skill's
// injected text, not a subagent, not the output of a local command like /plugin.)
export function isHumanPrompt(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return !content.startsWith("<local-command");
  if (Array.isArray(content)) {
    return content.length > 0 && content.every((part) => part && part.type !== "tool_result");
  }
  return false;
}

// Every prompt timestamp since `since`, de-duplicated (resumed sessions copy lines).
export async function collectPrompts(since, root = claudeProjectsDir()) {
  const seen = new Set();
  const times = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return times; }

  for (const project of projects) {
    const dir = path.join(root, project.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.mtime < since) continue; // a folder named x.jsonl, or untouched since then: skip
      } catch { continue; }

      const lines = readline.createInterface({ input: fs.createReadStream(full, "utf8"), crlfDelay: Infinity });
      try {
      for await (const line of lines) {
        // Cheap text check first, so we only JSON-parse the few lines that can matter.
        if (!line.includes('"type":"user"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!isHumanPrompt(entry)) continue;
        const t = new Date(entry.timestamp);
        if (Number.isNaN(t.getTime()) || t < since) continue;
        const key = entry.uuid || `${entry.sessionId}|${entry.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        times.push(t); // ONLY the time is kept
      }
      } catch { /* unreadable or deleted mid-read: skip this file, keep the rest of the report */ }
    }
  }
  return times;
}

// Turn timestamps + events into one row per day.
export function summarise({ prompts, events, date, cfg, days }) {
  const evening = cfg.cutoff || DEFAULT_EVENING;
  const rows = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(date);
    d.setDate(d.getDate() - i);
    d.setHours(23, 59, 0, 0); // late in the day, so the key is this calendar day even if morning is after noon
    const key = workday(d, cfg);
    const row = {
      key, label: `${DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`,
      prompts: 0, evening: 0, last: null, blocked: 0, overrides: 0,
      dayOff: isDayOff(d, cfg), handoff: false,
    };
    rows.push(row);
    index.set(key, row);
  }

  for (const t of prompts) {
    const row = index.get(workday(t, cfg));
    if (!row) continue;
    row.prompts++;
    if (isEvening(t, cfg)) row.evening++;
    if (!row.last || lateness(t, cfg) > lateness(row.last, cfg)) row.last = t;
  }
  for (const e of events) {
    const t = new Date(e.t);
    if (Number.isNaN(t.getTime())) continue;
    const row = index.get(workday(t, cfg));
    if (!row) continue;
    if (e.type === "blocked") row.blocked++;
    if (e.type === "override") row.overrides++;
    if (e.type === "handoff") row.handoff = true;
  }

  const active = rows.filter((r) => r.prompts > 0);
  const totalPrompts = rows.reduce((s, r) => s + r.prompts, 0);
  const totalEvening = rows.reduce((s, r) => s + r.evening, 0);
  let latest = null;
  for (const r of rows) if (r.last && (!latest || lateness(r.last, cfg) > lateness(latest.last, cfg))) latest = r;

  // Typical finish: the MEDIAN time of each active day's last prompt, so one very late
  // night doesn't drag it. Counted from the morning, so 23:00 and 01:00 give midnight.
  let typicalFinish = null;
  if (active.length) {
    const sorted = active.map((r) => lateness(r.last, cfg)).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    const m = (median + toMinutes(cfg.morning)) % 1440;
    typicalFinish = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  const daysOff = rows.filter((r) => r.dayOff);

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

export function renderText(s, htmlPath) {
  const out = [];
  out.push(`Sundown report: last ${s.days} days (evening = after ${s.evening})`, "");
  out.push("Day          Prompts  Evening  Last prompt  Held back  Overrides");
  for (const r of s.rows) {
    out.push(
      `${r.label.padEnd(12)} ${String(r.prompts).padStart(7)}  ${String(r.evening).padStart(7)}  ` +
      `${(r.last ? hhmm(r.last) : "-").padStart(11)}  ${String(r.blocked).padStart(9)}  ${String(r.overrides).padStart(9)}`,
    );
  }
  out.push("");
  const p = s.previous && s.previous.totalPrompts ? s.previous : null;
  out.push(`Evenings you kept working: ${s.eveningsWorked} of ${s.days}${p ? ` (the ${s.days} days before: ${p.eveningsWorked} of ${s.days})` : ""}`);
  out.push(`Prompts in the evening: ${s.totalEvening} of ${s.totalPrompts} (${s.eveningShare}%)`);
  if (s.typicalFinish) out.push(`Typical finish: ${s.typicalFinish}${p && p.typicalFinish ? ` (before: ${p.typicalFinish})` : ""}`);
  if (s.latest) out.push(`Latest finish: ${s.latest.time} (${s.latest.label})`);
  if (s.daysOff) out.push(`Days off you kept off: ${s.daysOff - s.daysOffWorked} of ${s.daysOff}`);
  if (s.handoffMornings) out.push(`Mornings that started from TOMORROW.md: ${s.handoffMornings}`);
  out.push(`Sundown held back ${s.blocked} message(s); you overrode it ${s.overrides} time(s).`);
  if (htmlPath) out.push(`Full report: ${htmlPath}`);
  return out.join("\n");
}

// Only numbers and our own labels go into the page, but escape anyway.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function renderHtml(s) {
  const max = Math.max(1, ...s.rows.map((r) => r.prompts));
  const bars = s.rows.map((r) => {
    const day = Math.round(((r.prompts - r.evening) / max) * 100);
    const eve = Math.round((r.evening / max) * 100);
    return `<div class="row"><span class="lbl">${esc(r.label)}</span>
      <span class="bar"><i class="d" style="width:${day}%"></i><i class="e" style="width:${eve}%"></i></span>
      <span class="num">${r.evening ? `${r.evening} after ${esc(s.evening)}` : ""}${r.last ? ` · last ${esc(hhmm(r.last))}` : ""}</span></div>`;
  }).join("\n");
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
  const since = new Date(date);
  since.setDate(since.getDate() - 2 * days - 1); // one extra day so the first evening is complete
  const prompts = await collectPrompts(since);
  const events = readEvents();
  const summary = summarise({ prompts, events, date, cfg, days });
  const before = new Date(date);
  before.setDate(before.getDate() - days);
  const prev = summarise({ prompts, events, date: before, cfg, days });
  summary.previous = { eveningsWorked: prev.eveningsWorked, typicalFinish: prev.typicalFinish, totalPrompts: prev.totalPrompts };
  const htmlPath = path.join(stateDir(), "report.html");
  fs.writeFileSync(htmlPath, renderHtml(summary), { mode: 0o600 });
  return { summary, text: renderText(summary, htmlPath), htmlPath };
}
