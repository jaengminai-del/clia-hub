#!/usr/bin/env python3
"""목업 v11 만들기 — 가벼운 단일 HTML (네트워크 안 씀)

  python3 -I build_v11.py --sources v11-sources.json --fonts <clia-hub>/fonts --logo <clia-hub>/shared/assets/lg-logo.svg \
      --template v11.template.html --out mockup-v11.html

- 글꼴은 LGEIHeadline Regular·SemiBold, LINESeedSansTH Regular·Bold 만 넣는다(약 100KB). LGEIText(벌당 약 580KB)는 뺀다.
- 이미지는 넣지 않고 운영 주소(/media/fullshot · /media/slices)를 화면이 보이는 근처에서만 읽는다.
- BU·제품군은 운영 규칙 그대로(bulk-catalog.js divOf/grpOf, clia/index.html 허브 목록 2단계 필터와 같음).
"""
import argparse, base64, json, os, re, sys

# ── bulk-catalog.js 와 같은 규칙 ──
CAT = [(r'tvs?[-_/]|oled|qned|stanbyme|lifestyle-(tvs|screens|ekranlar)', 'TV'), (r'soundbar|speaker|lautsprecher|audio', 'Audio'),
       (r'fridge|refrigerator|kuehl', 'Fridge'), (r'dishwasher', 'Dishwasher'), (r'wash|laundry|dryer|waesche', 'Washer'), (r'monitor', 'Monitor'),
       (r'laptop|gram', 'Laptop'), (r'microwave|cook|oven', 'Cooking'), (r'air|puricare|dehumid|condicionado', 'Air')]
DIV_ES = re.compile(r'(^|[^a-z])(aircon|air[-_ ]?condition\w*|air[-_ ]?purif\w*|puricare|dehumid\w*|air[-_ ]?solution\w*|air[-_ ]?care|klima\w*|luftreiniger|luftentfeuchter|condicionado|purificador)([^a-z]|$)', re.I)
DIV_MS = re.compile(r'(^|[^a-z])(tvs?|oled|qned|nanocell|stanbyme|lifestyle[-_ ]?(tvs|screens|ekranlar)|audio|soundbars?|sound[-_ ]?suite|speakers?|lautsprecher|xboom|xboombuds|earbuds|kopfhoerer|headphones?|tone[-_ ]?free|monitors?|monitore|laptops?|gram|notebooks?|it[-_ ]?products?|projectors?|beamer|cinebeam)([^a-z]|$)', re.I)


def classify(url):
    path = re.sub(r'^https?://[^/]+', '', url)
    segs = [s for s in path.split('/') if s]
    cat = next((c for r, c in CAT if re.search(r, url, re.I)), segs[1].replace('-', ' ').title() if len(segs) > 1 else '')
    sub = (segs[-2] if len(segs) >= 2 else segs[1]).replace('-', ' ').replace('_', ' ').title()
    k = ' '.join([cat, sub, path])
    dv = 'ES' if cat == 'Air' or DIV_ES.search(k) else ('MS' if DIV_MS.search(k) else 'HS')
    k = k.lower()
    if dv == 'ES':
        if re.search(r'dehumid|entfeuchter', k): return dv, 'Dehumidifier'
        if re.search(r'air[-_ ]?condition|aircon|klima|condicionado|split|heat[-_ ]?pump|waermepumpe|heizung', k): return dv, 'AC'
        if re.search(r'purif|puricare|luftreiniger|purificador', k): return dv, 'Purifier'
        return dv, 'AC'
    if dv == 'MS':
        if 'monitor' in k: return dv, 'Monitor'
        if re.search(r'laptop|gram|notebook', k): return dv, 'Laptop'
        if re.search(r'projector|beamer|cinebeam', k): return dv, 'Projector'
        if re.search(r'audio|soundbar|sound[-_ ]?suite|speaker|lautsprecher|xboom|earbuds|kopfhoerer|headphone|tone[-_ ]?free', k) and not re.search(r'tvs?[-_ ]?(und|and|&)?[-_ ]?soundbar|tvs?-soundbars', k):
            return dv, 'Audio'
        return dv, 'TV'
    if 'styler' in k: return dv, 'Styler'
    if re.search(r'dishwasher|geschirr|\bdw\b', k): return dv, 'Dishwasher'
    if re.search(r'vacuum|cordzero|staubsauger', k): return dv, 'Vacuum'
    if re.search(r'micro|mikrowell|cook|oven|backofen|range|hob|kochfeld', k): return dv, 'Cooking'
    if re.search(r'fridge|refrigerator|kuehl|kühl|freezer|kimchi', k): return dv, 'Fridge'
    pth = ' '.join([sub, path]).lower()
    if re.search(r'dryer|trockner', pth) and not re.search(r'washtower|waschtrockner|washers?[-_ ]?dryers?|wash[-_ ]?combo|washcombo', pth): return dv, 'Dryer'
    if re.search(r'wash|wasch|waesche|laundry', k): return dv, 'Washer'
    return dv, 'Other'


