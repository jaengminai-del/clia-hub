#!/usr/bin/env python3
"""목업 v10 만들기 — v9 결과(mockup-v9.html)를 틀로, lg.com 캡처 + CLIA 결과가 둘 다 있는 제품으로 다시 구성

  python3 -I build_v10.py --template ../v9/mockup-v9.html --sources v10-sources.json --out mockup-v10.html

바뀌는 것
- 제품 = v10-sources.json (TH 배치 중 운영에 lg.com 전체 화면 캡처와 배치 슬라이스가 둘 다 있는 것). 상태는 모두 미검토.
- 비교 화면 기본 보기 = 「세 줄 보기」: Squad Hub 3P ASIA Contents QA(work-automation
  src/components/contents-qa/tabs/DetailTab.tsx)의 상세페이지 탭 방식을 가져옴
  · SKU 하나에 Shopee / Lazada / LG.com(기준) 세 줄, 왼쪽 칸에 상태 칩, 오른쪽에 페이지
  · 「전체 페이지」: 긴 페이지를 신문 단처럼 세로 단 n개로 잘라 한 줄(약 600px)에 전체가 들어가게
    (n ≈ √(비율·줄너비/600), 1~16). 같은 내용을 단마다 위치만 바꿔 보여 줘 비율이 바뀌지 않음
  · 「상세 이미지만」: 상세 이미지를 원래 비율로 격자에
- CLIA 결과 줄은 기준 폭(모바일 390 / PC 1000, 둘 다 추정)으로 그린 뒤 단 너비로 축소
- 「나란히 보기」는 v9 비교 화면 그대로 (왼쪽 lg.com 캡처는 PDP부터)
"""
import argparse, json, re, sys

