# CLIA PDP 검토/승인 — 목업 v10 (lg.com 캡처 + CLIA 결과가 둘 다 있는 제품)

2026-11-24 KST. **문서·목업만 있습니다. 운영 코드는 바꾸지 않았고, 병합·배포하지 마세요.** 운영 서버에는 GET만 보냈습니다.

## 요청 (2026-11-24)

- 「닷컴과 캡처가 다 있는 제품으로 다시 구성해. 이미 클리아에 많이 쌓여 있잖아.」
- 「스쿼드 허브 리포에 3P QA 페이지가 있어. 닷컴과 비교하는 로직이 비슷하니까 차용하자.」
- 「PDP가 길 수밖에 없으니까 왼쪽엔 닷컴, 오른쪽엔 쇼피 혹은 라자다가 보이고, 스크롤하면서 같은 영역으로 동시에 스크롤되게 해 줘. 쇼피/라자다가 길면 닷컴은 기다렸다가 다시 스크롤되게 해.」

## 기본 화면: 나란히 보기 + 같은 영역 동시 스크롤

- 비교 화면은 **왼쪽 lg.com, 오른쪽 Shopee 또는 Lazada**로 열립니다(탭으로 채널 전환).
- **같은 영역:** 양쪽을 각자 콘텐츠 폭 기준으로 같은 거리만큼 움직입니다(`u = 스크롤량 ÷ 콘텐츠 폭`). 시작점은 왼쪽이 lg.com PDP 첫 섹션, 오른쪽이 상세 설명 첫머리입니다. 어느 쪽을 스크롤해도 같습니다.
- **짧은 쪽은 기다림:** 결과가 더 길면 lg.com은 끝(스펙 끝)에서 멈추고, 머리글에 노란 「LG.com 끝 · 기다리는 중」이 뜹니다. 결과를 다시 올려 lg.com 범위 안으로 돌아오면 같이 움직입니다. 반대로 lg.com이 더 길면 결과 쪽이 기다립니다.
- 브라우저 검사(`sync_test`): A9-ACE·OLED48C6PSA·GN-Y331SLS·45GX950A-B·98NU855BPSB에서 결과를 10단계로 내리며 왼쪽 위치를 재 보니 모두 `min(u, lg.com 길이)` 그대로였습니다.
- 28개 전부, Shopee·Lazada 두 채널 모두 CLIA 결과(모바일 390 기준)가 lg.com PDP보다 깁니다(브라우저에서 모두 잼). 콘텐츠 폭의 몇 배인지로 보면 lg.com은 0.7~19.5배, 결과는 5.1~59.2배입니다. 그래서 실제로는 대부분 lg.com이 먼저 끝나 기다립니다.
- 「세 줄 보기」(3P QA 방식)는 탭으로 남겨 두었습니다.

## 제품 고르기

1. TH 배치 URL **540개** 전부 `GET /api/v1/fullshot?url=`로 lg.com 전체 화면 캡처가 있는지 조회했습니다([fullshot_scan.jsonl](./fullshot_scan.jsonl)). 결과 **37개**에 캡처가 있습니다. 새로 찍는 `POST`는 쓰지 않았습니다.
2. 37개 모두 CLIA 결과(배치 `image-html.txt`의 운영 슬라이스)가 있습니다.
3. 시작선 주변을 눈으로 확인해 **9개를 뺐고**, 나머지 **28개**로 구성했습니다([v10-sources.json](./v10-sources.json) `skipped`).

| 뺀 것 | 이유 |
|---|---|
| IAQ13G1 · SEQ18A · ISC10E · RV09VHP4W1 · 27G850A-B-ATM · OLED65G4PSA · 55QNED86TSA | 캡처에 **기능 섹션이 없음**. 탭 바 바로 아래가 스펙 요약입니다. CLIA 쪽은 슬라이스가 5~42장이라 lg.com에는 기능 섹션이 있었을 것이고, 지연 로드가 안 찍힌 것으로 보입니다(추정). |
| 65UR7550PSC · OLED65G4PSA-B187 | 캡처가 **제품 페이지가 아니라 lg.com 메인(11.11 프로모션) 화면**입니다. |

