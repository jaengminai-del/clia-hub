# Shopee / Lazada PDP Content Builder

LG.com 제품 페이지(PDP) URL을 넣으면 상품 상세 콘텐츠를 만들고, **이미지 슬라이스 ZIP**으로
내려받는 도구입니다. `ebay-listing/` 빌더에서 복사해 만들었고, 차이는 **출력 형태 하나**입니다.

| | eBay 빌더 | 이 빌더 |
|---|---|---|
| 출력 | HTML `.txt` (설명란에 붙여넣기) | **이미지 ZIP** (슬라이스 6장) |
| 이유 | eBay는 HTML 설명란 지원 | Shopee / Lazada는 상세를 이미지로 업로드 |

---

## 실행

```bash
cd "/Users/kangjaeyeong/Desktop/AI Study/lg-web-project"
node server.js
# → http://localhost:3001/shopee-lazada-pdp/index.html
```

렌더는 서버(`/api/render-slices`)가 실제 Chrome으로 처리하므로 **`node server.js`가 떠 있어야
이미지 다운로드가 됩니다.** (크롤·생성도 이미 이 서버를 씁니다.)

## 사용

1. LG.com PDP URL 입력 → `Go`
2. 좌측 미리보기에서 확인 (`✏ Edit`로 텍스트 수정 가능 — 수정본이 이미지에 반영됩니다)
3. 하단에서 옵션 조정 → `⬇ Download Images (ZIP)`

| 옵션 | 기본값 | 설명 |
|---|---|---|
| Slices | **6** | 몇 장으로 자를지 (1~20). 한 장이 너무 길면 플랫폼 업로드가 거부되므로 나눈다 |
| Output width | **비움 = 자동** | 최종 이미지 폭(px). 비우면 콘텐츠 실측 폭의 2배로 저장 |
| Format | JPG | JPG(품질 88) 또는 PNG |

ZIP 안에는 `<slug>-01.jpg` … `<slug>-06.jpg`와 `<slug>-manifest.json`(각 장의 픽셀 크기·용량,
크롭 정보, 이미지 로드 성공 수)이 들어 있습니다. 다운로드 후 하단에 `6 images · 1664px wide ·
tallest 3374px · largest 482KB` 처럼 요약이 표시되니, 플랫폼 한도를 넘으면 Slices를 늘리거나
Output width를 낮추세요.

## 잘라내는 영역 — 좌우 여백 없음

생성된 콘텐츠는 `.lg-container { max-width: 800px; margin: 0 auto }` 로 가운데 정렬돼서, 뷰포트를
그대로 촬영하면 좌우에 흰 여백이 함께 찍힙니다. 그래서 **뷰포트가 아니라 콘텐츠의 실측 경계**
(최상위 자식들의 bounding box 합집합)를 잘라냅니다.

- 렌더는 넓은 뷰포트(1600px)에서 하고 → 콘텐츠 폭만 잘라냄 (예: 832px = 800 + 좌우 패딩 16px)
- 콘텐츠가 뷰포트보다 좁아 결과가 작아지는 만큼 **배율 2배**로 촬영해 선명도를 유지
  (예: 832css → **1664px** 출력)
- `Output width`를 지정하면 그 폭에 맞는 배율로 촬영 (배율 0.5~4배 범위)

## 자르는 위치

글자 중간이 잘리지 않도록 **요소 경계에서만** 자릅니다.

1. 섹션 바닥을 우선 사용 (제목·이미지·본문이 한 덩어리로 유지됨)
2. 섹션이 한 장보다 길면 표 행 / 문단 경계
3. 둘 다 없으면 균등 분할

그래서 각 장의 높이는 서로 다릅니다. 슬라이스 높이의 합은 항상 원본 전체 높이와 같습니다
(누락·중복 없음).

## 참고

- 원격 이미지(lg.com DAM)는 개별 25초 타임아웃으로 기다립니다. 일부가 실패해도 나머지는
  정상 렌더되고, 실패 수는 manifest의 `images_loaded`와 서버 로그에 남습니다.
- 폰트는 프로젝트의 `css/fonts.css`(LGEIHeadline / LGEIText)를 그대로 사용합니다.
- `📋 Copy HTML` 버튼은 남겨뒀습니다 — 다른 채널에 HTML로 재사용할 때 씁니다.
