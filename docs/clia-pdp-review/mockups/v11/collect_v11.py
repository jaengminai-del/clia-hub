#!/usr/bin/env python3
"""목업 v11 입력 — v10 의 28개 제품에 체크리스트 재료와 슬라이스 크기를 더한다. 읽기(GET)만 한다.

  python3 -I collect_v11.py --v10 ../v10/v10-sources.json --batch-out <clia-th-batch>/out --cache <작업폴더> --out v11-sources.json

- 슬라이스 크기: 운영 /media/slices/<hash>/<file> 앞 16KB 만 GET(Range) 해서 JPEG 머리(SOF)에서 폭·높이를 읽는다.
  → 화면이 이미지를 받기 전에 자리를 정확히 잡아, 동시 스크롤 위치가 흔들리지 않게 한다.
- 슬라이스 alt: 배치 image-html.txt 의 <img alt="…"> (그 이미지에 든 섹션 글)
- 섹션 제목: 운영 GET /api/v1/products/<slug> 의 mirror.sections[].text 첫 「## 」 줄 (없으면 첫 줄)
  → 섹션 제목을 alt 에서 찾아 「상세 이미지 n 에서 볼 것」 목록을 만든다.
- USP 이름: 운영 코드 crawler-py/content_gen/pdp_summary.py 의 usp_list(mirror) 그대로 (--crawler-py 로 그 폴더를 줌).
  PDP 요약의 「จุดเด่นสินค้า」와 같은 목록. 이름을 alt 에서 순서대로 찾아 각 상세 이미지의 체크리스트 이름으로 쓴다.
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
    ap.add_argument('--crawler-py', required=True, help='clia-hub crawler-py 폴더 (usp_list 를 불러옴)')
    a = ap.parse_args()
    os.makedirs(os.path.join(a.cache, 'api'), exist_ok=True)
    os.makedirs(os.path.join(a.cache, 'slicehead'), exist_ok=True)
    V10 = json.load(open(a.v10, encoding='utf-8'))
    sys.path.insert(0, os.path.abspath(a.crawler_py))
    from content_gen.pdp_summary import usp_list
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
        # USP → 슬라이스 (순서 유지, 못 찾으면 전체에서 한 번 더)
        # alt 는 이미지마다 앞 250자에서 잘려 있다 → alt 에서 못 찾은 USP 는 어느 이미지의 「뒷부분」에 있다.
        #   USP 순서는 lg.com 과 같으므로, 앞뒤로 찾은 USP 사이(앞 USP 의 이미지 ~ 뒤 USP 이미지 바로 앞)에 있다.
        #   그 범위가 한 장이면 확정, 여러 장이면 앞쪽 이미지로 두고 「추정」 표시.
        usps = usp_list((json.load(open(af, encoding='utf-8')).get('mirror') or {}))
        # 순서를 지키면서(이미지 번호가 줄지 않게) 가장 많은 USP 가 alt 에 맞는 배치를 고른다 (동적 계획법)
        cands = [[i for i in range(len(slices)) if norm(u['title'])[:40] and norm(u['title'])[:40] in norm(slices[i]['alt'])] for u in usps]
        best = {-1: (0, [])}                            # 마지막으로 고른 이미지 번호 → (맞은 수, 배치)
        for k, cs in enumerate(cands):
            nxt = {key: (n, path + [None]) for key, (n, path) in best.items()}
            for c in cs:
                prev = max(((n, path) for key, (n, path) in best.items() if key <= c), key=lambda x: x[0], default=None)
                if prev and (c not in nxt or prev[0] + 1 > nxt[c][0]):
                    nxt[c] = (prev[0] + 1, prev[1] + [c])
            best = nxt
        found = max(best.values(), key=lambda x: x[0])[1] if usps else []
        sliceUsps, uspMiss = [[] for _ in slices], []
        for k, u in enumerate(usps):
            t = u['title'][:80]
            if found[k] is not None:
                sliceUsps[found[k]].append({'t': t}); continue
            lo = next((found[j] for j in range(k - 1, -1, -1) if found[j] is not None), 0)
            hi = next((found[j] for j in range(k + 1, len(usps)) if found[j] is not None), len(slices))
            hi = max(lo, hi - 1) if hi > lo else lo        # 뒤 USP 이미지의 앞 250자에는 없으니 그 앞 장까지
            if not slices:
                uspMiss.append(t); continue
            sliceUsps[lo].append({'t': t, 'est': hi > lo, 'range': [lo + 1, hi + 1]})
        out.append({'usps': [u['title'][:80] for u in usps], 'sliceUsps': sliceUsps, 'uspMiss': uspMiss,
                    'uspNotInAlt': sum(1 for x in found if x is None), **{k: p[k] for k in ('slug', 'url', 'model', 'title', 'fullshot', 'slicesSame', 'sum', 'sumText', 'shopeeN', 'shopeeChars')},
                    'slices': slices, 'sliceSections': per, 'unmatchedSections': unmatched})
        print(f"{p['model']:17} slices {len(slices):2} sections→slices {sum(len(x) for x in per):3} unmatched {len(unmatched)} · USP {len(usps)} (alt 에 없음 {sum(1 for x in found if x is None)}, 추정 {sum(1 for L in sliceUsps for x in L if x.get('est'))})", file=sys.stderr)
    json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M KST', time.gmtime(time.time() + 9 * 3600)),
               'products': out}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
