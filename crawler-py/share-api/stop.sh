#!/usr/bin/env bash
# CLIA 크롤러 API 공유용 프로세스(uvicorn + cloudflared) 종료.
# 사용: ./stop.sh
set -uo pipefail
cd "$(dirname "$0")/.."
SHARE_DIR="share-api"

[[ -f "$SHARE_DIR/tunnel.pid" ]] && kill "$(cat "$SHARE_DIR/tunnel.pid")" 2>/dev/null
[[ -f "$SHARE_DIR/api.pid" ]] && kill "$(cat "$SHARE_DIR/api.pid")" 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:8080" 2>/dev/null || true
pkill -f "uvicorn api:app" 2>/dev/null || true
rm -f "$SHARE_DIR/url.txt" "$SHARE_DIR/api.pid" "$SHARE_DIR/tunnel.pid"
echo "✓ API·터널 종료됨"
