#!/usr/bin/env python3
"""목업 v10 입력 — lg.com 전체 화면 캡처와 CLIA 결과가 둘 다 있는 TH 제품만 모은다. 읽기(GET)만 한다.

  python3 -I collect_v10.py --scan fullshot_scan.jsonl --batch-out <clia-th-batch>/out \
      --products-list products_th.json --cache <작업폴더> --out v10-sources.json

입력
- --scan: TH 배치 URL(urls_all.json 540개)마다 GET /api/v1/fullshot?url= 결과를 한 줄씩 (scan_fullshots.py)
- --batch-out: clia-th-batch 브랜치 th-batch-results 의 out/ (<slug>/{shopee,lazada}/image-html.txt)
- --products-list: 운영 GET /api/v1/products?country=th 응답 (제목)
받는 것: GET /media/fullshot/<key>.jpg (크기와 PDP 시작 위치를 재려고. 결과 파일엔 주소만 남김)

PDP 끝(bottom): 리뷰 섹션 제목 「รีวิวจากผู้ใช้สินค้า」 위치 − 16px (스펙 카드와 「ดูสเปคทั้งหมด」 링크 아래).
  제목은 모든 캡처에서 같은 글꼴·크기·x 위치라, A9-ACE 캡처에서 자른 견본(review-heading-template.png, 220×40)을
  x 96~150 · y 전체에서 정규화 상관으로 찾는다(2배 축소). 28개 모두 상관 0.85 이상, 눈 확인 결과 모두 맞음.
PDP 시작 위치(top): 캡처(폭 960px)에서 갤러리 아래 앵커 탭 바(คุณสมบัติ·สเปค·รีวิว)를 찾고,
그 아래 빈 띠 뒤 처음 무늬가 생기는 행 − 16px. 행별 밝기 분산으로 재고 오른쪽 채팅 아이콘 영역(x>880)은 뺀다.
탭 바 바로 아래에 추천 액세서리·프로모션 띠가 있는 페이지는 사람이 보고 OVERRIDE 에 적는다.
"""
import argparse, io, json, os, re, subprocess, sys, time
from urllib.parse import unquote

API = 'https://clia-hub-production-699d.up.railway.app'
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'v9'))
from build_v9 import summary_text, shopee_cut  # noqa: E402

# 시작선 주변을 사람이 눈으로 보고 뺀 캡처 {model: 이유} — 2026-11-24 확인
EXCLUDE = {m: '캡처에 기능 섹션이 없음 (탭 바 아래가 바로 스펙 요약) — 지연 로드가 안 찍힌 것으로 보임, CLIA 슬라이스와 비교 불가'
           for m in ('IAQ13G1', 'SEQ18A', 'ISC10E', 'RV09VHP4W1', '27G850A-B-ATM', 'OLED65G4PSA', '55QNED86TSA')}
EXCLUDE.update({m: '캡처가 제품 페이지가 아님 — lg.com 메인(프로모션) 화면이 찍힘'
                for m in ('65UR7550PSC', 'OLED65G4PSA-B187')})

# 사람이 확인해 고친 시작 위치 {model: (top, 이유)}
OVERRIDE = {
    'RV10VHP2B': (976, '탭 바 아래 추천 액세서리·프로모션 띠(저장본 섹션에 없음)를 건너뜀'),
    # 탭 바 바로 아래에서 검은 배경 섹션이 시작해 자동 감지가 첫 제목을 자름 → 탭 바 밑부터
    '98NU855BPSB': (488, '탭 바 바로 아래 검은 섹션 — 탭 바 밑부터'),
    '65QNED70BSA': (488, '탭 바 바로 아래 검은 섹션 — 탭 바 밑부터'),
    'OLED42C6PSA-GRAB': (488, '탭 바 바로 아래 섹션 — 탭 바 밑부터'),
}


def slug_of(url):
    return url.replace('https://', '').replace('http://', '').rstrip('/').replace('/', '-').replace('.', '-')


def row_stats(im, y, x1=880):
    px = [im.getpixel((x, y)) for x in range(0, x1, 4)]
    m = sum(px) / len(px)
    return m, sum((p - m) ** 2 for p in px) / len(px)


def pdp_top(im):
    """갤러리(흰 바탕) 끝 → 베이지 띠 → 탭 글자 → 밑줄 → 빈 띠 → 첫 내용."""
    w, h = im.size
    y = 300
    # 1) 탭 바: y≥300 에서 흰(≥250) 줄이 끝나고 베이지(<250, 분산≈0)가 8줄 이어지는 곳
    while y < min(h - 10, 2200):
        if all(row_stats(im, y + k)[0] < 250 and row_stats(im, y + k)[1] < 5 for k in range(8)) and row_stats(im, y - 1)[0] >= 250:
            break
        y += 1
    else:
        return None, 'tab bar not found'
    band = y
    # 2) 탭 글자·밑줄(띠 시작 + 40px 안) 지나 분산 0 이 12줄 이어진 뒤 처음 분산≥5
    y = band + 40
    quiet = 0
    beige = row_stats(im, band + 2)[0]
    while y < min(h - 1, band + 1200):
        mean, v = row_stats(im, y)
        if v < 5 and abs(mean - beige) < 6:   # 빈 띠 = 탭 바와 같은 베이지 (검은 배경 섹션은 빈 줄로 치지 않음)
            quiet += 1
        elif quiet >= 12:   # 빈 띠 뒤 처음으로 무늬가 생기는 줄 (분산 ≥5)
            return max(0, y - 16), f'tab band {band}, first content {y}'
        else:
            quiet = 0
        y += 1
    return None, f'no content after tab band {band}'


TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'review-heading-template.png')


def pdp_bottom(img, top, tmpl, xs=range(96, 150, 2), ds=2):
    import numpy as np
    from numpy.lib.stride_tricks import sliding_window_view
    g = np.asarray(img.convert('L'), dtype=np.float32)[::ds, ::ds]
    t = tmpl[::ds, ::ds]; th, tw = t.shape
    t = (t - t.mean()) / (t.std() + 1e-6)
    y_from = top + 300
    best = (-1.0, None)
    for x in xs:
        col = g[y_from // ds:, x // ds:x // ds + tw]
        if col.shape[1] < tw or col.shape[0] < th:
            continue
        win = sliding_window_view(col, (th, tw))[:, 0]
        score = ((win - win.mean(axis=(1, 2))[:, None, None]) * t).mean(axis=(1, 2)) / (win.std(axis=(1, 2)) + 1e-6)
        i = int(score.argmax())
        if score[i] > best[0]:
            best = (float(score[i]), y_from + i * ds)
    if best[0] < 0.8:
        return None, f'review heading not found (best {best[0]:.2f})'
    return best[1] - 16, f'review heading at {best[1]} (corr {best[0]:.3f})'


def main():
    from PIL import Image
    ap = argparse.ArgumentParser()
    ap.add_argument('--scan', required=True)
    ap.add_argument('--batch-out', required=True)
    ap.add_argument('--products-list', required=True)
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', default='v10-sources.json')
    a = ap.parse_args()
    os.makedirs(os.path.join(a.cache, 'fullshot'), exist_ok=True)
    titles = {p['slug']: p for p in json.load(open(a.products_list, encoding='utf-8'))['products']}
    scan = [json.loads(l) for l in open(a.scan, encoding='utf-8')]
    ready = [s for s in scan if s.get('status') == 'ready']
    out, skipped = [], []
    for s in ready:
        slug = slug_of(s['url'])
        model = s['url'].rstrip('/').rsplit('/', 1)[-1].upper()
        if model in EXCLUDE:
            skipped.append((slug, EXCLUDE[model]))
            continue
        b = {}
        for ch in ('shopee', 'lazada'):
            f = os.path.join(a.batch_out, slug, ch, 'image-html.txt')
            if os.path.exists(f):
                lines = open(f, encoding='utf-8').read().split('\n')
                b[ch] = {'summary': lines[0] if lines and 'lg-pdp-summary' in lines[0] else None,
                         'slices': re.findall(r'<img src="(https://[^"]+/media/slices/[0-9a-f]+/[^"]+)"', '\n'.join(lines))}
        if not b.get('shopee') or not b['shopee']['slices']:
            skipped.append((slug, 'CLIA 결과(배치 슬라이스) 없음'))
            continue
        fp = os.path.join(a.cache, 'fullshot', s['key'] + '.jpg')
        if not os.path.exists(fp):
            r = subprocess.run(['curl', '-s', '-o', fp, '-w', '%{http_code}', API + s['src']], capture_output=True, text=True)
            time.sleep(1.2)
            if r.stdout != '200':
                skipped.append((slug, f'캡처 GET {r.stdout}'))
                continue
        im = Image.open(fp).convert('L')
        if model in OVERRIDE:
            top, how = OVERRIDE[model][0], '수동: ' + OVERRIDE[model][1]
        else:
            top, how = pdp_top(im)
        if top is None:
            skipped.append((slug, 'PDP 시작 위치 못 찾음: ' + how))
            continue
        import numpy as np
        bottom, bhow = pdp_bottom(im, top, np.asarray(Image.open(TEMPLATE).convert('L'), dtype=np.float32))
        if bottom is None:
            skipped.append((slug, 'PDP 끝 못 찾음: ' + bhow))
            continue
        t = titles.get(slug, {})
        sumhtml = b['shopee']['summary']
        txt = summary_text(sumhtml)
        n, chars = shopee_cut(txt, b['shopee']['slices'])
        nsg, _ = shopee_cut(None, b['shopee']['slices'])
        out.append({
            'slug': slug, 'url': s['url'], 'model': s['url'].rstrip('/').rsplit('/', 1)[-1].upper(),
            'title': t.get('title') or slug, 'crawled_at': t.get('crawled_at'),
            'fullshot': {'src': API + s['src'], 'key': s['key'], 'width': im.size[0], 'height': im.size[1], 'top': top, 'topHow': how, 'bottom': bottom, 'bottomHow': bhow},
            'slices': b['shopee']['slices'], 'slicesSame': b['shopee']['slices'] == (b.get('lazada') or {}).get('slices'),
            'sum': sumhtml, 'sumText': txt, 'shopeeN': n, 'shopeeChars': chars, 'shopeeNsg': nsg,
        })
        print(f"{out[-1]['model']:16} {im.size[0]}x{im.size[1]} top {top:5} bottom {bottom:6} ({how} / {bhow}) slices {len(b['shopee']['slices']):2} sum {bool(sumhtml)}", file=sys.stderr)
    json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M KST', time.gmtime(time.time() + 9 * 3600)),
               'scanned': len(scan), 'fullshot_ready': len(ready), 'products': out,
               'skipped': [{'slug': s, 'why': w} for s, w in skipped]},
              open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'scanned {len(scan)} · fullshot ready {len(ready)} · used {len(out)} · skipped {len(skipped)}', file=sys.stderr)


if __name__ == '__main__':
    main()
