# CLIA Content Hub — 클라우드 배포 가이드

이 저장소만 있으면 Docker를 지원하는 클라우드(Railway, Render, Google Cloud Run 등)에 그대로 배포됩니다.
Node.js 20 · Python 3.12 · Chromium(Playwright·Puppeteer)은 `Dockerfile`이 빌드할 때 자동으로 설치합니다.

## 1. 준비물 — API 키 3개

API 키는 **저장소에 넣지 않고** 클라우드 관리 화면의 환경 변수(Variables / Environment / Secrets)에 입력합니다.

| 변수 | 필수 | 용도 | 발급 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | GEO Q&A·키워드 생성, A+ 모듈 생성 | console.anthropic.com |
| `GEMINI_API_KEY` | ✅ | 크롤러 비전 분석 | aistudio.google.com |
| `FIRECRAWL_API_KEY` | ✅ | 크롤러 페이지 수집 | firecrawl.dev |
| `DATA_DIR` | 권장 | 크롤링 결과를 영구 보관할 볼륨 경로 (예: `/data`) | — |
| `PORT` | 자동 | 대부분의 클라우드가 자동 지정. 직접 지정 시 `3001` | — |

## 2. 서버 사양

- 메모리 **2GB 이상** 권장 (크롤링 중 Chromium 실행)
- 디스크(볼륨) **5GB 이상** 권장 — 크롤링한 제품이 계속 쌓입니다 (현재 캐시 약 0.9GB)
- 새 URL 크롤링은 10~15분 걸리므로, 요청 시간 제한이 있는 플랫폼은 20분 이상으로 설정

## 3-A. Railway (권장)

1. railway.app → **New Project → Deploy from GitHub repo** → 이 저장소 선택
   (Dockerfile을 자동 인식해 빌드합니다)
2. 서비스 → **Variables**에 위 API 키 3개 입력, `DATA_DIR=/data` 추가
3. 서비스 → **Settings → Volumes → Add Volume**, Mount path `/data`
4. **Settings → Networking → Generate Domain** → 발급된 주소로 접속
5. 헬스체크 경로(선택): `/api/health`

## 3-B. Render

1. render.com → **New → Web Service** → 이 저장소 연결, Runtime **Docker**
2. Instance type: 2GB 이상 (Standard 이상)
3. **Environment**에 API 키 3개 + `DATA_DIR=/data`
4. **Disks → Add Disk**, Mount path `/data`, 5GB 이상
5. Health Check Path: `/api/health` → Create Web Service

## 3-C. Google Cloud Run

```bash
gcloud run deploy clia-hub --source . --region asia-northeast3 \
  --memory 2Gi --cpu 2 --timeout 3600 --port 3001 \
  --set-env-vars ANTHROPIC_API_KEY=...,GEMINI_API_KEY=...,FIRECRAWL_API_KEY=... \
  --allow-unauthenticated
```
Cloud Run은 기본적으로 디스크가 유지되지 않습니다. 크롤링 결과를 보관하려면 Cloud Storage 볼륨을 `/data`에 마운트하고 `DATA_DIR=/data`를 지정하세요.

## 4. 접속

- `https://<발급된 주소>/` → 자동으로 `/clia/`(CLIA 허브)로 이동
- 로그인은 **시연 모드**입니다: 아무 이메일·비밀번호 + 법인(영국·독일·태국·사우디) 선택
- 저장소에 포함된 크롤링 캐시 제품은 바로 열리고, 새 URL은 허브의 URL 입력란에서 크롤링합니다

## 5. 동작 확인

| 확인 | 방법 |
|---|---|
| 서버 | `https://<주소>/api/health` 응답 |
| 크롤링 캐시 | `https://<주소>/api/v1/products?country=uk` 에 제품 목록 |
| 크롤러 | 허브에서 새 LG.com URL 크롤 → Coffee Break 팝업 진행률 → 완료 후 목록에 추가 |

## 문제 해결

- **크롤이 바로 실패** → API 키 3개가 모두 입력됐는지, 메모리가 2GB 이상인지 확인
- **재배포 후 새로 크롤한 제품이 사라짐** → 볼륨 마운트와 `DATA_DIR` 설정 확인
- **화면은 뜨는데 eBay/Shopee 스타일이 예전 모양** → 브라우저 강력 새로고침 (캐시)
