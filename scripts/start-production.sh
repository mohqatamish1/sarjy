#!/bin/bash
# A failure in either server stops the app, so the host can restart it cleanly.
set -euo pipefail
alembic upgrade head
uvicorn app.main:app --host 127.0.0.1 --port 8000 &
api_pid=$!
# Match the exposed container port even when the host injects its own PORT or HOSTNAME.
HOSTNAME=0.0.0.0 PORT=3000 BACKEND_URL=http://127.0.0.1:8000 node /app/web/server.js &
web_pid=$!
cleanup() {
  kill "$api_pid" "$web_pid" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
wait -n "$api_pid" "$web_pid"
exit 1
