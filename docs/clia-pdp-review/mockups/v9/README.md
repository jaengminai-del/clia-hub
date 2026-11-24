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

## 파일

| 파일 | 내용 |
|---|---|
| [mockup-v9.html](./mockup-v9.html) | 인터랙티브 목업 (1.6MB). 이미지는 주소 직접 링크 — 인터넷 필요 |
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
| [list-v9.png](./list-v9.png) | 목록 — 썸네일이 상세 첫 슬라이스 |
| [compare-v9-shopee.png](./compare-v9-shopee.png) | IHQ18R Shopee (요약 없음 → 「요약 대기」) |
| [compare-v9-lazada-summary.png](./compare-v9-lazada-summary.png) | AS10GDBY0 Lazada — PDP 요약 + 슬라이스 |
| [compare-v9-sync.png](./compare-v9-sync.png) | F2515RNEW 섹션 동기 스크롤 |
| [compare-v9-no-blocks.png](./compare-v9-no-blocks.png) | OLED83G4PSA — 슬라이스 39장, 위치표 없음 |
| [compare-v9-zoom.png](./compare-v9-zoom.png) | MS2032GAS 1000px 확대 보기 |

## 다음 (사용자와 같이)

사용자 컴퓨터에서 세션을 열고 LG 공식 스토어의 같은 모델(예: IHQ18R, AS10GDBY0) Shopee TH·Lazada TH 상품 페이지를 **모바일 웹과 PC 웹**으로 연 뒤, 상세 설명 영역의 폭·글자·이미지 이어 붙임·여백·요약 위치를 재서 프리뷰를 그대로 맞춥니다. 확인 전까지 v9의 프레임 폭(390px)·색·글자 크기는 v7 추정값입니다.

## 갤러리 조사 결과는 어디에

갤러리를 화면에서 뺐지만, v8에서 확인한 사실(덜 저장된 3건이 공백 잘림 → 404 탈락으로 설명됨, `SRCSET_FIX` 위치)은 [../v8/README.md](../v8/README.md)에 그대로 있습니다. 재크롤 여부 같은 질문도 크롤 품질 문제로는 여전히 남아 있습니다.
