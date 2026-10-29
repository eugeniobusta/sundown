#!/usr/bin/env bash
# setup-demo.sh — prepares the live demo in one go. Safe to run again before every rehearsal.
#
# Creates two tiny projects:
#   ~/sundown-demo/app     a CSV parser with a TODO (the project you "shut down")
#   ~/sundown-demo/agent   an empty folder where an agent writes haiku files (the "forgotten agent")
# and a SEPARATE Sundown state folder, ~/.sundown-demo, so the demo never changes your
# real settings in ~/.sundown. Every terminal tab used in the demo needs:
#   export SUNDOWN_DIR="$HOME/.sundown-demo"
#
# Usage:  bash demo/setup-demo.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # the sundown plugin folder
DEMO="$HOME/sundown-demo"
export SUNDOWN_DIR="$HOME/.sundown-demo"

mkdir -p "$DEMO/app" "$DEMO/agent"

# The "real work" project: small, with one obvious next step.
cat > "$DEMO/app/parser.js" <<'JS'
// parser.js — a tiny CSV parser.
// TODO: quoted fields that contain commas ("Dublin, Ireland") are split in two.
export function parseLine(line) {
  return line.split(",");
}

export function parse(text) {
  return text.trim().split("\n").map(parseLine);
}
JS
printf '# CSV parser\n\nSmall demo project for Sundown.\n' > "$DEMO/app/README.md"
printf '# Haiku collection\n' > "$DEMO/agent/README.md"

# Clean up anything left by the last rehearsal.
rm -f "$DEMO/app/TOMORROW.md" "$DEMO/agent/TOMORROW.md" "$DEMO"/agent/haiku-*.md
rm -rf "$SUNDOWN_DIR"

# Demo settings: cutoff late enough that it doesn't trigger during the talk,
# and phone pushes after turns of 30 seconds or more.
node "$ROOT/bin/sundown" config cutoff 23:30 >/dev/null
node "$ROOT/bin/sundown" config morning 08:00 >/dev/null
node "$ROOT/bin/sundown" config minTurnSeconds 30 >/dev/null

# Reuse your phone topic from your real settings, if you have set one.
TOPIC="$(node -e 'try{const c=require(require("os").homedir()+"/.sundown/config.json");process.stdout.write(c.ntfyTopic||"")}catch{}')"
if [ -n "$TOPIC" ]; then
  node "$ROOT/bin/sundown" config ntfyTopic "$TOPIC" >/dev/null
  echo "Phone pushes: ON (same topic as your real settings)."
else
  echo "Phone pushes: off. Run /sundown:setup once (outside the demo) to connect your phone, then run this again."
fi

echo "Demo ready in $DEMO"
echo "In EVERY demo tab run first:   export SUNDOWN_DIR=\"\$HOME/.sundown-demo\""
