#!/usr/bin/env python3
"""목업 v8 입력 모으기 — 읽기 전용(GET)만 한다.

  python3 -I collect_v8.py --cache <작업폴더> --batch-out <clia-th-batch/out> --out v8-sources.json

- 운영 제품 API  GET {API}/api/v1/products/<slug>   (1.2초 간격, 캐시 있으면 다시 안 받음)
- lg.com 라이브 페이지 GET                          (1.5초 간격, 캐시 있으면 다시 안 받음)
- TH 배치 결과 out/<slug>/{shopee,lazada}/image-html.txt  (로컬 파일, clia-th-batch 브랜치 th-batch-results)

쓰지 않는 것: POST /api/v1/slice-html, /api/render-slices (운영에서 렌더가 돈다).
결과 v8-sources.json 은 목업에 필요한 필드만 남긴 작은 파일이다(원본 덤프는 넣지 않음).
"""
import argparse, json, os, re, subprocess, sys, time
from urllib.parse import unquote

API = 'https://clia-hub-production-699d.up.railway.app'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'

# 목업에 올릴 제품 (배치 행에 있는 것만). 앞 10개 = v7 그대로, 뒤 3개 = v8에서 추가한 실제 사례.
SLUGS = [
    'www-lg-com-th-air-conditioner-inverter-air-conditioner-with-air-purifier-ihq18r',
    'www-lg-com-th-laundry-front-load-washing-machine-f2515rnew',
    'www-lg-com-th-laundry-top-load-washing-machine-t2109nbtb',
    'www-lg-com-th-air-puricare-puricare-360-as10gdby0',
    'www-lg-com-th-vacuum-cleaner-cordless-vacuum-cleaner-a9-ace',
    'www-lg-com-th-refrigerators-multi-door-refrigerator-gc-b41fpgam',
    'www-lg-com-th-microwave-ovens-solo-microwave-ms2032gas',
    'www-lg-com-th-refrigerators-side-by-side-refrigerator-gc-b187jbam',
    'www-lg-com-th-laundry-dryer-rv10vhp2b',
    'www-lg-com-th-air-conditioner-inverter-wifi-air-air-conditioner-scq13a',
    'www-lg-com-th-refrigerators-side-by-side-refrigerator-gc-b257sqyl',   # 갤러리 0장
    'www-lg-com-th-laundry-top-load-washing-machine-t2313vspm',            # 저장 6 < 원본 10
    'www-lg-com-th-tv-soundbars-oled-oled83g4psa',                         # 저장 3 < 원본 9
]


def get(url, out, wait):
    if os.path.exists(out) and os.path.getsize(out) > 0:
        return 'cache'
    for _ in range(3):
        r = subprocess.run(['curl', '-s', '-L', '-A', UA, '-o', out, '-w', '%{http_code}', url], capture_output=True, text=True)
        time.sleep(wait)
        if r.stdout == '200':
            return '200'
    os.remove(out) if os.path.exists(out) else None
    return r.stdout or 'ERR'


# ── 라이브 갤러리 장수: crawler-py/make_mirror.py extract_gallery 와 같은 선택자 ──
def live_gallery(html, split):
    from bs4 import BeautifulSoup
    gal = BeautifulSoup(html, 'html.parser').select_one('.c-gallery')
    if not gal:
        return None
    by, seq = {}, []
    for it in gal.select('.c-gallery__item--display-image'):
        sl = it if it.has_attr('data-swiper-slide-index') else it.find_parent(attrs={'data-swiper-slide-index': True})
        idx = sl.get('data-swiper-slide-index') if sl is not None else None
        img = it.find('img'); src = (img.get('src') or img.get('data-src') or '') if img else ''
        if not src:
            for so in it.find_all('source'):
                src = (so.get('srcset') or so.get('data-srcset') or '').split(',')[0]
                if src:
                    break
        src = src.strip()
        # split=True  → SRCSET_FIX=False 기본 규칙(공백에서 자름)
        # split=False → SRCSET_FIX=True (pdp_pipeline_sl.py 만 켬): 끝의 " 1600w" 만 뗌
        src = src.split(' ')[0] if split else re.sub(r'\s+\d+(\.\d+)?[wx]\s*$', '', src)
        if not src or src.startswith('data:'):
            continue
        (by.setdefault(int(idx), src) if idx is not None else seq.append(src))
    urls = [by[k] for k in sorted(by)] if by else seq
    seen, out = set(), []
    for u in urls:
        k = re.sub(r'\?.*$', '', unquote(u))
        if k not in seen:
            seen.add(k); out.append(u)
    return out


