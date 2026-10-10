# CLIA Content Hub

LG.com 제품 페이지(PDP)를 한 번 크롤링해서 **eBay · Amazon A+ · Shopee / Lazada** 리테일 컨텐츠를 만드는 웹 솔루션입니다.
크롤러 하나와 컨텐츠 스타일 엔진 하나를 모든 채널 빌더가 함께 씁니다.

## 구성

| 경로 | 내용 |
|---|---|
| `clia/` | CLIA 허브 — 로그인(법인 선택·4개 언어), 제품 목록, URL 크롤, GEO, 채널별 컨텐츠 생성 |
| `ebay-listing/` | eBay 리스팅 빌더 (단독 실행 가능) |
| `shopee-lazada-pdp/` | Shopee / Lazada PDP 빌더 — 이미지 슬라이스 ZIP(+슬라이스별 텍스트) |
| `amazon-aplus/` | Amazon A+ 빌더 — Feature Card 7개 선택 → A+ 모듈 자동 구성 |
| `shared/` | 공용 UI 스타일(`clia-ui.css`, LG Design System v3), 빌더 번역 엔진(`clia-i18n.js`), LG 로고 |
| `server.js`, `crawler-routes.js` | Node 서버 (기본 :3001) — 정적 파일 + API |
| `crawler-py/` | LG.com PDP 크롤러 (Python) + CCG 스타일 렌더러(`ebay_builder.py`) + 크롤링 캐시(`out/`) |
| `crawler/` | Firecrawl 기반 보조 크롤러 |
| `css/`, `fonts/` | LG EI Headline / LG EI Text 폰트 |

## 클라우드 배포

**[DEPLOY.md](DEPLOY.md)** 참고 — `Dockerfile`이 Node.js·Python·Chromium을 모두 설치하므로, 이 저장소를 Docker 지원 클라우드(Railway·Render·Cloud Run)에 연결하고 API 키만 환경 변수로 넣으면 됩니다.

## 로컬 실행

```bash
npm install
cp .env.example .env          # API 키 입력

# 크롤러 (Python 3.12+)
python3 -m venv crawler-py/.venv
crawler-py/.venv/bin/pip install -r crawler-py/requirements.txt
crawler-py/.venv/bin/playwright install chromium

node server.js                # http://localhost:3001/clia/
```

- 로그인은 시연 모드입니다. 아무 이메일·비밀번호와 법인(영국·독일·태국·사우디)을 선택하면 들어갑니다.
- 저장된 크롤링 캐시(`crawler-py/out/`)의 제품은 바로 열 수 있습니다. 새 URL 크롤링은 보통 1분 이내입니다(HTML 컴포넌트 구조로 바로 생성). 컴포넌트 구조가 부족한 예전 형식 페이지만 Gemini 분석으로 10~15분 걸립니다.
- 크롤 결과 품질이 떨어지면 `CRAWLER_FULL_AI=1`로 기존 방식(스크린샷 + Gemini 분석·시각 QA)으로 되돌릴 수 있습니다. 한 건만 기존 방식으로 돌리려면 `POST /api/v1/crawl`에 `"full_ai": true`를 보냅니다. 기존 방식 코드는 GitHub 태그 `pre-fast-crawl`에도 남아 있습니다.
- 서버는 **하나만** 띄우세요. 같은 3001 포트를 쓰는 다른 서버가 떠 있으면 크롤러·스타일이 적용되지 않은 예전 방식으로 동작합니다.

## 주요 API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/v1/products?country=uk` | 크롤링된 제품 목록 |
| GET | `/api/v1/products/:slug` | 제품 1건 (원본 URL + mirror + geo) |
| POST | `/api/v1/products/:slug/geo` | GEO Q&A·키워드 생성 — Gemini (`geo.json` 캐시) |
| POST | `/api/v1/crawl` → GET `/api/v1/jobs/:id` | URL 크롤링 작업 등록 / 상태 조회 |
| GET | `/api/v1/ebay-html?url=` | eBay HTML (CCG 스타일) |
| POST | `/api/pcg-vision` | 빌더용 크롤 결과(mirror) |
| POST | `/api/render-slices` | Shopee/Lazada 이미지 슬라이스 ZIP |

## 개발 메모

이 저장소는 작업 원본(`lg-web-project`)에서 `scripts/export-clia-hub.sh`로 내보낸 결과물입니다.
