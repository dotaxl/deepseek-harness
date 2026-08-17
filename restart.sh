#!/usr/bin/env bash
# Restart the deepseek-harness web UI: kill any process already bound to the
# web port, then start `pnpm dsh web` detached and wait until it answers.
set -euo pipefail

PORT=3080
LOG="${TMPDIR:-/tmp}/dsh-web.log"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

cd "$REPO_ROOT"

# Kill whatever is already listening on the web port.
kill_port() {
  local pids
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$PORT/tcp" 2>/dev/null | tr -s ' ' '\n' || true)"
  else
    return 0
  fi
  if [ -n "$pids" ]; then
    echo "killing existing web server on port $PORT: $(echo "$pids" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 20); do
      if command -v lsof >/dev/null 2>&1; then
        lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      else
        curl -s -o /dev/null "http://127.0.0.1:$PORT" 2>/dev/null || break
      fi
      sleep 0.5
    done
  fi
}

kill_port

echo "starting dsh web on port $PORT (log: $LOG) ..."
nohup pnpm dsh web > "$LOG" 2>&1 &

# Wait for the server to bind and answer HTTP 200.
code=""
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then break; fi
  sleep 1
done

if [ "$code" = "200" ]; then
  echo "web server up: http://127.0.0.1:$PORT (HTTP 200)"
else
  echo "web server did not come up in time (last HTTP '$code'); tail of $LOG:" >&2
  tail -n 20 "$LOG" >&2
  exit 1
fi
