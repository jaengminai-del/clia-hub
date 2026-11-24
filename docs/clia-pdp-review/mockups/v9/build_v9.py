#!/usr/bin/env python3
"""목업 v9 만들기 — 갤러리를 완전히 빼고 상세(PDP)만 비교 (네트워크 안 씀)

  python3 -I build_v9.py --v7 <mockup-v7.html> --sources ../v8/v8-sources.json \
      --logo <clia-hub>/shared/assets/lg-logo.svg --out mockup-v9.html --report v9-match.json

v8 과 같은 입력(v7 HTML + v8-sources.json)을 쓰고, 왼쪽 원본 매칭은 v8 build_v8.py 함수를 그대로 쓴다.

v9 에서 바뀌는 것 (2026-11-24 사용자 결정: 「갤러리는 필요 없고 PDP 페이지가 핵심」, 갤러리는 완전히 뺌)
- 오른쪽 프리뷰 = 상세 설명(PDP) 영역만: 요약(TH) + 운영 슬라이스. 갤러리·가격·판매자·스펙·하단 구매 바 자리 표시 삭제
- 갤러리 승인 규칙(0장 잠금, 원본/저장 경고, %20(N) 칩)과 마켓 장수 제한 표시 삭제
- 목록 썸네일 = 상세 첫 슬라이스(위쪽)
- Shopee·Lazada 실제 페이지(모바일 웹·PC 웹) 모양 맞추기는 사용자와 실제 페이지를 같이 본 뒤로 미룸
"""
import argparse, base64, html as _html, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'v8'))
from build_v8 import match_sections, sections_to_O, V7_FABRICATED_BLOCK, NEW_SKU  # noqa: E402

SHOPEE_MAX_IMAGES = 12      # bulk-jobs.js SHOPEE_MAX_IMAGES (main 8bc6c6d)
SHOPEE_DESC_LIMIT = 3000    # shared/clia-image-html.js: 설명 한도 3,000자를 넘으면 뒤 이미지부터 뺀다


def summary_text(h):
    """요약 HTML(content_gen/pdp_summary.py to_html) → 같은 파일 plain_text() 와 같은 글.
    to_html: h2 제품명, p 소개, h3 「จุดเด่นสินค้า」, li…, h3 「ข้อมูลสินค้า」, li… → plain_text: 줄바꿈 + 빈 줄 + '• ' 목록"""
    if not h:
        return None
    t = lambda x: _html.unescape(re.sub(r'<[^>]+>', '', x)).strip()
    name = t(re.search(r'<h2[^>]*>(.*?)</h2>', h, re.S).group(1))
    intro = t(re.search(r'<p[^>]*>(.*?)</p>', h, re.S).group(1))
    heads = [t(x) for x in re.findall(r'<h3[^>]*>(.*?)</h3>', h, re.S)]
    lists = [[t(li) for li in re.findall(r'<li[^>]*>(.*?)</li>', ul, re.S)] for ul in re.findall(r'<ul[^>]*>(.*?)</ul>', h, re.S)]
    out = [name, '', intro, '', heads[0]] + ['• ' + x for x in lists[0]] + ['', heads[1]] + ['• ' + x for x in lists[1]]
    return '\n'.join(out)


