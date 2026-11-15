#!/usr/bin/env bash
# Capture the demo transcript from the REAL CLI (no hand-edited output).
# Runs in a scratch dir so nothing pollutes the repo. The transcript is
# rendered to demo/vibeleak-demo.gif by scripts/render-gif.py.
#
# The fixture app + PostgREST server are SYNTHETIC (fake app, fake anon
# JWT, fake rows labelled synthetic). Nothing here touches a real app or
# a real Supabase project.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH=/tmp/vibeleak-demo
BIN="$SCRATCH/bin"
rm -rf "$SCRATCH"
mkdir -p "$BIN" "$ROOT/demo"
ln -sf "$ROOT/dist/cli.js" "$BIN/vibeleak"
chmod +x "$ROOT/dist/cli.js"
export PATH="$BIN:$PATH"

WORK="$SCRATCH/work"
mkdir -p "$WORK"
cp "$ROOT/examples/vibeleak.json" "$WORK/vibeleak.json"
cd "$WORK"

SERVER_PID=""
start_server() {
  local mode="$1"
  rm -f "$SCRATCH/server.log"
  FAKE_MODE="$mode" PORT=0 node "$ROOT/examples/fake-postgrest/server.js" > "$SCRATCH/server.log" 2>&1 &
  SERVER_PID=$!
  local port=""
  for _ in $(seq 1 50); do
    port=$(grep -o 'http://127.0.0.1:[0-9]*' "$SCRATCH/server.log" 2>/dev/null | head -1 | grep -o '[0-9]*$' || true)
    if [ -n "$port" ]; then break; fi
    sleep 0.2
  done
  if [ -z "$port" ]; then
    echo "fixture server did not start" >&2
    cat "$SCRATCH/server.log" >&2
    exit 1
  fi
  APP_URL="http://127.0.0.1:$port"
  echo "fixture server ($mode) on $APP_URL"
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT

OUT="$ROOT/demo/transcript.txt"
start_server leaky
{
  echo "# vibeleak demo - real CLI output on the SYNTHETIC local fixtures"
  echo "# (fake Lovable-style app + fake PostgREST server on 127.0.0.1;"
  echo "#  anon key is a self-signed synthetic JWT; row values are fake"
  echo "#  and never stored - only column names and a 0/1 rows flag.)"
  echo ""
  echo "\$ vibeleak scan <app-url> --i-own-this-app --out report-before.json"
  vibeleak scan "$APP_URL" --i-own-this-app --out report-before.json || echo "exit: $?"
  echo ""
  echo "# the app owner enables Row Level Security and locks the bucket:"
  echo "# (fixture restarted with FAKE_MODE=fixed)"
  stop_server
  start_server fixed > /dev/null 2>&1
  echo ""
  echo "\$ vibeleak scan <app-url> --i-own-this-app --out report-after.json"
  vibeleak scan "$APP_URL" --i-own-this-app --out report-after.json || echo "exit: $?"
  echo ""
  echo "\$ vibeleak check --report report-after.json --baseline report-before.json"
  vibeleak check --report report-after.json --baseline report-before.json || echo "exit: $?"
  echo ""
  echo "\$ vibeleak diff --baseline report-before.json --report report-after.json"
  vibeleak diff --baseline report-before.json --report report-after.json || echo "exit: $?"
} > "$OUT" 2>&1
echo "transcript written: $OUT ($(wc -l < "$OUT") lines)"
