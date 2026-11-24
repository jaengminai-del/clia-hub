# CLIA PDP 검토/승인 — 목업 v12 (갤러리 보기 · 한국어/영어/태국어)

2026-11-24 KST. **문서·목업만 있습니다. 병합·배포하지 마세요.** 데이터는 v11과 같습니다(`../v11/v11-sources.json`, TH 28개).

## v11에서 바뀐 것

- **리스트 / 갤러리 전환:** 벌크 엑셀 화면과 같은 낱말(리스트·갤러리 / List·Gallery / รายการ·แกลเลอรี)입니다.
  - 갤러리 카드: 상세 첫 장을 크게(높이 200px, 비율 그대로), 상태 배지, 모델·상품명, BU·제품군·상세 이미지 수, 체크리스트 진행, 빌더 다운로드(🔒 승인 전 / 열림).
- **전체 선택을 필터 줄로 옮김:** 리스트·갤러리 모두에서 쓰고, 지금 보이는(필터된) 제품만 고릅니다.
- **언어:** `?lang=th | en | ko` 또는 오른쪽 위 언어 선택으로 바꿉니다. 주소에 남아서 새로 고쳐도 유지됩니다.
  - 검수 메뉴가 th·sg 법인용이라(이전 결정) 태국어·영어, 그리고 본사 확인용 한국어를 넣었습니다. 독일어·아랍어는 넣지 않았습니다.
  - 화면 문구 95개를 세 언어 사전에 똑같이 넣었습니다(빠진 키가 없는지 `capture_v12.js`가 검사).
  - 제품군 이름은 벌크 엑셀(`bulk/bulk-i18n.js`)과 같은 낱말입니다(예: 냉장고 / Fridge / ตู้เย็น).
  - 태국어 화면은 본문 글꼴을 LINESeedSansTH로 바꿉니다.
  - 그대로 두는 것: 제품명·USP 이름·요약은 lg.com·CLIA 원문(태국어)이라 번역하지 않습니다. 마켓 머리글 「รายละเอียดสินค้า」도 실제 마켓 낱말이라 그대로입니다.
  - 버튼·배지·탭이 칸을 넘는 곳: 세 언어 모두 없음(자동 검사).
- 동시 스크롤·체크리스트·승인 규칙은 v11과 같습니다. v11 검사(`../v11/check_v11.js`)를 v12에 다시 돌려 위치 이동 0 · 스크롤 규칙 어긋남 0 · 비율 어긋남 0 확인(A9-ACE · OLED48C6PSA · GC-X257CMEW).
- 태국어 번역은 Claude가 썼고 태국 법인 확인 전입니다.

## 파일

| 파일 | 내용 |
|---|---|
| [mockup-v12.html](./mockup-v12.html) | 목업 (약 0.57MB). `?lang=th` · `?lang=en` · `?lang=ko` |
| [v12.template.html](./v12.template.html) | 화면 틀 (세 언어 사전 `TX` 포함) |
| [build_v12.py](./build_v12.py) | v11과 같은 빌드 (틀만 v12) |
| [capture_v12.js](./capture_v12.js) | 언어별 캡처 + 사전 키 검사 + 넘침 검사 |

```bash
python3 -I build_v12.py --sources ../v11/v11-sources.json --fonts ../../../../fonts --logo ../../../../shared/assets/lg-logo.svg
```

```bash
node capture_v12.js mockup-v12.html .
```

## 캡처 (1배 JPEG)

| | ไทย | English | 한국어 |
|---|---|---|---|
| 리스트 | [list-v12-th.jpg](./list-v12-th.jpg) | [list-v12-en.jpg](./list-v12-en.jpg) | [list-v12-ko.jpg](./list-v12-ko.jpg) |
| 갤러리 | [gallery-v12-th.jpg](./gallery-v12-th.jpg) | [gallery-v12-en.jpg](./gallery-v12-en.jpg) | [gallery-v12-ko.jpg](./gallery-v12-ko.jpg) |
| 갤러리 · HS 냉장고 필터 · 전체 선택 | [gallery-v12-th-filter-select.jpg](./gallery-v12-th-filter-select.jpg) | [gallery-v12-en-filter-select.jpg](./gallery-v12-en-filter-select.jpg) | [gallery-v12-ko-filter-select.jpg](./gallery-v12-ko-filter-select.jpg) |
| 비교 (A9-ACE, 체크리스트) | [compare-v12-th.jpg](./compare-v12-th.jpg) | [compare-v12-en.jpg](./compare-v12-en.jpg) | [compare-v12-ko.jpg](./compare-v12-ko.jpg) |
