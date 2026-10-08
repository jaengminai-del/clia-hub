#!/usr/bin/env bash
# CLIA 크롤러 API를 백그라운드로 띄우고 cloudflared 임시 공개 URL을 발급한다.
# tunnel-share.sh와 달리 포그라운드를 블로킹하지 않음 — 스킬/에이전트가 호출하고
# 바로 다음 단계(상대방용 프롬프트 md 생성)로 넘어갈 수 있게 전부 nohup으로 백그라운드 기동.
#
# 사용: ./start.sh            (이미 떠 있으면 기존 URL 재사용, 조용히 종료)
#      ./start.sh --restart   (기존 API·터널 죽이고 새 URL 강제 발급 — 상대방 URL 끊김 주의)
#
# 산출물:
#   share-api/url.txt          ← 현재 공개 URL (한 줄)
#   share-api/api.pid          ← uvicorn PID
#   share-api/tunnel.pid       ← cloudflared PID
#   share-api/tunnel.log       ← cloudflared 로그 (URL 파싱 원본)
#   share-api/PROMPT_FOR_PARTNER.md ← 상대방 Claude에 붙여넣을 프롬프트 (URL 치환 완료)

set -uo pipefail
cd "$(dirname "$0")/.."   # crawler-py/
SHARE_DIR="share-api"
PORT=8080
RESTART="${1:-}"

api_alive()    { [[ -f "$SHARE_DIR/api.pid" ]] && kill -0 "$(cat "$SHARE_DIR/api.pid")" 2>/dev/null; }
tunnel_alive() { [[ -f "$SHARE_DIR/tunnel.pid" ]] && kill -0 "$(cat "$SHARE_DIR/tunnel.pid")" 2>/dev/null; }

if [[ "$RESTART" == "--restart" ]]; then
  echo "→ 기존 프로세스 종료 (--restart)..."
  tunnel_alive && kill "$(cat "$SHARE_DIR/tunnel.pid")" 2>/dev/null
  api_alive && kill "$(cat "$SHARE_DIR/api.pid")" 2>/dev/null
  rm -f "$SHARE_DIR/url.txt" "$SHARE_DIR/api.pid" "$SHARE_DIR/tunnel.pid"
  sleep 1
fi

# ── 이미 둘 다 살아있고 URL도 있으면 그대로 재사용 (상대방 연결 유지) ──
if api_alive && tunnel_alive && [[ -s "$SHARE_DIR/url.txt" ]]; then
  echo "✓ 이미 가동 중 — 기존 URL 재사용"
  echo "URL=$(cat "$SHARE_DIR/url.txt")"
  exit 0
fi

# ── ① API 기동 (죽어있을 때만) ──
if ! api_alive; then
  pkill -f "uvicorn api:app" 2>/dev/null || true
  sleep 1
  echo "→ [1/2] 크롤러 API 기동 (localhost:$PORT)..."
  nohup ./.venv/bin/uvicorn api:app --host 127.0.0.1 --port "$PORT" \
    > "$SHARE_DIR/api.log" 2>&1 &
  echo $! > "$SHARE_DIR/api.pid"
fi

for i in $(seq 1 20); do
  curl -s "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -s "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "✗ API 기동 실패. 로그: $SHARE_DIR/api.log"; exit 1
fi
echo "  ✓ API 정상"

# ── ② cloudflared 터널 (죽어있을 때만) ──
if ! tunnel_alive; then
  pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null || true
  rm -f "$SHARE_DIR/tunnel.log"
  echo "→ [2/2] cloudflared 터널 연결..."
  nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" \
    > "$SHARE_DIR/tunnel.log" 2>&1 &
  echo $! > "$SHARE_DIR/tunnel.pid"
fi

URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$SHARE_DIR/tunnel.log" 2>/dev/null | head -1)
  [[ -n "$URL" ]] && break
  sleep 1
done
if [[ -z "$URL" ]]; then
  echo "✗ 터널 URL 발급 실패. 로그: $SHARE_DIR/tunnel.log"; exit 1
fi
echo "$URL" > "$SHARE_DIR/url.txt"
echo "  ✓ 공개 URL: $URL"

# ── ③ 상대방용 프롬프트 md 생성 (템플릿의 {{BASE_URL}}/{{DATE}} 치환, 한/영 둘 다) ──
DATE_STR=$(date +%Y-%m-%d)
for PAIR in "PROMPT_TEMPLATE.md:PROMPT_FOR_PARTNER.md" "PROMPT_TEMPLATE_EN.md:PROMPT_FOR_PARTNER_EN.md"; do
  TEMPLATE="$SHARE_DIR/${PAIR%%:*}"
  OUT="$SHARE_DIR/${PAIR##*:}"
  if [[ -f "$TEMPLATE" ]]; then
    sed -e "s|{{BASE_URL}}|$URL|g" -e "s|{{DATE}}|$DATE_STR|g" "$TEMPLATE" > "$OUT"
    echo "  ✓ 상대방 전달용 프롬프트 생성: $OUT"
  fi
done

echo "URL=$URL"
