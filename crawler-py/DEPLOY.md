# CLIA Crawler API — 클라우드 배포 가이드

Firecrawl + Playwright + Gemini 크롤 파이프라인을 **Docker 상시 배포**해서
다른 사람/서비스가 REST로 호출할 수 있게 한다.

## 구성 파일
- `Dockerfile` — Playwright 공식 파이썬 이미지 기반 (Chromium 포함)
- `.dockerignore` — out/·.venv 등 제외
- `render.yaml` — Render 배포 설정 (Disk 캐시 + 자동 토큰)
- `api.py` — FastAPI 앱 (`CLIA_API_TOKEN` 설정 시 Bearer 인증 강제)

## 필요한 환경변수
| 키 | 용도 | 필수 |
|---|---|---|
| `FIRECRAWL_API_KEY` | Firecrawl 크롤 | ✅ |
| `GEMINI_API_KEY` | Gemini 분석 (마스터 키) | BYOK만 쓸 거면 생략 가능 |
| `CLIA_API_TOKEN` | 공유 호출 인증 토큰 | 공유 시 ✅ (render.yaml이 자동 생성) |

## Render 배포 (권장)
1. GitHub에 push (이미 됨) → Render 대시보드 → **New → Blueprint** → 이 repo 선택
2. `render.yaml`이 자동 인식됨. `FIRECRAWL_API_KEY`·`GEMINI_API_KEY`를 대시보드에서 입력
3. 배포 완료 → `https://clia-crawler-api.onrender.com` 형태 URL 확보
4. `CLIA_API_TOKEN` 값은 Render 대시보드 Environment 탭에서 확인 (자동 생성됨)

> **plan: standard** 권장 — Chromium이 메모리를 써서 starter(512MB)는 OOM 위험.

## 로컬 Docker 테스트
```bash
cd crawler-py
docker build -t clia-crawler .
docker run -p 8080:8080 \
  -e FIRECRAWL_API_KEY=fc-... \
  -e GEMINI_API_KEY=... \
  -e CLIA_API_TOKEN=my-secret \
  clia-crawler
```

## 공유받는 사람의 호출법
```bash
# 1) 크롤 등록
curl -X POST https://<배포URL>/api/v1/crawl \
  -H "Authorization: Bearer <CLIA_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.lg.com/.../product/"}'
# → { "job_id": "...", "status": "queued"|"completed" }

# 2) 결과 조회 (폴링)
curl https://<배포URL>/api/v1/jobs/<job_id> \
  -H "Authorization: Bearer <CLIA_API_TOKEN>"
# → status=completed 이면 result 에 mirror(PCG) JSON

# 3) (선택) 실시간 진행률 SSE
curl -N https://<배포URL>/api/v1/jobs/<job_id>/stream
```

### 키 비용 옵션 (BYOK)
호출자가 자기 Gemini 키로 과금받게 하려면 헤더에 실어 보낸다:
```
X-Gemini-API-Key: AIza...   (없으면 서버 마스터 키 사용)
```

## CLIA 빌더(Node)에서 원격 API 쓰기
`server.js`가 참조하는 두 환경변수만 지정하면 로컬 대신 배포 API를 탄다:
```bash
FASTAPI_BASE=https://<배포URL> CLIA_API_TOKEN=<토큰> node server.js
```

## 주의
- **WAF 우회**: 로컬은 `channel="chrome"`(실제 Chrome)로 Akamai 우회. 컨테이너는
  번들 Chromium으로 폴백된다 — 일부 PDP에서 차단 가능성 있으니 배포 후 회귀 테스트 필수.
- **캐시**: `render.yaml`의 Disk(`/app/out`)가 mirror.json을 영속화 → 재배포에도 캐시 유지.
