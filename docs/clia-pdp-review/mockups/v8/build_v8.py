#!/usr/bin/env python3
"""목업 v8 만들기 — v7 HTML + v8-sources.json → mockup-v8.html (네트워크 안 씀)

  python3 -I build_v8.py --v7 <mockup-v7.html> --sources v8-sources.json --logo <clia-hub>/shared/assets/lg-logo.svg \
      --out mockup-v8.html --report v8-match.json

v7 HTML 은 contentfactoryhsad-blip/clia-hub-temporary 브랜치 docs/clia-pdp-review 의
docs/clia-pdp-review/mockups/mockup-v7.html (이미지를 1×1 자리 표시로 바꾼 인수인계본).

v8 에서 바뀌는 것
- 갤러리 = 운영 저장본 mirror._gallery[].pc_url 그대로 (lg.com 주소 직접 링크, data URI 없음)
- 0장 → 승인 잠금 「갤러리 없음」 / 저장 < 원본 → 노란 경고 「원본 n장 · 저장 m장」(승인 가능)
  / 주소가 %20(N) → 목록에만 회색 「재크롤 시 잘림 위험」
- 왼쪽 원본 이미지 = mirror.sections[].media[0].pc_url (v7 섹션과 텍스트로 맞춤, 결과는 --report)
- 오른쪽 상세 = TH 배치 결과 image-html.txt 의 운영 슬라이스 주소 (/media/slices/<hash>/<file>, GET 만)
- v7 의 AS10GDBY0 「승인 불가 — 대표 이미지 누락」(지어낸 예시) 제거, 실제 사례 3개 추가
- v7 에서 <style> 주석 안에 들어가 안 보이던 안내문을 화면에 보이는 안내로 옮김
"""
import argparse, base64, json, re, sys

V7_FABRICATED_BLOCK = 'AS10GDBY0'
NEW_SKU = {'GC-B257SQYL': 'GC-B257SQYL', 'T2313VSPM': 'T2313VSPM', 'OLED83G4PSA': 'OLED83G4PSA'}


def norm(s):
    return re.sub(r'[\s​]+', '', s or '')


def is_int_order(o):
    return isinstance(o, int) or (isinstance(o, str) and o.isdigit())


def match_sections(p7, src):
    """v7 O[] ↔ 운영 mirror.sections[] 맞추기. 반환: [(o, sec_index|None, method)]"""
    secs = src['sections']
    out = []
    if src['mirror_path'] == 'aem':
        # 페이지 컴포넌트 모델 경로: v7 O.key == sections[].order (null == "n - disclaimer")
        by = {str(s['order']): i for i, s in enumerate(secs)}
        disc = [i for i, s in enumerate(secs) if not is_int_order(s['order'])]
        di = 0
        for o in p7['O']:
            if o['key'] is None:
                i = disc[di] if di < len(disc) else None; di += 1
            else:
                i = by.get(str(o['key']))
            txt = [t for t in o['h'] + o['p'] if norm(t)]
            if i is not None and txt:
                hit = sum(1 for t in txt if norm(t) in norm(secs[i]['text']))
                out.append((o, i, 'order+text' if hit == len(txt) else f'order(텍스트 {hit}/{len(txt)})'))
            else:
                out.append((o, i, 'order' if i is not None else 'none'))
        return out
    # component-first 경로: 번호가 다르므로 텍스트로 맞추고 순서를 지킨다
    res = [None] * len(p7['O'])
    prev = -1
    for k, o in enumerate(p7['O']):
        txt = [t for t in o['h'] + o['p'] if norm(t)]
        if not txt:
            continue
        sc = [(sum(1 for t in txt if norm(t) in norm(s['text'])), i) for i, s in enumerate(secs)]
        best = max(h for h, _ in sc)
        if best == 0:
            res[k] = (None, 'none(텍스트 불일치)')
            continue
        after = [i for h, i in sc if h == best and i > prev]
        i = after[0] if after else [i for h, i in sc if h == best][0]
        res[k] = (i, ('text' if best == len(txt) else f'text {best}/{len(txt)}') + ('' if after else ' · 순서 역전'))
        prev = max(prev, i)
    used = {r[0] for r in res if r and r[0] is not None}
    for k, o in enumerate(p7['O']):
        if res[k] is not None:
            continue
        lo = max([res[j][0] for j in range(k) if res[j] and res[j][0] is not None] or [-1])
        hi = min([res[j][0] for j in range(k + 1, len(res)) if res[j] and res[j][0] is not None] or [len(secs)])
        cand = [i for i in range(lo + 1, hi) if i not in used and secs[i]['img'] and not norm(secs[i]['text'])]
        if cand:
            res[k] = (cand[0], 'gap(앞뒤 사이 이미지만 있는 섹션)'); used.add(cand[0])
        else:
            res[k] = (None, 'none')
    return [(o, r[0], r[1]) for o, r in zip(p7['O'], res)]