- 이 9개는 운영 캡처를 다시 찍어야(`POST /api/v1/fullshot` + `retry`) 쓸 수 있습니다. 운영에서 캡처 작업이 돌기 때문에 장혁님 승인이 필요합니다.
- 운영 `fullshotReady()`는 80KB 미만 파일만 「Access Denied 화면」으로 거릅니다. 이번에 본 「기능 섹션 누락」과 「메인 화면」 캡처는 이 검사를 통과합니다. 운영 쪽 검사를 보강할지도 질문으로 남깁니다.

## lg.com은 PDP부터

- 캡처(폭 960px)에서 갤러리 아래 앵커 탭 바(คุณสมบัติ·สเปค·รีวิว)를 찾고, 그 아래 빈 베이지 띠 다음에 처음 무늬가 생기는 줄에서 16px 위를 시작으로 잡습니다(`collect_v10.py` `pdp_top`).
- 탭 바 바로 아래의 **추천 액세서리** 블록(สินค้าและอุปกรณ์เสริมที่แนะนำ)은 자동으로 건너뜁니다.
- 사람이 보고 고친 것(`OVERRIDE`)은 4개입니다.
  - RV10VHP2B 976: 액세서리 아래 프로모션 띠까지 건너뜀
  - 98NU855BPSB · 65QNED70BSA · OLED42C6PSA-GRAB 488: 탭 바 바로 아래에서 검은 섹션이 시작해 자동 감지가 첫 제목을 자름
- **끝(bottom):** 리뷰 섹션 제목 「รีวิวจากผู้ใช้สินค้า」 바로 위입니다. 스펙 카드와 「ดูสเปคทั้งหมด」 링크까지만 보입니다.
  - 제목은 모든 캡처에서 같은 글꼴·크기·x 위치라, A9-ACE에서 자른 견본([review-heading-template.png](./review-heading-template.png))을 정규화 상관으로 찾습니다.
  - 28개 모두 상관 0.85 이상이고, 자른 선을 모아 눈으로 확인했습니다.
  - 리뷰·FAQ·추천 제품·지원·푸터는 숨깁니다.
  - 노란색(별점)으로 찾는 방식도 해 봤지만 기능 이미지의 노란색과 섞여 28개 중 9개만 잡혀서 쓰지 않았습니다.
- 이미지를 잘라내지 않고 CSS로 위·아래만 가리므로 비율은 그대로입니다.

## Squad Hub 3P QA에서 가져온 것

출처: `contentfactoryhsad-blip/work-automation` `src/components/contents-qa/` (Squad Hub `/tools/3p-asia-contents-qa`, 「Shopee·Lazada 3P PDP의 썸네일·갤러리·상세페이지를 SKU별로 LG.com과 비교」).

| 3P QA (DetailTab.tsx) | v10 「세 줄 보기」 |
|---|---|
| SKU 하나에 Shopee / Lazada / LG.com(기준) 세 줄, 왼쪽 200px 칸에 상태 칩 | 같음. 칩: 요약 글/HTML/대기, 넣는 이미지 수, Shopee 글자 수(3,000자 한도), 기준 폭 |
| 「전체 페이지」: 긴 캡처 한 장을 세로 단 n개로 잘라 한 줄(약 600px)에. n ≈ √(비율·줄너비/600), 1~16 | 같은 식. 3P QA는 마켓 실제 페이지 **캡처 이미지**를 자르고, v10은 **CLIA 결과**(요약 + 슬라이스)를 기준 폭으로 그린 뒤 같은 내용을 단마다 위치만 바꿔 보여 줍니다. LG.com 줄은 캡처를 PDP부터 |
| 「상세 이미지만」: 상세 이미지를 원래 비율로 격자에 | 같음. Shopee에 넣지 않는 이미지는 흐리게 |
| 단을 누르면 원본 크게 보기 | 단을 누르면 「나란히 보기」에서 그 위치로 |

- 「나란히 보기」(기본)는 v9 비교 화면에 같은 영역 동시 스크롤을 더한 것입니다(위 참고).
- 승인 바(콘텐츠 승인·요약 승인·반려·편집), 목록, ZIP/엑셀 「승인 n/전체」도 그대로입니다. 상태는 모두 「미검토」로 시작합니다(v7의 데모 상태는 뺌).
- SKU는 엑셀에만 있어서 모델 코드를 「예시」로 씁니다.

### 3P QA 데이터는 아직 못 씀

