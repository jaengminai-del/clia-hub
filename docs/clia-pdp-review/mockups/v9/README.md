# CLIA PDP 검토/승인 — 목업 v9 (상세(PDP)만)

2026-11-24 KST. **문서·목업만 있습니다. 운영 코드는 바꾸지 않았고, 병합·배포하지 마세요.** 새로 보낸 요청은 없습니다. 입력은 v8과 같은 `../v8/v8-sources.json`(운영 저장본·배치 슬라이스 주소, GET으로 모은 것)입니다.

## 왜 v9인가 (사용자 결정, 2026-11-24)

- 「갤러리는 필요 없고, PDP 페이지가 가장 핵심」 → **갤러리를 완전히 뺐습니다.**
- 「Shopee·Lazada 프리뷰가 실제 페이지 그대로 보여야 함 — 모바일 웹·PC 웹 기준, 실제 페이지를 같이 접속해서 확인」 → **아직 못 했습니다.** 이 클라우드 세션에서는 사용자 컴퓨터를 연결하지 못해(Remote Control 폴더가 클라우드 세션에 제공되지 않음) 나중에 사용자 컴퓨터에서 같이 보기로 했습니다. 그래서 v9 프리뷰는 「실제 페이지 모양 대조 전」이라고 표시합니다.

## v8에서 바뀐 것

| 항목 | v8 | v9 |
|---|---|---|
| 오른쪽 프리뷰 | Shopee/Lazada 상품 페이지 전체 흉내(갤러리·가격·판매자·스펙 자리 표시·하단 구매 바) + 상세 | **상세 설명 영역만**: PDP 요약(TH) + 운영 슬라이스 전체 |
| 갤러리 승인 규칙 | 0장 잠금 / 원본·저장 노란 경고 / `%20(N)` 회색 칩 | **모두 삭제.** 갤러리 때문에 막히는 제품 없음 (`gc-b257sqyl`도 미검토) |
| 마켓 갤러리 장수 제한(Shopee 9·Lazada 8) | 표시 | 삭제 |
| 목록 썸네일 | 갤러리 첫 장(lg.com) | **상세 첫 슬라이스** 위쪽 (운영 슬라이스라 바로 보임) |
| 오른쪽 머리글 | 「SHOPEE 상품 페이지」 | 「SHOPEE 상세 설명」 |

그대로인 것: 왼쪽 lg.com 원본(운영 저장본 섹션 + v8 매칭), 섹션 단위 동기 스크롤(위치표 「추정」, 위치표 없는 3개 제품은 꺼짐), 1000px 확대 보기, 요약 2단계 승인, 별표 경고·매칭 확인·SKU 예시, ZIP/엑셀 승인 n/전체, 법인 th/sg 전환. v7의 지어낸 「AS10GDBY0 승인 불가」는 계속 빠져 있습니다.

## 이미지 비율 버그 수정 (v8·v9 공통)

- **v8과 v9 첫 업로드에 있던 버그:** 상세 슬라이스에 자리 잡기용 `height` 속성을 넣었는데 CSS에 `height:auto`가 없었습니다. 그래서 슬라이스가 폭은 줄고 높이는 원본 그대로여서 **세로로 늘어나** 보였습니다. 예를 들어 1000×1721 슬라이스가 390×1721로 그려졌습니다.
- `.slices img{height:auto}`로 고쳤습니다. 목록 썸네일도 잘라내지 않고(`object-fit:contain`) 전체가 보이게 바꿨습니다.
- 캡처 스크립트가 모든 제품·채널을 열어서, 화면에 그려진 가로세로 비율과 원본 이미지 비율이 1% 넘게 다른 이미지를 셉니다.
  - 고치기 전: 260장 중 150장이 어긋남
  - 고친 뒤: 0장
  - lg.com 이미지는 이 환경에서 열리지 않아 검사하지 못했습니다(미확인). 왼쪽 원본 이미지는 `width:100%; height:auto`라 비율이 바뀌지 않는 구조입니다.

## LG.com 화면 그대로 · Shopee 실제 규칙 (2026-11-24 오후 추가)

### 왼쪽: lg.com 전체 화면 캡처 (있는 제품만)