def sections_to_O(src):
    """v8 에서 추가한 제품: 운영 저장본 섹션을 그대로 왼쪽 원본으로."""
    O = []
    for s in src['sections']:
        h, ps = [], []
        for ln in (s['text'] or '').split('\n'):
            ln = ln.strip()
            if not ln:
                continue
            if ln.startswith('## '):
                h.append(ln[3:])
            else:
                ps.append(re.sub(r'^(#+|-)\s*', '', ln))
        if len(ps) > 12:
            ps = ps[:12] + [f'… {len(ps) - 12}줄 더 (저장본 원문)']
        disc = not is_int_order(s['order'])
        O.append({'key': None if disc else int(s['order']), 'disc': disc, 'h': h, 'p': ps,
                  'img': s['img'], 'video': False, 'src': 'mirror'})
    return O


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--v7', required=True)
    ap.add_argument('--sources', required=True)
    ap.add_argument('--logo', required=True)
    ap.add_argument('--out', default='mockup-v8.html')
    ap.add_argument('--report', default='v8-match.json')
    a = ap.parse_args()

    lines = open(a.v7, encoding='utf-8').read().split('\n')
    di = next(i for i, l in enumerate(lines) if l.startswith('const DATA='))
    V7 = json.loads(re.match(r'\s*const DATA=(.*);\s*$', lines[di]).group(1))
    SRC = json.load(open(a.sources, encoding='utf-8'))
    by_slug = {p['slug']: p for p in SRC['products']}
    v7_by_slug = {p['slug']: p for p in V7}

    DATA, report = [], []
    for src in SRC['products']:
        slices = (src['batch']['shopee'] or {}).get('slices') or []
        lz = (src['batch']['lazada'] or {}).get('slices') or []
        live = src['live']
        gal = {'stored': len(src['gallery']), 'live': live['count'], 'split': live['count_split'],
               'spaced': live['spaced'], 'pct': src['gallery_pct20_paren'], 'path': src['mirror_path'],
               'checked': live['checked_at'], 'truncDead': any(live['trunc_in_dead']),
               'crawled': src['crawled_at']}
        p7 = v7_by_slug.get(src['slug'])
        if p7:
            p = {k: v for k, v in p7.items() if k not in ('gallery', 'galleryDropped', 'thumb', 'slices', 'sum', 'summary', 'R')}   # R(섹션별 결과 HTML)는 화면에서 안 씀
            O = []
            mrep = []
            for o, i, how in match_sections(p7, src):
                o = dict(o)
                o['img'] = src['sections'][i]['img'] if i is not None else None
                o['imgHow'] = how
                O.append(o)
                mrep.append({'v7_key': o['key'], 'text': ((o['h'] + o['p'] or [''])[0])[:40],
                             'mirror_order': src['sections'][i]['order'] if i is not None else None, 'how': how,
                             'img': (o['img'] or '').rsplit('/', 1)[-1][:80]})
            p['O'] = O
            if p['model'] == V7_FABRICATED_BLOCK and p.get('st') == 'block':
                p['st'] = 'unrev'   # v7 지어낸 「대표 이미지 누락」 제거
            if len(slices) != p7.get('sliceCount', len(p7['slices'])):
                sys.exit(f"slice count mismatch {p['model']}: batch {len(slices)} vs v7 {p7.get('sliceCount')}")
        else:
            model = src['url'].rstrip('/').rsplit('/', 1)[-1].upper()   # …/gc-b257sqyl/ → GC-B257SQYL
            p = {'slug': src['slug'], 'model': model, 'title': src['title'], 'st': 'unrev',
                 'blocks': [], 'blockNote': '섹션 위치표 없음 — v8에서 추가한 제품이라 위치표를 만들지 않았음', 'sliceH': []}
            p['O'] = sections_to_O(src)
            mrep = [{'v7_key': None, 'how': 'mirror.sections 그대로', 'n': len(p['O'])}]
        p['gallery'] = [{'src': u} for u in src['gallery']]
        p['thumb'] = src['gallery'][0] if src['gallery'] else None
        p['slices'] = slices
        p['slicesSame'] = slices == lz
        p['sum'] = (src['batch']['shopee'] or {}).get('summary')
        p['summary'] = p['sum']
        p['gal'] = gal
        p['url'] = src['url']
        p['v8new'] = not p7
        DATA.append(p)
        report.append({'model': p['model'], 'slug': src['slug'], 'mirror_path': src['mirror_path'],
                       'gallery': gal, 'slices': len(slices), 'sections': mrep})

    # ── HTML ──
    html = lines[:]
    html[di] = 'const DATA=' + json.dumps(DATA, ensure_ascii=False) + ';'
    text = '\n'.join(html)

    def rep(old, new, count=1):
        nonlocal text
        n = text.count(old)
        if n != count:
            sys.exit(f'replace target found {n}x (want {count}): {old[:80]!r}')
        text = text.replace(old, new)

    rep('<title>CLIA · 검토/승인 — 목업 v7</title>', '<title>CLIA · 검토/승인 — 목업 v8</title>')
    # v7: 안내문이 <style> 안 CSS 주석 속에 들어가 안 보였다 → 지우고 화면 안내로 옮김
    text, n = re.subn(r'\n<div style="position:sticky;top:0;z-index:9999;[^\n]*?</div>', '', text, count=1)
    if n != 1:
        sys.exit('v7 hidden notice not found')
    logo = 'data:image/svg+xml;base64,' + base64.b64encode(open(a.logo, 'rb').read()).decode()
    rep('<div class="tb-logo"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="LG">',
        f'<div class="tb-logo"><img src="{logo}" alt="LG">')

    css = """
/* ── v8 ── */
.gchips{display:flex;flex-wrap:wrap;gap:4px}
.gchip{display:inline-block;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:600;white-space:nowrap;cursor:help}
.gchip.none{background:#FDE8E7;color:#C8241F}.gchip.short{background:#FFF3C4;color:#7A5A00}.gchip.risk{background:var(--clia-gray-100);color:var(--clia-gray-500)}
.gwarn{flex:none;display:flex;align-items:center;gap:10px;padding:8px 24px;background:#FFF3C4;border-top:1px solid #EBD27A;color:#5C4400;font-size:13px;font-weight:600}
.gwarn small{font-weight:500;color:#7A5A00}
.glegend{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:8px 16px 0;font-size:11.5px;color:var(--clia-gray-500)}
.card .empty-gallery{height:150px;border-radius:10px;background:#FDE8E7;color:#C8241F;font-weight:700;flex-direction:column;gap:2px;text-align:center}
.card .empty-gallery small{font-weight:500;font-size:11px}
.market-gallery .empty-gallery{height:100%;flex-direction:column;gap:4px;background:#FDE8E7;color:#C8241F;font-weight:700;text-align:center}
.market-gallery .empty-gallery small{font-weight:500;font-size:12px;color:#9B3B37}
.imgfail{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:100%;min-height:72px;background:var(--clia-gray-100);color:var(--clia-gray-500);font-size:11px;font-weight:600;text-align:center;line-height:1.3}.imgfail small{font-weight:400;font-size:10px;color:var(--clia-gray-400)}.card .imgfail{height:150px;border-radius:10px}.os .imgfail{height:140px}.market-gallery .imgfail{position:absolute;inset:0;height:auto}.thumb .imgfail{min-height:0;height:100%;font-size:0}.thumb .imgfail small{display:none}.thumb .imgfail::after{content:'✕';font-size:12px}
.os .nomatch{display:block;padding:8px 16px;font-size:11px;color:var(--clia-gray-400);background:var(--clia-gray-50);border-bottom:1px dashed var(--clia-gray-200)}
.slices img{height:auto}/* width·height 속성은 자리만 잡고 비율은 이미지 그대로 */
.v8note{position:fixed;left:80px;bottom:12px;z-index:50;max-width:560px;background:#1F1E1C;color:#fff;border-radius:12px;padding:10px 36px 10px 14px;font-size:12px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.v8note b{color:#FFD86B}.v8note button{position:absolute;top:6px;right:8px;background:none;border:0;color:#fff;font-size:14px;cursor:pointer}
"""
    rep('</style></head>', css + '</style></head>')

    note = ('<div class="v8note" id="v8note"><b>목업 v8</b> · 갤러리·원본 이미지는 lg.com, 상세 슬라이스는 운영 '
            '<code>/media/slices/</code> 주소를 직접 읽습니다(인터넷 필요, 읽기만). 가격·판매자는 자리 표시. '
            'SKU는 <i>예시</i>. 데이터 기준: 운영 저장본 ' + SRC['generated_at'] + ' 조회.'
            '<button onclick="this.parentElement.remove()" title="닫기">✕</button></div>')
    rep('<div class="toast" id="toast"></div>', note + '<div class="toast" id="toast"></div>')

    # 목록 범례
    rep('<div class="grid" id="grid"></div>',
        '<div class="glegend"><b>갤러리</b><span class="gchip none">갤러리 없음</span>승인 잠금'
        '<span class="gchip short">원본 n장 · 저장 m장</span>경고만, 승인 가능'
        '<span class="gchip risk">재크롤 시 잘림 위험</span>표시만</div><div class="grid" id="grid"></div>')
    # 비교 화면: 노란 갤러리 경고 줄
    rep('<div class="rvban" id="ban" hidden></div>', '<div class="rvban" id="ban" hidden></div><div class="gwarn" id="gwarn" hidden></div>')

    # 상태 초기화: 갤러리 규칙
    rep("p.block=p.st==='block'?'대표 이미지 누락':'';",
        "p.block=p.gallery.length?'':'갤러리 없음';if(p.block)p.st='block';"
        "p.gshort=p.gal.live!=null&&p.gallery.length>0&&p.gallery.length<p.gal.live;p.grisk=p.gal.pct>0;")
    rep("const SKU={", "const SKU={" + ','.join(f"'{k}':'{v}'" for k, v in NEW_SKU.items()) + ",")

    # 목록 카드: 갤러리 칩
    rep("${p.thumb?`<img src=\"${p.thumb}\" alt=\"${esc(p.model)}\">`:`<div class=\"empty-gallery\">갤러리 미확보</div>`}${identity(p)}<div>${badge(p)}</div></div>`",
        "${p.thumb?`<img src=\"${p.thumb}\" alt=\"${esc(p.model)}\">`:`<div class=\"empty-gallery\">갤러리 없음<small>운영 저장본 0장</small></div>`}${identity(p)}<div>${badge(p)}</div>${gchips(p)}</div>`")
    rep("function sel(i,on){",
        "function gchips(p){const g=p.gal,c=[];"
        "if(!p.gallery.length)c.push(`<span class=\"gchip none\" title=\"운영 저장본 _gallery 0장 — 승인 잠금\">갤러리 없음</span>`);"
        "if(p.gshort)c.push(`<span class=\"gchip short\" title=\"lg.com ${esc(g.checked)} 기준 원본 ${g.live}장 · 운영 저장본 ${g.stored}장\">원본 ${g.live}장 · 저장 ${g.stored}장</span>`);"
        "if(p.grisk)c.push(`<span class=\"gchip risk\" title=\"저장 주소가 %20(N) 형태 ${g.pct}장 — 지금은 열리지만, 기본 설정(SRCSET_FIX=False)으로 다시 크롤하면 공백에서 잘려 ${g.split}장으로 줄어듦\">재크롤 시 잘림 위험</span>`);"
        "return c.length?`<div class=\"gchips\">${c.join('')}</div>`:'';}\n"
        "function ratioCheck(img){const t=document.getElementById('ratioTag');if(t)t.hidden=!(img.naturalWidth&&img.naturalWidth!==img.naturalHeight);}\n"
        "document.addEventListener('error',e=>{const t=e.target;if(!t||t.tagName!=='IMG')return;let h='';try{h=new URL(t.src).host}catch(_){}"
        "const d=document.createElement('div');d.className='imgfail';d.title=t.src;d.innerHTML='이미지를 불러오지 못함<small>'+esc(h)+'</small>';t.replaceWith(d);},true);\n"
        "function sel(i,on){")

    # 프리뷰 갤러리: 0장 문구, 비율 태그는 실제 이미지 크기로
    rep("${g?`<img src=\"${g.src}\" alt=\"${esc(p.model)}\">`:'<div class=\"empty-gallery\">갤러리 미확보</div>'}",
        "${g?`<img src=\"${g.src}\" alt=\"${esc(p.model)}\" onload=\"ratioCheck(this)\">`:'<div class=\"empty-gallery\">갤러리 없음<small>운영 저장본 _gallery 0장 · 승인 잠금</small></div>'}")
    rep("${g.w!==g.h?'<span class=\"ratio-tag\">비율 조정됨 · 기준 미확인</span>':''}",
        "<span class=\"ratio-tag\" id=\"ratioTag\" hidden>비율 조정됨 · 기준 미확인</span>")

    # 상세 슬라이스: 운영 주소, 크기 미리 잡기
    rep("<span>상세 이미지 ${p.slices.length}장</span>",
        "<span>상세 이미지 ${p.slices.length}장${p.slicesSame?' · Shopee·Lazada 같은 슬라이스':''}</span>")
    rep("<img src=\"${src}\" alt=\"상세 이미지 ${i+1}\">",
        "<img src=\"${src}\" alt=\"상세 이미지 ${i+1}\" width=\"1000\" ${p.sliceH[i]?`height=\"${p.sliceH[i]}\"`:''}>")

    # 위치표 없는 제품
    rep("' 상품 페이지 <span class=\"badge b-q pos-note\" title=\"'+esc(p.blockNote)+'\">섹션 위치표 · 추정</span>'",
        "' 상품 페이지 <span class=\"badge b-q pos-note\" title=\"'+esc(p.blockNote)+'\">'+(p.blocks.length?'섹션 위치표 · 추정':'섹션 위치표 없음 · 동기 스크롤 안 됨')+'</span>'")
    rep("const p=cur(),stack=$('pR').querySelector('.slices');if(!stack)return;",
        "const p=cur(),stack=$('pR').querySelector('.slices');if(!stack||!p.blocks.length)return;")

    # 왼쪽 원본: 이미지 매칭 안 된 섹션 표시
    rep("${o.img?`<img src=\"${o.img}\" alt=\"\">`:''}",
        "${o.img?`<img src=\"${o.img}\" alt=\"\" title=\"${esc(o.imgHow||'운영 저장본')}\">`:(o.imgHow&&o.imgHow.startsWith('none')&&!o.disc?'<span class=\"nomatch\">원본 이미지 매칭 안 됨 (v8 빌드)</span>':'')}")

    # 비교 화면: 승인 잠금 이유 + 노란 경고
    rep("const why=p.block?'승인 불가 항목 있음'", "const why=p.block?p.block")
    rep("  $('ban').hidden=!p.block;",
        "  {const g=p.gal,w=$('gwarn');w.hidden=!p.gshort;w.innerHTML=p.gshort?`⚠ 갤러리 원본 ${g.live}장 · 저장 ${g.stored}장 <small>운영 저장본을 그대로 보여 줍니다 · 승인 가능 · lg.com ${esc(g.checked)} 기준${g.truncDead?` · 공백 이름 ${g.spaced}장이 잘린 주소 1개로 합쳐져 404로 빠진 흔적`:''}</small>`:'';}\n  $('ban').hidden=!p.block;")

    open(a.out, 'w', encoding='utf-8').write(text)
    json.dump(report, open(a.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{a.out}: {len(text)/1e6:.2f} MB, {len(DATA)} products', file=sys.stderr)
    for r in report:
        how = {}
        for s in r['sections']:
            how[s['how'].split('(')[0].split(' ')[0]] = how.get(s['how'].split('(')[0].split(' ')[0], 0) + 1
        print(f"  {r['model']:12} {r['mirror_path']:15} 갤러리 {r['gallery']['stored']}/{r['gallery']['live']} 슬라이스 {r['slices']:2} 매칭 {how}", file=sys.stderr)


if __name__ == '__main__':
    main()
