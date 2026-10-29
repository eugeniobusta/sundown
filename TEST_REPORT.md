# SUNDOWN QA Report
**Date:** 2026-10-29  
**Tester:** Independent QA (Claude Sonnet 4.6)  
**Repo path:** /Users/kirkramilo/sundown  
**State isolation:** All tests used `SUNDOWN_DIR` pointed at fresh `mktemp -d` dirs. Real `~/.sundown` was never touched.

---

## Verdict

**MOSTLY PASS — 83/100**

One confirmed bug in the hook path for `/sundown:shutdown` that causes session commits to be dropped from the recap. Fixed in place (7-line change). All 15 scenarios pass after the fix. 31 automated tests pass (31/31, 0 fail, 0 skip).

---

## Step 1: Stranger Install

Timed: ~3 minutes from reading README to first `sundown status` working.

**What works:**
- `git clone … && node bin/sundown status` runs immediately with no `npm install`.
- README Option A (`claude --plugin-dir ./sundown`) is accurate.
- Defaults (50 prompts, 22:30 cutoff, 08:00 wake) are live immediately.

**README gaps:**
1. Option B (`/plugin marketplace add eugeniobusta/sundown`) — the GitHub repo `eugeniobusta/sundown` is referenced but not verified to exist or be public. A stranger following Option B may hit a 404.
2. The `Every command runs the same way from a terminal, with node <plugin folder>/bin/sundown <command>` note is buried mid-page after all commands are already listed. New users may not see it before trying `sundown status` bare (which fails without the path).
3. No mention of what happens on Windows (hooks use POSIX `O_APPEND` atomic semantics; this is documented under "Honest limits" but not in Install).
4. `SUNDOWN_DIR` env var is only documented in the Tests section, not in Install. Someone wanting an isolated test run has to find it.

---

## Step 2: Automated Tests

**Command:** `node --test test/*.test.mjs`

**Result: 31 pass, 0 fail, 0 skip, 0 todo.**

| Assessment | Result |
|---|---|
| Tests use real child processes (not mocked) | Yes — hooks are invoked via `spawnSync` with JSON on stdin, exactly as Claude Code does |
| Concurrent test uses real parallel spawns | Yes — 20 `spawn()` calls via `Promise.all()` |
| Recap test uses a real git repo | Yes — `git init`, real commit, real `git log` |
| Push test uses a real local HTTP server | Yes — `http.createServer()` on a random port |
| Any tests that assert nothing meaningful | No |
| Any tests skipped | No |
| Clock injectable | Yes — `SUNDOWN_NOW` env var throughout |

**One test gap:** No test exercises the gate.mjs path (`/sundown:shutdown` via hook invocation) with a real git repo and verifies commits appear in the recap. This gap allowed the `since`-time bug (below) to exist undetected.

---

## Step 3: End-to-End Scenarios

