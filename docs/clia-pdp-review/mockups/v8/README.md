# CLIA PDP 검토/승인 — 목업 v8

2026-11-24 KST. v7(`contentfactoryhsad-blip/clia-hub-temporary` 브랜치 `docs/clia-pdp-review`, 초안 PR #2)을 이어 만든 목업입니다.
**문서·목업만 있습니다. 운영 코드는 바꾸지 않았고, 병합·배포하지 마세요.** 운영 서버와 lg.com에는 GET만 보냈습니다.

「확인」은 이번에 직접 데이터로 본 것, 「미확인」은 아직 못 본 것, 「제안」은 결정이 필요한 것입니다.

## 파일

| 파일 | 내용 |
|---|---|
| [mockup-v8.html](./mockup-v8.html) | 인터랙티브 목업 (1.6MB, 글꼴 포함). 이미지는 lg.com·운영 슬라이스 주소를 **직접 링크** — 인터넷이 있어야 보입니다. |
| [collect_v8.py](./collect_v8.py) | 입력 모으기 (운영 API·lg.com GET, TH 배치 결과 파일 읽기) → `v8-sources.json` |
| [build_v8.py](./build_v8.py) | v7 HTML + `v8-sources.json` → `mockup-v8.html`, 섹션 매칭표 `v8-match.json` (네트워크 안 씀) |
| [capture_v8.js](./capture_v8.js) | Playwright 캡처 |
| [v8-sources.json](./v8-sources.json) | 13개 제품의 운영 저장본 요약(갤러리 주소, 섹션 텍스트·첫 이미지, 죽은 미디어), 라이브 장수, 슬라이스 주소 |
| [v8-match.json](./v8-match.json) | 왼쪽 원본: v7 섹션 ↔ 운영 `mirror.sections` 매칭 결과 |
| `*.jpg` | 화면 캡처 (아래, 1배 JPEG로 줄임) |

다시 만들기:

```bash
python3 -I collect_v8.py --cache <작업폴더> --batch-out <clia-th-batch 체크아웃>/out --out v8-sources.json
```

```bash
python3 -I build_v8.py --v7 <mockup-v7.html> --sources v8-sources.json --logo ../../../../shared/assets/lg-logo.svg
```

```bash
node capture_v8.js mockup-v8.html .
```

`--batch-out`은 `contentfactoryhsad-blip/clia-th-batch` 브랜치 `th-batch-results`의 `out/`입니다(`<slug>/{shopee,lazada}/image-html.txt`만 읽음).

## v8에서 바꾼 것

### 1. 갤러리 = 운영 저장본 그대로 (방 합의 규칙 1~4)

| 규칙 | 목업 동작 | 사례 |
|---|---|---|
| 운영 `mirror._gallery[].pc_url`을 그대로 보여 줌, 다시 읽어 채우지 않음 | 프리뷰 갤러리·썸네일·목록 카드 모두 저장본 주소 | 13개 전부 |
| 0장 | 승인 잠금, 빨간 배너 「승인 불가 — 갤러리 없음」, 승인 버튼 옆 「갤러리 없음」, 목록 카드 빨간 칩 | `gc-b257sqyl` |
| 저장 < 원본 페이지 | 승인 열어 둠, 노란 줄 「⚠ 갤러리 원본 n장 · 저장 m장」 + 목록 노란 칩 | `t2313vspm` 10→6, `oled83g4psa` 9→3 |
| 주소가 `%20(N)` | 목록 카드에만 회색 「재크롤 시 잘림 위험」, 승인 막지 않음 | `gc-b187jbam` (14장 모두 `%20(N)`) |

- 「원본 n장」은 오늘 lg.com 라이브 페이지를 `make_mirror.extract_gallery`와 같은 선택자로, 공백을 자르지 않고(`SRCSET_FIX=True`와 같게) 센 값입니다. 화면에 기준 시각을 같이 적었습니다.
- 「비율 조정됨」 태그는 v7처럼 미리 넣은 w/h가 아니라, 브라우저가 실제 이미지를 읽은 뒤 `naturalWidth ≠ naturalHeight`로 판단합니다.
- 마켓 장수 제한 표시(Shopee 9 / Lazada 8, 「기준 미확인」)는 v7 그대로입니다.

### 2. 실제 데이터로 교체

- **오른쪽 상세 슬라이스:** TH 배치 결과 `image-html.txt`에 있는 운영 주소 `…/media/slices/<hash>/slice-NN.jpg`를 그대로 씁니다. 13개 해시 모두 GET(첫 1KB) 206 확인. `POST /api/v1/slice-html`·`/api/render-slices`는 쓰지 않았습니다.
  - 확인: 13개 모두 **Shopee와 Lazada의 슬라이스가 같은 해시**입니다. 화면에 「Shopee·Lazada 같은 슬라이스」라고 적었습니다.
  - 확인: v7 10개의 슬라이스 장수 = 배치 결과 장수 (빌드에서 다르면 멈춤).
  - PDP 요약은 배치 `image-html.txt` 첫 줄(`lg-pdp-summary`) — v7에 있던 요약과 같은 내용.
- **왼쪽 원본 이미지:** 운영 `mirror.sections[].media[0].pc_url`. v7 섹션 텍스트와 맞춰서 붙였습니다(아래 「섹션 매칭」).
- **v7의 「승인 불가 — 대표 이미지 누락」(AS10GDBY0) 삭제.** 지어낸 예시였고, 운영 저장본은 갤러리 15장(라이브 15장)이라 v8 규칙으로는 막을 이유가 없습니다. 「미검토」로 바꿨습니다. v7은 이 제품을 14장으로 보였는데 운영 저장본은 15장입니다.
- **실제 사례 3개 추가:** `gc-b257sqyl`(0장), `t2313vspm`(6/10), `oled83g4psa`(3/9). 이 셋은 왼쪽 원본을 운영 저장본 섹션 그대로 만들었고(긴 스펙은 12줄 뒤 접음), 섹션 위치표가 없어 「섹션 위치표 없음 · 동기 스크롤 안 됨」으로 표시합니다.
- v7에서 `<style>` 주석 안에 들어가 **안 보이던 안내문**을 지우고, 화면 왼쪽 아래에 닫을 수 있는 안내(데이터 기준 시각 포함)로 옮겼습니다.
- 상단 LG 로고를 `shared/assets/lg-logo.svg`로 되돌렸습니다(v7 인수인계본은 1×1 자리 표시).
- v7 데이터 중 화면에서 쓰지 않던 `R[].html`(섹션별 결과 HTML)은 뺐습니다. 파일이 2.2MB → 1.6MB.
- 이미지를 못 읽으면 깨진 아이콘 대신 회색 상자 「이미지를 불러오지 못함 · 호스트」로 보입니다.

### v7에서 그대로 둔 것 (여전히 예시)

SKU(`예시`), 상태(승인·반려·수정요청), IHQ18R의 별표 경고와 「#5 빠짐」, 매칭 확인 토글, 2단계 요약 승인, 동기 스크롤 위치표(「추정」), Shopee/Lazada 프레임 모양은 v7과 같습니다. IHQ18R 「#5 빠짐」은 v6부터 내려온 예시이고, 실제 슬라이스 위치표에는 #5 블록이 있습니다(**미확인 예시**).

## 캡처

> 이 환경의 헤드리스 Chromium은 lg.com 이미지 요청에 **403**(`HeadlessChrome` 이름을 막는 것으로 보임)을 받아, **캡처 속 lg.com 이미지(갤러리·왼쪽 원본)는 회색 「이미지를 불러오지 못함」 상자**로 나옵니다. 운영 슬라이스(Railway)는 정상으로 보입니다. 일반 브라우저로 HTML을 열면 lg.com 이미지도 보일 것으로 예상하지만(curl GET은 206), 이 세션에서 일반 브라우저로 열어 확인하지는 못했습니다(**미확인**).

| 파일 | 화면 |
|---|---|
| [list-v8.jpg](./list-v8.jpg) | 목록 (13개, 갤러리 범례, 승인 2/13) |
| [list-v8-gallery-chips.jpg](./list-v8-gallery-chips.jpg) | 목록 카드의 갤러리 칩 3종 확대 |
| [compare-v8-gallery-none.jpg](./compare-v8-gallery-none.jpg) | `gc-b257sqyl` — 승인 잠금, 「갤러리 없음」 |
| [compare-v8-gallery-short.jpg](./compare-v8-gallery-short.jpg) | `t2313vspm` Shopee — 노란 경고 「원본 10장 · 저장 6장」, 승인 가능 |
| [compare-v8-gallery-short-lazada.jpg](./compare-v8-gallery-short-lazada.jpg) | `oled83g4psa` Lazada — 「원본 9장 · 저장 3장」 |
| [compare-v8-shopee.jpg](./compare-v8-shopee.jpg) | IHQ18R Shopee |
| [compare-v8-lazada.jpg](./compare-v8-lazada.jpg) | AS10GDBY0 Lazada (v7 「승인 불가」 → 미검토) |
| [compare-v8-gallery-dropped.jpg](./compare-v8-gallery-dropped.jpg) | F2515RNEW 10번째 사진 — 「마켓에서 빠짐 · 기준 미확인」 |
| [compare-v8-sync.jpg](./compare-v8-sync.jpg) | F2515RNEW 동기 스크롤 — 오른쪽 실제 슬라이스 |

## 이번에 새로 확인한 사실 (2026-11-24 11:35 KST 전후, GET만)

### 덜 저장된 3건은 「공백 잘림 → 같은 주소로 합쳐짐 → 404로 탈락」 산술이 정확히 맞음 (확인)

| 제품 | 경로 | 라이브 | 그중 공백 이름 | 공백에서 자르면 | 저장본 | 저장본 「죽은 미디어」에 잘린 주소 |
|---|---|---:|---:|---:|---:|---|
| `gc-b257sqyl` | `_aem_stats` | 11 | 11 | 1 | **0** | `…/GC-B257SQYL_1600` (404) |
| `t2313vspm` | `_aem_stats` | 10 | 4 | 7 | **6** | `…/T2313VSPM_1600` (404) |
| `oled83g4psa` | `_aem_stats` | 9 | 6 | 4 | **3** | `…/2024_65_G4_A_Wall` (404) |

- 저장본 `_dead_media_dropped`에 있는 주소가 **오늘 라이브의 공백 이름 파일들을 공백에서 자른 앞부분과 글자 그대로 같습니다.** 즉 크롤 당시에도 공백 이름이었고, 공백 이름 n장이 잘린 주소 1개로 합쳐진 뒤 404라 빠졌습니다. 세 제품 모두 「공백에서 자른 장수 − 1 = 저장 장수」.
- 인수인계 문서의 「크롤 이후 페이지가 바뀌었을 가능성(미확인)」은 이 세 건에 대해서는 거의 해소됐습니다. 다만 공백 이름이 아닌 사진이 그 사이 바뀌었는지는 여전히 미확인입니다.
- `gc-b187jbam`은 component-first 경로이고 저장본이 `%20(N)`로 14장 모두 살아 있습니다(죽은 미디어에 잘린 주소 없음).

### 그 밖

- `t2312vspb`·`t2313vspb`(저장 5 < 라이브 7)는 TH 배치 URL 목록(`urls_all.json` 540개)에 **없습니다.** 「검수 대상 = 배치 행」 규칙에 따라 목업 목록에 넣지 않았습니다.
- 10개 기존 제품은 모두 저장 = 라이브(인수인계 §3-3과 같음). AS10GDBY0만 v7의 14와 달리 15.
- 운영 목록 API가 11:3x KST에 한때 `count: 372`를 돌려주고 일부 상세가 404였다가, 몇 분 뒤 다시 558·200이 됐습니다. 원인(재시작 중 버킷 복원 등)은 **미확인**입니다. `/healthz`는 그때도 `ok:true`.

## 섹션 매칭 (왼쪽 원본 이미지)

`v8-match.json` 전체. 방법:

- `_aem_stats` 경로(IHQ18R, T2109NBTB): v7 `O.key` == `sections[].order`, `null` == `"n - disclaimer"`. 텍스트가 있는 섹션은 모두 텍스트도 일치.
- component-first 경로: 번호가 다르므로(예: F2515RNEW v7 12개 vs 저장본 27개) **v7 섹션 텍스트가 들어 있는 저장본 섹션을 순서를 지키며** 찾고, 텍스트가 없는 v7 섹션은 앞뒤로 맞춘 섹션 사이에 있는 「이미지만 있는 섹션」을 씁니다(`gap`). 이미지에 마우스를 올리면 어떤 방법으로 붙였는지 보입니다.

완전 일치가 아닌 것:

| 제품 | v7 섹션 → 저장본 order | 방법 |
|---|---|---|
| F2515RNEW | 2→2, 10→13 | 텍스트 1/3 |
| AS10GDBY0 | 4→7, 6→10 | 텍스트 2/3 |
| AS10GDBY0 | 9→14 | gap |
| A9-ACE | 1→1, 6→6 | gap |
| GC-B41FPGAM | 6→6 | 텍스트 2/3 |
| MS2032GAS | 1→1 | gap |
| RV10VHP2B | 9→10 | 텍스트 1/3 |
| SCQ13A | 1→1, 7→12, 17→23 | 텍스트 2/3 |
| SCQ13A | 2→4, 18→26 | gap |
| SCQ13A | **3 → 없음** | 텍스트 불일치 — 화면에 「원본 이미지 매칭 안 됨」 |

부분 일치는 v7 섹션이 저장본 섹션 2~3개(아이콘 그리드 등)를 묶은 경우로 보이지만, 사람이 눈으로 확인하지는 않았습니다(**미확인**).

## 장혁님께 남은 질문 (README 6개 + 인수인계 2개에 더해)

1. `gc-b257sqyl`·`t2313vspm`·`oled83g4psa`를 SL 경로(`SRCSET_FIX=True`)로 재크롤해 고칠지, 승인 화면 경고·잠금으로만 둘지. (인수인계 질문 — 원인이 위 표처럼 거의 확정됨)
2. `component_parser.py`의 `SRCSET_FIX`도 기본값 유지(SL만 켬)로 둘지. (인수인계 질문)
3. 「재크롤 시 잘림 위험」을 목록에만 둘지, 비교 화면에도 작게 보일지. 방 합의는 「목록에만」이라 그대로 뒀습니다(**제안**: 비교 화면 식별 줄에도 회색 칩).
4. 「원본 n장」을 승인 화면이 어디서 가져올지. 목업은 오늘 라이브를 미리 센 값입니다. 실제 화면에서 매번 lg.com을 읽으면 규칙 1(다시 읽어 채우지 않음)과 부딪히므로, **제안**: 크롤할 때 「라이브 갤러리 장수(공백 유지)」를 저장본에 같이 남기고 그 값과 비교.

## 이 PR에 넣지 않은 것

- 운영 API 원본 JSON·lg.com 페이지 HTML (작업 폴더 캐시). `v8-sources.json`에 필요한 필드만 남김.
- v7 HTML·PNG (원래 자리: `clia-hub-temporary` 초안 PR #2).
- 운영 코드 수정, `SRCSET_FIX` 변경 — 하지 않음.