def media0(sec):
    for m in sec.get('media') or []:
        if m.get('type', 'image') == 'image' and m.get('pc_url'):
            return m['pc_url']
    return None


def batch_channel(path):
    if not os.path.exists(path):
        return None
    lines = open(path, encoding='utf-8').read().split('\n')
    summary = lines[0] if lines and 'lg-pdp-summary' in lines[0] else None
    slices = re.findall(r'<img src="(https://[^"]+/media/slices/[0-9a-f]+/[^"]+)"', '\n'.join(lines))
    return {'summary': summary, 'slices': slices}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--batch-out', required=True)
    ap.add_argument('--out', default='v8-sources.json')
    a = ap.parse_args()
    os.makedirs(os.path.join(a.cache, 'api'), exist_ok=True)
    os.makedirs(os.path.join(a.cache, 'live'), exist_ok=True)
    res = []
    for slug in SLUGS:
        f = os.path.join(a.cache, 'api', slug + '.json')
        st = get(f'{API}/api/v1/products/{slug}', f, 1.2)
        j = json.load(open(f, encoding='utf-8'))
        m = j.get('mirror') or {}
        lf = os.path.join(a.cache, 'live', slug + '.html')
        lst = get(j['url'], lf, 1.5)
        html = open(lf, encoding='utf-8', errors='replace').read()
        full, cut = live_gallery(html, False), live_gallery(html, True)
        dead = [d.get('url') for d in (m.get('_dead_media_dropped') or [])]
        trunc = sorted({u.split(' ')[0] for u in (full or []) if ' ' in unquote(u)})
        gallery = [g['pc_url'] for g in (m.get('_gallery') or []) if g.get('pc_url')]
        res.append({
            'slug': slug, 'url': j['url'], 'title': j.get('title'), 'crawled_at': j.get('crawled_at'),
            'mirror_path': 'aem' if '_aem_stats' in m else 'component-first' if '_cf_stats' in m else 'unknown',
            'mirror_note': m.get('note'),
            'gallery': gallery,
            'gallery_pct20_paren': sum(1 for u in gallery if re.search(r'%20\(\d+\)', u)),
            'dead_media': dead,
            'qa': (m.get('_qa') or {}),
            'live': {
                'checked_at': time.strftime('%Y-%m-%d %H:%M KST', time.gmtime(os.path.getmtime(lf) + 9 * 3600)),
                'count': None if full is None else len(full),
                'count_split': None if cut is None else len(cut),
                'spaced': sum(1 for u in (full or []) if ' ' in unquote(u)),
                # 공백에서 잘린 주소가 저장본의 죽은 미디어(404) 목록에 그대로 있는지
                'trunc_in_dead': [any(d.endswith(t) for d in dead) for t in trunc],
            },
            'sections': [{'order': s.get('order'), 'text': (s.get('text') or '')[:4000], 'img': media0(s),
                          'layout': s.get('layout_type'), 'n_media': len(s.get('media') or [])}
                         for s in m.get('sections') or []],
            'batch': {ch: batch_channel(os.path.join(a.batch_out, slug, ch, 'image-html.txt')) for ch in ('shopee', 'lazada')},
        })
        r = res[-1]
        print(f"{st:>5} {lst:>5} {slug[-24:]:24} {r['mirror_path']:15} 저장 {len(gallery):2} 원본 {r['live']['count']} "
              f"(공백자름 {r['live']['count_split']}) %20(N) {r['gallery_pct20_paren']} 슬라이스 {len((r['batch']['shopee'] or {}).get('slices', []))}",
              file=sys.stderr)
    json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M KST', time.gmtime(time.time() + 9 * 3600)), 'api': API,
               'products': res}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
