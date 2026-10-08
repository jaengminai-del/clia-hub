#!/usr/bin/env bash
# CLIA Crawler API — Google Cloud Run 배포 스크립트
#
# 사전 준비(최초 1회):
#   1) gcloud CLI 설치:  https://cloud.google.com/sdk/docs/install
#   2) gcloud auth login
#   3) 프로젝트 생성/선택 (아래 PROJECT_ID 수정)
#   4) 결제 계정 연결 (무료 크레딧/티어 사용 — 카드 등록 필요)
#
# 사용:
#   cd crawler-py
#   ./deploy-cloudrun.sh
#
# 이 스크립트는 crawler-py/ 디렉터리에서 실행하세요 (Dockerfile 위치).

set -euo pipefail

# ── 설정 (본인 값으로 수정) ─────────────────────────────
PROJECT_ID="${PROJECT_ID:-clia-crawler}"        # GCP 프로젝트 ID
REGION="${REGION:-asia-northeast3}"             # 서울 리전 (싱가포르: asia-southeast1)
SERVICE="${SERVICE:-clia-crawler-api}"

# ── 키 (환경변수로 주입; 없으면 프롬프트) ───────────────
: "${FIRECRAWL_API_KEY:?FIRECRAWL_API_KEY 환경변수를 설정하세요 (export FIRECRAWL_API_KEY=fc-...)}"
: "${GEMINI_API_KEY:?GEMINI_API_KEY 환경변수를 설정하세요 (export GEMINI_API_KEY=...)}"

echo "→ 프로젝트 설정: $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

echo "→ 필요한 API 활성화 (Cloud Run, Cloud Build, Artifact Registry)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "→ Cloud Run 배포 (소스에서 자동 빌드 → 배포)..."
# 핵심 플래그:
#   --memory 2Gi / --cpu 2  : Chromium 구동 메모리·CPU
#   --no-cpu-throttling      : 202 응답 후 백그라운드 크롤 프로세스가 계속 돌게
#   --min-instances 1        : 인스턴스 상주 → 작업 완료·폴링 응답 보장 (0으로 안 죽음)
#   --max-instances 1        : 단일 인스턴스 → 인메모리 Job·로컬 out/ 캐시 일관성
#   --timeout 900            : 긴 크롤 허용 (최대 3600)
#   --allow-unauthenticated  : 무인증 공개 (자유 테스트). 나중에 CLIA_API_TOKEN 추가로 잠금
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --no-cpu-throttling \
  --min-instances 1 \
  --max-instances 1 \
  --timeout 900 \
  --port 8080 \
  --set-env-vars "FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY},GEMINI_API_KEY=${GEMINI_API_KEY}"

echo ""
echo "✓ 배포 완료. 서비스 URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)'
echo ""
echo "테스트:  curl <위URL>/healthz"
