/* bulk.js — Shopee / Lazada 벌크 엑셀 (2026-11-18 · 일괄 등록·확인 필요·알림 2026-11-19)
   빌더의 "Bulk Excel" 버튼이 이 화면을 빌더 위에 띄운다 (?embed=1&channel=&lang=&corp=). 메일 링크는 ?job= 로 연다.
   첨부 → 인식·매칭 → (CLIA 에 없는 상품은 같은 나라 LG.com 에서 찾아 일괄 등록할지 선택) → 고르기 → 내보내기.
   확인 필요(크롤 실패·원문 누락·동영상 장면 자동 선택·Shopee 12장 초과·요약 실패·모델명 추정)는 맨 위 빨간색 + 바로 할 일.
   문구: bulk-i18n.js. 서버: bulk-routes.js · bulk-jobs.js */
(function () {
  const TX = window.BULK_TX;
  const qs = new URLSearchParams(location.search);
  const L = TX[qs.get('lang')] ? qs.get('lang') : 'en';
  const T = TX[L];
  // 채널을 정해서 열었으면(CLIA·빌더의 Shopee / Lazada 버튼) 안내 문구의 'Shopee / Lazada' 를 그 채널 하나로 쓴다 (2026-11-19)
  const ONE_CH = { shopee: 'Shopee', lazada: 'Lazada' }[qs.get('channel')] || '';
  const oneCh = (v) => (!ONE_CH ? v : typeof v === 'string' ? v.replace(/Shopee-\/Lazada-/g, ONE_CH + '-').replace(/Shopee\s*[\/·]\s*Lazada/g, ONE_CH) : Array.isArray(v) ? v.map(oneCh) : v);
  const t = (k, ...a) => { const v = T[k] ?? TX.en[k]; return oneCh(typeof v === 'function' ? v(...a) : v); };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} } };
  const api = async (p, body) => {
    const r = await fetch(p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { code: d.code });
    return d;
  };
  const EMBED = qs.get('embed') === '1';
  const cName = (c) => ((T.cn || TX.en.cn)[c]) || String(c || '').toUpperCase();
  let home = String(qs.get('corp') || '').toLowerCase();
  const DIVS = ['MS', 'HS', 'ES'];
  const GRPS = { MS: ['TV', 'Audio', 'Monitor', 'Laptop', 'Projector', 'Other'], HS: ['Fridge', 'Washer', 'Dryer', 'Vacuum', 'Dishwasher', 'Cooking', 'Styler', 'Other'], ES: ['AC', 'Purifier', 'Dehumidifier'] };
  const grpName = (g) => (T.grp || TX.en.grp)[g] || g;
  const CH0 = ['shopee', 'lazada'].includes(qs.get('channel')) ? qs.get('channel') : '';
  const chName = (c) => (c === 'lazada' ? 'Lazada' : 'Shopee');
  const S = { tab: 'all', q: '', last: null, mis: '', data: null, channel: CH0, ok: [], reg: [], skip: [], regOn: false, own: {}, pick: {}, fixed: {}, draft: {}, uerr: {}, skuIn: {}, openG: null, edits: {}, editsLoaded: false, sel: new Set(), force: new Set(), redo: new Set(), ack: new Set(), job: null, busy: false, cfg: {} };
  const act = () => S.ok.concat(S.reg.filter((r) => S.regOn || S.own[r.row]));
  // 매칭 불가 = CLIA 가 건드리지 않는 행: 제품을 못 정한 행 + (등록을 켜지 않았으면) CLIA 에 없는 행
  const noMatch = () => S.skip.concat(S.regOn ? [] : S.reg.filter((r) => !S.own[r.row]).map((r) => ({ ...r, why: 'rReg' })));

  document.documentElement.lang = L;
  document.documentElement.dir = L === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i); });
  function chTag() { $('chTag').textContent = chName(S.channel); $('chTag').classList.toggle('hidden', !S.channel); }
  chTag();
  api('/api/v1/bulk/config').then((c) => { S.cfg = c; if (S.data) refresh(); }).catch(() => {});
  $('close').onclick = () => {
    if (EMBED && parent !== window) parent.postMessage('clia-bulk-close', '*');   // 작업은 서버에서 계속된다
    else if (history.length > 1) history.back(); else location.href = '/clia/';
  };
  const show = (id) => ['s1', 's2', 's3'].forEach((x) => $(x).classList.toggle('hidden', x !== id));

  // ── 1. 첨부 ──
  const drop = $('drop'), file = $('file');
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) attach(e.dataTransfer.files[0]); };
  file.onchange = () => { if (file.files[0]) attach(file.files[0]); file.value = ''; };
  $('again').onclick = () => { if (!S.busy) file.click(); };

  function fail(code, extra) {
    const [title, body] = T['e_' + code] || TX.en['e_' + code] || T.e_other;
    show('s1');
    $('et').textContent = title.replace('{n}', (extra && extra.maxMb) || 40);
    $('eb').textContent = body || (extra && extra.error) || '';
    $('ef').textContent = (extra && extra.fileName) || '';
    $('ecard').classList.remove('hidden');
  }
  // 고른 나라와 다른 엑셀 (bulk-country.js): 왜 그렇게 봤는지 + 고른 나라의 템플릿을 올리라는 안내
  function wrongCountry(d, fileName) {
    const ch = S.channel === 'lazada' ? 'Lazada' : S.channel === 'shopee' ? 'Shopee' : 'Shopee / Lazada';
    const det = d.detected === 'other' ? '' : cName(d.detected);
    const why = d.by === 'history' ? t('wcHist', d.n, d.all, det) : d.by === 'sku' ? t('wcSku', d.n, det, d.ex || '')
      : d.detected === 'other' ? t('wcNotThai', d.n, d.all) : t('wcThai', d.n, d.all);
    show('s1');
    $('et').textContent = det ? t('wcT', det) : t('wcNotThT');
    $('eb').textContent = why + ' ' + t('wcTail', cName(home), ch);
    $('ef').textContent = fileName || '';
    $('ecard').classList.remove('hidden');
  }
  async function attach(f) {
    if (S.busy) return;
    $('ecard').classList.add('hidden'); $('resume').classList.add('hidden');
    $('pfile').textContent = f.name; $('pmsg').textContent = t('reading');
    show('s2');
    const t0 = Date.now();
    const req = fetch(`/api/v1/bulk/upload?name=${encodeURIComponent(f.name)}&country=${encodeURIComponent(home)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })
      .then(async (r) => {
        const d = await r.json().catch(() => ({ code: r.status === 413 ? 'too_big' : 'other' }));
        if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { code: d.code || 'other', maxMb: d.maxMb, info: d });
        return d;
      });
    try {
      await Promise.race([sleep(900), req.catch(() => {})]);
      await sleep(Math.max(0, 900 - (Date.now() - t0)));
      $('pmsg').textContent = t('matching');
      const d = await req;
      await sleep(Math.max(0, 2000 - (Date.now() - t0)));
      if (!d.looksLikeMarket) return fail('notMarket', { fileName: f.name });
      if (!d.rows.length) return fail('noRows', { fileName: f.name });
      S.mis = CH0 && d.channel && d.channel !== CH0 ? d.channel : '';
      S.channel = S.mis ? '' : (CH0 || d.channel || '');
      chTag();
      Object.assign(S, { job: null, q: '', last: null, regOn: false, own: {}, pick: {}, fixed: {}, draft: {}, uerr: {}, skuIn: {}, openG: null, edits: {}, editsLoaded: false, force: new Set(), redo: new Set(), ack: new Set() });
      $('q').value = '';
      setData(d, true);
      askRegister();
    } catch (e) {
      if (e.code === 'wrong_country') return wrongCountry(e.info || {}, f.name);
      fail(e.code || 'other', { maxMb: e.maxMb, error: e.message, fileName: f.name });
    }
  }

  // 행 나누기: CLIA 제품 하나에 딱 맞음(ok) · 같은 나라 LG.com 에서 찾음(reg, 등록 후보) · 그 밖(skip)
  // 묶음 상품 ('A + B' SKU): 구성품을 모두 찾았으면 빌더 번들처럼 합쳐서 채운다 — 등록이 필요한 구성품이 있으면 '등록하고 채우기' 쪽
  const bundleP = (r) => { const ps = r.bundleParts; return { slug: null, isBundle: true, parts: ps, model: ps.map((x) => x.model || '?').join(' + '),
    dv: ps[0].dv, grp: ps[0].grp, title: r.name, thumb: (ps.find((x) => x.thumb) || {}).thumb || '', isNew: ps.some((x) => x.register), fuzzy: ps.some((x) => x.fuzzy) }; };
  const newP = (r, lg) => ({ slug: null, url: lg.url, model: lg.model, dv: lg.dv, grp: lg.grp, title: r.name, thumb: '', isNew: true, alts: lg.alts || 0, fuzzy: !!lg.fuzzy });
  // 사은품 묶음 행 ('본 제품 … ฟรี 사은품 …'): 'ฟรี/free' 앞에 모델명이 있는 후보가 딱 하나면 그 제품이 본 제품 (2026-11-23)
  const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function giftMain(r, c) {
    const m = String(r.name || '').match(/^(.*?)(?:ฟรี|\bfree\b)/i);
    if (!m || !m[1].trim()) return null;
    const before = norm(m[1]);
    const hit = c.filter((p) => p.model && before.includes(norm(p.model)));
    const best = hit.filter((p) => !hit.some((q) => q !== p && norm(q.model).includes(norm(p.model)) && norm(q.model) !== norm(p.model)));
    return best.length === 1 ? best[0] : null;
  }
  function setData(d, fresh) {
    S.data = d;
    if (!home) {   // 법인 나라를 모르면 매칭된 제품이 가장 많은 나라
      const cnt = {};
      d.rows.forEach((r) => r.candidates.forEach((s) => { const c = d.products[s] && d.products[s].country; if (c) cnt[c] = (cnt[c] || 0) + 1; }));
      home = (Object.entries(cnt).sort((a, b) => b[1] - a[1])[0] || [''])[0];
    }
    S.ok = []; S.reg = []; S.skip = [];
    for (const r of d.rows) {
      let c = r.candidates.map((s) => d.products[s]).filter(Boolean);
      if (home) c = c.filter((p) => p.country === home);
      const own = S.own[r.row];
      if (r.bundle && r.bundleParts) (r.bundleParts.some((x) => x.register) ? S.reg : S.ok).push({ ...r, kind: 'bundle', p: bundleP(r) });
      else if (r.bundle) S.skip.push({ ...r, why: 'rBundle' });
      else if (c.length === 1) S.ok.push({ ...r, p: c[0], kind: 'clia' });
      else if (c.length > 1) { const pk = c.find((p) => p.slug === S.pick[r.row]) || giftMain(r, c); if (pk) S.ok.push({ ...r, p: pk, kind: 'clia', gift: !S.pick[r.row] }); else S.skip.push({ ...r, why: 'rMulti' }); }
      // 'SKU 번호가 비어 있음' 행을 여기서 주소로 해결했으면 SKU 번호도 넣어야 끝 (상품명으로 자동으로 찾은 행 · 예전 작업은 그대로)
      else if (own && S.fixed[r.row] && !r.lg && !hasSku(r) && !S.skuIn[r.row]) S.skip.push({ ...r, why: 'rNone', half: own });
      else if (own || r.lg) S.reg.push({ ...r, kind: 'new', p: newP(r, own || r.lg) });
      else S.skip.push({ ...r, why: 'rNone' });
    }
    if (fresh) S.sel = new Set(S.ok.map((r) => r.row).concat(S.reg.map((r) => r.row)));
    if (!S.editsLoaded) { S.editsLoaded = true; loadEdits(); }
    show('s3');
    render(fresh);
  }

  $('descSel').onchange = async () => {
    const v = +$('descSel').value;
    if (!v) return;
    try { setData(await api('/api/v1/bulk/analyze', { id: S.data.id, sheet: S.data.sheet, cols: { desc: v }, country: home }), false); } catch (e) { alert(e.message); }
  };
  $('askMis').onclick = (e) => { const c = e.target.closest('button'); if (c && c.dataset.ch && !S.busy) { S.channel = c.dataset.ch; chTag(); render(); } };
  $('askCh').onclick = (e) => { const c = e.target.dataset && e.target.dataset.ch; if (c) { S.channel = c; chTag(); render(); } };

  // ── 확인 필요 ──
  const itemOf = (row) => S.job && S.job.items && S.job.items.find((x) => x.row === row);
  // 확인 필요 = 다른 제품일 수 있거나 다시 돌리면 고쳐질 수 있는 것. 그대로 써도 되는 것(장면 자동 선택 · 글 일부 누락)은 작은 안내
  const normFlag = (f) => (f.code === 'frame' ? { ...f, sev: 'info' } : f.code === 'qa' && !f.images ? { ...f, code: 'qaTx', sev: 'info' } : f);   // 예전 작업 기록 호환
  const slugOfRow = (row) => { const r = S.ok.find((x) => x.row === row) || S.reg.find((x) => x.row === row); return r && r.p && r.p.slug; };
  const editOf = (row) => { const sl = slugOfRow(row); return (sl && S.edits[sl]) || null; };
  // 편집본을 저장한 뒤 LG.com 내용이 바뀐 제품 → 확인 필요 (편집본은 덮어쓰지 않으므로 새 내용이 묻힘, 2026-11-23)
  const flagsOf = (row) => ((itemOf(row) || {}).flags || []).map(normFlag).concat((editOf(row) || {}).changed ? [{ code: 'editChanged', sev: 'warn' }] : []);
  const openFlags = (row) => flagsOf(row).filter((f) => f.sev !== 'info' && !S.ack.has(`${row}:${f.code}`));
  const flagText = (f) => ({ editChanged: () => t('f_editChanged'), bundle: () => t('f_bundle', f.n), crawl: () => t('f_crawl'), content: () => t('f_content'), qa: () => t('f_qa', f.images), qaTx: () => t('f_qaTx', f.texts), frame: () => t('f_frame', f.n),
    over12: () => t('f_over12', f.all), summary: () => t('f_summary'), fuzzy: () => t('f_fuzzy'), alts: () => t('f_alts', f.n) }[f.code] || (() => f.code))();
  const builderUrl = (u) => `/shopee-lazada-pdp/index.html?url=${encodeURIComponent(u || '')}&channel=${S.channel || 'shopee'}&lang=${L}`;
  const reviewRows = () => act().filter((r) => openFlags(r.row).length);
  // 다시 돌리면 고쳐지는 것: LG.com 페이지 · 이미지 누락은 다시 가져오고, 설명 · 요약은 다시 만든다
  const RETRY = { crawl: 'a_retry', content: 'a_retry', summary: 'a_retry', qa: 'a_refetch' };
  // 행 오른쪽 = 네 칸 (목록 머리: 상태 · 확인 필요 내용 · Next step · 직접 편집하기, 2026-11-24)
  //   상태: 매칭 완료 / 확인 필요 (작업 중이면 대기 · 가져오는 중 · 만드는 중 · 실패). 확인 필요 내용: 이유 하나.
  //   Next step: 버튼은 많아야 하나 (다시 가져오기 · 다시 시도 · 편집본 그대로 · 문제없음 · 되돌리기). 편집: 모든 행 같은 자리
  function itemStatus(r, isRv) {
    const it = itemOf(r.row), fl = openFlags(r.row);
    let state = `<span class="badge ${isRv ? 'b-bad' : 'b-ok'}">${esc(t(isRv ? 'tabReview' : 'tabOk'))}</span>`, why = '', ac = '';
    if (it && it.status === 'queued') state = `<span class="badge b-q">${esc(it.register && !it.crawled ? t('st_regq') : t('q'))}</span>`;
    else if (it && it.status === 'crawling') state = `<span class="badge b-run">${esc(t('st_crawl'))}</span>`;
    else if (it && it.status === 'working') state = `<span class="badge b-run">${esc(t('w'))}</span>`;
    else if (it && it.status === 'failed') state = `<span class="badge b-bad">${esc(t('bad'))}</span>`;
    else if (it && it.status === 'cancelled') state = `<span class="badge b-q">${esc(t('st_stop'))}</span>`;
    if (S.force.has(r.row) || S.redo.has(r.row)) why = `<span class="note">${esc(t('a_retryNote'))}</span>`;
    else if (fl.length) {
      const f = fl[0];
      const fix = RETRY[f.code] ? `<button class="mini" data-a="retry" data-row="${r.row}" data-code="${f.code}">${esc(t(RETRY[f.code]))}</button>`
        : f.code === 'editChanged' ? `<button class="mini" data-a="keepEdit" data-url="${esc(r.p.url)}">${esc(t('a_keepEdit'))}</button>` : '';
      const ack = f.sev === 'warn' && f.code !== 'editChanged';
      why = `<span class="why"${f.files && f.files.length ? ` title="${esc(f.files.join(', '))}"` : ''}>${esc(flagText(f))}` +
        (fix && ack ? `<button class="x" data-a="ack" data-row="${r.row}" data-code="${f.code}" title="${esc(t('a_ack'))}" aria-label="${esc(t('a_ack'))}">×</button>` : '') + '</span>';
      ac = fix || (ack ? `<button class="mini" data-a="ack" data-row="${r.row}" data-code="${f.code}">${esc(t('a_ack'))}</button>` : '');
    }
    // 매칭 불가에서 해결한 행(주소 · 후보 · 등록): 되돌리기
    if (!ac && S.fixed[r.row]) ac = `<button type="button" class="mini un" data-undo="${r.row}">${esc(t('undo'))}</button>`;
    const pen = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
    const edit = r.p && r.p.url && !r.p.isBundle ? `<button type="button" class="eb" data-a="edit" data-url="${esc(r.p.url)}" title="${esc(t('a_editTip'))}">${pen}${esc(t('a_edit'))}</button>` : '';
    return `<span class="c-state">${state}</span><span class="c-why">${why}</span><span class="c-ac">${ac}</span><span class="c-ed">${edit}</span>`;
  }

  // ── 3. 목록 ──
  function estMin(nNew, nAll) {
    const c = S.cfg.crawlConc || 2, sc = S.cfg.secPerCrawl || 55, si = S.cfg.secPerItem || 15;
    return Math.max(1, Math.round((nNew * sc / c + nAll * si / 2) / 60));
  }
  function render(animate) {
    const d = S.data;
    $('askCh').classList.toggle('hidden', !!S.channel || !!S.mis);
    $('askMis').classList.toggle('hidden', !S.mis || !!S.channel);
    if (S.mis) {
      $('misT').textContent = t('misT', chName(S.mis), chName(CH0)); $('misB').textContent = t('misB');
      $('misA').textContent = t('useAs', chName(S.mis)); $('misA').dataset.ch = S.mis;
      $('misB2').textContent = t('useAs', chName(CH0)); $('misB2').dataset.ch = CH0;
    }
    const rows = act();
    // CLIA 에 없지만 같은 나라 LG.com 에 있는 상품 → 한 줄 + 버튼 하나 (켜면 등록하고 함께 채운다)
    const nReg = S.reg.filter((r) => !S.own[r.row]).length;
    $('regCard').classList.toggle('hidden', !nReg || !d.site);
    if (nReg && d.site) {
      $('regCard').classList.toggle('on', S.regOn);
      $('regT').textContent = t('regSw', nReg);
      $('regBtn').setAttribute('aria-checked', String(S.regOn));
      $('regBtn').disabled = S.busy;
    }
    $('noMatch').classList.toggle('hidden', rows.length > 0 || S.reg.length > 0);
    $('noMatchT').textContent = t('noMatchT'); $('noMatchB').textContent = t('noMatchB');
    $('askDesc').classList.toggle('hidden', !!d.cols.desc);
    if (!d.cols.desc) $('descSel').innerHTML = '<option value="">—</option>' + d.columns.map((c) => `<option value="${c.col}">${c.letter} · ${esc(c.label)}</option>`).join('');
    $('pFile').textContent = d.fileName || '';
    // 표 하나 (2026-11-24): 확인 필요 → 매칭 불가(이유 순서로 모음) → 매칭 완료. 탭은 이 표를 거르기만 한다
    const rv = new Set(reviewRows().map((r) => r.row));
    const ordered = rows.slice().sort((a, b) => (rv.has(b.row) - rv.has(a.row)));
    const nRv = ordered.filter((r) => rv.has(r.row)).length;
    const nm = noMatch().slice().sort((a, b) => G_ORDER.indexOf(groupOf(a)) - G_ORDER.indexOf(groupOf(b)));
    const anim = (i) => (animate ? `animation-delay:${Math.min(i, 30) * 45}ms` : 'animation:none');
    const rowHtml = (r, i) => `<div class="item${rv.has(r.row) ? ' rv' : ''}${DW.row === r.row ? ' cur' : ''}" data-r="${r.row}" style="${anim(i)}">` +
      `<input type="checkbox" data-row="${r.row}">` +
      ((r.p.thumb || (itemOf(r.row) || {}).thumb) ? `<img src="${esc(r.p.thumb || itemOf(r.row).thumb)}" alt="" loading="lazy">` : `<div class="ph">${esc(grpName(r.p.grp))}</div>`) +
      `<div class="m">${r.p.isBundle ? `<span class="badge b-q">${esc(t('bundleTag'))}</span> ` : ''}${esc(r.p.model)}${r.gift ? `<span class="badge b-q">${esc(t('giftTag'))}</span>` : ''}${r.p.slug && S.edits[r.p.slug] ? `<span class="badge b-ed">${esc(t('editedTag'))}</span>` : ''}</div>` +
      `<div class="bu">${esc([r.p.dv, grpName(r.p.grp)].filter(Boolean).join(' · ') || '—')}</div>` +
      `<div class="s pn" title="${esc(r.name || r.p.title)}">${esc(r.name || r.p.title)}</div><div class="r"></div></div>`;
    $('list').innerHTML = ordered.slice(0, nRv).map(rowHtml).join('') + nm.map((r, i) => nmRowHtml(r, anim(nRv + i))).join('') +
      ordered.slice(nRv).map((r, i) => rowHtml(r, nRv + nm.length + i)).join('');
    if (!rows.length && noMatch().length) S.tab = 'skip';
    refresh();
  }

  const hasSku = (r) => /[\p{L}\p{N}]/u.test(r.parentSku || r.sku || '');
  const G_ORDER = ['gUrl', 'gNoSku', 'gMulti', 'gReg', 'gBundle', 'gNone'];
  const groupOf = (r) => (r.why === 'rNone' ? (S.data.site ? (hasSku(r) ? 'gUrl' : 'gNoSku') : 'gNone')
    : ({ rMulti: 'gMulti', rReg: 'gReg', rBundle: 'gBundle' }[r.why] || 'gNone'));
  const candsOf = (r) => r.candidates.map((x) => S.data.products[x]).filter((p) => p && (!home || p.country === home));
  // 매칭 불가 행: 제품 칸 = 엑셀 SKU (비어 있으면 넣은 SKU 또는 'SKU 번호 없음')
  const skuCell = (r) => (hasSku(r) ? `<span class="k">${esc(r.parentSku || r.sku)}</span>`
    : S.skuIn[r.row] ? `<span class="k">${esc(S.skuIn[r.row])}</span>` : `<span class="k nosku">${esc(t('skuEmpty'))}</span>`);
  // SKU 번호가 비어 있는 행: SKU 번호 칸 (엑셀 SKU 칸에 적는다 · 그 SKU 로 LG.com 제품도 찾는다)
  const skuInput = (r) => `<input type="text" class="skuin" autocomplete="off" spellcheck="false" data-skurow="${r.row}" value="${esc(S.skuIn[r.row] || '')}" placeholder="${esc(t('skuPh'))}" aria-label="${esc(t('skuPh'))} — ${esc(r.name)}">`;
  const whyCell = (g) => `<span class="sw2">${esc(t(g))}${g === 'gNoSku' ? `<i>${esc(skuColName())}</i>` : ''}</span>`;
  function skuColName() {
    const ci = S.data.cols.parentSku || S.data.cols.sku, cc = (S.data.columns || []).find((c) => c.col === ci);
    return (S.data.cols.parentSku ? 'Parent SKU' : 'SKU') + (cc ? ` (${cc.letter})` : '');
  }
  const catOf = (p) => { const seg = String(p.url || '').split('/').filter(Boolean); return seg.length > 2 ? seg[seg.length - 2] : ''; };   // LG.com 카테고리
  function nmRowHtml(r, style) {
    const g = groupOf(r);
    let ac = '';
    if (g === 'gUrl' || g === 'gNoSku') {
      // SKU 번호가 비어 있음: SKU 번호 칸 + 주소 칸 (주소로 제품을 이미 찾았으면 ✓ 제품 · 되돌리기)
      ac = (g === 'gNoSku' ? skuInput(r) : '') +
        (r.half ? `<span class="okt">✓ ${esc(r.half.model || '')} <button type="button" class="lnk" data-undo="${r.row}">${esc(t('undo'))}</button></span>`
          : `<input type="url" inputmode="url" autocomplete="off" spellcheck="false" data-urow="${r.row}" value="${esc(S.draft[r.row] || '')}" placeholder="${esc(t('urlPh'))}" aria-label="${esc(t('urlPh'))} — ${esc(r.parentSku || r.sku || r.name)}">`) +
        `<span class="ust" data-ust="${r.row}" role="status" aria-live="polite">${S.uerr[r.row] ? esc(t('urlBad', S.data.site || home)) : ''}</span>`;
    } else if (g === 'gMulti') {
      // 같은 모델이 LG.com 카테고리 두 곳에 있으면(예: 2-door-refrigerator · top-freezer) 버튼이 똑같아 보인다 — 카테고리를 붙인다
      const cs = candsOf(r), dupe = (p) => cs.filter((x) => x.model === p.model).length > 1;
      ac = cs.map((p) => `<button type="button" class="pick" data-pick="${r.row}" data-slug="${esc(p.slug)}" title="${esc((p.title || p.model) + (p.url ? '\n' + p.url : ''))}">` +
        `${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : ''}${esc(p.model)}${dupe(p) && catOf(p) ? `<span class="pc">${esc(catOf(p))}</span>` : ''}</button>`).join('');
    } else if (g === 'gReg' && r.lg) {
      ac = `<button type="button" class="mini" data-regrow="${r.row}"${S.busy ? ' disabled' : ''}>${esc(t('regRow'))}</button>`;
    } else ac = `<span class="leave">${esc(t('leaveAs'))}</span>`;
    return `<div class="item nm${S.uerr[r.row] ? ' bad' : ''}${DW.row === r.row ? ' cur' : ''}" data-nm="${r.row}" style="${style}"><span class="cbx"></span><div class="ph">—</div>` +
      `<div class="m">${skuCell(r)}</div><div class="bu">—</div><div class="s pn" title="${esc(r.name)}">${esc(r.name)}</div>` +
      `<div class="r"><span class="c-state"><span class="badge b-q">${esc(t('tabSkip'))}</span></span><span class="c-why">${whyCell(g)}</span><span class="c-ac">${ac}</span><span class="c-ed"></span></div></div>`;
  }
  // 해결한 뒤: 다음 빈 주소 칸으로 (없으면 그대로)
  function focusNext(afterRow) {
    const ins = [...document.querySelectorAll('#list .item:not(.hidden) input[data-urow]')];
    const next = ins.find((x) => +x.dataset.urow > afterRow && !x.value) || ins.find((x) => !x.value);
    if (next) next.focus({ preventScroll: false });
  }

  function refresh() {
    const rows = act();
    const nSel = (rs) => rs.filter((r) => S.sel.has(r.row)).length;
    const cbOf = (k, n) => (k === 0 ? '' : (k === n ? 'on' : 'part'));
    const ariaOf = (k, n) => (k === 0 ? 'false' : (k === n ? 'true' : 'mixed'));
    const ofDv = (dv) => rows.filter((r) => r.p.dv === dv);
    const ofGrp = (dv, g) => rows.filter((r) => r.p.dv === dv && r.p.grp === g);
    const hit = (r) => !S.q || [r.p.model, r.name, r.sku, r.parentSku, r.p.title, r.id].join(' ').toLowerCase().includes(S.q);
    const chev = '<svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
    const ddLabel = (key, v) => `<span class="k">${esc(t(key))}</span><span class="v">${esc(v)}</span>${chev}`;
    // 본부: 하나 또는 여러 개 — 고르면 그 본부 상품이 선택된다
    const dvs = DIVS.filter((dv) => ofDv(dv).length);
    const dvK = Object.fromEntries(dvs.map((dv) => [dv, nSel(ofDv(dv))]));
    const dvOn = dvs.filter((dv) => dvK[dv] > 0);
    $('dvBtn').innerHTML = ddLabel('dvBtn', dvs.every((dv) => dvK[dv] === ofDv(dv).length) ? t('ddAll') : (!dvOn.length ? t('ddNone') : dvOn.join(', ')));
    $('dvPop').innerHTML = dvs.map((dv) => { const n = ofDv(dv).length;
      return `<button class="opt" role="menuitemcheckbox" aria-checked="${ariaOf(dvK[dv], n)}" data-dv="${dv}"${S.busy ? ' disabled' : ''}><span class="cb ${cbOf(dvK[dv], n)}"></span>${esc(dv)}<span class="n">${dvK[dv]}/${n}</span></button>`; }).join('');
    // 제품군: 목록 전체를 보여 주고, 선택한 본부의 제품군만 고를 수 있다 (나머지는 회색)
    const gs = dvs.flatMap((dv) => GRPS[dv].filter((g) => ofGrp(dv, g).length).map((g) => [dv, g]));
    const gK = gs.map(([dv, g]) => nSel(ofGrp(dv, g)));
    $('grpBtn').innerHTML = ddLabel('grpBtn', gs.every(([dv, g], i) => gK[i] === ofGrp(dv, g).length) ? t('ddAll') : (gK.some((k) => k) ? t('ddN', gK.filter((k) => k).length) : t('ddNone')));
    $('ctl2').innerHTML = `<div class="hint">${esc(t('grpHint'))}</div>` + dvs.map((dv) => `<div class="gh">${esc(dv)}</div>` +
      gs.map(([d, g], i) => [d, g, i]).filter(([d]) => d === dv).map(([d, g, i]) => { const n = ofGrp(d, g).length;
        return `<button class="opt" role="menuitemcheckbox" aria-checked="${ariaOf(gK[i], n)}" data-dv="${d}" data-grp="${g}"${S.busy || !dvK[d] ? ' disabled' : ''}><span class="cb ${cbOf(gK[i], n)}"></span>${esc(grpName(g))}<span class="n">${gK[i]}/${n}</span></button>`; }).join('')).join('');
    $('dvBtn').disabled = $('grpBtn').disabled = S.busy;
    // 탭: 전체 · 확인 필요 · 매칭 완료 · 매칭 불가 — 세 상태는 겹치지 않고, 전체 = 세 상태의 합 (확인 필요는 빨간 숫자)
    const rvSet = new Set(reviewRows().map((r) => r.row));
    const rvN = rvSet.size, noN = noMatch().length, okN = rows.length - rvN;
    if ((S.tab === 'review' && !rvN) || (S.tab === 'ok' && !okN) || (S.tab === 'skip' && !noN)) S.tab = 'all';
    const tabs = [['all', t('tabAll'), rows.length + noN, ''], ['review', t('tabReview'), rvN, 'rv'], ['ok', t('tabOk'), okN, ''], ['skip', t('tabSkip'), noN, '']]
      .filter(([k, , n]) => k === 'all' || n);
    $('tabs').innerHTML = tabs.map(([k, label, n, cls]) => `<button class="tab ${cls}${S.tab === k ? ' on' : ''}" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${esc(label)}<b>${n}</b></button>`).join('');
    const inTab = (r) => S.tab === 'all' || (S.tab === 'review' && rvSet.has(r.row)) || (S.tab === 'ok' && !rvSet.has(r.row));
    const nmBy = new Map(noMatch().map((r) => [r.row, r]));
    const hitNm = (r) => !S.q || [r.name, r.sku, r.parentSku, r.id, S.skuIn[r.row]].join(' ').toLowerCase().includes(S.q);
    // 전체 선택 ↔ 해제: 버튼 하나 (지금 보이는 상품 — 탭 · 검색 결과 — 에만)
    const vis = rows.filter((r) => hit(r) && inTab(r)), vk = nSel(vis);
    $('selCb').className = 'cb ' + cbOf(vk, vis.length);
    $('selL').textContent = S.q ? t('qRes', vis.length) : t('selAll');
    $('selN').textContent = `${vk}/${vis.length}`;
    $('selAll').setAttribute('aria-pressed', String(vis.length > 0 && vk === vis.length));
    $('selAll').disabled = S.busy || !vis.length;
    document.querySelectorAll('#list .item').forEach((el) => {
      if (el.dataset.nm) { const r = nmBy.get(+el.dataset.nm); el.classList.toggle('hidden', !r || !hitNm(r) || !(S.tab === 'all' || S.tab === 'skip')); return; }
      const cb = el.querySelector('input[data-row]'), row = +cb.dataset.row;
      const r = rows.find((x) => x.row === row);
      if (!r) return;
      cb.checked = S.sel.has(row);
      cb.disabled = S.busy;
      el.classList.toggle('off', !S.sel.has(row));
      el.classList.toggle('hidden', !hit(r) || !inTab(r) || S.tab === 'skip');
      el.querySelector('.r').innerHTML = itemStatus(r, rvSet.has(row));
    });
    const anyRow = rows.length + noN > 0;
    $('lhead').classList.toggle('hidden', !anyRow || VIEW === 'grid');
    // 확인할 행이 없는 목록(매칭 완료 탭 · 확인 필요 · 매칭 불가가 없는 전체 탭)은 '확인 필요 내용 · Next step' 열을 뺀다
    const noAct = S.tab === 'ok' || (S.tab === 'all' && !rvN && !noN);
    $('lhead').classList.toggle('noact', noAct); $('list').classList.toggle('noact', noAct);
    $('list').classList.toggle('hidden', !anyRow);
    $('selbar').classList.toggle('hidden', !anyRow);
    // 상황판
    const c = rows.filter((r) => S.sel.has(r.row)), rep = c.filter((r) => r.descLen > 0).length;
    const nNew = c.filter((r) => r.kind === 'new').length;
    const j = S.job, running = j && j.status === 'running';
    if (running) {
      const crawling = j.crawlTotal && j.crawlDone < j.crawlTotal;
      $('info').textContent = crawling ? t('progCrawl', j.crawlDone, j.crawlTotal) : t('progMake', j.done, j.total);
      $('prog').firstElementChild.style.width = (100 * (crawling ? j.crawlDone / j.crawlTotal : j.done / Math.max(1, j.total))) + '%';
    } else if (j && j.status === 'ready' && sameAsJob()) $('info').innerHTML = `<span class="okline">${esc(t('doneShort', j.ok))}</span>` + apLine(j);
    else if (j && j.status === 'cancelled') $('info').innerHTML = `<span>${esc(t('stopped', j.ok || 0, j.total || (j.items || []).length))}</span>`;
    else if (j && j.status === 'failed') $('info').innerHTML = `<span style="color:var(--bad)">${esc(t('expFail') + (j.error || ''))}</span>`;
    else $('info').innerHTML = `<span>${t('info', c.length, rep)}</span>`;
    $('prog').classList.toggle('hidden', !running);
    $('stop').classList.toggle('hidden', !running); $('stop').textContent = t('stop');   // 진행 중일 때만 중단
    // 알림 고르기: 오래 걸릴 작업(새로 등록 포함 또는 상품 40개 초과)에만
    // 버튼 하나: 끝났고 선택이 그대로면 '엑셀 받기', 아니면 '내보내기 / 다시 내보내기 (N)' — 늘 같은 자리
    // 검토·승인 (approvals.js): 잠금이 켜져 있고 승인 전 상품이 있으면 엑셀 받기를 잠근다
    const apLock = !!(j && j.approval && j.approval.gate && j.approval.pending > 0);
    const dlNow = !!(j && j.status === 'ready' && !S.busy && sameAsJob() && !apLock);
    $('export').classList.toggle('hidden', dlNow || running);
    $('export').textContent = S.busy ? t('exporting') : (j && !running ? t('expAgain', c.length) : t('exp', c.length));
    $('export').disabled = S.busy || !c.length || !S.channel || !S.data.cols.desc;
    $('dl').classList.toggle('hidden', !dlNow);
    if (j && j.file) { $('dl').href = j.file; $('dl').setAttribute('download', j.fileName || 'clia-bulk.xlsx'); }
    $('again').disabled = S.busy;
    if (DW.row != null) fillDetail();
  }

  // 승인 전 상품 안내 줄 (잠금 켜짐: 엑셀 잠김 / 꺼짐: 알림만)
  function apLine(j) {
    const a = j && j.approval;
    if (!a || !a.pending) return '';
    return ` <span style="color:${a.gate ? 'var(--bad)' : 'var(--muted, #888)'}" title="${esc((a.models || []).join(', '))}">· ${esc(t(a.gate ? 'apPend' : 'apPendOff', a.pending))}</span>`;
  }
  // 넣은 SKU 번호 (SKU 번호가 비어 있던 행) → 엑셀 SKU 칸에
  const skuList = () => Object.entries(S.skuIn).filter(([, v]) => v);
  // 끝난 작업과 지금 선택이 같은지 (같으면 다시 만들 필요 없이 받기만)
  function sameAsJob() {
    const j = S.job;
    if (!j || !j.items || S.force.size || S.redo.size) return false;
    const rows = new Set(j.items.map((x) => x.row));
    const js = (j.skus || []).map((x) => `${x.row}:${x.sku}`).sort().join('|'), ns = skuList().map(([r, v]) => `${r}:${v}`).sort().join('|');
    return js === ns && rows.size === S.sel.size && [...S.sel].every((r) => rows.has(r));
  }
  // 탭
  const goTab = (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; refresh(); };
  $('tabs').onclick = goTab;
  $('info').addEventListener('click', (e) => { goTab(e); if (e.target.closest('[data-tab]')) $('tabs').scrollIntoView({ block: 'nearest' }); });
  // 펼침 메뉴: 제품군 · 알림 (바깥을 누르면 닫힘)
  const POPS = [['dvBtn', 'dvPop'], ['grpBtn', 'ctl2']];
  const closePops = (keep) => POPS.forEach(([b, x]) => { if (x !== keep) { $(x).classList.add('hidden'); $(b).setAttribute('aria-expanded', 'false'); } });
  const pop = (btn, box) => { $(btn).onclick = (e) => { e.stopPropagation(); closePops(box); const open = $(box).classList.toggle('hidden'); $(btn).setAttribute('aria-expanded', String(!open)); }; $(box).onclick = (e) => e.stopPropagation(); };
  POPS.forEach(([b, x]) => pop(b, x));
  document.addEventListener('click', () => closePops());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });
  // 선택
  const pickDv = (e) => {
    const b = e.target.closest('button[data-dv]');
    if (!b || b.disabled || S.busy) return;
    const rs = act().filter((r) => r.p.dv === b.dataset.dv && (!b.dataset.grp || r.p.grp === b.dataset.grp));
    const on = rs.every((r) => S.sel.has(r.row));
    rs.forEach((r) => (on ? S.sel.delete(r.row) : S.sel.add(r.row)));
    refresh();
  };
  $('dvPop').addEventListener('click', pickDv);
  $('ctl2').addEventListener('click', pickDv);
  $('selAll').onclick = () => {
    if (S.busy) return;
    const vis = [...document.querySelectorAll('#list .item:not(.hidden) input[data-row]')].map((x) => +x.dataset.row);
    const all = vis.length && vis.every((r) => S.sel.has(r));
    vis.forEach((r) => (all ? S.sel.delete(r) : S.sel.add(r)));
    refresh();
  };
  let shiftDown = false;
  $('list').addEventListener('click', (e) => { shiftDown = e.shiftKey; }, true);
  $('list').onchange = (e) => {
    const el = e.target;
    if (!el.dataset.row) return;
    const row = +el.dataset.row;
    const vis = [...document.querySelectorAll('#list .item:not(.hidden) input[data-row]')].map((x) => +x.dataset.row);
    const a = vis.indexOf(S.last), z = vis.indexOf(row);
    (shiftDown && a >= 0 && z >= 0 ? vis.slice(Math.min(a, z), Math.max(a, z) + 1) : [row]).forEach((x) => (el.checked ? S.sel.add(x) : S.sel.delete(x)));
    S.last = row;
    refresh();
  };
  // 확인 필요 항목의 할 일
  const saveAck = () => { if (S.job && S.job.id) store.set('clia-bulk-ack-' + S.job.id, [...S.ack]); };
  const onAct = (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    e.preventDefault();
    const row = +b.dataset.row;
    if (b.dataset.a === 'ack') { S.ack.add(`${row}:${b.dataset.code}`); saveAck(); render(false); }
    if (b.dataset.a === 'retry') { if (['crawl', 'qa'].includes(b.dataset.code)) S.force.add(row); else S.redo.add(row); S.ack.add(`${row}:${b.dataset.code}`); S.sel.add(row); saveAck(); render(false); }   // crawl · qa: LG.com 에서 다시 가져옴 / 그 밖: 다시 만듦
    if (b.dataset.a === 'frame') openFrames(b.dataset.slug);
    if (b.dataset.a === 'edit') openEditor(b.dataset.url);
    if (b.dataset.a === 'keepEdit') keepEdit(b.dataset.url, b);
  };
  $('list').addEventListener('click', onAct);
  $('dwBody').addEventListener('click', onAct);
  // 행을 누르면 상세 (체크 칸 · 버튼 · 입력 칸 · 링크는 그대로)
  $('list').addEventListener('click', (e) => {
    if (e.target.closest('input, button, a, select, textarea, label, .c-ac')) return;
    const el = e.target.closest('.item');
    if (el) openDetail(+(el.dataset.r || el.dataset.nm));
  });

  // ── 한 건 상세 (2026-11-24): 행을 누르면 오른쪽 패널 — 엑셀 정보 · 매칭된 LG.com 제품 · 확인 필요 · 엑셀에 들어갈 설명.
  //    설명은 끝난 작업이면 결과 엑셀의 그 칸 그대로 (/api/v1/bulk/jobs/:job/cell), 아니면 '내보내면 만들어짐'
  const DW = { row: null, idx: 0, cells: {} };
  const visRows = () => [...document.querySelectorAll('#list .item:not(.hidden)')].map((x) => +(x.dataset.r || x.dataset.nm));
  function openDetail(row) {
    DW.row = row;
    document.querySelectorAll('#list .item.cur').forEach((x) => x.classList.remove('cur'));
    const el = document.querySelector(`#list .item[data-r="${row}"], #list .item[data-nm="${row}"]`);
    if (el) el.classList.add('cur');
    $('dw').classList.remove('hidden');
    fillDetail();
    $('dwBody').scrollTop = 0;
    $('dwX').focus({ preventScroll: true });
  }
  function closeDetail() {
    DW.row = null;
    $('dw').classList.add('hidden');
    document.querySelectorAll('#list .item.cur').forEach((x) => x.classList.remove('cur'));
  }
  function stepDetail(d) {
    // 보던 행이 할 일(문제없음 · 다시 가져오기 등)로 지금 탭에서 빠졌으면, 그 자리에 들어온 행부터 이어서
    const vs = visRows(), i = vs.indexOf(DW.row);
    const to = i >= 0 ? vs[i + d] : vs[d > 0 ? DW.idx : DW.idx - 1];
    if (to != null) {
      openDetail(to);
      const el = document.querySelector(`#list .item.cur`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }
  $('dwX').onclick = closeDetail;
  $('dw').querySelector('.dw-bg').onclick = closeDetail;
  $('dwPrev').onclick = () => stepDetail(-1);
  $('dwNext').onclick = () => stepDetail(1);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && DW.row != null && $('edov').classList.contains('hidden')) closeDetail(); });
  $('dwInc').onchange = () => { if (DW.row == null) return; if ($('dwInc').checked) S.sel.add(DW.row); else S.sel.delete(DW.row); refresh(); };
  const dl = (pairs) => `<dl class="dw-dl">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  function fillDetail() {
    const row = DW.row, a = act().find((x) => x.row === row), nm = a ? null : noMatch().find((x) => x.row === row);
    const r = a || nm;
    if (!r) { closeDetail(); return; }
    const it = itemOf(row), rvRow = a && openFlags(row).length;
    const vs = visRows(), i = vs.indexOf(row);
    if (i >= 0) DW.idx = i;
    $('dwPrev').disabled = i >= 0 ? i <= 0 : DW.idx <= 0;
    $('dwNext').disabled = i >= 0 ? i >= vs.length - 1 : DW.idx >= vs.length;
    $('dwPos').textContent = i >= 0 ? `${i + 1} / ${vs.length}` : `– / ${vs.length}`;
    $('dwIncW').classList.toggle('hidden', !a);
    $('dwInc').checked = S.sel.has(row); $('dwInc').disabled = S.busy;
    const p = a ? r.p : {};
    const thumb = (p && p.thumb) || (it && it.thumb);
    const state = nm ? `<span class="badge b-q">${esc(t('tabSkip'))}</span>` : rvRow ? `<span class="badge b-bad">${esc(t('tabReview'))}</span>` : `<span class="badge b-ok">${esc(t('tabOk'))}</span>`;
    const pen = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
    const head = `<div class="dw-hd">${thumb ? `<img src="${esc(thumb)}" alt="">` : '<div class="ph">—</div>'}<div class="dw-ht">` +
      `<div class="dw-m">${a ? esc(p.model) : skuCell(r)}</div>` +
      `<div class="dw-sub">${a ? esc([p.dv, grpName(p.grp)].filter(Boolean).join(' · ')) : ''} ${state}${a && p.slug && S.edits[p.slug] ? ` <span class="badge b-ed">${esc(t('editedTag'))}</span>` : ''}</div>` +
      `<div class="dw-acts">${a && p.url ? `<a class="eb" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(t('dwLg'))} ↗</a>` : ''}` +
      `${a && p.url && !p.isBundle ? `<button type="button" class="eb" data-a="edit" data-url="${esc(p.url)}">${pen}${esc(t('a_edit'))}</button>` : ''}</div></div></div>`;
    // 엑셀 정보
    const sku = r.parentSku || r.sku ? esc(r.parentSku || r.sku) : S.skuIn[row] ? esc(S.skuIn[row]) : `<i class="mut">${esc(t('skuEmpty'))}</i>`;
    const cur = r.descLen ? `<div class="dw-cur">${esc(r.descHead || '')}${r.descLen > (r.descHead || '').length ? '…' : ''}</div>${nm ? '' : `<div class="dw-note">${esc(t('dwDescRep', r.descLen))}</div>`}` : `<i class="mut">${esc(t('dwDescNone'))}</i>`;
    const excel = `<section><h4>${esc(t('dwExcel'))}</h4>` + dl([[t('dwRow'), String(row)], r.id ? [t('dwId'), esc(r.id)] : null, ['SKU', sku], [t('hdName'), esc(r.name || '')], [t('dwDesc'), cur]]) + '</section>';
    // 확인 필요
    let check = '';
    if (nm) {
      check = `<section><h4>${esc(t('hdStatus'))}</h4><div class="dw-why">${whyCell(groupOf(nm))}</div><div class="dw-note">${esc(t('dwNmHint'))}</div></section>`;
    } else if (rvRow || S.force.has(row) || S.redo.has(row)) {
      const tmp = document.createElement('div'); tmp.innerHTML = itemStatus(r, !!rvRow);
      check = `<section><h4>${esc(t('hdStatus'))}</h4><div class="dw-why">${tmp.querySelector('.c-why').innerHTML}</div><div class="dw-ac">${tmp.querySelector('.c-ac').innerHTML}</div></section>`;
    }
    // 엑셀에 들어갈 설명
    let out;
    const j = S.job, inJob = it && j;
    if (nm) out = `<div class="dw-empty">${esc(t('dwOutNm'))}</div>`;
    else if (inJob && it.status === 'ok' && j.status === 'ready') {
      const c = DW.cells[`${j.id}:${row}`];
      if (c == null) {
        out = `<div class="dw-empty">${esc(t('checking'))}</div>`;
        DW.cells[`${j.id}:${row}`] = false;
        api(`/api/v1/bulk/jobs/${j.id}/cell?row=${row}`).then((d) => { DW.cells[`${j.id}:${row}`] = d.text || ''; }, () => { DW.cells[`${j.id}:${row}`] = 'ERR'; })
          .then(() => { if (DW.row === row) fillDetail(); });
      } else if (c === false) out = `<div class="dw-empty">${esc(t('checking'))}</div>`;
      else if (c === 'ERR') out = `<div class="dw-empty">${esc(t('dwOutFail'))}</div>`;
      else out = cellHtml(c);
      if (it.edited) out = `<div class="dw-note">${esc(t('dwEdited'))}</div>` + out;
    } else if (inJob && ['queued', 'crawling', 'working'].includes(it.status)) out = `<div class="dw-empty">${esc(t('dwOutRun'))}</div>`;
    else if (p.url && !p.isNew && !p.isBundle) out = previewHtml(p.url);   // CLIA 에 있는 제품: 내보내기 전 미리보기
    else out = `<div class="dw-empty">${esc(t('dwOutNot'))}</div>`;
    $('dwBody').innerHTML = head + check + excel + `<section><h4>${esc(t('dwOut'))}</h4>${out}</section>`;
    fitFrames();
  }
  // 결과 칸: Shopee = (요약 글 + 빈 줄) + 이미지 주소 한 줄에 하나 / Lazada = HTML
  function cellHtml(text) {
    const lines = String(text).split('\n');
    const isUrls = !/<[a-z][\s\S]*>/i.test(text);
    if (isUrls) {
      const urls = lines.filter((l) => /^https?:\/\/\S+$/.test(l.trim())).map((l) => l.trim());
      const words = lines.filter((l) => !/^https?:\/\/\S+$/.test(l.trim())).join('\n').trim();
      // 마켓 상세 페이지처럼 한 장으로: 요약 글 → 이미지를 위에서 아래로 이어 붙임 (2026-11-24)
      return `<div class="dw-meta">${esc(t('dwImgs', urls.length))} · ${esc(t('dwChars', text.length))}</div>` +
        `<div class="dw-page">${words ? `<div class="dw-sum">${esc(words)}</div>` : ''}` +
        `${urls.map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div>`;
    }
    const n = (text.match(/<img\b/gi) || []).length;
    // Lazada: 결과 HTML 을 그대로 그린다 (스크립트 없이, 1000px 폭을 패널 폭에 맞춰 줄임)
    return `<div class="dw-meta">${esc(t('dwImgs', n))} · ${esc(t('dwChars', text.length, true))}</div>` + frameHtml(text);
  }
  // HTML 을 한 페이지로: 스크립트 없이(sandbox), 1000px 폭을 패널 폭에 맞춰 줄이고 높이는 내용만큼 (fitFrames)
  const frameHtml = (html) => `<div class="dw-frame"><iframe sandbox="allow-same-origin" title="preview" srcdoc="${esc('<!doctype html><meta charset="utf-8"><body style="margin:0">' + html)}"></iframe></div>`;
  function fitFrames() {
    document.querySelectorAll('#dwBody .dw-frame iframe').forEach((f) => {
      const fit = () => {
        const w = f.parentElement.clientWidth, sc = w / 1000;
        let h = 0;
        try { h = f.contentDocument.documentElement.scrollHeight; } catch (_) {}
        if (!h) return;
        f.style.height = h + 'px'; f.style.transform = `scale(${sc})`; f.parentElement.style.height = Math.ceil(h * sc) + 'px';
      };
      f.addEventListener('load', () => { fit(); setTimeout(fit, 800); setTimeout(fit, 2500); });   // 이미지가 늦게 뜨면 높이가 바뀐다
    });
  }
  // 내보내기 전 미리보기 (2026-11-24): 저장한 편집본이 있으면 그것, 없으면 빌더와 같은 렌더(/api/ebay-generate — 크롤 데이터로, AI 없음).
  //   태국 제품은 이미 만들어 둔 PDP 요약만 위에 (새로 만들지 않음 — 없으면 '내보낼 때 만들어짐')
  const PV = {};
  function previewHtml(url) {
    const ch = S.channel || 'shopee', key = ch + ':' + url, v = PV[key];
    if (!v) {
      PV[key] = { busy: true };
      const th = /lg\.com\/th\//i.test(url);
      const edP = fetch(`/api/v1/edits?url=${encodeURIComponent(url)}&channel=${ch}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const smP = th ? api('/api/v1/pdp-summary', { url, cachedOnly: true }).catch(() => null) : Promise.resolve(null);
      edP.then((ed) => (ed && ed.html ? { html: ed.html, edited: true } : api('/api/ebay-generate', { url, medium: 'shopee_lazada', listing: ch === 'lazada' })))
        .then(async (g) => { PV[key] = { html: g.html || '', edited: !!g.edited, sum: await smP, th }; }, () => { PV[key] = { err: true }; })
        .then(() => { if (DW.row != null) fillDetail(); });
      return `<div class="dw-empty">${esc(t('dwPvLoading'))}</div>`;
    }
    if (v.busy) return `<div class="dw-empty">${esc(t('dwPvLoading'))}</div>`;
    if (v.err || !v.html) return `<div class="dw-empty">${esc(t('dwOutNot'))}</div>`;
    const sum = v.sum ? (ch === 'shopee' ? `<div class="dw-sum">${esc(v.sum.text || '')}</div>` : v.sum.html || '') : '';
    const notes = [t('dwPvNote')].concat(v.edited ? [t('dwEdited')] : [], v.th && !v.sum ? [t('dwPvNoSum')] : [], ch === 'shopee' ? [t('dwPvShopee')] : []);
    return `<div class="dw-meta">${notes.map(esc).join(' · ')}</div>` +
      (ch === 'shopee' ? `<div class="dw-page">${sum}${frameHtml(v.html)}</div>` : frameHtml(sum + v.html));
  }

  // ── 편집 = 빌더 (2026-11-23): 이 화면 위에 빌더를 띄운다. 빌더 위쪽 막대의 [저장] · [← 벌크 업로드로 돌아가기].
  //    저장한 편집본은 다음 내보내기부터 엑셀에 들어가고, 그 행에 '편집됨' 표시
  async function loadEdits() {
    if (!S.channel) return;
    try { S.edits = (await api('/api/v1/edits/list?channel=' + encodeURIComponent(S.channel))).edits || {}; } catch (_) { return; }
    render(false);
  }
  const scroller = () => document.querySelector('.body') || document.scrollingElement;
  let edScroll = 0;   // 돌아왔을 때 보던 자리 그대로
  async function keepEdit(url, b) {   // 편집본 그대로 쓰기 (바뀐 LG.com 내용을 확인함)
    b.disabled = true;
    try { await api('/api/v1/edits/keep', { url, channel: S.channel }); } catch (e) { b.disabled = false; alert(e.message); return; }
    await loadEdits();
  }
  function openEditor(url) {
    edScroll = scroller().scrollTop;
    $('edFrame').src = builderUrl(url) + '&from=bulk';
    $('edov').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  async function closeEditor() {
    $('edov').classList.add('hidden');
    $('edFrame').src = 'about:blank';
    document.body.style.overflow = '';
    // 키보드 포커스를 빌더 틀에서 되찾는다 (그대로 두면 Esc 같은 키가 이 화면에 오지 않는다)
    if (DW.row != null) $('dwX').focus({ preventScroll: true });
    else { $('edFrame').blur(); document.body.focus({ preventScroll: true }); }
    scroller().scrollTop = edScroll;
    await loadEdits();   // 저장했으면 그 행에 '편집됨'
    scroller().scrollTop = edScroll;
  }
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'clia-edit-back' && e.source === $('edFrame').contentWindow) closeEditor(); });

  // 등록 스위치 · 주소 직접 넣기
  $('regBtn').onclick = () => { S.regOn = !S.regOn; render(true); };
  // 올리자마자 묻는다: CLIA 에 없지만 LG.com 에 있는 상품을 등록하고 함께 채울지 (중요한 기능이라 놓치지 않게)
  const rgClose = () => $('rg').classList.add('hidden');
  function askRegister() {
    const d = S.data, n = S.reg.length;
    if (!n || !d || !d.site) return;
    $('rgT').textContent = t('rgT', n); $('rgB').textContent = t('rgB', d.site);
    const MAX = 8, models = S.reg.map((r) => r.p.model).filter(Boolean);
    $('rgM').innerHTML = models.slice(0, MAX).map((m) => `<span>${esc(m)}</span>`).join('') + (models.length > MAX ? `<span class="more">${esc(t('rgMore', models.length - MAX))}</span>` : '');
    $('rgYes').textContent = t('rgYes', n); $('rgNo').textContent = t('rgNo');
    $('rg').classList.remove('hidden'); $('rgYes').focus();
  }
  $('rgYes').onclick = () => { rgClose(); S.regOn = true; render(true); };
  $('rgNo').onclick = rgClose;
  $('rg').onclick = (e) => { if (e.target === $('rg')) rgClose(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('rg').classList.contains('hidden')) rgClose(); });
  // 매칭 불가 행에서 바로 해결하기 (2026-11-23)
  const skipRowOf = (row) => noMatch().find((x) => x.row === row);
  async function tryUrl(inp) {
    const row = +inp.dataset.urow, v = inp.value.trim(), el = inp.closest('.item'), st = document.querySelector(`[data-ust="${row}"]`);
    if (!v || inp.dataset.tried === v) return;
    inp.dataset.tried = v;
    el.classList.remove('bad'); delete S.uerr[row]; st.textContent = t('checking');
    try {
      const c = await api(`/api/v1/bulk/classify?url=${encodeURIComponent(v)}&country=${encodeURIComponent(home)}`);
      const r = skipRowOf(row);
      if (!r) return;
      S.own[row] = { ...c, alts: 0, fuzzy: false };
      S.fixed[row] = { g: groupOf(r), r };
      delete S.draft[row];
      S.sel.add(row);
      setData(S.data, false);
      focusNext(row);
    } catch (_) {
      S.uerr[row] = 1; el.classList.add('bad'); st.textContent = t('urlBad', S.data.site || home);
      inp.select();
    }
  }
  // SKU 번호: 쓰는 대로 기억하고, 칸을 떠나거나 Enter · 붙여 넣기 하면 그 SKU 로 제품을 찾아 주소 칸을 채운다
  async function commitSku(inp) {
    const row = +inp.dataset.skurow, v = inp.value.trim();
    if (v) S.skuIn[row] = v; else delete S.skuIn[row];
    const urlIn = document.querySelector(`#list input[data-urow="${row}"]`), st = document.querySelector(`[data-ust="${row}"]`);
    const r = skipRowOf(row);
    if (r && r.half) { if (v) { setData(S.data, false); focusNext(row); } return; }   // 제품은 이미 찾음 → SKU 를 넣으면 매칭 완료로
    if (!v || !urlIn || urlIn.value.trim() || inp.dataset.tried === v) return;
    inp.dataset.tried = v;
    if (st) st.textContent = t('checking');
    try {
      const m = await api(`/api/v1/bulk/match-sku?sku=${encodeURIComponent(v)}&country=${encodeURIComponent(home)}&site=${encodeURIComponent(S.data.site || '')}`);
      if (m.cands) {   // 여러 제품과 맞음 → 후보 버튼 (고르면 그 주소로)
        if (st) st.innerHTML = `${esc(t('gMultiD'))}<span class="cands">${m.cands.map((p) => `<button type="button" class="pick" data-skupick="${row}" data-url="${esc(p.url)}" title="${esc(p.url)}">` +
          `${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : ''}${esc(p.model)}${catOf(p) ? `<span class="pc">${esc(catOf(p))}</span>` : ''}</button>`).join('')}</span>`;
        return;
      }
      urlIn.value = m.url; S.draft[row] = m.url;
      await tryUrl(urlIn);
    } catch (_) { if (st) st.textContent = t('skuNoHit'); }
  }
  $('list').addEventListener('input', (e) => {
    const sk = e.target.closest('input[data-skurow]');
    if (sk) { if (sk.value.trim()) S.skuIn[+sk.dataset.skurow] = sk.value.trim(); else delete S.skuIn[+sk.dataset.skurow]; return; }
    const inp = e.target.closest('input[data-urow]');
    if (!inp) return;
    S.draft[+inp.dataset.urow] = inp.value;
    if (!inp.value.trim()) { delete S.uerr[+inp.dataset.urow]; inp.closest('.item').classList.remove('bad'); document.querySelector(`[data-ust="${inp.dataset.urow}"]`).textContent = ''; delete inp.dataset.tried; }
  });
  $('list').addEventListener('paste', (e) => { const inp = e.target.closest('input[data-urow]'); if (inp) setTimeout(() => tryUrl(inp), 0); });
  $('list').addEventListener('keydown', (e) => {
    const sk = e.target.closest('input[data-skurow]');
    if (sk && e.key === 'Enter') { e.preventDefault(); sk.blur(); return; }   // 칸을 떠나면 change → commitSku
    const inp = e.target.closest('input[data-urow]'); if (inp && e.key === 'Enter') { e.preventDefault(); delete inp.dataset.tried; tryUrl(inp); }
  });
  $('list').addEventListener('change', (e) => {
    const sk = e.target.closest('input[data-skurow]'); if (sk) { commitSku(sk); return; }
    const inp = e.target.closest('input[data-urow]'); if (inp) tryUrl(inp);
  });
  $('list').addEventListener('click', (e) => {
    const sp = e.target.closest('button[data-skupick]');
    if (sp) {   // SKU 로 찾은 후보 중 고르기 → 그 주소로 해결
      const urlIn = document.querySelector(`#list input[data-urow="${sp.dataset.skupick}"]`);
      if (urlIn) { urlIn.value = sp.dataset.url; S.draft[+sp.dataset.skupick] = sp.dataset.url; delete urlIn.dataset.tried; tryUrl(urlIn); }
      return;
    }
    const pk = e.target.closest('button[data-pick]'), un = e.target.closest('button[data-undo]'), rr = e.target.closest('button[data-regrow]');
    if (pk || un || rr) e.preventDefault();   // 되돌리기는 매칭 완료 행(체크 칸이 있는 줄) 안에도 있다
    if (pk) {
      const row = +pk.dataset.pick, r = skipRowOf(row);
      if (!r) return;
      S.pick[row] = pk.dataset.slug; S.fixed[row] = { g: 'gMulti', r }; S.sel.add(row);
      setData(S.data, false);
      focusNext(row);
    } else if (un) {
      const row = +un.dataset.undo;
      delete S.own[row]; delete S.pick[row]; delete S.fixed[row]; S.sel.delete(row);
      setData(S.data, false);
    } else if (rr) {
      // 그 행만 등록하고 채우기 (파일 전체 스위치는 위 한 줄)
      const row = +rr.dataset.regrow, r = skipRowOf(row);
      if (!r || !r.lg) return;
      S.own[row] = { ...r.lg }; S.fixed[row] = { g: 'gReg', r }; S.sel.add(row);
      setData(S.data, false);
    }
  });

  // 보기 · 검색
  let VIEW = 'list';
  function setView(v) {
    VIEW = v === 'grid' ? 'grid' : 'list';
    $('list').classList.toggle('grid', VIEW === 'grid');
    $('lhead').classList.toggle('hidden', VIEW === 'grid' || !S.data);
    document.querySelectorAll('#view button').forEach((b) => { b.classList.toggle('on', b.dataset.v === VIEW); b.setAttribute('aria-pressed', b.dataset.v === VIEW); });
  }
  $('lhead').innerHTML = `<span></span><span></span><span>${esc(t('hdProduct'))}</span><span>${esc(t('hdBu'))}</span><span>${esc(t('hdName'))}</span><span>${esc(t('hdState'))}</span><span class="hs">${esc(t('hdStatus'))}</span><span class="hn">${esc(t('hdAction'))}</span><span class="he">${esc(t('hdEdit'))}</span>`;
  $('vList').textContent = t('viewList'); $('vGrid').textContent = t('viewGrid');
  document.querySelectorAll('#view button').forEach((b) => { b.title = t(b.dataset.v === 'grid' ? 'viewGrid' : 'viewList'); });
  $('view').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); };
  setView(VIEW);
  $('q').placeholder = t('search'); $('selAll').title = t('shift');   // Shift 범위 선택 안내는 마우스를 올렸을 때만
  $('q').oninput = () => { S.q = $('q').value.trim().toLowerCase(); refresh(); };

  // ── 동영상 장면 고르기 — 빌더와 같은 팝업(shared/clia-frame-picker.js) · 같은 저장(제품 데이터) ──
  //   이 팝업은 제품의 동영상 목록. 하나를 누르면 동영상을 보며 장면을 고른다 (맨 앞은 자동으로 고른 1~3위)
  async function openFrames(slug) {
    $('frm').classList.remove('hidden');
    $('frmT').textContent = t('frT'); $('frmX').textContent = t('frClose'); $('frmMsg').textContent = '';
    $('frmBody').innerHTML = '<div class="bar2"><i></i></div>';
    try { drawFrames(slug, (await api('/api/v1/product-videos?slug=' + encodeURIComponent(slug))).videos); }
    catch (e) { $('frmBody').textContent = e.message; }
  }
  function drawFrames(slug, videos) {
    if (!videos.length) { $('frmBody').textContent = t('frNone'); return; }
    const tag = (v) => (v.chosen ? t('frCur') : v.auto ? t('frAuto') : '');
    $('frmBody').innerHTML = `<div class="fo">` + videos.map((v, i) => `<button class="fopt${v.chosen ? ' on' : ''}" data-i="${i}" title="#${i + 1}">` +
      `<img src="${esc(v.poster)}" alt="" loading="lazy">${tag(v) ? `<span>${esc(tag(v))}</span>` : ''}</button>`).join('') + `</div>`;
    $('frmBody').onclick = (e) => {
      const b = e.target.closest('.fopt');
      if (!b) return;
      const v = videos[+b.dataset.i];
      CLIAFramePicker.open({ video: v.video, slug, at: (v.chosen || v.auto || {}).t || 0, onPicked: async () => {
        $('frmMsg').textContent = t('frSaved');
        const d = await api('/api/v1/product-videos?slug=' + encodeURIComponent(slug)).catch(() => null);
        if (!d) return;
        drawFrames(slug, d.videos);
        // 자동으로 고른 장면을 모두 확인했으면 '동영상 장면을 자동으로 고름' 안내를 닫는다
        if (d.videos.every((x) => !x.auto || x.auto.confirmed) && S.job) S.job.items.filter((x) => x.slug === slug).forEach((x) => S.ack.add(`${x.row}:frame`));
        saveAck(); render(false);
      } });
    };
  }
  $('frmX').onclick = () => $('frm').classList.add('hidden');
  $('frm').onclick = (e) => { if (e.target === $('frm')) $('frm').classList.add('hidden'); };

  // ── 내보내기 · 진행 · 알림 ──
  // 내보내기 팝업: 예상 소요 시간 → 오래 걸리면 "완료되면 메일로 알려 드릴까요?" (완성된 엑셀 첨부)
  const LONG_MIN = 3;
  const xpShow = (w, on) => $(w).classList.toggle('hidden', !on);
  const xpClose = () => $('xp').classList.add('hidden');
  function openXp(est, long) {
    $('xpT').textContent = t('xpT');
    $('xpE').innerHTML = t('xpEst', est);
    const ask = long && !!S.cfg.mail;
    xpShow('xpAskW', ask); xpShow('xpSetW', false); xpShow('xpOkW', !ask);
    $('xpNote').textContent = ask ? '' : t(long ? 'xpLeave' : 'xpShort'); xpShow('xpNote', !ask);
    $('xpAsk').textContent = t('xpAsk'); $('xpAskS').textContent = t('xpAskS');
    $('xpYes').textContent = t('xpYes'); $('xpNo').textContent = t('xpNo'); $('xpOk').textContent = t('xpOk');
    $('xpMail').placeholder = t('xpMailPh'); $('xpErr').textContent = ''; $('xpYes').disabled = false;
    if (!$('xpMail').value) { try { $('xpMail').value = localStorage.getItem('clia-bulk-mail') || sessionStorage.getItem('clia_user') || ''; } catch (_) {} }
    $('xp').classList.remove('hidden');
    (ask ? $('xpMail') : $('xpOk')).focus();
  }
  $('xpYes').onclick = async () => {
    const email = $('xpMail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('xpErr').textContent = t('xpBadMail'); $('xpMail').focus(); return; }
    if (!S.job || !S.job.id) return;
    $('xpYes').disabled = true; $('xpErr').textContent = '';
    try {
      await api(`/api/v1/bulk/jobs/${S.job.id}/notify`, { email, lang: L });
      try { localStorage.setItem('clia-bulk-mail', email); } catch (_) {}
      $('xpSet').textContent = t('xpSet', email);
      xpShow('xpAskW', false); xpShow('xpSetW', true); xpShow('xpOkW', true); $('xpOk').focus();
    } catch (e) { $('xpErr').textContent = t(e.code === 'bad_email' ? 'xpBadMail' : 'xpMailFail'); $('xpYes').disabled = false; }
  };
  $('xpMail').onkeydown = (e) => { if (e.key === 'Enter') $('xpYes').click(); };
  $('xpNo').onclick = xpClose; $('xpOk').onclick = xpClose;
  $('xp').onclick = (e) => { if (e.target === $('xp')) xpClose(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') xpClose(); });
  // 이 화면에서 마지막으로 한 작업 — 나라·채널별로 따로 (2026-11-23: 태국 작업이 싱가포르 화면에 보이지 않게)
  const lastKey = 'clia-bulk-last-' + (home || 'any') + '-' + (CH0 || 'any');
  const oldKey = 'clia-bulk-last-' + (CH0 || 'any');   // 나라 구분 전 기록 — 같은 나라 작업일 때만 옮겨 쓴다
  const jobUrl = (id) => '/api/v1/bulk/jobs/' + id + (home ? '?country=' + encodeURIComponent(home) : '');
  // ── 중단: 확인 팝업 → 서버에 cancel. 이미 등록한 제품은 남고 엑셀은 만들지 않는다 ──
  const cfClose = () => $('cf').classList.add('hidden');
  function askStop(id, after) {
    $('cfT').textContent = t('stopT'); $('cfB').textContent = t('stopB'); $('cfErr').textContent = '';
    $('cfNo').textContent = t('stopKeep'); $('cfYes').textContent = t('stop'); $('cfYes').disabled = false;
    $('cfYes').onclick = async () => {
      $('cfYes').disabled = true;
      try {
        const j = await api(`/api/v1/bulk/jobs/${id}/cancel`, {});
        cfClose(); after(j);
      } catch (e) { $('cfErr').textContent = t('stopFail') + e.message; $('cfYes').disabled = false; }
    };
    $('cf').classList.remove('hidden'); $('cfNo').focus();
  }
  $('cfNo').onclick = cfClose;
  $('cf').onclick = (e) => { if (e.target === $('cf')) cfClose(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('cf').classList.contains('hidden')) cfClose(); });
  $('stop').onclick = () => { if (S.job && S.job.id && S.job.status === 'running') askStop(S.job.id, (j) => { S.job = j; render(false); }); };
  async function poll(j) {
    S.busy = true; S.job = j; render(false);
    try {
      while (j.status === 'running') {
        await sleep(3000);
        const before = S.job;
        j = await api('/api/v1/bulk/jobs/' + j.id);
        S.job = j;
        if (!before || before.done !== j.done || before.crawlDone !== j.crawlDone) render(false); else refresh();
        document.title = (j.status === 'running' ? `(${j.done}/${j.total}) ` : '') + 'Bulk Excel — CLIA';
      }
    } catch (e) { S.job = { ...(S.job || { items: [] }), status: 'failed', error: e.message }; }
    S.busy = false;
    render(false);
    if ($('xpSetW').classList.contains('hidden')) xpClose();   // 끝났으면 팝업을 닫는다 (메일 주소를 넣었으면 그 안내는 남긴다)
    document.title = (S.job.status === 'ready' ? '✓ ' : S.job.status === 'cancelled' ? '' : '! ') + 'Bulk Excel — CLIA';
    if (S.job.status === 'ready' && S.autoDl) $('dl').click();
  }
  $('export').onclick = async () => {
    const items = act().filter((r) => S.sel.has(r.row)).map((r) => (r.kind === 'bundle'
      ? { row: r.row, title: r.name, force: S.force.has(r.row), bundle: r.p.parts.map((x) => (x.register ? { url: x.url, register: true } : { slug: x.slug })) }
      : r.kind === 'new'
      ? { row: r.row, url: r.p.url, register: true, alts: r.p.alts, fuzzy: r.p.fuzzy, force: S.force.has(r.row) }
      : { row: r.row, slug: r.p.slug, force: S.force.has(r.row) }));
    if (S.busy || !items.length) return;
    // 크롤 수: 단품 등록 + 묶음 구성품 중 등록할 것 (같은 제품은 한 번만)
    const toCrawl = new Set(items.flatMap((x) => (x.bundle ? x.bundle.filter((y) => y.register || x.force).map((y) => y.url || y.slug) : (x.register || x.force ? [x.url || x.slug] : []))));
    const est = estMin(toCrawl.size, items.length);
    const longJob = est >= LONG_MIN;
    S.autoDl = !longJob;   // 오래 걸리는 작업은 자동 다운로드 대신 '다시 받기' 버튼 · 메일
    S.busy = true; refresh();
    try {
      const j = await api('/api/v1/bulk/build', { id: S.data.id, channel: S.channel, sheet: S.data.sheet, descCol: S.data.cols.desc, country: home, lang: L, items, skus: Object.fromEntries(skuList()) });
      S.force = new Set(); S.redo = new Set(); S.ack = new Set();
      store.set(lastKey, { job: j.id, file: S.data.fileName, at: Date.now() });
      S.job = j; openXp(est, longJob);
      await poll(j);
    } catch (e) { S.busy = false; S.job = { items: [], status: 'failed', error: e.message }; render(false); }
  };

  // ── 이어 보기: 메일 링크(?job=) 또는 이 화면에서 마지막으로 한 작업 ──
  async function resume(id) {
    $('resume').classList.add('hidden');
    show('s2'); $('pmsg').textContent = t('reading'); $('pfile').textContent = '';
    try {
      const j = await api(jobUrl(id));
      if (!home && j.country) home = j.country;   // 메일 링크(나라 없이 열림): 작업의 나라로 맞춘다
      if (!S.channel) S.channel = j.channel;
      chTag();
      const d = await api('/api/v1/bulk/analyze', { id: j.upload, country: home });
      S.own = {};
      for (const it of j.items) if (!it.register && !it.bundle && it.slug) S.pick[it.row] = it.slug;   // 여러 후보 중 골랐던 제품
      for (const it of j.items) if (it.register) S.own[it.row] = { ...((d.rows.find((r) => r.row === it.row) || {}).lg || {}), url: it.url, model: it.model, alts: it.alts, fuzzy: it.fuzzy };
      S.regOn = j.items.some((x) => x.register);
      S.skuIn = Object.fromEntries((j.skus || []).map((x) => [x.row, x.sku]));
      S.ack = new Set(store.get('clia-bulk-ack-' + id) || []);
      setData(d, false);
      S.sel = new Set(j.items.map((x) => x.row));
      S.job = j;
      render(true);
      if (j.status === 'running') poll(j);
    } catch (e) { fail('other', { error: e.message }); }
  }
  if (/^[0-9a-f]{16}$/.test(qs.get('job') || '')) resume(qs.get('job'));
  else {
    let last = store.get(lastKey);
    if (!last && home) { const o = store.get(oldKey); if (o && o.job) last = { ...o, migrate: true }; }
    if (last && last.job && Date.now() - last.at < 7 * 864e5) {
      api(jobUrl(last.job)).then((j) => {   // 다른 나라 작업이면 서버가 404 → 보이지 않는다
        if (last.migrate) { store.set(lastKey, { job: last.job, file: last.file, at: last.at }); }
        $('resume').classList.remove('hidden');
        const label = (x) => t('resumeT', last.file || '') + ' · ' + (x.status === 'running' ? t('resumeRun', x.done, x.total) : x.status === 'cancelled' ? t('st_stop') : t('resumeDone'));
        $('resumeT').textContent = label(j);
        $('resumeB').textContent = t('resumeBtn');
        $('resumeB').onclick = () => resume(last.job);
        $('resumeS').textContent = t('stop'); $('resumeS').classList.toggle('hidden', j.status !== 'running');
        $('resumeS').onclick = () => askStop(last.job, (x) => { $('resumeT').textContent = label(x); $('resumeS').classList.add('hidden'); });
      }).catch(() => {});
    }
  }
  // 표 머리 고정 (2026-11-24): 머리는 위에 고정된 작업 상황판(#panel) 바로 아래에 붙는다 — 상황판 높이가 바뀌면(진행 막대 · 등록 줄) 따라간다
  (function stickHead() {
    const p = $('panel'); if (!p || typeof ResizeObserver === 'undefined') return;
    const set = () => document.documentElement.style.setProperty('--panelH', (p.offsetParent ? p.offsetHeight : 0) + 'px');
    new ResizeObserver(set).observe(p); set();
  })();
})();