- 운영 서버에 이미 있는 lg.com 전체 화면 캡처를 `GET /api/v1/fullshot?url=`로 조회했습니다([collect_fullshots.py](./collect_fullshots.py) → [fullshots.json](./fullshots.json)). 새로 찍는 `POST`는 쓰지 않았습니다.
- 캡처가 있는 제품은 **13개 중 3개**입니다: A9-ACE(960×9142), GC-B187JBAM(960×6184), RV10VHP2B(960×8202).
  - 이 3개는 왼쪽이 기본으로 「화면 그대로」입니다. 「섹션」으로 바꿔 볼 수도 있습니다.
  - **오른쪽처럼 PDP부터 시작합니다.** 헤더, 제품 상단(갤러리·가격), 앵커 탭 바(คุณสมบัติ·สเปค·รีวิว)는 CSS로 가립니다. 이미지를 잘라내지 않아 비율은 원본 그대로입니다.
    - 시작 위치는 캡처(폭 960px)에서 직접 쟀습니다. 행별 밝기 분산이 처음 0을 넘는 행에서 16px 위로 잡았고, 오른쪽 채팅 아이콘 영역은 제외했습니다.
    - A9-ACE y=516, GC-B187JBAM y=540, RV10VHP2B y=976 (`build_v9.py` `FULLSHOT_PDP_TOP`).
    - RV10VHP2B는 탭 바 아래의 추천 액세서리와 프로모션 띠가 운영 저장본 섹션에 없어서 그것까지 가리고, 저장본 첫 섹션(เครื่องอบผ้า DUAL Inverter Heat Pump™)부터 보여 줍니다.
    - GC-B187JBAM 맨 위의 작은 깨진 이미지 아이콘은 캡처 당시 lg.com 페이지에 있던 것입니다(저장본 1·2번 섹션도 이미지가 없음).
  - 아래쪽(리뷰·FAQ·추천 제품·푸터)은 아직 그대로 보입니다.
  - 캡처 화면에는 섹션 위치가 없어서 동기 스크롤이 꺼집니다.
- 나머지 10개는 「전체 화면 캡처 없음 · 운영 저장본 섹션으로 표시」입니다. 이 10개를 만들려면 `POST /api/v1/fullshot`로 운영 서버에서 캡처를 돌려야 합니다(장혁님 승인 필요).
- 캡처 시각은 확인하지 못했습니다(미확인). 파일 `Last-Modified`가 11-24 12:00 KST인데, 서버가 버킷에서 복원한 시각일 수 있습니다.

### 오른쪽 Shopee: 실제로 들어가는 모양 (main 8bc6c6d, PR #39)

- 근거: `shared/clia-image-html.js`, `bulk-jobs.js`(`SHOPEE_MAX_IMAGES = 12`), `crawler-py/content_gen/pdp_summary.py`(`plain_text`).
- **Shopee 설명 칸은 HTML을 받지 않습니다.** 그래서 태국 제품은 맨 위에 요약을 **태그 없는 글**로 넣고, 빈 줄 하나 뒤에 이미지 주소를 한 줄에 하나씩 넣습니다.
  - 이미지는 **앞 12장**까지만 넣습니다.
  - 전체가 **3,000자**를 넘으면 뒤 이미지부터 뺍니다.
- 프리뷰도 이 규칙대로 계산했습니다. 요약 글은 `plain_text()`와 같은 모양으로 만들고, 넣지 않는 이미지는 흐리게 표시하며 「아래 n장은 Shopee 설명에 넣지 않음」 줄을 붙입니다.
  - SCQ13A: 13장 중 **11장**. 3,000자 한도 때문이고, 빠지는 2장이 스펙 표입니다.
  - OLED83G4PSA: 39장 중 **12장**.
- Lazada는 HTML이 들어가므로 요약 HTML과 이미지 전체가 그대로입니다.
- **미확인:** Shopee가 설명 안의 이미지 주소를 실제 화면에서 이미지로 보여 주는지, 주소 글자로 보여 주는지는 확인하지 못했습니다. 프리뷰는 이미지로 그렸고 머리글에 「이미지 주소 표시 방식 확인 전」이라고 적었습니다.

### 이전 작업에서 Shopee·Lazada 페이지 캡처 찾기 (결과: 없음)

다음 곳을 찾아봤지만 Shopee·Lazada 실제 상품 페이지 캡처는 없었습니다.

- clia-hub·clia-hub-temporary·clia-th-batch의 모든 브랜치: 파일 이름과 문서 내용. 이미지는 eBay 캡처와 이 목업 캡처뿐이었습니다.
- Slack, Google Drive.
- 팀 KB, 그리고 KB가 가리킨 「27년 운영방향 논의」 PPT(Airtable 문서): Shopee 리뷰 화면과 프로모션 배너만 있었습니다.
- 11-23 문서에도 「캡차에 막혀 기준 캡처가 없음, 장혁님 휴대폰 캡처가 오면 맞춤」이라고 적혀 있습니다.

## 아직 안 된 것 (사용자 요구, 2026-11-24)

