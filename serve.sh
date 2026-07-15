#!/usr/bin/env bash
# Launch Flash locally. A service worker needs http(s), not file://.
cd "$(dirname "$0")"
PORT="${1:-8777}"
URL="http://localhost:$PORT"
command -v xdg-open >/dev/null && (sleep 1 && xdg-open "$URL") &
echo "Flash → $URL   (Ctrl-C to stop)"
exec python -m http.server "$PORT"