def spec_kinds(p):
    """USP 가 없는 상세 이미지 중 스펙 표 — alt 에 스펙 제목이 있거나, 바로 앞이 스펙 표인 이미지(표가 이어짐)."""
    out = []
    for i, s in enumerate(p['slices']):
        if p['sliceUsps'][i]:
            out.append(''); continue
        kv = len(re.findall(r':\s*(มี|ไม่มี|ใช่|ไม่|\d)', s['alt']))     # 「항목: 값」 줄 (스펙 표)
        if re.search(r'สเปค|ข้อมูลจำเพาะ|คุณลักษณะเด่น', s['alt']) or kv >= 3:
            out.append('spec')
        elif out and out[-1] in ('spec', 'spec+'):
            out.append('spec+')
        else:
            out.append('')
    return out


def lead(alt):
    """이미지 글(alt)의 첫머리 — USP 로 이름을 못 붙인 이미지의 이름. 첫 제목 줄이 보통 맨 앞에 온다."""
    t = re.sub(r'\s+', ' ', alt or '').strip()
    return (t[:38] + '…') if len(t) > 40 else t


def b64(path):
    return base64.b64encode(open(path, 'rb').read()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sources', required=True)
    ap.add_argument('--fonts', required=True)
    ap.add_argument('--logo', required=True)
    ap.add_argument('--template', default='v11.template.html')
    ap.add_argument('--out', default='mockup-v11.html')
    a = ap.parse_args()
    SRC = json.load(open(a.sources, encoding='utf-8'))
    DATA = []
    for p in SRC['products']:
        dv, grp = classify(p['url'])
        f = p['fullshot']
        DATA.append({
            'model': p['model'], 'title': p['title'], 'url': p['url'], 'dv': dv, 'grp': grp,
            'shot': {'src': f['src'], 'w': f['width'], 'h': f['height'], 'top': f['top'], 'bottom': f['bottom']},
            'slices': [[s['src'], s['w'], s['h']] for s in p['slices']],
            'usps': p['sliceUsps'], 'nUsp': len(p['usps']),
            'kind': spec_kinds(p),
            'lead': [lead(s['alt']) for s in p['slices']],
            'secs': p['sliceSections'],
            'sum': p['sum'], 'sumText': p['sumText'], 'shopeeN': p['shopeeN'], 'shopeeChars': p['shopeeChars'],
        })
    fonts = ''.join(
        f"@font-face{{font-family:'{fam}';src:url(data:font/woff2;base64,{b64(os.path.join(a.fonts, fn))}) format('woff2');font-weight:{w};font-display:swap}}"
        for fam, fn, w in [('LGEIHeadline', 'LGEIHeadlineTTF-Regular.woff2', 400), ('LGEIHeadline', 'LGEIHeadlineTTF-Semibold.woff2', 600),
                           ('LGEIHeadline', 'LGEIHeadlineTTF-Bold.woff2', 700),
                           ('LINESeedSansTH', 'LINESeedSansTH-Regular.woff2', 400), ('LINESeedSansTH', 'LINESeedSansTH-Bold.woff2', 700)])
    t = open(a.template, encoding='utf-8').read()
    t = t.replace('/*__FONTS__*/', fonts)
    t = t.replace('__LOGO__', 'data:image/svg+xml;base64,' + b64(a.logo))
    t = t.replace('__GENERATED__', SRC['generated_at'])
    t = t.replace('/*__DATA__*/[]', json.dumps(DATA, ensure_ascii=False, separators=(',', ':')))
    for k in ('/*__FONTS__*/', '__LOGO__', '/*__DATA__*/'):
        if k in t:
            sys.exit('placeholder left: ' + k)
    open(a.out, 'w', encoding='utf-8').write(t)
    print(f'{a.out}: {len(t)/1e3:.0f} KB, {len(DATA)} products', file=sys.stderr)


if __name__ == '__main__':
    main()
