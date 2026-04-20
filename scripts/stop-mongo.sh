#!/usr/bin/env bash
#
# Stop the local OTA mongod started by scripts/start-mongo.sh.

set -e

PID_FILE=/opt/homebrew/var/mongodb-otadev/mongod.pid

PID=""
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
fi

# Fallback: discover by port
if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  PID=$(lsof -iTCP:27017 -sTCP:LISTEN -t 2>/dev/null || true)
fi

if [[ -z "$PID" ]]; then
  echo "mongod is not running on :27017"
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping mongod (PID $PID)…"
kill "$PID"

# Wait up to 10s for it to shut down cleanly
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "mongod stopped."
    rm -f "$PID_FILE"
    exit 0
  fi
  sleep 1
done

echo "mongod did not stop within 10s, sending SIGKILL…" >&2
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
