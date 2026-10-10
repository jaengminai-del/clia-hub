# CLIA Content Hub — 클라우드 배포 가이드

이 저장소만 있으면 Docker를 지원하는 클라우드(Railway, Render, Google Cloud Run 등)에 그대로 배포됩니다.
Node.js 20 · Python 3.12 · Chromium(Playwright·Puppeteer)은 `Dockerfile`이 빌드할 때 자동으로 설치합니다.

## 1. 준비물 — API 키 2개

API 키는 **저장소에 넣지 않고** 클라우드 관리 화면의 환경 변수(Variables / Environment / Secrets)에 입력합니다.

| 변수 | 필수 | 용도 | 발급 |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | 크롤러 비전 분석 + GEO Q&A·키워드 생성 | aistudio.google.com |
| `FIRECRAWL_API_KEY` | ✅ | 크롤러 페이지 수집 | firecrawl.dev |
| `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, `REGION` | 권장 | 크롤링 결과를 보관할 S3 호환 버킷 (Railway Bucket 등). 아래 4장 참고 | 클라우드 버킷 화면 |
| `S3_FORCE_PATH_STYLE` | 선택 | 버킷이 path-style URL을 쓰면 `1` | — |
| `DATA_DIR` | 선택 | 버킷 대신 볼륨에 보관할 때 볼륨 경로 (예: `/data`) | — |
| `PORT` | 자동 | 대부분의 클라우드가 자동 지정. 직접 지정 시 `3001` | — |

## 2. 서버 사양

- 메모리 **2GB 이상** 권장 (크롤링 중 Chromium 실행)
- 크롤링 결과는 버킷에 보관합니다 (현재 약 82MB, 스크린샷 제외). 버킷을 쓰면 볼륨은 필요 없습니다
- 새 URL 크롤링은 보통 1분 이내지만, 예전 형식 페이지(Gemini 분석)는 10~15분 걸리므로 요청 시간 제한이 있는 플랫폼은 20분 이상으로 설정

## 3-A. Railway (권장)

1. railway.app → **New Project → Deploy from GitHub repo** → 이 저장소 선택
   (Dockerfile을 자동 인식해 빌드합니다)
2. 서비스 → **Variables**에 위 API 키 2개 입력
3. 프로젝트 화면 **+ Create → Bucket**으로 버킷 생성 → 서비스 **Variables**에서 버킷 변수
   `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, `REGION`을 참조 변수로 추가
   (버킷 **Credentials** 탭이 path-style URL을 안내하면 `S3_FORCE_PATH_STYLE=1`도 추가)
4. **Settings → Networking → Generate Domain** → 발급된 주소로 접속
5. 헬스체크 경로(선택): `/api/health`
6. 기존 크롤링 데이터 올리기 → 아래 4장

## 3-B. Render

1. render.com → **New → Web Service** → 이 저장소 연결, Runtime **Docker**
2. Instance type: 2GB 이상 (Standard 이상)
3. **Environment**에 API 키 2개 + `DATA_DIR=/data`
4. **Disks → Add Disk**, Mount path `/data`, 5GB 이상
5. Health Check Path: `/api/health` → Create Web Service

## 3-C. Google Cloud Run

```bash
gcloud run deploy clia-hub --source . --region asia-northeast3 \
  --memory 2Gi --cpu 2 --timeout 3600 --port 3001 \
  --set-env-vars GEMINI_API_KEY=...,FIRECRAWL_API_KEY=... \
  --allow-unauthenticated
```
Cloud Run은 기본적으로 디스크가 유지되지 않습니다. 크롤링 결과를 보관하려면 Cloud Storage 볼륨을 `/data`에 마운트하고 `DATA_DIR=/data`를 지정하세요.

## 4. 크롤링 데이터 — 버킷 보관

서버는 크롤링 결과를 컨테이너 안 폴더(`crawler-py/out`, `crawler/out`)에 쓰고, `crawl-store.js`가 버킷과 동기화합니다.

- **서버 시작 시**: 버킷 → 서버로 내려받습니다. 서버는 바로 뜨고, 제품 목록은 받는 대로 채워집니다(수십 초).
- **크롤링·GEO 생성 후**: 결과가 자동으로 버킷에 올라갑니다. 재배포해도 사라지지 않습니다.
- **올리지 않는 파일**: 풀페이지 스크린샷(`pc_full.png`)·타일·백업(`*.bak`)·로그 — 재크롤 때 다시 만들어집니다.
- 버킷 변수가 없으면 동기화는 꺼지고, 예전처럼 컨테이너(또는 `DATA_DIR` 볼륨)에만 저장됩니다.

**처음 한 번 — 내 PC의 크롤링 데이터를 버킷에 올리기**

1. 버킷 **Credentials** 탭의 값을 작업 폴더 `.env`에 추가합니다 (`.env`는 git에 올라가지 않습니다).
   ```
   BUCKET=...
   ACCESS_KEY_ID=...
   SECRET_ACCESS_KEY=...
   ENDPOINT=https://t3.storageapi.dev
   REGION=auto
   ```
2. 확인 후 업로드합니다. 이미 같은 파일은 건너뛰므로 여러 번 실행해도 됩니다.
   ```bash
   node crawl-store.js status   # 올라갈 파일 수·용량
   node crawl-store.js push     # 업로드
   ```
3. Railway 서비스를 **Restart**하면 서버가 버킷에서 데이터를 받아 옵니다.

배포 서버에서 크롤링한 결과를 내 PC로 받으려면 `node crawl-store.js pull`.

## 5. 접속

- `https://<발급된 주소>/` → 자동으로 `/clia/`(CLIA 허브)로 이동
- 로그인은 **시연 모드**입니다: 아무 이메일·비밀번호 + 법인(영국·독일·태국·사우디) 선택
- 저장소에 포함된 크롤링 캐시 제품은 바로 열리고, 새 URL은 허브의 URL 입력란에서 크롤링합니다

## 6. 동작 확인

| 확인 | 방법 |
|---|---|
| 서버 | `https://<주소>/api/health` 응답 |
| 크롤링 캐시 | `https://<주소>/api/v1/products?country=uk` 에 제품 목록 |
| 크롤러 | 허브에서 새 LG.com URL 크롤 → Coffee Break 팝업 진행률 → 완료 후 목록에 추가 |

## 문제 해결

- **크롤이 바로 실패** → API 키 2개가 모두 입력됐는지, 메모리가 2GB 이상인지 확인
- **재배포 후 새로 크롤한 제품이 사라짐** → 버킷 변수 5개가 서비스에 들어가 있는지, 서버 로그에 `[crawl-store]` 업로드 메시지가 있는지 확인
- **제품 목록이 비어 있음** → 서버 로그의 `[crawl-store] 동기화 완료` 확인. `node crawl-store.js status`로 버킷에 데이터가 있는지 확인
- **화면은 뜨는데 eBay/Shopee 스타일이 예전 모양** → 브라우저 강력 새로고침 (캐시)