All scenarios run with `SUNDOWN_DIR` pointing to a fresh temp dir. `SUNDOWN_NOW` controls the clock where needed.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Fresh state, no config → sensible defaults, prompts allowed, count increments | PASS | Prompt at 10:00 → exit 0; counts/2026-10-29 has 1 line |
| 2 | Prompt count reaches limit → next normal prompt blocked with reason, count, wake time | PASS | Limit=3; 4th prompt → exit 2, stderr: `☾ Sundown: you've used 3/3 prompts today. Work resumes at 08:00.` |
| 3 | Shutdown time passes before limit → blocked with time-based reason | PASS | At 22:35 with 22:30 cutoff → exit 2, stderr: `it's after your 22:30 cutoff` |
| 4 | During shutdown, /sundown:recap, /sundown:wake, /sundown:override, /sundown:schedule all run | PASS | After `/sundown:shutdown`: recap→exit 0, override→exit 0 + pass stored, schedule list→exit 0, wake→exit 0 |
| 5 | Override 15m → prompts allowed; clock +16m → blocked again; daily count NOT reset | PASS | +5m→exit 0, count=4; +16m→exit 2, count still 4 |
| 6 | Override expires while closed (no process running, advance clock) → blocked | PASS | Pass file stores `2026-10-29T22:50:00.000Z`; at 22:55 → exit 2 |
| 7 | Clock moves past wake time next day → prompts allowed, count reset to 0 | PASS | Yesterday count=5, today at 09:00→exit 0, today count=1 |
| 8 | Crossing midnight while shut down → still shut down until wake time | PASS | At 23:30, 01:00, 07:59 → exit 2; at 08:01 → exit 0 |
| 9 | Schedule change during shutdown (later shutdown time) → takes effect | PASS | Cutoff changed 21:00→23:00; at 21:35→exit 0; at 23:05→exit 2 |
| 10 | Concurrency: 20 parallel hook invocations → count is exactly 20 | PASS | `wc -l counts/2026-10-29` = 20 after 20 parallel spawns |
| 11 | Recap with no history → clear message, no crash | PASS | `sundown recap` → exit 0, stdout: `No recap yet. Run /sundown:shutdown...` |
| 12 | Recap after real activity → lists real files/commits only | PASS | SHA in recap matches `git log --oneline` SHA exactly; no invented content |
| 13 | Repeated /sundown:shutdown and /sundown:wake → idempotent, no corrupted state | PASS | 3 cycles: lock file valid JSON each time; final prompt → exit 0; config valid |
| 14 | Corrupt or deleted state file → recovers gracefully | PASS | Corrupt config.json → exit 0 (uses defaults); corrupt lock → exit 0 (fail-open); deleted dir → re-created, exit 0 |
| 15 | Prompt text not stored in state files | PASS | `grep SECRET_PROMPT` across all state files → no matches; counts file has only ISO timestamps |

---

## Bugs (by severity)

### BUG-1 (HIGH): `/sundown:shutdown` via hook produces a recap that misses all session commits

**File:** `/Users/kirkramilo/sundown/scripts/gate.mjs`, lines 75–85  
**Repro:**
```bash
SD=$(mktemp -d); PROJ=$(mktemp -d)
echo '{"cutoff":"22:30","morning":"08:00","dailyLimit":50}' > $SD/config.json
git init -q -b main $PROJ && git -C $PROJ config user.email t@t && git -C $PROJ config user.name T
echo "work" > $PROJ/work.js && git -C $PROJ add work.js && git -C $PROJ commit -q -m "feat: real work"
# A prior prompt in the session
echo '{"session_id":"s","cwd":"'"$PROJ"'","prompt_text":"do work"}' | SUNDOWN_DIR=$SD node gate.mjs >/dev/null
sleep 1
# Shutdown via hook
echo '{"session_id":"s","cwd":"'"$PROJ"'","prompt_text":"/sundown:shutdown"}' | SUNDOWN_DIR=$SD node gate.mjs >/dev/null
grep "feat: real work" $SD/recap.md   # empty - bug
```
**Root cause:** `recordTurnStart(session, date)` at line 76 overwrites the stored session start time with `now` (= the shutdown moment). Then `turnStart(session)` at line 85 reads back `now`, so `since=now`. `git log --since=now` returns no commits made before the shutdown instant.  
**Impact:** The primary advertised recap feature — "Built from real data: git log + diff" — silently produces empty commit lists when used via the Claude Code hook. The CLI (`sundown shutdown`) uses an explicit 12-hour lookback and is unaffected.

**Fix applied:** Read `prevTurnStart` before calling `recordTurnStart`, then pass it as `since` (falling back to 12h lookback if null). 7 lines changed.

---

### BUG-2 (LOW): `/sundown:override` exits 0 with "override granted" message but silently drops the pass when `session_id` is absent

