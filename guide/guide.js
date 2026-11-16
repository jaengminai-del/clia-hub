/* 콘텐츠 이미지 가이드 — 화면 그리기.
   내용은 guide-data.js(한글, 배포돼 있던 Content Guide 문구 그대로) / guide-data.en.js(영문 번역),
   형식은 Retail OBS Guide 와 같다: 왼쪽 목차 · 1920×1080 한 장씩 · ← → 키 · 쪽 번호 입력 · PDF 저장.
   언어: 주소의 ?lang=ko|en → 지난번 고른 언어 → 브라우저 언어(한국어면 ko, 아니면 en) */
(function () {
  'use strict';
  const LANGS = { ko: window.GUIDE_DATA, en: window.GUIDE_DATA_EN };
  const pickLang = () => {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && LANGS[q]) return q;
    try { const s = localStorage.getItem('guideLang'); if (s && LANGS[s]) return s; } catch (e) {}
    return /^ko/i.test(navigator.language || '') ? 'ko' : 'en';
  };
  const LANG = pickLang(), D = LANGS[LANG] || LANGS.ko;
  // 화면 글자 (내용 밖)
  const T = {
    ko: { doc: '콘텐츠 이미지 가이드', cover: '글로벌 콘텐츠<br>이미지 가이드라인', toc: '목차', overview: '가이드 구성', start: '시작하기', coverNav: '표지', end: '마무리',
      specs: '공통 사양', aiSpecs: '공통 적용 스펙 요약', aiRules: '학습 원칙 · 파이프라인 주의', open: 'CLIA 열기', pdf: 'PDF로 저장', hint: '← → 키로 넘길 수 있습니다',
      ui: 'UI 영역', key: '핵심 콘텐츠', safe: '안전 영역', comment: '댓글창 UI', menu: '목차 열기', prev: '이전 쪽', next: '다음 쪽', page: '쪽 번호', nav: '가이드 목차' },
    en: { doc: 'Content Image Guide', cover: 'Global Content<br>Image Guidelines', toc: 'Contents', overview: 'Guide Overview', start: 'Getting Started', coverNav: 'Cover', end: 'Closing',
      specs: 'Common Specs', aiSpecs: 'Common Spec Summary', aiRules: 'Training Principles · Pipeline Notes', open: 'Open CLIA', pdf: 'Download as PDF', hint: 'Press ← → keys to navigate',
      ui: 'UI area', key: 'Key content', safe: 'Safe zone', comment: 'Comment UI', menu: 'Open contents', prev: 'Previous page', next: 'Next page', page: 'Page number', nav: 'Guide navigation' },
  }[LANG] ;

  // LG 로고 (저장소 shared/assets/lg-logo.svg 의 경로) — 표지·마무리용 흰색판
  const LG_LOGO_WHITE = (bg) => `<svg viewBox="0 0 300 132.157" xmlns="http://www.w3.org/2000/svg" aria-label="LG">
    <path d="M66.0787 132.157C102.58 132.157 132.157 102.552 132.157 66.0694C132.157 29.5869 102.58 0 66.0787 0C29.5776 0 0 29.5683 0 66.0694C0 102.57 29.5869 132.157 66.0787 132.157Z" fill="#fff"/>
    <path d="M63.4586 37.0699V94.9989H81.8653V89.8377H68.713V37.0699H63.4586Z" fill="${bg}"/>
    <path d="M44.9865 52.8844C49.3691 52.8844 52.9217 49.3317 52.9217 44.9725C52.9217 40.6132 49.3691 37.0373 44.9865 37.0373C40.604 37.0373 37.0746 40.5899 37.0746 44.9725C37.0746 49.355 40.6366 52.8844 44.9865 52.8844Z" fill="${bg}"/>
    <path d="M68.7129 10.7839C68.0368 10.7559 66.7174 10.7373 66.0833 10.7373C35.5966 10.7373 10.7839 35.5593 10.7839 66.0601C10.7839 80.8349 16.5231 94.7145 26.9527 105.158C37.4335 115.611 51.3318 121.355 66.0833 121.355C80.8348 121.355 94.7378 115.606 105.219 105.158C115.639 94.7145 121.378 80.8395 121.378 66.0601V63.5331L119.173 63.5517H81.9072V68.6849H116.133V69.4262C114.375 95.5118 92.6025 116.189 66.088 116.189C52.7026 116.189 40.1144 110.977 30.6452 101.512C21.1668 92.043 15.9543 79.4455 15.9543 66.0554C15.9543 52.6653 21.1715 40.0631 30.6452 30.6033C40.1144 21.1155 52.7026 15.9078 66.088 15.9078C66.6941 15.9078 68.1161 15.9217 68.7175 15.9357V10.7839H68.7129Z" fill="${bg}"/>
    <path d="M181.438 22.9944H161.702V108.431H222.326V91.7959H181.438V22.9944Z" fill="#fff"/>
    <path d="M265.746 75.8695H281.808V90.8028C278.857 91.9358 273.08 93.0687 267.583 93.0687C249.815 93.0687 243.889 84.0378 243.889 65.7104C243.889 47.3829 249.521 37.9371 267.289 37.9371C277.155 37.9371 282.801 41.0422 287.449 46.9586L299.725 35.6899C292.251 24.9712 279.132 21.7309 266.865 21.7309C239.232 21.7309 224.704 36.8135 224.704 65.5705C224.704 94.3275 237.814 109.699 266.725 109.699C279.971 109.699 292.941 106.319 300 101.386V59.9384H265.741V75.8742L265.746 75.8695Z" fill="#fff"/>
  </svg>`;
  const ARROW = '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // **굵게**, 줄바꿈, ✅/❌ 표시
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
    .replace(/✅\s?/g, '<i class="ok">✓</i>').replace(/❌\s?/g, '<i class="no">✕</i>');
  // 'BASIC A+ CONTENT' → 'Basic A+ Content' (영문 대문자 낱말만)
  const titleCase = (s) => s.replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => (m === 'AI' || m === 'MO' || m === 'PC' ? m : a + b.toLowerCase()));
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ── 작은 부품 ──
  const chip = (b) => {
    const [t, c] = b; const k = c.includes('util-req') ? 'req' : c.includes('util-h') ? 'hi' : c.includes('util-m') ? 'mid' : c.includes('util-l') ? 'low' : c === 'blimit' ? 'cnt' : 'size';
    return `<span class="chip ${k}">${esc(t)}</span>`;
  };
  // 크기 표시에서 정확한 가로×세로가 있으면 비율 그림
  function ratioBox(badges) {
    const b = badges.find((x) => x[1].startsWith('bsize')); if (!b) return '';
    const m = b[0].match(/(\d[\d,]*)\s*[×x]\s*(\d[\d,]*)(?!\s*~|\d)/); if (!m || /~\s*$/.test(b[0].slice(0, m.index + m[0].length + 1))) return '';
    const w = +m[1].replace(/,/g, ''), h = +m[2].replace(/,/g, ''); if (!w || !h) return '';
    const s = Math.min(300 / w, 96 / h), bw = Math.max(18, Math.round(w * s)), bh = Math.max(10, Math.round(h * s));
    return `<div class="ratio"><div class="rbox" style="width:${bw}px;height:${bh}px"></div><span>${m[1]} × ${m[2]}</span></div>`;
  }
  const rowsDl = (rows) => rows.length ? `<dl class="rows">${rows.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${Array.isArray(v) ? `<span class="tags">${v.map((t) => `<span>${esc(t)}</span>`).join('')}</span>` : rich(v)}</dd></div>`).join('')}</dl>` : '';
  const uses = (u) => (u && u.length ? `<div class="uses">${u.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '');
  const notes = (n, cls) => (n && n.length ? `<div class="notes ${cls || ''}">${n.map(([k, h, t]) => `<div class="note ${k}">${h ? `<b class="nh">${esc(h)}</b>` : ''}<span>${rich(t)}</span></div>`).join('')}</div>` : '');
  function table(rows) {
    const L = rows[0].length; let html = `<table class="dt"><thead><tr>${rows[0].map((c) => `<th>${rich(c)}</th>`).join('')}</tr></thead><tbody>`;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 1) { html += `<tr class="grp"><td colspan="${L}">${rich(r[0])}</td></tr>`; continue; }
      if (r.length === L - 1) { html += `<tr>${r.map((c) => `<td>${rich(c)}</td>`).join('')}</tr>`; continue; }
      // 첫 칸을 아래 줄과 함께 쓰는 표 (AI 표의 플랫폼 칸)
      let span = 1; while (rows[i + span] && rows[i + span].length === L - 1) span++;
      html += `<tr${span > 1 || i > 1 ? ' class="top"' : ''}>${r.map((c, j) => `<td${j === 0 && span > 1 ? ` rowspan="${span}" class="lead"` : ''}>${rich(c)}</td>`).join('')}</tr>`;
    }
    return html + '</tbody></table>';
  }

  // ── 슬라이드 종류 ──
  const R = {
    cover: () => `<div class="s s-cover"><div class="logo">${LG_LOGO_WHITE('#F52A35')}</div>
      <h1>${T.cover}</h1><div class="sub"><span>${esc(D.platforms)}</span><i></i><span>${esc(D.version)}</span></div></div>`,
    divider: (p) => `<div class="s s-dark s-divider"><div class="kicker">${esc(p.kicker)}</div><h1>${esc(p.title)}</h1>
      ${p.lead ? `<p class="lead">${rich(p.lead)}</p>` : ''}${p.list ? `<ul class="secs">${p.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`,
    toc: () => `<div class="s s-dark s-toc"><h1>${esc(T.toc)}</h1><div class="cols">${
      NAV.filter((n) => n.kids).map((n) => `<div><h2>${esc(n.label)}</h2><ul>${n.kids.map((k) => `<li>${esc(k.label)}</li>`).join('')}</ul></div>`).join('')}</div></div>`,
    content: (p, body) => `<div class="s s-content"><div class="crumb">${esc(p.crumb || '')}${p.part ? `<span class="part">${p.part}</span>` : ''}</div>
      <div class="title-row"><h1>${esc(p.title)}</h1><div class="intro">${rich(p.intro || '')}</div></div>
      <div class="panel">${body}</div></div>`,
    overview: (p) => R.content(p, `<div class="ov">${D.plats.map((pl, k) => `<div class="ov-card">
        <div class="ov-no">${String(k + 1).padStart(2, '0')}</div><h3>${esc(pl.name)}</h3><p>${rich(pl.p)}</p>
        <ul>${pl.sections.filter((s) => !s.ai).map((s) => { const ns = s.items.map((x) => x.num).filter((x) => x && x !== '★');
          return `<li><span>${esc(titleCase(s.h))}</span><b>${esc(ns.length > 1 ? ns[0] + '–' + ns[ns.length - 1] : ns[0] || '')}</b></li>`; }).join('')}</ul></div>`).join('')}
      <div class="ov-card ai"><div class="ov-no">${String(D.plats.length + 1).padStart(2, '0')}</div><h3>${esc(AI.sec.h)}</h3><p>${rich(AI.sec.pill)}</p>
        <ul><li><span>${esc(AI.item.h)}</span><b>AI</b></li></ul></div></div>`),
    specs: (p) => R.content(p, `<div class="specs">${p.plat.specs.map(([l, v, s]) => `<div class="spec"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="u">${esc(s)}</div></div>`).join('')}</div>`),
    modules: (p) => R.content(p, `<div class="mods n${p.items.length}${p.items.length > 2 && p.items.some((x) => x.rows && x.rows.length >= 4) ? ' dense' : ''}">${p.items.map((it) => it.callout ? `<div class="mod callout"><h3>${esc(it.h)}</h3><p>${rich(it.p)}</p></div>` : `<div class="mod">
        <div class="mod-top"><span class="num">${esc(it.num)}</span><span class="chips">${it.badges.filter((b) => b[1].startsWith('butil')).map(chip).join('')}</span></div>
        <h3>${esc(it.h)}</h3>${it.sub ? `<p class="sub">${rich(it.sub)}</p>` : ''}
        <div class="chips size">${it.badges.filter((b) => !b[1].startsWith('butil')).map(chip).join('')}</div>
        ${ratioBox(it.badges)}${rowsDl(it.rows)}${uses(it.uses)}${notes(it.notes)}</div>`).join('')}</div>`),
    table: (p) => { const it = p.item, rows = it.tables.reduce((n, x) => n + x.length, 0); return R.content(p, `<div class="tbl-page${rows <= 9 ? ' roomy' : ''}">
        ${p.noHead ? '' : `<div class="item-head"><span class="num">${esc(it.num)}</span><div><h2>${esc(it.h)}</h2>${it.sub ? `<p>${rich(it.sub)}</p>` : ''}</div><span class="chips">${it.badges.map(chip).join('')}</span></div>`}
        ${p.only === 'notes' ? '' : it.tables.map(table).join('')}${p.only === 'table' ? '' : notes(it.notes, p.only === 'notes' ? 'big' : 'row')}</div>`); },
    premium: (p) => { const it = p.item; return R.content(p, `<div class="tbl-page">
        <div class="item-head"><span class="num star">★</span><div><h2>${esc(it.h)}</h2><p>${rich(it.sub)}</p></div><span class="chips">${it.badges.map(chip).join('')}</span></div>
        <div class="pre"><div class="conds">${it.conditions.map((c) => `<div class="cond"><div class="k"><i class="ok">✓</i>${esc(c.k)}</div><h3>${esc(c.h)}</h3><p>${rich(c.p)}</p>${c.sub ? `<p class="s2">${esc(c.sub)}</p>` : ''}</div>`).join('')}</div>
        <div class="pre-r">${it.tables.map(table).join('')}${notes(it.notes, 'row')}</div></div></div>`); },
    ratios: (p) => { const it = p.item; return R.content(p, `<div class="tbl-page">
        <div class="item-head"><span class="num">${esc(it.num)}</span><div><h2>${esc(it.h)}</h2><p>${rich(it.sub)}</p></div></div>
        <div class="rcards">${it.ratios.map((r) => { const [a, b] = r.ratio.split(/\s*\/\s*/)[0].split(':').map((x) => parseFloat(x)); const s = Math.min(230 / a, 250 / b);
          return `<div class="rcard"><div class="rpic"><div style="width:${Math.round(a * s)}px;height:${Math.round(b * s)}px">${esc(r.ratio.split('/')[0].trim())}</div></div>
            <div class="t">${esc(r.tag)}</div><div class="r">${esc(r.ratio)}</div><div class="px">${esc(r.res)}</div><p>${esc(r.desc)}</p></div>`; }).join('')}</div>
        ${notes(it.notes, 'row')}</div>`); },
    safe: (p) => { const it = p.item; return R.content(p, `<div class="safe-page">
        <div class="phone"><div class="z top"><b>${esc(T.ui)}</b><span>14%</span></div><div class="z mid"><i class="ok">✓</i><b>${esc(T.key)}</b><span>${esc(T.safe)}</span></div><div class="z bot"><b>${esc(T.comment)}</b><span>20%</span></div></div>
        <div class="safe-r"><div class="item-head"><span class="num">${esc(it.num)}</span><div><h2>${esc(it.h)}</h2><p>${rich(it.sub)}</p></div><span class="chips">${it.badges.map(chip).join('')}</span></div>
        ${rowsDl(it.rows)}${uses(it.uses)}${notes(it.notes, 'row')}</div></div>`); },
    profile: (p) => { const it = p.item, f = it.profile; return R.content(p, `<div class="tbl-page roomy">
        <div class="item-head"><span class="num">${esc(it.num)}</span><div><h2>${esc(it.h)}</h2>${it.sub ? `<p>${rich(it.sub)}</p>` : ''}</div></div>
        <div class="prof"><div class="prof-l"><div class="circle"><span>${esc(f.label)}</span></div><div class="t">${esc(f.label)}</div><div class="r">${esc(f.ratio)}</div><div class="px">${esc(f.res)}</div><p>${esc(f.desc)}</p>${notes(it.notes)}</div>
        <div class="prof-r">${it.tables.map(table).join('')}</div></div></div>`); },
    outro: () => `<div class="s s-dark s-outro"><h1>${esc(D.foot[0].replace(/\s*·.*$/, ''))}</h1>
      <p>${D.foot.slice(1).map(esc).join('<br>')}</p>
      <a class="go" href="../clia/" target="_blank" rel="noopener">${esc(T.open)} ${ARROW}</a><div class="logo">${LG_LOGO_WHITE('#2B2B2B')}</div></div>`,
  };

  // ── 쪽 만들기 ──
  // AI 이미지 생성 가이드는 Instagram 화면 안에 있었지만 모든 플랫폼 공통이라 따로 묶는다
  const igSecs = D.plats.find((p) => p.id === 'instagram').sections;
  const aiSec = igSecs.find((s) => /^AI /.test(s.h)); aiSec.ai = true;
  const AI = { sec: aiSec, item: aiSec.items[0] };

  const PAGES = [];
  const add = (p) => { p.index = PAGES.length; PAGES.push(p); };
  add({ id: 'cover', type: 'cover', nav: T.coverNav, group: 'cover' });
  add({ id: 'overview', type: 'overview', nav: T.overview, group: 'overview', crumb: T.start, title: T.overview, intro: D.foot[2] || '' });
  add({ id: 'toc', type: 'toc', nav: T.toc, group: 'toc' });

  const special = (it) => (it.conditions ? 'premium' : it.ratios ? 'ratios' : it.profile ? 'profile' : it.safe ? 'safe' : it.tables ? 'table' : null);
  D.plats.forEach((pl, k) => {
    const g = pl.id, crumb = `${k + 1}. ${pl.name}`;
    add({ id: g, type: 'divider', nav: crumb, group: g, kicker: pl.badge, title: crumb, lead: pl.h1.replace(/\n/g, ' ') + '\n' + pl.p,
      list: pl.sections.filter((s) => !s.ai).map((s) => titleCase(s.h)) });
    add({ id: `${g}-specs`, type: 'specs', group: g, kid: `${g}-specs`, kidLabel: T.specs, crumb, title: T.specs, intro: pl.h1.replace(/\n/g, ' '), plat: pl });
    pl.sections.filter((s) => !s.ai).forEach((sec) => {
      const key = `${g}-${slug(sec.h)}`, title = titleCase(sec.h);
      // 카드 밖에 있던 Amazon 안내 두 개를 해당 묶음에 넣는다
      const items = sec.items.slice();
      if (pl.extras && /^BASIC LISTING/.test(sec.h)) items.push({ callout: true, h: pl.extras.upgrade.h, p: pl.extras.upgrade.p });
      if (pl.extras && /^BASIC A\+/.test(sec.h)) items.unshift({ callout: true, h: pl.extras.aplus.h, p: pl.extras.aplus.p });
      const pages = []; let run = [];
      const flush = () => { if (!run.length) return; const n = Math.ceil(run.length / 3), base = Math.floor(run.length / n); let r = run.length % n, i = 0;
        for (let j = 0; j < n; j++) { const c = base + (r-- > 0 ? 1 : 0); pages.push({ type: 'modules', items: run.slice(i, i + c) }); i += c; } run = []; };
      items.forEach((it) => {
        const t = special(it);
        if (!t) { run.push(it); return; }
        flush();
        if (t === 'table' && it.notes.length && it.tables[0].length > 10) { pages.push({ type: 'table', item: it, only: 'table' }); pages.push({ type: 'table', item: it, only: 'notes' }); }
        else pages.push({ type: t, item: it });
      });
      flush();
      pages.forEach((pg, j) => add(Object.assign(pg, { id: `${key}${pages.length > 1 ? '-' + (j + 1) : ''}`, group: g, kid: key, kidLabel: title, crumb, title,
        intro: sec.pill, part: pages.length > 1 ? `${j + 1} / ${pages.length}` : '' })));
    });
  });
  // AI 이미지 생성 가이드
  {
    const g = 'ai', crumb = `${D.plats.length + 1}. ${aiSec.h}`, it = AI.item;
    add({ id: g, type: 'divider', nav: crumb, group: g, kicker: '', title: crumb, lead: aiSec.pill + '\n' + it.h, list: null });
    add({ id: 'ai-specs', type: 'table', item: it, only: 'table', group: g, kid: 'ai-specs', kidLabel: T.aiSpecs, crumb, title: T.aiSpecs, intro: it.h + ' — ' + it.sub, noHead: true });
    add({ id: 'ai-rules', type: 'table', item: it, only: 'notes', group: g, kid: 'ai-rules', kidLabel: T.aiRules, crumb, title: T.aiRules, intro: it.h + ' — ' + it.sub, noHead: true });
  }
  add({ id: 'end', type: 'outro', nav: T.end, group: 'end' });

  // 목차: 맨 위 묶음 + 그 아래 항목(같은 항목의 여러 쪽은 첫 쪽으로)
  const NAV = [];
  PAGES.forEach((p, i) => {
    if (p.nav) NAV.push({ group: p.group, label: p.nav, index: i, kids: p.type === 'divider' ? [] : null });
    else if (p.kid) { const top = NAV[NAV.length - 1]; if (!top.kids.some((k) => k.key === p.kid)) top.kids.push({ key: p.kid, label: p.kidLabel, index: i }); }
  });
  const num = (i) => String(i + 1).padStart(2, '0');
  const render = (p) => (R[p.type] || R.content)(p);

  // ── 화면 ──
  const $ = (id) => document.getElementById(id);
  const frame = $('frame'), box = $('frameBox'), nav = $('nav'), input = $('pageInput');
  let cur = 0;

  function drawNav() {
    nav.innerHTML = NAV.map((n) => {
      const kids = n.kids && n.kids.length ? `<div class="nav-kids">${n.kids.map((k) => `<button class="nav-kid" data-i="${k.index}" data-k="${k.key}"><span>${esc(k.label)}</span><span class="nav-num">${num(k.index)}</span></button>`).join('')}</div>` : '';
      return `<div><button class="nav-top" data-i="${n.index}" data-g="${n.group}"><span>${esc(n.label)}</span><span class="nav-num">${num(n.index)}</span></button>${kids}</div>`;
    }).join('');
  }
  function mark() {
    const p = PAGES[cur];
    nav.querySelectorAll('.nav-top').forEach((b) => b.classList.toggle('on', b.dataset.g === p.group));
    nav.querySelectorAll('.nav-kid').forEach((b) => b.classList.toggle('on', b.dataset.k === p.kid));
    const on = nav.querySelector('.nav-kid.on') || nav.querySelector('.nav-top.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function fit() {
    const stage = $('stage'), cs = getComputedStyle(stage);
    const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 80;
    const s = Math.max(0.1, Math.min(availW / 1920, availH / 1080));
    frame.style.transform = `scale(${s})`;
    box.style.width = `${1920 * s}px`; box.style.height = `${1080 * s}px`;
  }
  const BASE_TITLE = T.doc;
  document.documentElement.lang = LANG;
  $('pdfBtn').textContent = T.pdf; $('openBtn').textContent = T.open; $('hint').textContent = T.hint;
  $('menuBtn').setAttribute('aria-label', T.menu); $('prevBtn').setAttribute('aria-label', T.prev); $('nextBtn').setAttribute('aria-label', T.next);
  input.setAttribute('aria-label', T.page); $('side').setAttribute('aria-label', T.nav);
  document.querySelectorAll('.lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === LANG); b.setAttribute('aria-pressed', String(b.dataset.lang === LANG));
    // 같은 쪽 번호로 다른 언어를 연다 (두 언어의 쪽 구성은 같다)
    b.addEventListener('click', () => { if (b.dataset.lang === LANG) return; try { localStorage.setItem('guideLang', b.dataset.lang); } catch (e) {}
      location.href = `?lang=${b.dataset.lang}#${cur + 1}`; });
  });
  function go(i, push) {
    cur = Math.max(0, Math.min(PAGES.length - 1, i));
    const p = PAGES[cur];
    frame.innerHTML = render(p);
    box.classList.toggle('dark', ['cover', 'divider', 'toc', 'outro'].includes(p.type));
    input.value = String(cur + 1);
    $('prevBtn').disabled = cur === 0; $('nextBtn').disabled = cur === PAGES.length - 1;
    document.title = (cur ? `${p.title || p.nav} — ` : '') + BASE_TITLE;
    const h = '#' + p.id;
    if (location.hash !== h) (push ? history.pushState : history.replaceState).call(history, null, '', h);
    mark();
    document.body.classList.remove('menu-open'); $('menuBtn').setAttribute('aria-expanded', 'false');
  }
  const fromHash = () => { const id = decodeURIComponent(location.hash.slice(1)); const k = PAGES.findIndex((p) => p.id === id || String(p.index + 1) === id); return k < 0 ? 0 : k; };

  drawNav();
  $('pageTotal').textContent = `/ ${PAGES.length}`;
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) go(+b.dataset.i, true); });
  $('prevBtn').addEventListener('click', () => go(cur - 1, true));
  $('nextBtn').addEventListener('click', () => go(cur + 1, true));
  input.addEventListener('change', () => { const n = parseInt(input.value, 10); if (n >= 1 && n <= PAGES.length) go(n - 1, true); else input.value = String(cur + 1); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(cur + 1, true); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1, true); }
    else if (e.key === 'Home') go(0, true); else if (e.key === 'End') go(PAGES.length - 1, true);
  });
  window.addEventListener('popstate', () => go(fromHash(), false));
  window.addEventListener('resize', fit);
  $('menuBtn').addEventListener('click', () => { const o = document.body.classList.toggle('menu-open'); $('menuBtn').setAttribute('aria-expanded', String(o)); });

  // PDF: 모든 쪽을 한 장씩 인쇄용으로 그린 뒤 브라우저 인쇄(PDF 저장)
  $('pdfBtn').addEventListener('click', () => {
    $('printPages').innerHTML = PAGES.map((p) => `<div class="pp">${render(p)}</div>`).join('');
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(() => window.print(), 150));
  });
  window.addEventListener('afterprint', () => { $('printPages').innerHTML = ''; });

  go(fromHash(), false);
  fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
})();
