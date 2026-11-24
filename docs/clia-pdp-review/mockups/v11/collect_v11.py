#!/usr/bin/env python3
"""목업 v11 입력 — v10 의 28개 제품에 체크리스트 재료와 슬라이스 크기를 더한다. 읽기(GET)만 한다.

  python3 -I collect_v11.py --v10 ../v10/v10-sources.json --batch-out <clia-th-batch>/out --cache <작업폴더> --out v11-sources.json

- 슬라이스 크기: 운영 /media/slices/<hash>/<file> 앞 16KB 만 GET(Range) 해서 JPEG 머리(SOF)에서 폭·높이를 읽는다.
  → 화면이 이미지를 받기 전에 자리를 정확히 잡아, 동시 스크롤 위치가 흔들리지 않게 한다.
- 슬라이스 alt: 배치 image-html.txt 의 <img alt="…"> (그 이미지에 든 섹션 글)
- 섹션 제목: 운영 GET /api/v1/products/<slug> 의 mirror.sections[].text 첫 「## 」 줄 (없으면 첫 줄)
  → 섹션 제목을 alt 에서 찾아 「상세 이미지 n 에서 볼 것」 목록을 만든다.
"""
import argparse, html, json, os, re, struct, subprocess, sys, time

API = 'https://clia-hub-production-699d.up.railway.app'


def norm(s):
    return re.sub(r'[\s​]+', '', s or '')


def jpeg_size(b):
    i = 2
    while i < len(b) - 9:
        if b[i] != 0xFF:
            i += 1; continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3):
            h, w = struct.unpack('>HH', b[i + 5:i + 9]); return w, h
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2; continue
        i += 2 + struct.unpack('>H', b[i + 2:i + 4])[0]
    return None


def get(url, out=None, rng=None, wait=0.25):
    args = ['curl', '-s', '-m', '30', '-w', '%{http_code}', '-o', out or '/dev/stdout']
    if rng: args += ['-r', rng]
    r = subprocess.run(args + [url], capture_output=True)
    time.sleep(wait)
    return r


def headings(sec):
    lines = [l.strip() for l in (sec.get('text') or '').split('\n') if l.strip()]
    hs = [l[3:] for l in lines if l.startswith('## ')]
    return hs or lines[:1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--v10', required=True)
    ap.add_argument('--batch-out', required=True)
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', default='v11-sources.json')
    a = ap.parse_args()
    os.makedirs(os.path.join(a.cache, 'api'), exist_ok=True)
    os.makedirs(os.path.join(a.cache, 'slicehead'), exist_ok=True)
    V10 = json.load(open(a.v10, encoding='utf-8'))
    out = []
    for p in V10['products']:
        slug = p['slug']
        # 슬라이스 alt
        t = open(os.path.join(a.batch_out, slug, 'shopee', 'image-html.txt'), encoding='utf-8').read()
        alts = {src: html.unescape(alt) for src, alt in re.findall(r'<img src="([^"]+/media/slices/[^"]+)" alt="([^"]*)"', t)}
        # 슬라이스 크기
        slices = []
        for src in p['slices']:
            f = os.path.join(a.cache, 'slicehead', re.sub(r'[^\w.-]', '_', src.split('/media/slices/')[1]))
            if not os.path.exists(f) or os.path.getsize(f) < 100:
                get(src, f, '0-16383')
            wh = jpeg_size(open(f, 'rb').read())
            if not wh:
                sys.exit(f'size not found: {src}')
            slices.append({'src': src, 'w': wh[0], 'h': wh[1], 'alt': alts.get(src, '')})
        # 섹션 제목 → 어느 슬라이스에 있나
        af = os.path.join(a.cache, 'api', slug + '.json')
        if not os.path.exists(af):
            r = get(f'{API}/api/v1/products/{slug}', af, wait=1.2)
        secs = (json.load(open(af, encoding='utf-8')).get('mirror') or {}).get('sections') or []
        per = [[] for _ in slices]
        unmatched = []
        last = 0
        for s in secs:
            disc = not (isinstance(s.get('order'), int) or str(s.get('order')).isdigit())
            hs = headings(s)
            if not hs:
                continue
            key = norm(hs[0])[:40]
            idx = next((i for i in range(last, len(slices)) if key and key in norm(slices[i]['alt'])), None)
            if idx is None:
                idx = next((i for i in range(len(slices)) if key and key in norm(slices[i]['alt'])), None)
            if idx is None:
                unmatched.append(hs[0][:60]); continue
            last = idx
            label = ('각주: ' if disc else '') + hs[0][:70]
            if label not in per[idx]:
                per[idx].append(label)
        out.append({**{k: p[k] for k in ('slug', 'url', 'model', 'title', 'fullshot', 'slicesSame', 'sum', 'sumText', 'shopeeN', 'shopeeChars')},
                    'slices': slices, 'sliceSections': per, 'unmatchedSections': unmatched})
        print(f"{p['model']:17} slices {len(slices):2} sections→slices {sum(len(x) for x in per):3} unmatched {len(unmatched)}", file=sys.stderr)
    json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M KST', time.gmtime(time.time() + 9 * 3600)),
               'products': out}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