**File:** `/Users/kirkramilo/sundown/scripts/gate.mjs`, line 112; `/Users/kirkramilo/sundown/scripts/lib.mjs`, line 267 (`safeId`)  
**Repro:**
```bash
SD=$(mktemp -d); PROJ=$(mktemp -d)
echo '{"cutoff":"22:30","morning":"08:00","dailyLimit":50}' > $SD/config.json
echo '{"cwd":"'"$PROJ"'","prompt_text":"/sundown:override 15m"}' | SUNDOWN_DIR=$SD SUNDOWN_NOW=2026-10-29T23:00:00 node gate.mjs
# Output: "Sundown: override granted..." but passes/ dir is empty
echo '{"cwd":"'"$PROJ"'","prompt_text":"urgent fix"}' | SUNDOWN_DIR=$SD SUNDOWN_NOW=2026-10-29T23:05:00 node gate.mjs 2>&1
# Output: blocked — pass was never written
```
**Impact:** Low in practice — Claude Code always includes `session_id` in hook payloads. No user-facing breakage under normal use. Not fixed (not meeting the "small, clearly broken" bar since it requires an abnormal input).

---

## Fixes Applied

| Fix | File | Lines changed | Description |
|---|---|---|---|
| BUG-1: recap since-time | `/Users/kirkramilo/sundown/scripts/gate.mjs` | 7 | Capture `prevTurnStart = turnStart(session)` before `recordTurnStart(session, date)` overwrites it. Pass `prevTurnStart \|\| new Date(date - 12h)` as `since` to `saveRecap`. |

---

## README Gaps (stranger install)

1. **Option B (marketplace) not verifiable.** The GitHub repo URL appears but the marketplace install path (`/plugin marketplace add eugeniobusta/sundown`) was not tested and may not be published.
2. **`node bin/sundown`** vs **bare `sundown`** — the CLI path is mentioned only once, halfway through the document. A stranger who runs `sundown status` without the path gets "command not found".
3. **No Windows note.** Atomic append behavior and file permissions (`0o700`, `0o600`) are POSIX. Not called out.
4. **`SUNDOWN_DIR` env var** only appears in the Tests section. Should appear in Install for users who want to keep multiple configs.
5. **`/sundown:setup` is listed as optional** but is the only way to connect phone pushes. The README correctly says phone pushes are off by default, but doesn't say "run /sundown:setup to enable them."

---

## Rubric Score

| Criterion | Score | Max | Reason |
|---|---|---|---|
| Takes on the problem | 28 | 30 | Clearly about compression burnout; names the "shutdown command" concept explicitly; identifies the audience (developers using Claude Code who keep working late). Slightly off: it doesn't address team/organizational dynamics, only individual willpower. |
| It actually works | 23 | 30 | Repo runs, all 15 scenarios pass, 31 automated tests pass. One confirmed bug (recap misses commits via the hook path) is real and in the primary feature. Fixed during QA. The CLI path works correctly. |
| Someone would use it | 18 | 20 | README gets a stranger started in 3 minutes. Zero-config defaults are sensible. The 60-second walkthrough is realistic. Deduction: marketplace install unverified; `node bin/sundown` path discovery is not obvious enough. |
| Gives time back | 14 | 20 | Quiet, no popups, no streak maintenance. The TOMORROW.md handoff is genuinely useful. Deduction: the `pause.mjs` PreToolUse hook adding ~50ms per tool call during shutdown is a real cost (acknowledged in README but still real). The report and setup flow add some first-time friction. |
| **Total** | **83** | **100** | |

---

## Top 3 Changes for the Next 30 Minutes

1. **Add a hook-path recap test.** Add one `test("gate: shutdown via hook includes today's real commits in recap", ...)` that: spins up a git repo, makes a commit, sends two hook invocations (a prior prompt, then `/sundown:shutdown`), and asserts the commit SHA appears in the recap. This would have caught BUG-1 immediately.

2. **Fix the README install step.** Move the `node bin/sundown <command>` note into the Install section right after `git clone`. Remove the ambiguity by adding: "From the terminal (outside Claude Code): `node ./sundown/bin/sundown status`." Also add a one-liner showing how to test without installing: `SUNDOWN_DIR=/tmp/test node ./sundown/bin/sundown status`.

3. **Verify or remove Option B.** Either confirm the plugin is published to the Claude Code marketplace (and add a note about the expected URL), or remove Option B from the README until it is. A stranger following a broken install path loses trust in the whole README.
