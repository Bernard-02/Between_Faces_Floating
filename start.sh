#!/usr/bin/env bash
# Start a tiny local web server and open the tool in your browser.
# Uses Python 3's built-in http.server — no install needed on macOS / Linux.

set -e
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
URL="http://localhost:${PORT}/"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 找不到 python3。請先安裝 Python 3，或自行用任意靜態 server 開啟此資料夾。"
  exit 1
fi

echo "▶︎ Serving on ${URL}"
echo "  按 Ctrl+C 結束。"

# Try to open the browser (best-effort)
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "${URL}") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "${URL}") &
fi

exec python3 -m http.server "${PORT}"
