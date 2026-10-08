<!--
이 파일은 상대방에게 그대로 전달하는 용도입니다.
상대방은 이 md 파일 전체를 복사해서 본인이 쓰는 Claude(Claude Code / claude.ai)에
붙여넣으면, 그 Claude가 내용을 읽고 자기 프로젝트에 맞게 API를 연동해줍니다.
URL은 cloudflared 재시작 시 바뀌므로, 공유할 때마다 새로 발급된 파일을 보내세요.
발급일: {{DATE}} (이 URL은 발급자의 맥북이 켜져 있고 터널이 살아있는 동안만 유효합니다)
-->

# 요청: LG.com PDP 크롤러 API 연동

아래 API를 내 프로젝트에 연동해줘. LG.com 상품 페이지(PDP) URL을 넣으면
**이미지와 텍스트가 짝지어진 구조화 JSON**(또는 완성된 eBay HTML)을 돌려주는
외부 서비스야. 크롤링·봇 우회·AI 비전 분석은 전부 그쪽 서버가 처리하니까,
나는 **URL을 보내고 → 결과를 받아서 화면에 뿌리는 클라이언트 코드**만 작성하면 돼.

## 기본 정보
- **Base URL**: `{{BASE_URL}}`
- **인증**: 없음 (자유 테스트 단계)
- **비용**: 제공자가 부담 (내 쪽 API 키 불필요)
- **주의**: 이 URL은 임시 터널 주소라 상대방 컴퓨터가 꺼지거나 터널을 재시작하면
  끊기거나 바뀔 수 있음. 404/연결 실패가 계속되면 상대방에게 새 URL을 요청할 것.

## 호출 흐름 — "던지고 → 폴링으로 받기"

처음 크롤하는 URL은 **10~15분** 걸림 (AI 비전 분석 + 시각 QA 포함).
이미 크롤된 URL(캐시)은 **즉시** 반환됨. 한 HTTP 요청을 오래 붙잡지 말고
`job_id`를 받아 몇 초 간격으로 폴링할 것 — 전체 대기 타임아웃은 20분 이상으로.

### ① 크롤 요청
```
POST {{BASE_URL}}/api/v1/crawl
Content-Type: application/json

{ "url": "https://www.lg.com/uk/tvs-soundbars/oled-evo/oled83c6elb/" }
```
응답: `{ "job_id": "job_ab12cd34", "status": "queued" }`
(이미 크롤된 URL이면 `"status": "completed"`로 즉시 옴)

### ② 결과 조회 (완료까지 2~3초 간격 폴링)
```
GET {{BASE_URL}}/api/v1/jobs/{job_id}
```
- 진행 중: `{ "status": "processing", "progress_percent": 65 }`
- 완료: `{ "status": "completed", "result": { "product_title": "...", "sections": [...] } }`
- 실패: `{ "status": "failed", "error": "..." }`

### 최소 예제 (JavaScript)
```javascript
const BASE = "{{BASE_URL}}";

async function crawl(url) {
  const r = await fetch(`${BASE}/api/v1/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  let job = await r.json();
  while (job.status !== "completed") {
    if (job.status === "failed") throw new Error(job.error);
    await new Promise(s => setTimeout(s, 2500));
    job = await (await fetch(`${BASE}/api/v1/jobs/${job.job_id}`)).json();
  }
  return job.result;   // { product_title, sections: [...] }
}
```

## 받는 데이터 구조 (result)
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
    { "order": "3 - disclaimer", "text": "*Images have been simulated...", "media": [] }
  ]
}
```
- `section.order`에 `disclaimer`가 포함되면 법적 고지문 — 맨 아래 고지 영역에 몰아서 배치
- `section.text`는 LG 원문 그대로임 (AI가 지어낸 카피 아님). **이 텍스트를 임의로
  바꾸거나 없는 내용을 추가하지 말 것** — 없으면 빈칸으로 둘 것
- 이미지는 PC/모바일 반응형으로 `pc_url`/`mobile_url` 중 화면 폭에 맞는 것 사용

## (선택) 완성된 eBay HTML을 바로 받기 — JSON 직접 렌더 불필요
```
GET {{BASE_URL}}/api/v1/jobs/{job_id}/ebay-html
GET {{BASE_URL}}/api/v1/ebay-html?url=<PDP URL>     ← 캐시된 URL이면 바로
```
- 응답은 `text/html` — eBay 설명란에 그대로 붙여넣을 수 있는 fragment
  (인라인 `<style>`만 포함, `<script>`/`<form>`/`<iframe>` 등 active content 없음
  → eBay 리스팅 정책 준수)
- 크롤이 안 된 URL이면 404 — 먼저 `POST /api/v1/crawl` 호출 후 사용할 것

## 옵션 파라미터
```json
{ "url": "...", "force_refresh": false, "use_pro_model": false }
```

## 연동 작업 시 지켜줄 것
1. 폴링 간격은 2~3초, 전체 타임아웃은 20분 이상으로 넉넉히 잡을 것 (첫 크롤은 느림)
2. `section.text`를 그대로 쓰고, PDP에 없는 문구를 AI로 지어내 채우지 말 것
3. 이미지 태그 렌더 시 원본 폭(응답에 width가 있으면)보다 확대하지 말 것 —
   없으면 컨테이너 폭을 상한으로만 쓰고 늘리지 말 것
4. 인증 헤더는 지금은 불필요하지만, 추후 `Authorization: Bearer <토큰>`이 추가될 수
   있다고 가정하고 헤더를 쉽게 추가할 수 있는 구조로 작성할 것
