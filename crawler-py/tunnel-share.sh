#!/usr/bin/env bash
# CLIA Crawler API — 무료 임시 공개 (내 노트북 + cloudflared 터널)
#
# 내 노트북에서 API를 띄우고 cloudflared로 공개 URL을 뽑는다.
# 노트북이 켜져 있고 이 스크립트가 실행 중일 때만 작동 (데모/단기 테스트용).
#
# 사용:  cd crawler-py && ./tunnel-share.sh
# 종료:  Ctrl+C  (API·터널 함께 종료)

set -euo pipefail
cd "$(dirname "$0")"

PORT=8080
PY="./.venv/bin/uvicorn"

# 이전 잔여 프로세스 정리
pkill -f "uvicorn api:app" 2>/dev/null || true
sleep 1

echo "→ [1/2] 크롤러 API 기동 (localhost:$PORT)..."
"$PY" api:app --host 127.0.0.1 --port $PORT > /tmp/clia-api.log 2>&1 &
API_PID=$!

# 헬스체크 대기 (최대 20초)
for i in $(seq 1 20); do
  if curl -s "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -s "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "✗ API 기동 실패. 로그: /tmp/clia-api.log"; kill $API_PID 2>/dev/null || true; exit 1
fi
echo "  ✓ API 정상 (키 인식: $(curl -s http://127.0.0.1:$PORT/healthz))"

# API 종료 시 함께 정리
trap 'echo ""; echo "→ 종료 중..."; kill $API_PID 2>/dev/null || true; pkill -f "uvicorn api:app" 2>/dev/null || true' EXIT

echo ""
echo "→ [2/2] cloudflared 터널 연결 → 공개 URL 발급..."
echo "  (아래 초록색 https://....trycloudflare.com 주소를 상대에게 전달하세요)"
echo "  ─────────────────────────────────────────────────────────────"
cloudflared tunnel --url "http://127.0.0.1:$PORT"
