# CLIA Crawler API — 사용 안내 (연동 개발자용)

LG.com 상품 페이지(PDP) URL을 넣으면, **이미지와 텍스트가 짝지어진 구조화
JSON**을 돌려주는 API입니다. 크롤링·봇 우회·AI 분석은 서버가 다 처리하니,
여러분은 **URL을 보내고 → JSON을 받아 화면에 뿌리기**만 하면 됩니다.

---

## 0. 준비물 (이것만 받으면 시작)
- **API 주소(Base URL)**: `https://<배포주소>`  ← 전달받은 값
- 인증: **현재 없음** (자유 테스트 단계). 나중에 토큰이 생기면
  `Authorization: Bearer <토큰>` 헤더만 추가하면 됩니다.
- AI 비용: **서버(제공자)가 부담**합니다. 별도 키 불필요.

---

## 1. 호출 흐름 — "던지고 → 기다렸다 받기"

**처리 시간: 처음 크롤하는 URL은 10~15분** 걸립니다 (AI 비전 분석 + 시각 QA
검수 루프 포함). **이미 크롤된 URL(캐시)은 즉시** 반환됩니다.

> ⚠️ **클라이언트 타임아웃 주의**: 한 번의 HTTP 요청을 오래 잡아두지 마세요.
> 아래처럼 `job_id`를 받고 **몇 초 간격으로 폴링**하는 방식이라 개별 요청은
> 1초 안에 끝납니다. 전체 대기 한도를 두려면 **20분 이상**으로 잡으세요.
> 클라이언트가 중간에 끊어도 **서버는 작업을 끝까지 완료**하므로, 잠시 후
> 같은 URL로 다시 요청하면 캐시로 즉시 받습니다.

### ① 크롤 요청
```
POST {BASE_URL}/api/v1/crawl
Content-Type: application/json

{ "url": "https://www.lg.com/uk/tvs-soundbars/oled-evo/oled83c6elb/" }
```
응답:
```json
{ "job_id": "job_ab12cd34", "status": "queued" }
```
> 이미 크롤한 URL이면 `"status": "completed"` 로 바로 옵니다(기다림 0초).

### ② 결과 조회 (완료될 때까지 폴링)
```
GET {BASE_URL}/api/v1/jobs/{job_id}
```
- 진행 중: `{ "status": "processing", "progress_percent": 65, "log_message": "..." }`
- 완료: `{ "status": "completed", "result": { ...아래 데이터... } }`
- 실패: `{ "status": "failed", "error": "..." }`

권장: **2~3초 간격 폴링**. (선택) 실시간 진행률이 필요하면
`GET {BASE_URL}/api/v1/jobs/{job_id}/stream` (SSE) 사용.

---

## 2. 받는 데이터 구조 (result)

```json
{
  "product_title": "83 inch LG OLED evo AI C6 4K Smart TV 2026",
  "sections": [
    {
      "order": 1,
      "text": "Perfect Black & Perfect Color\n딥 블랙과 생생한 색을 동시에...",
      "media": [
        { "pc_url": "https://www.lg.com/.../feature-02-d.jpg",
          "mobile_url": "https://www.lg.com/.../feature-02-m.jpg" }
      ]
    },
    {
      "order": "3 - disclaimer",
      "text": "*Images have been simulated to enhance...",
      "media": []
    }
  ]
}
```

필드 설명:
| 필드 | 의미 |
|---|---|
| `product_title` | 제품명 |
| `sections[]` | 페이지 상단→하단 순서의 섹션 배열 |
| `section.order` | 순서 번호. **문자열에 `disclaimer` 포함 시 법적 고지문** |
| `section.text` | 그 섹션의 **LG 원문 텍스트** (AI 생성 아님, 첫 줄이 대개 헤드라인) |
| `section.media[]` | 그 텍스트에 짝지어진 이미지/영상 |
| `media.pc_url` / `mobile_url` | PC용 / 모바일용 에셋. 하나만 있으면 `unified_url` |
| `_qa.match_score` | (참고) 시각 검수 점수 0~100 |

### 화면에 뿌리는 팁
- 일반 섹션 → 특징 카드로 렌더 (text + media 세트)
- `order`에 `disclaimer` 있는 섹션 → **맨 아래 고지문 영역**에 몰아두기
- 이미지는 PC/모바일 반응형으로 `pc_url`/`mobile_url` 골라 쓰기

---

## 3. 최소 예제 (JavaScript)

```javascript
const BASE = "https://<배포주소>";

async function crawl(url) {
  // ① 요청
  const r = await fetch(`${BASE}/api/v1/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  let job = await r.json();

  // ② 완료까지 폴링
  while (job.status !== "completed") {
    if (job.status === "failed") throw new Error(job.error);
    await new Promise(s => setTimeout(s, 2500));
    job = await (await fetch(`${BASE}/api/v1/jobs/${job.job_id}`)).json();
  }
  return job.result;   // { product_title, sections: [...] }
}
```

---

## 4. 옵션 파라미터 (필요 시)
```json
{
  "url": "...",
  "force_refresh": false,   // true = 캐시 무시하고 새로 크롤
  "use_pro_model": false    // true = 정확도↑ Gemini Pro (느림). 기본 Flash
}
```

## 5. 완성된 eBay HTML 받기 (직접 렌더 불필요) ★추천

JSON을 직접 HTML로 그리지 않아도 됩니다. **LG 닷컴 컴포넌트 디자인
(카드 프레임·레이아웃·폰트 스케일)이 이미 적용된 완성 HTML**을 그대로 받으세요:

```
GET {BASE_URL}/api/v1/jobs/{job_id}/ebay-html     ← 크롤 완료된 잡으로
GET {BASE_URL}/api/v1/ebay-html?url=<PDP URL>     ← URL만으로 (캐시 필요)
```

- 응답: `text/html` — eBay 설명란에 그대로 삽입 가능한 fragment
  (`<style>` + 컨텐츠, JS 없음 = eBay active content 정책 준수)
- 디자인은 서버가 관리하므로, 개선 시 여러분 결과물도 자동으로 좋아집니다.
- 크롤이 아직 안 된 URL이면 404 — 먼저 `POST /api/v1/crawl` 후 호출하세요.

```js
const html = await (await fetch(`${BASE}/api/v1/ebay-html?url=${encodeURIComponent(pdpUrl)}`)).text();
```

## 6. 알아둘 점
- **자동 반영**: 제공자가 크롤러를 개선하면 이 API를 쓰는 모든 서비스에 즉시 반영됩니다. 여러분은 코드를 바꿀 필요 없습니다. (응답 구조 `sections/text/media`는 유지됩니다.)
- **하지 않아도 되는 것**: 크롤링 구현, 봇 차단 우회, 이미지-텍스트 매칭, AI 키 관리 — 전부 서버가 처리합니다.
- **첫 호출은 느릴 수 있음**: 새 URL은 10~15분(1장 참고). 같은 URL 재호출은 캐시로 즉시.