def shopee_cut(text, urls):
    """clia-image-html.js build(urlsOnly): 요약 글 + 빈 줄 + 이미지 주소 앞 12장, 3,000자 넘으면 뒤 이미지부터 뺌"""
    top = (text.strip() + '\n\n') if text else ''
    u = urls[:SHOPEE_MAX_IMAGES]
    while len(u) > 1 and len(top + '\n'.join(u)) > SHOPEE_DESC_LIMIT:
        u.pop()
    return len(u), len(top + '\n'.join(u))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--v7', required=True)
    ap.add_argument('--sources', required=True)
    ap.add_argument('--logo', required=True)
    ap.add_argument('--fullshots', default='fullshots.json')
    ap.add_argument('--out', default='mockup-v9.html')
    ap.add_argument('--report', default='v9-match.json')
    a = ap.parse_args()

    lines = open(a.v7, encoding='utf-8').read().split('\n')
    di = next(i for i, l in enumerate(lines) if l.startswith('const DATA='))
    V7 = json.loads(re.match(r'\s*const DATA=(.*);\s*$', lines[di]).group(1))
    SRC = json.load(open(a.sources, encoding='utf-8'))
    v7_by_slug = {p['slug']: p for p in V7}
    FS = json.load(open(a.fullshots, encoding='utf-8')) if os.path.exists(a.fullshots) else {'products': {}}

    DATA, report = [], []
    for src in SRC['products']:
        slices = (src['batch']['shopee'] or {}).get('slices') or []
        lz = (src['batch']['lazada'] or {}).get('slices') or []
        p7 = v7_by_slug.get(src['slug'])
        if p7:
            p = {k: v for k, v in p7.items()
                 if k not in ('gallery', 'galleryDropped', 'thumb', 'slices', 'sum', 'summary', 'R')}
            O, mrep = [], []
            for o, i, how in match_sections(p7, src):
                o = dict(o)
                o['img'] = src['sections'][i]['img'] if i is not None else None
                o['imgHow'] = how
                O.append(o)
                mrep.append({'v7_key': o['key'], 'mirror_order': src['sections'][i]['order'] if i is not None else None, 'how': how})
            p['O'] = O
            if p['model'] == V7_FABRICATED_BLOCK and p.get('st') == 'block':
                p['st'] = 'unrev'   # v7 지어낸 「대표 이미지 누락」 제거
            if len(slices) != p7.get('sliceCount', len(p7['slices'])):
                sys.exit(f"slice count mismatch {p['model']}")
        else:
            p = {'slug': src['slug'], 'model': src['url'].rstrip('/').rsplit('/', 1)[-1].upper(), 'title': src['title'],
                 'st': 'unrev', 'blocks': [], 'sliceH': [],
                 'blockNote': '섹션 위치표 없음 — v8에서 추가한 제품이라 위치표를 만들지 않았음'}
            p['O'] = sections_to_O(src)
            mrep = [{'how': 'mirror.sections 그대로', 'n': len(p['O'])}]
        p['slices'] = slices
        p['slicesSame'] = slices == lz
        p['thumb'] = slices[0] if slices else None
        p['sum'] = (src['batch']['shopee'] or {}).get('summary')
        p['summary'] = p['sum']
        p['url'] = src['url']
        p['sumText'] = summary_text(p['sum'])
        p['shopeeN'], p['shopeeChars'] = shopee_cut(p['sumText'], slices)
        p['shopeeNsg'], _ = shopee_cut(None, slices)          # 싱가포르: 요약 없이 이미지 주소만
        fs = FS['products'].get(src['slug']) or {}
        p['fullshot'] = {k: fs[k] for k in ('src', 'width', 'height')} if fs.get('status') == 'ready' and fs.get('width') else None
        DATA.append(p)
        report.append({'model': p['model'], 'slug': src['slug'], 'slices': len(slices), 'summary': bool(p['sum']),
                       'shopee_images': p['shopeeN'], 'shopee_chars': p['shopeeChars'], 'fullshot': bool(p['fullshot']), 'sections': mrep})

    html = lines[:]
    html[di] = 'const DATA=' + json.dumps(DATA, ensure_ascii=False) + ';'
    text = '\n'.join(html)

    def rep(old, new, count=1):
        nonlocal text
        n = text.count(old)
        if n != count:
            sys.exit(f'replace target found {n}x (want {count}): {old[:90]!r}')
        text = text.replace(old, new)

    rep('<title>CLIA · 검토/승인 — 목업 v7</title>', '<title>CLIA · 검토/승인 — 목업 v9</title>')
    text, n = re.subn(r'\n<div style="position:sticky;top:0;z-index:9999;[^\n]*?</div>', '', text, count=1)
    if n != 1:
        sys.exit('v7 hidden notice not found')
    logo = 'data:image/svg+xml;base64,' + base64.b64encode(open(a.logo, 'rb').read()).decode()
    rep('<div class="tb-logo"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="LG">',
        f'<div class="tb-logo"><img src="{logo}" alt="LG">')

    css = """
/* ── v9: 상세(PDP)만 ── */
.card img.pdp-thumb{object-fit:contain;object-position:center;background:#fff;border:1px solid var(--clia-gray-200)}
.card .empty-gallery{height:150px;border-radius:10px;background:var(--clia-gray-100);color:var(--clia-gray-500)}
.phone.pdp-only{background:#fff}
.pdp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;font-size:13px;font-weight:700;color:#222;border-bottom:1px solid #eee}
.pdp-head span{white-space:nowrap}.pdp-head small{white-space:nowrap;font-weight:500;font-size:11px;color:#9e9e9e;text-align:right}
.phone.shopee .pdp-head{box-shadow:inset 3px 0 0 #EE4D2D}.phone.lazada .pdp-head{box-shadow:inset 3px 0 0 #F57224}
.phone.pdp-only .description{padding-top:10px}
.imgfail{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:100%;min-height:72px;background:var(--clia-gray-100);color:var(--clia-gray-500);font-size:11px;font-weight:600;text-align:center;line-height:1.3}
.imgfail small{font-weight:400;font-size:10px;color:var(--clia-gray-400)}
.card .imgfail{height:150px;border-radius:10px}.os .imgfail{height:140px}
.os .nomatch{display:block;padding:8px 16px;font-size:11px;color:var(--clia-gray-400);background:var(--clia-gray-50);border-bottom:1px dashed var(--clia-gray-200)}
.slices img{height:auto}
.fullshot img{width:100%;height:auto;display:block}.fullshot{background:#fff}
.ohsw{display:inline-flex;gap:4px;margin-left:8px}.ohsw button{border:1px solid var(--clia-gray-200);background:#fff;border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;color:var(--clia-gray-500)}.ohsw button.on{background:var(--clia-gray-900);color:#fff;border-color:var(--clia-gray-900)}
.ohnote{font-size:11px;color:var(--clia-gray-400);font-weight:500;margin-left:8px}
.shopee-text{white-space:pre-wrap;font:14px/1.55 Roboto,"Helvetica Neue",Helvetica,Arial,"LINESeedSansTH",sans-serif;color:#222;margin:0;padding:4px 0 10px}
.desc-head{flex-wrap:wrap}.desc-head h3{white-space:nowrap}.desc-head span{white-space:normal}.pdp-head small{white-space:normal}\n.slice.cut{opacity:.35}.cutnote{padding:10px 12px;font-size:12px;color:#757575;background:#fafafa;border-top:1px dashed #ddd;border-bottom:1px dashed #ddd}/* width·height 속성은 자리만 잡고 비율은 이미지 그대로 */
.v8note{position:fixed;left:80px;bottom:12px;z-index:50;max-width:560px;background:#1F1E1C;color:#fff;border-radius:12px;padding:10px 36px 10px 14px;font-size:12px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.v8note b{color:#FFD86B}.v8note button{position:absolute;top:6px;right:8px;background:none;border:0;color:#fff;font-size:14px;cursor:pointer}
"""
    rep('</style></head>', css + '</style></head>')
    note = ('<div class="v8note" id="v8note"><b>목업 v9</b> · 갤러리를 빼고 상세(PDP)만 비교합니다. 왼쪽 원본 이미지는 lg.com, '
            '오른쪽 상세는 운영 <code>/media/slices/</code> 주소를 직접 읽습니다(인터넷 필요, 읽기만). '
            'Shopee·Lazada 실제 페이지 모양은 아직 대조 전. SKU는 <i>예시</i>. 데이터 기준: 운영 저장본 ' + SRC['generated_at'] + ' 조회.'
            '<button onclick="this.parentElement.remove()" title="닫기">✕</button></div>')
    rep('<div class="toast" id="toast"></div>', note + '<div class="toast" id="toast"></div>')

    # 갤러리 기반 승인 불가 없음 (v7 지어낸 예시 포함)
    rep("p.block=p.st==='block'?'대표 이미지 누락':'';", "p.block='';")
    rep("const SKU={", "const SKU={" + ','.join(f"'{k}':'{v}'" for k, v in NEW_SKU.items()) + ",")

    # 목록 썸네일 = 상세 첫 슬라이스
    rep("${p.thumb?`<img src=\"${p.thumb}\" alt=\"${esc(p.model)}\">`:`<div class=\"empty-gallery\">갤러리 미확보</div>`}",
        "${p.thumb?`<img class=\"pdp-thumb\" src=\"${p.thumb}\" alt=\"${esc(p.model)} 상세 첫 장\">`:`<div class=\"empty-gallery\">상세 이미지 없음</div>`}")

    # 이미지 실패 시 회색 상자, 슬라이스 크기 미리 잡기
    rep("function sel(i,on){",
        "document.addEventListener('error',e=>{const t=e.target;if(!t||t.tagName!=='IMG')return;let h='';try{h=new URL(t.src).host}catch(_){}"
        "const d=document.createElement('div');d.className='imgfail';d.title=t.src;d.innerHTML='이미지를 불러오지 못함<small>'+esc(h)+'</small>';t.replaceWith(d);},true);\n"
        "function sel(i,on){")

    # 오른쪽 프리뷰 = 상세 설명 영역만
    m = re.search(r'^function market\(p,sum\)\{.*$', text, re.M)
    if not m:
        sys.exit('market() not found')
    text = text[:m.start()] + (
        "function market(p,sum){const laz=S.ch==='lazada';"
        "return `<div class=\"phone ${S.ch} pdp-only\"><div class=\"pdp-head\"><span>${laz?'Lazada':'Shopee'} · รายละเอียดสินค้า</span>"
        "<small>실제 페이지 모양 대조 전</small></div>"
        "<div class=\"market-card description\"><div class=\"desc-head\"><h3>รายละเอียดสินค้า</h3>"
        "<span>상세 이미지 ${p.slices.length}장${p.slicesSame?' · Shopee·Lazada 같은 슬라이스':''}</span></div>${sum}"
        "<div class=\"slices\">${p.slices.map((src,i)=>`<div class=\"slice\" onclick=\"lbOpen(${i})\"><img src=\"${src}\" alt=\"상세 이미지 ${i+1}\" width=\"1000\" ${p.sliceH[i]?`height=\"${p.sliceH[i]}\"`:''}><span>1:1 확대</span></div>`).join('')}</div></div></div>`;}"
    ) + text[m.end():]
    rep("' 상품 페이지 <span class=\"badge b-q pos-note\" title=\"'+esc(p.blockNote)+'\">섹션 위치표 · 추정</span>'",
        "' 상세 설명 <span class=\"badge b-q pos-note\" title=\"'+esc(p.blockNote)+'\">'+(p.blocks.length?'섹션 위치표 · 추정':'섹션 위치표 없음 · 동기 스크롤 안 됨')+'</span>'")
    rep("const p=cur(),stack=$('pR').querySelector('.slices');if(!stack)return;",
        "const p=cur(),stack=$('pR').querySelector('.slices');if(!stack||!p.blocks.length)return;")
    rep("${o.img?`<img src=\"${o.img}\" alt=\"\">`:''}",
        "${o.img?`<img src=\"${o.img}\" alt=\"\" title=\"${esc(o.imgHow||'운영 저장본')}\">`:(o.imgHow&&o.imgHow.startsWith('none')&&!o.disc?'<span class=\"nomatch\">원본 이미지 매칭 안 됨</span>':'')}")
    # 갤러리 함수는 더 쓰지 않음 (호출하는 곳 없음)
    for fn in ('galleryMove', 'gallery'):
        text, n = re.subn(r'^function %s\(p?i?\)\{.*\n' % fn, '', text, count=1, flags=re.M)
        if n != 1:
            sys.exit(f'{fn}() not found')
    if re.search(r'\bgallery\(|galleryMove\(', text.split('<script>', 1)[1].split('const DATA=', 1)[0] + text.split('const DATA=', 1)[1].split('\n', 1)[1]):
        sys.exit('gallery call left over')

    # ── 왼쪽: lg.com 전체 화면 캡처(운영 /media/fullshot) 가 있으면 화면 그대로 ──
    rep('<div class="ph">LG.COM 원본</div>', '<div class="ph" id="oH">LG.COM 원본</div>')
    rep("const S={corp:'th',tab:'all',q:'',sel:new Set(),cur:0,ch:'shopee'};",
        "const S={corp:'th',tab:'all',q:'',sel:new Set(),cur:0,ch:'shopee',lg:'shot'};")
    a_ = "  $('pO').innerHTML=p.O.map("
    rep(a_, "  const shot=p.fullshot&&S.lg==='shot';\n"
            "  $('oH').innerHTML='LG.COM 원본'+(p.fullshot?`<span class=\"ohsw\"><button class=\"${shot?'on':''}\" onclick=\"S.lg='shot';renderCmp()\">화면 그대로</button><button class=\"${shot?'':'on'}\" onclick=\"S.lg='sec';renderCmp()\">섹션</button></span><span class=\"ohnote\">전체 화면 캡처 · PC 1920px → 폭 ${p.fullshot.width}px · 동기 스크롤 안 됨</span>`:'<span class=\"ohnote\">전체 화면 캡처 없음 · 운영 저장본 섹션으로 표시</span>');\n"
            "  $('pO').innerHTML=shot?`<div class=\"fullshot\"><img src=\"${p.fullshot.src}\" width=\"${p.fullshot.width}\" height=\"${p.fullshot.height}\" alt=\"lg.com 전체 화면\"></div>`:p.O.map(")
    rep("if(!stack||!p.blocks.length)return;", "if(!stack||!p.blocks.length||$('pO').querySelector('.fullshot'))return;")

    # ── 오른쪽 Shopee: 설명 칸은 HTML 을 받지 않음 → 요약은 태그 없는 글, 이미지는 앞 12장(3,000자 한도) ──
    m2 = re.search(r"^function market\(p,sum\)\{const laz=S.ch==='lazada';", text, re.M)
    if not m2:
        sys.exit('market() head not found')
    text = text[:m2.end()] + (
        "const shp=!laz,nUse=shp?(sumOn()?p.shopeeN:p.shopeeNsg):p.slices.length;"
        "if(shp&&sumOn()&&p.hasSum)sum=sum.replace(`<div class=\"sumbody\">${p.sum}</div>`,`<pre class=\"shopee-text\" lang=\"th\">${esc(p.sumText)}</pre>`);"
    ) + text[m2.end():]
    rep("<span>상세 이미지 ${p.slices.length}장${p.slicesSame?' · Shopee·Lazada 같은 슬라이스':''}</span>",
        "<span>${shp?`이미지 ${nUse}/${p.slices.length}장 · 글은 태그 없음`:`상세 이미지 ${p.slices.length}장 · HTML`}</span>")
    rep("${p.slices.map((src,i)=>`<div class=\"slice\" onclick=\"lbOpen(${i})\">",
        "${p.slices.map((src,i)=>`${i===nUse&&nUse<p.slices.length?`<div class=\"cutnote\">아래 ${p.slices.length-nUse}장은 Shopee 설명에 넣지 않음 (앞 12장·3,000자 규칙) — 흐리게 표시</div>`:''}<div class=\"slice ${i>=nUse?'cut':''}\" onclick=\"lbOpen(${i})\">")
    rep("<small>실제 페이지 모양 대조 전</small>",
        "<small>${shp?'이미지 주소 표시 방식 확인 전':'실제 페이지 모양 대조 전'}</small>")

    open(a.out, 'w', encoding='utf-8').write(text)
    json.dump(report, open(a.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{a.out}: {len(text)/1e6:.2f} MB, {len(DATA)} products', file=sys.stderr)


if __name__ == '__main__':
    main()