TARGET_H = 600
GAP = 6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--template', required=True)
    ap.add_argument('--sources', required=True)
    ap.add_argument('--out', default='mockup-v10.html')
    a = ap.parse_args()
    text = open(a.template, encoding='utf-8').read()
    SRC = json.load(open(a.sources, encoding='utf-8'))

    DATA = []
    for s in SRC['products']:
        DATA.append({
            'slug': s['slug'], 'model': s['model'], 'title': s['title'], 'st': 'unrev', 'url': s['url'],
            'O': [], 'blocks': [], 'sliceH': [], 'blockNote': '',
            'slices': s['slices'], 'slicesSame': s['slicesSame'], 'thumb': s['slices'][0],
            'sum': s['sum'], 'summary': s['sum'], 'sumText': s['sumText'],
            'shopeeN': s['shopeeN'], 'shopeeChars': s['shopeeChars'], 'shopeeNsg': s['shopeeNsg'],
            'fullshot': {k: s['fullshot'][k] for k in ('src', 'width', 'height', 'top', 'topHow', 'bottom')},
        })

    def rep(old, new, count=1):
        nonlocal text
        n = text.count(old)
        if n != count:
            sys.exit(f'replace target found {n}x (want {count}): {old[:90]!r}')
        text = text.replace(old, new)

    # lg.com 캡처: PDP 첫 섹션(top) ~ 스펙 끝(bottom, 리뷰 제목 위)만
    rep("aspect-ratio:${p.fullshot.width}/${p.fullshot.height-p.fullshot.top}", "aspect-ratio:${p.fullshot.width}/${p.fullshot.bottom-p.fullshot.top}")
    text = re.sub(r'^const DATA=.*$', lambda m: 'const DATA=' + json.dumps(DATA, ensure_ascii=False) + ';', text, count=1, flags=re.M)
    rep('<title>CLIA · 검토/승인 — 목업 v9</title>', '<title>CLIA · 검토/승인 — 목업 v10</title>')
    rep('<b>목업 v9</b> · 갤러리를 빼고 상세(PDP)만 비교합니다.',
        f'<b>목업 v10</b> · lg.com 전체 화면 캡처와 CLIA 결과가 둘 다 있는 TH 제품 {len(DATA)}개. 세 줄 보기는 Squad Hub 3P QA 상세페이지 탭 방식.')
    # v7 데모 SKU 표 대신 모델 코드(예시)
    text = re.sub(r"const SKU=\{[^}]*\};", "const SKU={};", text, count=1)
    rep("p.sku=SKU[p.model];", "p.sku=SKU[p.model]||p.model;")

    # ── 비교 화면 머리: 보기 전환 · 기준 폭 · 페이지/이미지 ──
    rep('<span class="sp"></span><label class="sw"><input type="checkbox" id="syncT" checked><span class="tr"></span>동기 스크롤</label></div>',
        '<div class="wtabs" id="viewTabs"><button class="tab" data-v="side" onclick="setView(\'side\')">나란히 보기</button>'
        '<button class="tab" data-v="all" onclick="setView(\'all\')">세 줄 보기</button></div>'
        '<span class="sp"></span><span id="allOpts"></span>'
        '<label class="sw" id="syncW"><input type="checkbox" id="syncT" checked><span class="tr"></span>동기 스크롤</label></div>')
    rep('<div class="panes">', '<div class="allv" id="all" hidden></div>\n <div class="panes" id="panes">')
    rep("const S={corp:'th',tab:'all',q:'',sel:new Set(),cur:0,ch:'shopee',lg:'shot'};",
        "const S={corp:'th',tab:'all',q:'',sel:new Set(),cur:0,ch:'shopee',lg:'shot',view:'side',mode:'page',base:390};")
    # 섹션 데이터가 없으면 「섹션」 전환 숨김
    rep("$('oH').innerHTML='LG.COM 원본'+(p.fullshot?`<span class=\"ohsw\">",
        "$('oH').innerHTML='LG.COM 원본'+(p.fullshot&&p.O.length?`<span class=\"ohsw\">")
    rep(":'<span class=\"ohnote\">전체 화면 캡처 없음 · 운영 저장본 섹션으로 표시</span>');",
        ":p.fullshot?`<span class=\"ohnote\">전체 화면 캡처 · PDP 첫 섹션 ~ 스펙 끝</span>`:'<span class=\"ohnote\">전체 화면 캡처 없음 · 운영 저장본 섹션으로 표시</span>');")

    css = f"""
/* ── v10: 세 줄 보기 (Squad Hub 3P ASIA Contents QA 상세페이지 탭 방식) ── */
.allv{{flex:1;min-height:0;overflow:auto;padding:14px 24px 40px;display:grid;gap:10px;align-content:start;background:var(--clia-gray-50)}}
.allv[hidden]{{display:none}}
.arow{{background:#fff;border:1px solid var(--clia-gray-200);border-radius:14px;padding:14px 16px;display:grid;grid-template-columns:200px minmax(0,1fr);gap:16px;align-items:start}}
.arow .meta{{display:grid;gap:6px;align-content:start}}.arow h3{{margin:0;font-size:14px;font-weight:700}}
.arow .line{{display:flex;gap:6px;align-items:flex-start;font-size:12px;color:var(--clia-gray-700);line-height:1.45}}
.chip{{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px;white-space:nowrap;line-height:1.6}}
.chip.ok{{background:#ddefe4;color:#1f6a43}}.chip.warn{{background:#fbefd6;color:#7a4b00}}.chip.bad{{background:#fbe3e6;color:#8e0f2c}}.chip.info{{background:var(--clia-gray-100);color:var(--clia-gray-500)}}
.cols{{display:flex;gap:{GAP}px;align-items:flex-start;width:100%;min-height:80px}}
.col{{position:relative;flex:none;overflow:hidden;border:1px solid #eee;border-radius:6px;background:#fff;cursor:zoom-in;padding:0}}
.col>.pg{{position:absolute;left:0;top:0;transform-origin:0 0;text-align:left}}
.col .no{{position:absolute;top:4px;right:4px;padding:0 5px;border-radius:6px;background:rgba(38,38,38,.62);color:#fff;font:600 10px/16px ui-monospace,Menlo,monospace;z-index:2}}
.measure{{position:absolute;left:-99999px;top:0;visibility:hidden}}
.pg{{background:#fff}}.pg img{{display:block;width:100%;height:auto}}.pg .cut{{opacity:.35}}
.pg .stxt{{white-space:pre-wrap;margin:0;padding:12px;font:14px/1.55 Roboto,"Helvetica Neue",Helvetica,Arial,"LINESeedSansTH",sans-serif;color:#222}}
.pg .lg-pdp-summary{{padding:16px 12px!important}}
.pg .cutnote{{padding:10px 12px;font-size:12px;color:#757575;background:#fafafa;border-top:1px dashed #ddd;border-bottom:1px dashed #ddd}}
.agrid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;align-items:start}}
.agrid button{{padding:0;border:1px solid #eee;border-radius:8px;overflow:hidden;background:#fff;cursor:zoom-in}}.agrid img{{display:block;width:100%;height:auto}}
.agrid button.cut{{opacity:.35}}
.aempty{{border:1px dashed var(--clia-gray-300,#ccc);border-radius:10px;padding:28px 16px;text-align:center;font-size:13px;color:var(--clia-gray-500)}}
.ahint{{margin:0;font-size:12px;color:var(--clia-gray-500)}}
.waitc{{margin-left:8px;padding:1px 8px;border-radius:999px;background:#FFF3C4;color:#7A5A00;font-size:11px;font-weight:700}}.waitc[hidden]{{display:none}}
#allOpts{{display:inline-flex;gap:6px;align-items:center;margin-right:10px}}#allOpts .wtabs{{margin:0}}
"""
    rep('</style></head>', css + '</style></head>')

    js = r"""
// ── v10: 세 줄 보기 ─────────────────────────────────────────────
// Squad Hub 3P ASIA Contents QA 상세페이지 탭(DetailTab.tsx)과 같은 규칙:
//  한 줄 목표 높이 TARGET_H, 단 개수 n ≈ √(비율·줄너비/TARGET_H) (1~16), 단 너비 c, 단 높이 = 비율·c/n.
//  단마다 같은 내용을 위로 밀어 보여 줄 뿐 잘라 붙이지 않으므로 이미지 비율이 그대로다.
const TARGET_H=__TARGET_H__,COL_GAP=__GAP__;
function setView(v){S.view=v;renderCmp();}
function setMode(m){S.mode=m;renderCmp();}
function setBase(b){S.base=b;renderCmp();}
function chip(t,c){return `<span class="chip ${t}">${c}</span>`;}
function shopeeUse(p){return sumOn()?p.shopeeN:p.shopeeNsg;}
// 기준 폭 B 로 그릴 채널 페이지 HTML (Shopee: 태그 없는 요약 글 + 앞 n장 / Lazada: 요약 HTML + 전체)
function pageHTML(p,ch){
  if(ch==='lgcom'){const f=p.fullshot;return {B:f.width,html:`<div class="fullshot" style="aspect-ratio:${f.width}/${f.bottom-f.top}"><img src="${f.src}" width="${f.width}" height="${f.height}" style="margin-top:-${(f.top/f.width*100).toFixed(4)}%" alt="lg.com"></div>`};}
  const shp=ch==='shopee',n=shp?shopeeUse(p):p.slices.length;
  const top=sumOn()&&p.sum?(shp?`<pre class="stxt" lang="th">${esc(p.sumText)}</pre>`:p.sum):'';
  const imgs=p.slices.map((s,i)=>`${shp&&i===n&&n<p.slices.length?`<div class="cutnote">아래 ${p.slices.length-n}장은 Shopee 설명에 넣지 않음 (앞 12장·3,000자)</div>`:''}<img class="${shp&&i>=n?'cut':''}" src="${s}" width="1000" alt="">`).join('');
  return {B:S.base,html:top+imgs};
}
function rowMeta(p,ch){
  if(ch==='lgcom'){const f=p.fullshot;return `<h3>LG.com (기준)</h3><div class="line">${chip('ok','기준')}<span>전체 화면 캡처 · PDP 첫 섹션 ~ 스펙 끝 (헤더·갤러리·탭, 리뷰 아래 숨김)</span></div><div class="line">${chip('info','캡처')}<span>PC 1920px → 폭 ${f.width}px</span></div>`;}
  const shp=ch==='shopee',n=shp?shopeeUse(p):p.slices.length,th=sumOn();
  const sumc=!th?chip('info','요약 없음 · SG'):p.sum?chip('ok',shp?'요약 글 (태그 없음)':'요약 HTML'):chip('warn','요약 대기');
  return `<h3>${shp?'Shopee':'Lazada'}</h3><div class="line">${sumc}</div>`+
    `<div class="line">${chip(shp&&n<p.slices.length?'warn':'info','이미지')}<span>${shp?`${n}/${p.slices.length}장 넣음${n<p.slices.length?' — 앞 12장·3,000자 규칙':''}`:`${p.slices.length}장 · HTML`}</span></div>`+
    (shp&&th&&p.sum?`<div class="line">${chip('info','글자')}<span>${p.shopeeChars.toLocaleString()} / 3,000자</span></div>`:'')+
    `<div class="line">${chip('info','폭')}<span>기준 폭 ${S.base}px (추정 · 실제 페이지 대조 전)</span></div>`;
}
function renderAll(p){
  const rows=['shopee','lazada','lgcom'];
  $('all').innerHTML=`<p class="ahint">${S.mode==='page'?'왼쪽 단부터 페이지 맨 위 → 아래 순서예요. 단을 누르면 나란히 보기에서 그 위치를 크게 봐요.':'상세 설명에 올라간 이미지만 순서대로, 원래 비율로 보여줘요. 누르면 1000px 원본 크기로 봐요.'}</p>`+
    rows.map(ch=>`<section class="arow" data-ch="${ch}"><div class="meta">${rowMeta(p,ch)}</div><div class="body" id="ab_${ch}"></div></section>`).join('');
  rows.forEach(ch=>{const box=$('ab_'+ch);
    if(S.mode==='images'){
      if(ch==='lgcom'){box.innerHTML='<div class="aempty">LG.com 은 상세 이미지 대신 HTML 피처 섹션이에요 · 전체 페이지에서 보세요</div>';return;}
      const n=ch==='shopee'?shopeeUse(p):p.slices.length;
      box.innerHTML=`<div class="agrid">${p.slices.map((s,i)=>`<button class="${i>=n?'cut':''}" onclick="lbOpen(${i})" title="상세 이미지 ${i+1}${i>=n?' · Shopee에 넣지 않음':''}"><img src="${s}" alt="상세 이미지 ${i+1}" loading="lazy"></button>`).join('')}</div>`;return;}
    layoutCols(box,p,ch);});
}
// 내용을 기준 폭 B 로 한 번 그려 높이를 잰 뒤(이미지 로드 후), 단 n 개에 같은 내용을 위치만 바꿔 놓는다
function layoutCols(box,p,ch){
  const {B,html}=pageHTML(p,ch);
  const m=document.createElement('div');m.className='measure pg';m.style.width=B+'px';m.innerHTML=html;document.body.appendChild(m);
  const imgs=[...m.querySelectorAll('img')];
  box.innerHTML='<div class="cols"><span class="ahint" style="margin:auto">불러오는 중…</span></div>';
  Promise.all(imgs.map(im=>im.complete?0:new Promise(r=>{im.onload=im.onerror=r;}))).then(()=>{
    const H=m.offsetHeight;m.remove();
    const draw=()=>{const W=box.clientWidth;if(!W||!H)return;
      const ratio=H/B,n=Math.min(16,Math.max(1,Math.round(Math.sqrt(ratio*W/TARGET_H))));
      const colW=(W-COL_GAP*(n-1))/n,scale=colW/B,colH=H*scale/n;
      box.innerHTML=`<div class="cols" style="height:${Math.ceil(colH)+2}px">`+Array.from({length:n},(_,i)=>
        `<button class="col" style="width:${colW}px;height:${colH}px" onclick="openAt('${ch}',${i/n})" title="${ch==='lgcom'?'LG.com':ch==='shopee'?'Shopee':'Lazada'} ${i+1}/${n}단"><div class="pg" style="width:${B}px;transform:translateY(${-i*colH}px) scale(${scale})">${html}</div><span class="no">${i+1}</span></button>`).join('')+'</div>';};
    draw();
    if(box._ro)box._ro.disconnect();let w0=box.clientWidth;box._ro=new ResizeObserver(()=>{if(Math.abs(box.clientWidth-w0)>2){w0=box.clientWidth;draw();}});box._ro.observe(box);
  });
}
// ── 나란히 보기 동시 스크롤 (위치표 없는 제품) ──────────────────────
// 「같은 영역」: 양쪽을 각자 콘텐츠 폭 기준으로 같은 거리만큼 움직인다 (u = 스크롤량 ÷ 콘텐츠 폭).
//  왼쪽 0 = lg.com PDP 첫 섹션, 오른쪽 0 = 상세 설명 첫머리. 짧은 쪽은 끝에 닿으면 멈춰 기다리고,
//  긴 쪽을 다시 올려 그 범위 안으로 돌아오면 같이 움직인다.
function areaGeom(){const L=$('pO'),R=$('pR'),fs=L.querySelector('.fullshot'),d=R.querySelector('.description')||R.querySelector('.phone');
  const r0=d?d.getBoundingClientRect().top-R.getBoundingClientRect().top+R.scrollTop:0;
  return {L,R,lw:(fs||L).clientWidth||1,rw:(d||R).clientWidth||1,r0,lmax:L.scrollHeight-L.clientHeight,rmax:R.scrollHeight-R.clientHeight};}
function sameArea(a,b){const g=areaGeom();lock=a.id;
  const u=a===g.L?g.L.scrollTop/g.lw:Math.max(0,g.R.scrollTop-g.r0)/g.rw;
  const want=a===g.L?g.r0+u*g.rw:u*g.lw,max=a===g.L?g.rmax:g.lmax;
  b.scrollTop=Math.min(want,max);
  const waiting=want>max+2,w=$(b===g.L?'oWait':'rWait'),o=$(b===g.L?'rWait':'oWait');
  if(w){w.hidden=!waiting;w.textContent=b===g.L?'LG.com 끝 · 기다리는 중':'결과 끝 · 기다리는 중';}if(o)o.hidden=true;
  clearTimeout(window._lt);window._lt=setTimeout(()=>lock=null,120);}

// 단을 누르면 나란히 보기로 가서 같은 위치(비율)로 스크롤
function openAt(ch,frac){if(ch!=='lgcom')S.ch=ch;S.view='side';renderCmp();
  requestAnimationFrame(()=>setTimeout(()=>{const pane=ch==='lgcom'?$('pO'):$('pR');pane.scrollTop=frac*(pane.scrollHeight-pane.clientHeight*0)},350));}
"""
    js = js.replace('__TARGET_H__', str(TARGET_H)).replace('__GAP__', str(GAP))
    rep("function renderCmp(){const p=cur();", js + "\nfunction renderCmp(){const p=cur();")
    rep("(p.blocks.length?'섹션 위치표 · 추정':'섹션 위치표 없음 · 동기 스크롤 안 됨')",
        "(p.blocks.length?'섹션 위치표 · 추정':'같은 영역 동시 스크롤 · 짧은 쪽은 끝에서 기다림')")
    rep("const p=cur(),stack=$('pR').querySelector('.slices');if(!stack||!p.blocks.length||$('pO').querySelector('.fullshot'))return;",
        "const p=cur(),stack=$('pR').querySelector('.slices');if(!stack)return;if(!p.blocks.length||$('pO').querySelector('.fullshot')){sameArea(a,b);return;}")
    rep("  $('pR').innerHTML=market(p,sum);",
        "  $('pR').innerHTML=market(p,sum);\n  $('oH').insertAdjacentHTML('beforeend','<span class=\"waitc\" id=\"oWait\" hidden></span>');$('rH').insertAdjacentHTML('beforeend','<span class=\"waitc\" id=\"rWait\" hidden></span>');")
    # renderCmp 끝(renderBar 호출 직전)에서 보기 전환
    rep("  $('miss').innerHTML=", "  $('miss').hidden=true;$('miss').innerHTML=")
    rep("  renderBar();}\nfunction renderBar(){",
        "  const all=S.view==='all';$('all').hidden=!all;$('panes').style.display=all?'none':'';$('chTabs').style.display=all?'none':'';$('syncW').style.display=all?'none':'';\n"
        "  document.querySelectorAll('#viewTabs .tab').forEach(b=>b.classList.toggle('on',b.dataset.v===S.view));\n"
        "  $('allOpts').innerHTML=all?`<span class=\"wtabs\"><button class=\"tab ${S.mode==='page'?'on':''}\" onclick=\"setMode('page')\">전체 페이지</button><button class=\"tab ${S.mode==='images'?'on':''}\" onclick=\"setMode('images')\">상세 이미지만</button></span>`+(S.mode==='page'?`<span class=\"wtabs\"><button class=\"tab ${S.base===390?'on':''}\" onclick=\"setBase(390)\" title=\"추정\">모바일 390</button><button class=\"tab ${S.base===1000?'on':''}\" onclick=\"setBase(1000)\" title=\"추정\">PC 1000</button></span>`:''):'';\n"
        "  if(all)renderAll(p);\n  renderBar();}\nfunction renderBar(){")
    open(a.out, 'w', encoding='utf-8').write(text)
    print(f'{a.out}: {len(text)/1e6:.2f} MB, {len(DATA)} products', file=sys.stderr)


if __name__ == '__main__':
    main()
