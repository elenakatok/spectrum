#!/usr/bin/env bash
# clean-start.sh — free Spectrum emulator ports and boot a fresh emulator suite.
#
# Kills only the six Spectrum-specific ports (source: firebase.json emulators block).
# Does NOT use killall node — other Firebase projects are left alone.
# Builds Cloud Functions, starts auth+functions+firestore+database, confirms via health check.
#
# Run from anywhere:  bash games/spectrum/clean-start.sh
# Or from spectrum/:     ./clean-start.sh
# Press Ctrl+C to stop everything.  Log: /tmp/spectrum-emulators.log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Ports (source: firebase.json emulators block) ─────────────────────────────
PORT_AUTH=9101
PORT_FUNCTIONS=5005
PORT_FIRESTORE=8082
PORT_DATABASE=9002
PORT_HOSTING=5006
PORT_UI=4002

SPECTRUM_PORTS=($PORT_AUTH $PORT_FUNCTIONS $PORT_FIRESTORE $PORT_DATABASE $PORT_HOSTING $PORT_UI)

LOG=/tmp/spectrum-emulators.log

# ── 0. Free Spectrum emulator ports ──────────────────────────────────────────────
echo "▶ Clearing Spectrum emulator ports..."
KILLED_ANY=false
for port in "${SPECTRUM_PORTS[@]}"; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do
      echo "  Killing PID $pid on port $port"
      kill "$pid" 2>/dev/null || true
      KILLED_ANY=true
    done
  fi
done
if [ "$KILLED_ANY" = true ]; then
  sleep 1
else
  echo "  Ports already clear."
fi

# ── 1. Build Cloud Functions ──────────────────────────────────────────────────
echo "▶ Building Cloud Functions..."
if ! (cd "$SCRIPT_DIR/functions" && npm run build); then
  echo ""
  echo "✗ Functions build failed. Fix the error above, then re-run."
  exit 1
fi
echo "  Functions built ✅"
echo ""

# ── 2. Start emulators in the background ─────────────────────────────────────
echo "▶ Starting Firebase emulators (log → $LOG)..."
echo "  Auth:      http://localhost:${PORT_AUTH}"
echo "  Functions: http://localhost:${PORT_FUNCTIONS}"
echo "  Firestore: http://localhost:${PORT_FIRESTORE}"
echo "  Database:  http://localhost:${PORT_DATABASE}"
echo ""

firebase emulators:start --only auth,functions,firestore,database \
  > "$LOG" 2>&1 &
EMU_PID=$!

cleanup() {
  echo ""
  echo "▶ Shutting down emulators..."
  kill "$EMU_PID" 2>/dev/null || true
  wait "$EMU_PID" 2>/dev/null || true
  echo "  Done."
}
trap cleanup EXIT INT TERM

# ── 3. Wait for functions emulator (last to come up) ─────────────────────────
echo "▶ Waiting for emulators to be ready..."
MAX_WAIT=90
WAITED=0
while ! lsof -ti tcp:"$PORT_FUNCTIONS" >/dev/null 2>&1; do
  sleep 1
  WAITED=$((WAITED + 1))
  if ! kill -0 "$EMU_PID" 2>/dev/null; then
    echo ""
    echo "✗ Emulator process exited early. Last 30 lines of $LOG:"
    tail -30 "$LOG"
    exit 1
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo ""
    echo "✗ Timed out after ${MAX_WAIT}s. Check: $LOG"
    exit 1
  fi
done

# ── 4. Health check — auth emulator must respond ─────────────────────────────
echo "▶ Health check (auth emulator http://localhost:${PORT_AUTH}/)..."
if curl -sf "http://localhost:${PORT_AUTH}/" >/dev/null 2>&1; then
  echo "  Auth emulator responding ✅"
else
  echo "  ⚠  Auth emulator not yet responding — emulators may still be loading."
  echo "     Check: $LOG"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Spectrum emulators are up ✅"
echo "  Functions: http://localhost:${PORT_FUNCTIONS}/spectrum-mygames-live/us-central1"
echo "  Firestore: http://localhost:${PORT_FIRESTORE}"
echo "  Database:  http://localhost:${PORT_DATABASE}"
echo "  Log:       $LOG"
echo "  Press Ctrl+C to stop."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

wait "$EMU_PID"
