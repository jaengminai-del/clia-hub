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
  const S = { tab: 'all', q: '', last: null, mis: '', data: null, channel: CH0, ok: [], reg: [], skip: [], regOn: false, own: {}, sel: new Set(), force: new Set(), redo: new Set(), ack: new Set(), job: null, busy: false, cfg: {} };
  const act = () => (S.regOn ? S.ok.concat(S.reg) : S.ok);
  // 매칭 불가 = CLIA 가 건드리지 않는 행: 제품을 못 정한 행 + (등록을 켜지 않았으면) CLIA 에 없는 행
  const noMatch = () => S.skip.concat(S.regOn ? [] : S.reg.map((r) => ({ ...r, why: 'rReg' })));

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
      Object.assign(S, { job: null, q: '', last: null, regOn: false, own: {}, force: new Set(), redo: new Set(), ack: new Set() });
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
      else if (c.length > 1) S.skip.push({ ...r, why: 'rMulti' });
      else if (own || r.lg) S.reg.push({ ...r, kind: 'new', p: newP(r, own || r.lg) });
      else S.skip.push({ ...r, why: 'rNone' });
    }
    if (fresh) S.sel = new Set(S.ok.map((r) => r.row).concat(S.reg.map((r) => r.row)));
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
  const flagsOf = (row) => ((itemOf(row) || {}).flags || []).map(normFlag);
  const openFlags = (row) => flagsOf(row).filter((f) => f.sev !== 'info' && !S.ack.has(`${row}:${f.code}`));
  const flagText = (f) => ({ bundle: () => t('f_bundle', f.n), crawl: () => t('f_crawl'), content: () => t('f_content'), qa: () => t('f_qa', f.images), qaTx: () => t('f_qaTx', f.texts), frame: () => t('f_frame', f.n),
    over12: () => t('f_over12', f.all), summary: () => t('f_summary'), fuzzy: () => t('f_fuzzy'), alts: () => t('f_alts', f.n) }[f.code] || (() => f.code))();
  const builderUrl = (u) => `/shopee-lazada-pdp/index.html?url=${encodeURIComponent(u || '')}&channel=${S.channel || 'shopee'}&lang=${L}`;
  const reviewRows = () => act().filter((r) => openFlags(r.row).length);
  // 다시 돌리면 고쳐지는 것: LG.com 페이지 · 이미지 누락은 다시 가져오고, 설명 · 요약은 다시 만든다
  const RETRY = { crawl: 'a_retry', content: 'a_retry', summary: 'a_retry', qa: 'a_refetch' };
  function flagHtml(r) {
    const it = itemOf(r.row);
    const fl = openFlags(r.row);
    let h = flagsOf(r.row).filter((f) => f.sev === 'info' && !S.ack.has(`${r.row}:${f.code}`)).map((f) => `<div class="nrow"><span class="note">${esc(flagText(f))}</span>` +
      (f.code === 'frame' ? `<button class="mini" data-a="frame" data-slug="${esc(it.slug)}">${esc(t('a_frame'))}</button>` : '') + `</div>`).join('');
    // 동영상이 있는 제품은 자동 선택 안내가 없어도 장면을 바꿀 수 있다 (빌더와 같은 기능)
    if (it && it.status === 'ok' && it.videos && !h.includes('data-a="frame"'))
      h += `<div class="nrow"><span class="note">${esc(t('f_videos', it.videos))}</span><button class="mini" data-a="frame" data-slug="${esc(it.slug)}">${esc(t('a_frame'))}</button></div>`;
    if (!fl.length) return h;
    return h + `<div class="fl">` + fl.map((f) => `<div class="fx"><span${f.files && f.files.length ? ` title="${esc(f.files.join(', '))}"` : ''}>${esc(flagText(f))}</span>` +   // 마우스를 올리면 빠진 이미지 파일 이름
      (RETRY[f.code] ? `<button class="mini" data-a="retry" data-row="${r.row}" data-code="${f.code}">${esc(t(RETRY[f.code]))}</button>` : '') +
      (['qa', 'fuzzy'].includes(f.code) ? `<a class="mini" target="_blank" rel="noopener" href="${esc(builderUrl(r.p.url))}">${esc(t('a_builder'))}</a>` : '') +
      (f.sev === 'warn' ? `<button class="mini" data-a="ack" data-row="${r.row}" data-code="${f.code}">${esc(t('a_ack'))}</button>` : '') +
      `</div>`).join('') + `</div>`;
  }
  function itemStatus(r) {
    const it = itemOf(r.row);
    let h = '';
    if (S.force.has(r.row) || S.redo.has(r.row)) h = `<span class="note">${esc(t('a_retryNote'))}</span>`;
    else if (!it) h = r.descLen > 0 ? `<span class="note">${esc(t('repNote'))}</span>` : '';
    else if (it.status === 'queued') h = `<span class="badge b-q">${esc(it.register && !it.crawled ? t('st_regq') : t('q'))}</span>`;
    else if (it.status === 'crawling') h = `<span class="badge b-run">${esc(t('st_crawl'))}</span>`;
    else if (it.status === 'working') h = `<span class="badge b-run">${esc(t('w'))}</span>`;
    else if (it.status === 'failed') h = `<span class="badge b-bad">${esc(t('bad'))}</span>`;
    else if (it.status === 'cancelled') h = `<span class="badge b-q">${esc(t('st_stop'))}</span>`;
    else h = `<span class="badge b-ok">${esc(t('ok'))}</span>` + (it.prevLen > 0 ? `<span class="note">${esc(t('okRep'))}</span>` : '') + `<span class="note">${esc(t('imgs', it.images))}</span>`;
    return h + flagHtml(r);
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
    const nReg = S.reg.length;
    $('regCard').classList.toggle('hidden', !nReg || !d.site);
    if (nReg && d.site) {
      $('regCard').classList.toggle('on', S.regOn);
      $('regCard').querySelector('.regi path').setAttribute('d', S.regOn ? 'M5 12.5l4.5 4.5L19 7.5' : 'M12 5v14M5 12h14');   // 켜면 ✓
      $('regT').textContent = t(S.regOn ? 'regOn' : 'regOff', nReg, d.site);
      $('regBtn').textContent = S.regOn ? t('regUndo') : t('regDo', nReg);
      $('regBtn').className = 'clia-btn' + (S.regOn ? '' : ' primary');
      $('regBtn').disabled = S.busy;
    }
    $('noMatch').classList.toggle('hidden', rows.length > 0 || S.reg.length > 0);
    $('noMatchT').textContent = t('noMatchT'); $('noMatchB').textContent = t('noMatchB');
    $('askDesc').classList.toggle('hidden', !!d.cols.desc);
    if (!d.cols.desc) $('descSel').innerHTML = '<option value="">—</option>' + d.columns.map((c) => `<option value="${c.col}">${c.letter} · ${esc(c.label)}</option>`).join('');
    $('pFile').textContent = d.fileName || '';
    $('pMatch').textContent = t('rowsN', d.rows.length);
    const rv = new Set(reviewRows().map((r) => r.row));   // 확인 필요는 맨 위
    const ordered = rows.slice().sort((a, b) => (rv.has(b.row) - rv.has(a.row)));
    $('list').innerHTML = ordered.map((r, i) => `<label class="item${rv.has(r.row) ? ' rv' : ''}" style="${animate ? `animation-delay:${Math.min(i, 30) * 45}ms` : 'animation:none'}">` +
      `<input type="checkbox" data-row="${r.row}">` +
      ((r.p.thumb || (itemOf(r.row) || {}).thumb) ? `<img src="${esc(r.p.thumb || itemOf(r.row).thumb)}" alt="" loading="lazy">` : `<div class="ph">${esc(grpName(r.p.grp))}</div>`) +
      `<div style="min-width:0"><div class="m">${rv.has(r.row) ? `<span class="badge b-bad rvt">${esc(t('rvTag'))}</span>` : ''}${r.p.isBundle ? `<span class="badge b-q">${esc(t('bundleTag'))}</span> ` : ''}${esc(r.p.model)}<span class="dv">${esc(r.p.dv || '')} · ${esc(grpName(r.p.grp))}</span>${r.p.isNew ? `<span class="badge b-new">${esc(t('newTag'))}</span>` : ''}</div>` +
      `<div class="s">${esc(r.name || r.p.title)}</div></div><div class="r"></div></label>`).join('');
    if (!rows.length && noMatch().length) S.tab = 'skip';
    // 매칭 불가: 다른 탭과 같은 행 — SKU · 상품명 · 이유 (CLIA·LG.com 어디에도 없으면 주소를 직접 넣는 칸)
    $('skip').innerHTML = noMatch().map((r) => { const none = r.why === 'rNone' && d.site;
      return `<div class="item"><span></span><div class="ph">—</div>` +
        `<div style="min-width:0"><div class="m">${esc(r.parentSku || r.sku || '—')}</div><div class="s">${esc(r.name)}</div></div>` +
        `<div class="r"><span class="badge b-q">${esc(none ? t('notFound') : t(r.why))}</span>` +
        (none ? `<span class="urlin"><input type="url" data-urow="${r.row}" placeholder="${esc(t('urlPh'))}"><button class="mini" data-uadd="${r.row}">${esc(t('urlAdd'))}</button></span><span class="err2" data-uerr="${r.row}"></span>` : '') +
        `</div></div>`; }).join('');
    refresh();
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
    $('tabD').textContent = t({ all: 'td_all', review: 'td_review', ok: 'td_ok', skip: 'td_skip' }[S.tab] || 'td_all');
    $('tabs').innerHTML = tabs.map(([k, label, n, cls]) => `<button class="tab ${cls}${S.tab === k ? ' on' : ''}" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${esc(label)}<b>${n}</b></button>`).join('');
    const inTab = (r) => S.tab === 'all' || (S.tab === 'review' && rvSet.has(r.row)) || (S.tab === 'ok' && !rvSet.has(r.row));
    // 전체 선택 ↔ 해제: 버튼 하나 (지금 보이는 상품 — 탭 · 검색 결과 — 에만)
    const vis = rows.filter((r) => hit(r) && inTab(r)), vk = nSel(vis);
    $('selCb').className = 'cb ' + cbOf(vk, vis.length);
    $('selL').textContent = S.q ? t('qRes', vis.length) : t('selAll');
    $('selN').textContent = `${vk}/${vis.length}`;
    $('selAll').setAttribute('aria-pressed', String(vis.length > 0 && vk === vis.length));
    $('selAll').disabled = S.busy || !vis.length;
    document.querySelectorAll('#list .item').forEach((el) => {
      const row = +el.querySelector('input').dataset.row;
      const r = rows.find((x) => x.row === row);
      if (!r) return;
      el.querySelector('input').checked = S.sel.has(row);
      el.querySelector('input').disabled = S.busy;
      el.classList.toggle('off', !S.sel.has(row));
      el.classList.toggle('hidden', !hit(r) || !inTab(r));
      el.querySelector('.r').innerHTML = itemStatus(r);
    });
    const skipTab = S.tab === 'skip';
    $('list').classList.toggle('hidden', skipTab || !rows.length);
    $('skip').classList.toggle('hidden', !((skipTab || S.tab === 'all') && noN));   // 전체 탭에서는 목록 아래에 매칭 불가 행도 보인다
    $('skipHead').classList.toggle('hidden', !(S.tab === 'all' && noN && rows.length));
    $('skipHead').innerHTML = `${esc(t('tabSkip'))}<b>${noN}</b>`;
    $('selbar').classList.toggle('hidden', skipTab || !rows.length);
    $('shiftTip').classList.toggle('hidden', skipTab || !rows.length);
    // 상황판
    const c = rows.filter((r) => S.sel.has(r.row)), rep = c.filter((r) => r.descLen > 0).length;
    const nNew = c.filter((r) => r.kind === 'new').length;
    const j = S.job, running = j && j.status === 'running';
    if (running) {
      const crawling = j.crawlTotal && j.crawlDone < j.crawlTotal;
      $('info').textContent = crawling ? t('progCrawl', j.crawlDone, j.crawlTotal) : t('progMake', j.done, j.total);
      $('prog').firstElementChild.style.width = (100 * (crawling ? j.crawlDone / j.crawlTotal : j.done / Math.max(1, j.total))) + '%';
    } else if (j && j.status === 'ready') $('info').innerHTML = t('done', j.ok, j.replaced, j.failed) + (rvN ? ` <button class="lnk" data-tab="review">${esc(t('rvLink', rvN))}</button>` : '');
    else if (j && j.status === 'cancelled') $('info').innerHTML = `<span>${esc(t('stopped', j.ok || 0, j.total || (j.items || []).length))}</span>`;
    else if (j && j.status === 'failed') $('info').innerHTML = `<span style="color:var(--bad)">${esc(t('expFail') + (j.error || ''))}</span>`;
    else $('info').innerHTML = `<span>${t('info', c.length, rep)}</span>` + (rvN ? ` <button class="lnk" data-tab="review">${esc(t('rvLink', rvN))}</button>` : '');
    $('prog').classList.toggle('hidden', !running);
    $('stop').classList.toggle('hidden', !running); $('stop').textContent = t('stop');   // 진행 중일 때만 중단
    // 알림 고르기: 오래 걸릴 작업(새로 등록 포함 또는 상품 40개 초과)에만
    $('export').textContent = S.busy ? t('exporting') : (j && !running ? t('expAgain', c.length) : t('exp', c.length));
    $('export').disabled = S.busy || !c.length || !S.channel || !S.data.cols.desc;
    $('dl').classList.toggle('hidden', !(j && j.status === 'ready' && !S.busy));
    if (j && j.file) { $('dl').href = j.file; $('dl').setAttribute('download', j.fileName || 'clia-bulk.xlsx'); }
    $('again').disabled = S.busy;
  }

  // 탭 · 상황판의 "확인 필요 보기"
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
    const vis = [...document.querySelectorAll('#list .item:not(.hidden) input')].map((x) => +x.dataset.row);
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
    const vis = [...document.querySelectorAll('#list .item:not(.hidden) input')].map((x) => +x.dataset.row);
    const a = vis.indexOf(S.last), z = vis.indexOf(row);
    (shiftDown && a >= 0 && z >= 0 ? vis.slice(Math.min(a, z), Math.max(a, z) + 1) : [row]).forEach((x) => (el.checked ? S.sel.add(x) : S.sel.delete(x)));
    S.last = row;
    refresh();
  };
  // 확인 필요 항목의 할 일
  const saveAck = () => { if (S.job && S.job.id) store.set('clia-bulk-ack-' + S.job.id, [...S.ack]); };
  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    e.preventDefault();
    const row = +b.dataset.row;
    if (b.dataset.a === 'ack') { S.ack.add(`${row}:${b.dataset.code}`); saveAck(); render(false); }
    if (b.dataset.a === 'retry') { if (['crawl', 'qa'].includes(b.dataset.code)) S.force.add(row); else S.redo.add(row); S.ack.add(`${row}:${b.dataset.code}`); S.sel.add(row); saveAck(); render(false); }   // crawl · qa: LG.com 에서 다시 가져옴 / 그 밖: 다시 만듦
    if (b.dataset.a === 'frame') openFrames(b.dataset.slug);
  });

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
  $('skip').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-uadd]');
    if (!b) return;
    e.preventDefault();
    const row = +b.dataset.uadd, inp = document.querySelector(`input[data-urow="${row}"]`), err = document.querySelector(`[data-uerr="${row}"]`);
    try {
      const c = await api(`/api/v1/bulk/classify?url=${encodeURIComponent(inp.value.trim())}&country=${encodeURIComponent(home)}`);
      S.own[row] = { ...c, alts: 0, fuzzy: false };
      S.regOn = true; S.sel.add(row);
      setData(S.data, false);
    } catch (_) { err.textContent = t('urlBad', S.data.site || home); }
  });

  // 보기 · 검색
  let VIEW = 'list';
  function setView(v) {
    VIEW = v === 'grid' ? 'grid' : 'list';
    $('list').classList.toggle('grid', VIEW === 'grid');
    document.querySelectorAll('#view button').forEach((b) => { b.classList.toggle('on', b.dataset.v === VIEW); b.setAttribute('aria-pressed', b.dataset.v === VIEW); });
  }
  $('vList').textContent = t('viewList'); $('vGrid').textContent = t('viewGrid');
  document.querySelectorAll('#view button').forEach((b) => { b.title = t(b.dataset.v === 'grid' ? 'viewGrid' : 'viewList'); });
  $('view').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); };
  setView(VIEW);
  $('q').placeholder = t('search'); $('shiftTip').textContent = t('shift');
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
      const j = await api('/api/v1/bulk/build', { id: S.data.id, channel: S.channel, sheet: S.data.sheet, descCol: S.data.cols.desc, country: home, lang: L, items });
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
      for (const it of j.items) if (it.register) S.own[it.row] = { ...((d.rows.find((r) => r.row === it.row) || {}).lg || {}), url: it.url, model: it.model, alts: it.alts, fuzzy: it.fuzzy };
      S.regOn = j.items.some((x) => x.register);
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
})();