- **LG.com은 LG.com 페이지 그대로:** 지금 왼쪽은 운영 저장본 섹션(이미지 + 텍스트)을 카드로 다시 짠 것이라 lg.com 화면 그대로가 아닙니다.
  - 운영 서버에 lg.com 전체 화면 캡처 기능이 있습니다(`GET /api/v1/fullshot?url=`로 있는지 확인, `GET /media/fullshot/<key>.jpg`로 읽기, `crawler-py/fullshot.py`, PC 1920px을 폭 960px로 저장). 이것을 쓰면 왼쪽을 lg.com 화면 그대로 보여 줄 수 있습니다.
  - 이 세션에서는 그 확인 요청이 권한 검사에서 막혀 아직 못 봤습니다. 없는 제품은 `POST /api/v1/fullshot`으로 새로 찍어야 하는데, 운영 서버에서 캡처 작업(Firecrawl 포함)이 돌기 때문에 승인이 필요합니다.
- **Shopee·Lazada 사이즈 그대로:** 실제 페이지(모바일 웹·PC 웹)의 상세 영역 폭을 재야 합니다. 사용자 컴퓨터에서 같이 보기로 했습니다.

## 파일

| 파일 | 내용 |
|---|---|
| [mockup-v9.html](./mockup-v9.html) | 인터랙티브 목업 (1.6MB). 이미지는 주소 직접 링크 — 인터넷 필요 |
| [collect_fullshots.py](./collect_fullshots.py) · [fullshots.json](./fullshots.json) | 운영에 있는 lg.com 전체 화면 캡처 조회 결과 (GET만) |
| [build_v9.py](./build_v9.py) | v7 HTML + `../v8/v8-sources.json` → `mockup-v9.html` (섹션 매칭은 `../v8/build_v8.py` 함수 재사용) |
| [capture_v9.js](./capture_v9.js) | 캡처 |
| [v9-match.json](./v9-match.json) | 제품별 슬라이스 장수·요약 유무·섹션 매칭 |

```bash
python3 -I build_v9.py --v7 <mockup-v7.html> --sources ../v8/v8-sources.json --logo ../../../../shared/assets/lg-logo.svg
```

```bash
node capture_v9.js mockup-v9.html .
```

## 캡처

캡처 속 **왼쪽 lg.com 이미지는 회색 「이미지를 불러오지 못함」 상자**입니다(이 환경의 헤드리스 Chromium이 lg.com에서 403). 오른쪽 운영 슬라이스와 목록 썸네일은 정상입니다.

| 파일 | 화면 |
|---|---|
| [list-v9.jpg](./list-v9.jpg) | 목록 — 썸네일이 상세 첫 슬라이스 |
| [compare-v9-shopee.jpg](./compare-v9-shopee.jpg) | IHQ18R Shopee (요약 없음 → 「요약 대기」) |
| [compare-v9-lazada-summary.jpg](./compare-v9-lazada-summary.jpg) | AS10GDBY0 Lazada — PDP 요약 + 슬라이스 |
| [compare-v9-sync.jpg](./compare-v9-sync.jpg) | F2515RNEW 섹션 동기 스크롤 |
| [compare-v9-no-blocks.jpg](./compare-v9-no-blocks.jpg) | OLED83G4PSA — 슬라이스 39장, 위치표 없음 |
| [compare-v9-zoom.jpg](./compare-v9-zoom.jpg) | MS2032GAS 1000px 확대 보기 |
| [compare-v9-lgcom-fullshot.jpg](./compare-v9-lgcom-fullshot.jpg) | A9-ACE — 왼쪽 lg.com 전체 화면 캡처 그대로 |
| [compare-v9-shopee-text.jpg](./compare-v9-shopee-text.jpg) | AS10GDBY0 Shopee — 요약을 태그 없는 글로 |
| [compare-v9-shopee-cut.jpg](./compare-v9-shopee-cut.jpg) | SCQ13A Shopee — 3,000자 한도로 마지막 2장(스펙 표) 빠짐 |

## 다음 (사용자와 같이)

사용자 컴퓨터에서 세션을 열고 LG 공식 스토어의 같은 모델(예: IHQ18R, AS10GDBY0) Shopee TH·Lazada TH 상품 페이지를 **모바일 웹과 PC 웹**으로 연 뒤, 상세 설명 영역의 폭·글자·이미지 이어 붙임·여백·요약 위치를 재서 프리뷰를 그대로 맞춥니다. 확인 전까지 v9의 프레임 폭(390px)·색·글자 크기는 v7 추정값입니다.

## 갤러리 조사 결과는 어디에

갤러리를 화면에서 뺐지만, v8에서 확인한 사실(덜 저장된 3건이 공백 잘림 → 404 탈락으로 설명됨, `SRCSET_FIX` 위치)은 [../v8/README.md](../v8/README.md)에 그대로 있습니다. 재크롤 여부 같은 질문도 크롤 품질 문제로는 여전히 남아 있습니다.
