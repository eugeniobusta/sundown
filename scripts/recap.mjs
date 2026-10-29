// recap.mjs — generates and reads a shutdown recap built from REAL data only.
//
// The recap is written when the user runs /sundown:shutdown, from the project
// directory the hook ran in. We ONLY use data that already lives on disk:
//   - "git log --oneline --since=<when the session started>" for commits made today
//   - "git diff --stat" for still-uncommitted changes
//   - the project's TOMORROW.md, if the shutdown skill has written it yet
//
// If this isn't a git project, or there is nothing to say, we say so plainly
// rather than invent anything. Prompt text is never read, stored or shown.
//
// Persisted at ~/.sundown/recap.md so the user can see it after restarting
// Claude Code. One file: each shutdown replaces the previous recap.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stateDir } from "./lib.mjs";

export const RECAP_PATH = () => path.join(stateDir(), "recap.md");

// Safe wrapper around a git invocation. shell:false means nothing in the args
// is interpreted by a shell, so the project path can't inject commands.
function git(cwd, args, timeoutMs = 3000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, shell: false });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim();
}

function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

// Build the recap markdown. `since` is a Date (session start, or if we don't
// know, "today" — the last 12h is a reasonable upper bound for a workday).
export function buildRecap({ projectDir, since, date = new Date(), tomorrow = "" }) {
  const title = `# Sundown recap — ${date.toISOString().slice(0, 16).replace("T", " ")}`;
  const where = `_Project: ${projectDir}_`;

  if (!isGitRepo(projectDir)) {
    const parts = [title, where, "", "This project isn't a git repository, so Sundown has no commit history to summarise."];
    if (tomorrow) parts.push("", "## Tomorrow's list", tomorrow.trim());
    return parts.join("\n") + "\n";
  }

  const sinceIso = since instanceof Date && !Number.isNaN(since.getTime())
    ? since.toISOString()
    : new Date(date.getTime() - 12 * 3600 * 1000).toISOString();

  const commits = git(projectDir, ["log", "--oneline", "--no-decorate", `--since=${sinceIso}`]) || "";
  const diffstat = git(projectDir, ["diff", "--stat"]) || "";
  const staged = git(projectDir, ["diff", "--stat", "--cached"]) || "";

  const parts = [title, where, "", `## Commits since ${sinceIso.slice(11, 16)}`];
  parts.push(commits ? "```\n" + commits + "\n```" : "_No commits in this window._");

  parts.push("", "## Uncommitted changes");
  if (diffstat || staged) {
    if (diffstat) parts.push("```\n" + diffstat + "\n```");
    if (staged)   parts.push("_Staged:_", "```\n" + staged + "\n```");
  } else {
    parts.push("_Working tree is clean._");
  }

  parts.push("", "## Tomorrow's list");
  parts.push(tomorrow && tomorrow.trim() ? tomorrow.trim() : "_No TOMORROW.md yet. The shutdown skill writes one in the project root._");
  return parts.join("\n") + "\n";
}

// Save the recap under ~/.sundown/recap.md. Reads TOMORROW.md from the project
// dir if present. Never throws — if anything fails, no recap is written.
export function saveRecap({ projectDir, since, date = new Date() }) {
  try {
    let tomorrow = "";
    try { tomorrow = fs.readFileSync(path.join(projectDir, "TOMORROW.md"), "utf8"); } catch { /* ok */ }
    const md = buildRecap({ projectDir, since, date, tomorrow });
    fs.writeFileSync(RECAP_PATH(), md, { mode: 0o600 });
    return md;
  } catch {
    return "";
  }
}

export function readRecap() {
  try { return fs.readFileSync(RECAP_PATH(), "utf8"); } catch { return ""; }
}