- 3P QA 실행에는 Shopee·Lazada **실제 페이지 전체 캡처**(`fullpage`)가 쌓여 있습니다. 이것과 비교하면 「사이즈 그대로」를 확인할 수 있습니다.
- 다만 API(`/api/contents-qa/runs`)는 Squad Hub 로그인 쿠키가 있어야 읽을 수 있어서, 이 세션에서는 열지 않았습니다.
- 외부 공유 링크(`/share/3p-asia-contents-qa/<토큰>`)가 있으면 로그인 없이 읽을 수 있습니다.

## 기준 폭 (추정)

- **모바일 390 / PC 1000** 둘 중 하나로 CLIA 결과를 그립니다. 둘 다 실제 Shopee·Lazada 페이지와 대조하기 전의 추정값입니다.
- Lazada 요약은 운영 `to_html()` 그대로(본문 16px, 최대 폭 1000px)입니다.
- Shopee 요약은 태그 없는 글(14px)이고, 이 글자 크기도 추정입니다.
- 슬라이스는 원본 1000px 폭을 기준 폭에 맞춰 줄입니다.

## 파일

| 파일 | 내용 |
|---|---|
| [mockup-v10.html](./mockup-v10.html) | 목업 (2.0MB). 이미지는 운영 `/media/fullshot` · `/media/slices` 주소를 직접 읽음 |
| [collect_v10.py](./collect_v10.py) | 캡처 조회 결과 + 배치 결과 + 제품 목록 → `v10-sources.json`. 캡처를 받아 크기와 PDP 시작 위치를 잼 |
| [build_v10.py](./build_v10.py) | `../v9/mockup-v9.html`을 틀로 → `mockup-v10.html` |
| [capture_v10.js](./capture_v10.js) | 캡처 + 모든 제품·보기의 이미지 비율 검사 |
| [fullshot_scan.jsonl](./fullshot_scan.jsonl) | 540개 캡처 조회 원본 결과 |
| [review-heading-template.png](./review-heading-template.png) | PDP 끝을 찾는 리뷰 제목 견본 (A9-ACE 캡처에서 220×40) |
| [v10-sources.json](./v10-sources.json) | 쓴 28개 + 뺀 9개와 이유 |

```bash
python3 -I collect_v10.py --scan fullshot_scan.jsonl --batch-out <clia-th-batch>/out --products-list <GET /api/v1/products?country=th 결과> --cache <작업폴더>
```

```bash
python3 -I build_v10.py --template ../v9/mockup-v9.html --sources v10-sources.json
```

```bash
node capture_v10.js mockup-v10.html .
```

## 캡처

| 파일 | 화면 |
|---|---|
| [list-v10.png](./list-v10.png) | 목록 28개 |
| [compare-v10-all-mobile.png](./compare-v10-all-mobile.png) | A9-ACE 세 줄 보기 · 전체 페이지 · 모바일 390 |
| [compare-v10-all-pc.png](./compare-v10-all-pc.png) | 같은 제품 · PC 1000 |
| [compare-v10-all-long.png](./compare-v10-all-long.png) | OLED48C6PSA (슬라이스 33장, 캡처 24,352px) |
| [compare-v10-all-images.png](./compare-v10-all-images.png) | WT2116SHEG 세 줄 보기 · 상세 이미지만 |
| [compare-v10-side-top.png](./compare-v10-side-top.png) | A9-ACE 나란히 보기 · 처음 (lg.com PDP 첫 섹션 ↔ Shopee 요약 글) |
| [compare-v10-side-sync.png](./compare-v10-side-sync.png) | 같은 제품 · 결과 30% 지점, 양쪽 같은 영역 |
| [compare-v10-side-wait.png](./compare-v10-side-wait.png) | 같은 제품 · 결과 80% 지점, lg.com은 스펙 끝에서 「기다리는 중」 |
| [compare-v10-side-lazada-sync.png](./compare-v10-side-lazada-sync.png) | A9-ACE Lazada · 결과 20% 지점 |
| [compare-v10-side-shopee.png](./compare-v10-side-shopee.png) | GC-X257CMEW 나란히 보기 · Shopee |
| [compare-v10-side-lazada.png](./compare-v10-side-lazada.png) | 45GX950A-B 나란히 보기 · Lazada |
