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
  const t = (k, ...a) => { const v = T[k] ?? TX.en[k]; return typeof v === 'function' ? v(...a) : v; };
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
  let home = String(qs.get('corp') || '').toLowerCase();
  const DIVS = ['MS', 'HS', 'ES'];
  const GRPS = { MS: ['TV', 'Audio', 'Monitor', 'Laptop', 'Projector', 'Other'], HS: ['Fridge', 'Washer', 'Dryer', 'Vacuum', 'Dishwasher', 'Cooking', 'Styler', 'Other'], ES: ['AC', 'Purifier', 'Dehumidifier'] };
  const grpName = (g) => (T.grp || TX.en.grp)[g] || g;
  const CH0 = ['shopee', 'lazada'].includes(qs.get('channel')) ? qs.get('channel') : '';
  const chName = (c) => (c === 'lazada' ? 'Lazada' : 'Shopee');
  const S = { tab: 'all', q: '', last: null, mis: '', data: null, channel: CH0, ok: [], reg: [], skip: [], regOn: false, own: {}, sel: new Set(), force: new Set(), ack: new Set(), job: null, busy: false, cfg: {} };
  const act = () => (S.regOn ? S.ok.concat(S.reg) : S.ok);

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
  async function attach(f) {
    if (S.busy) return;
    $('ecard').classList.add('hidden'); $('resume').classList.add('hidden');
    $('pfile').textContent = f.name; $('pmsg').textContent = t('reading');
    show('s2');
    const t0 = Date.now();
    const req = fetch(`/api/v1/bulk/upload?name=${encodeURIComponent(f.name)}&country=${encodeURIComponent(home)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })
      .then(async (r) => {
        const d = await r.json().catch(() => ({ code: r.status === 413 ? 'too_big' : 'other' }));
        if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { code: d.code || 'other', maxMb: d.maxMb });
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
      Object.assign(S, { job: null, q: '', last: null, regOn: false, own: {}, force: new Set(), ack: new Set() });
      $('q').value = '';
      setData(d, true);
    } catch (e) { fail(e.code || 'other', { maxMb: e.maxMb, error: e.message, fileName: f.name }); }
  }

  // 행 나누기: CLIA 제품 하나에 딱 맞음(ok) · 같은 나라 LG.com 에서 찾음(reg, 등록 후보) · 그 밖(skip)
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
      if (r.bundle) S.skip.push({ ...r, why: 'rBundle' });
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
  const openFlags = (row) => ((itemOf(row) || {}).flags || []).filter((f) => f.sev !== 'info' && !S.ack.has(`${row}:${f.code}`));
  const flagText = (f) => ({ crawl: () => t('f_crawl'), content: () => t('f_content'), qa: () => t('f_qa', f.texts, f.images), frame: () => t('f_frame', f.n),
    over12: () => t('f_over12', f.all), summary: () => t('f_summary'), fuzzy: () => t('f_fuzzy'), alts: () => t('f_alts', f.n) }[f.code] || (() => f.code))();
  const builderUrl = (u) => `/shopee-lazada-pdp/index.html?url=${encodeURIComponent(u || '')}&channel=${S.channel || 'shopee'}&lang=${L}`;
  const reviewRows = () => act().filter((r) => openFlags(r.row).length);
  function flagHtml(r) {
    const it = itemOf(r.row);
    const fl = openFlags(r.row);
    let h = ((it || {}).flags || []).filter((f) => f.sev === 'info').map((f) => `<span class="note">${esc(flagText(f))}</span>`).join('');
    if (!fl.length) return h;
    return h + `<div class="fl">` + fl.map((f) => `<div class="fx"><span>${esc(flagText(f))}</span>` +
      (f.code === 'frame' ? `<button class="mini" data-a="frame" data-slug="${esc(it.slug)}">${esc(t('a_frame'))}</button>` : '') +
      (f.code === 'crawl' || f.code === 'content' ? `<button class="mini" data-a="retry" data-row="${r.row}" data-code="${f.code}">${esc(t('a_retry'))}</button>` : '') +
      (['qa', 'over12', 'summary', 'fuzzy'].includes(f.code) ? `<a class="mini" target="_blank" rel="noopener" href="${esc(builderUrl(r.p.url))}">${esc(t('a_builder'))}</a>` : '') +
      (f.sev === 'warn' ? `<button class="mini" data-a="ack" data-row="${r.row}" data-code="${f.code}">${esc(t('a_ack'))}</button>` : '') +
      `</div>`).join('') + `</div>`;
  }
  function itemStatus(r) {
    const it = itemOf(r.row);
    let h = '';
    if (S.force.has(r.row)) h = `<span class="note">${esc(t('a_retryNote'))}</span>`;
    else if (!it) h = r.descLen > 0 ? `<span class="badge b-rep">${esc(t('rep'))}</span>` : '';
    else if (it.status === 'queued') h = `<span class="badge b-q">${esc(it.register && !it.crawled ? t('st_regq') : t('q'))}</span>`;
    else if (it.status === 'crawling') h = `<span class="badge b-run">${esc(t('st_crawl'))}</span>`;
    else if (it.status === 'working') h = `<span class="badge b-run">${esc(t('w'))}</span>`;
    else if (it.status === 'failed') h = `<span class="badge b-bad">${esc(t('bad'))}</span>`;
    else h = `<span class="badge ${it.prevLen > 0 ? 'b-rep' : 'b-ok'}">${esc(it.prevLen > 0 ? t('okRep') : t('ok'))}</span><span class="note">${esc(t('imgs', it.images))}</span>`;
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
    // CLIA 에 없는 상품 → 같은 나라 LG.com 에서 찾은 것을 등록할지
    const notIn = S.reg.length + S.skip.filter((r) => r.why === 'rNone').length;
    $('regCard').classList.toggle('hidden', !notIn || !d.site);
    if (notIn && d.site) {
      $('regT').textContent = t('regT', notIn, S.reg.length, d.site);
      $('regSw').checked = S.regOn; $('regSw').disabled = S.busy || !S.reg.length;
      $('regL').textContent = t('regSw'); $('regN').textContent = t('regNote', d.site);
    }
    $('noMatch').classList.toggle('hidden', rows.length > 0 || S.reg.length > 0);
    $('noMatchT').textContent = t('noMatchT'); $('noMatchB').textContent = t('noMatchB');
    $('askDesc').classList.toggle('hidden', !!d.cols.desc);
    if (!d.cols.desc) $('descSel').innerHTML = '<option value="">—</option>' + d.columns.map((c) => `<option value="${c.col}">${c.letter} · ${esc(c.label)}</option>`).join('');
    $('pFile').textContent = d.fileName || '';
    $('pMatch').textContent = t('found', S.ok.length) + ' · ' + t('of', d.rows.length);
    const rv = new Set(reviewRows().map((r) => r.row));   // 확인 필요는 맨 위
    const ordered = rows.slice().sort((a, b) => (rv.has(b.row) - rv.has(a.row)));
    $('list').innerHTML = ordered.map((r, i) => `<label class="item${rv.has(r.row) ? ' rv' : ''}" style="${animate ? `animation-delay:${Math.min(i, 30) * 45}ms` : 'animation:none'}">` +
      `<input type="checkbox" data-row="${r.row}">` +
      ((r.p.thumb || (itemOf(r.row) || {}).thumb) ? `<img src="${esc(r.p.thumb || itemOf(r.row).thumb)}" alt="" loading="lazy">` : `<div class="ph">${esc(grpName(r.p.grp))}</div>`) +
      `<div style="min-width:0"><div class="m">${rv.has(r.row) ? `<span class="badge b-bad rvt">${esc(t('rvTag'))}</span>` : ''}${esc(r.p.model)}<span class="dv">${esc(r.p.dv || '')} · ${esc(grpName(r.p.grp))}</span>${r.p.isNew ? `<span class="badge b-new">${esc(t('newTag'))}</span>` : ''}</div>` +
      `<div class="s">${esc(r.name || r.p.title)}</div></div><div class="r"></div></label>`).join('');
    if (!rows.length && !S.reg.length && S.skip.length) S.tab = 'skip';
    $('skipSum').textContent = t('skip', S.skip.length);
    $('skipList').innerHTML = S.skip.map((r) => `<li>${esc(r.parentSku || r.sku || '—')} · ${esc(r.name)} <span class="badge b-q">${esc(r.why === 'rNone' && d.site ? t('notFound') : t(r.why))}</span>` +
      (r.why === 'rNone' && d.site ? `<span class="urlin"><input type="url" data-urow="${r.row}" placeholder="${esc(t('urlPh'))}"><button class="mini" data-uadd="${r.row}">${esc(t('urlAdd'))}</button><span class="err2" data-uerr="${r.row}"></span></span>` : '') + `</li>`).join('');
    refresh();
  }

  function refresh() {
    const rows = act();
    const allOf = (rs) => rs.length > 0 && rs.every((r) => S.sel.has(r.row));
    const pill = (attr, label, rs) => {
      const k = rs.filter((r) => S.sel.has(r.row)).length;
      return `<button class="pill ${k === 0 ? '' : (k === rs.length ? 'on' : 'part')}" ${attr}>${esc(label)}<b>${k ? k + '/' : ''}${rs.length}</b></button>`;
    };
    const ofDv = (dv) => rows.filter((r) => r.p.dv === dv);
    const ofGrp = (dv, g) => rows.filter((r) => r.p.dv === dv && r.p.grp === g);
    $('ctl').innerHTML = `<button class="pill ${allOf(rows) ? 'on' : ''}" data-act="all">${esc(t('selAll'))}<b>${rows.length}</b></button>` +
      `<button class="pill" data-act="none">${esc(t('selNone'))}</button><span class="div"></span>` +
      DIVS.filter((dv) => ofDv(dv).length).map((dv) => pill(`data-dv="${dv}"`, dv, ofDv(dv))).join('');
    $('ctl2').innerHTML = DIVS.filter((dv) => ofDv(dv).length).map((dv) =>
      GRPS[dv].filter((g) => ofGrp(dv, g).length).map((g) => pill(`data-dv="${dv}" data-grp="${g}"`, grpName(g), ofGrp(dv, g))).join('')).filter(Boolean).join('<span class="div"></span>');
    [...$('ctl').querySelectorAll('button'), ...$('ctl2').querySelectorAll('button'), ...$('qAct').querySelectorAll('button')].forEach((b) => { b.disabled = S.busy; });
    const hit = (r) => !S.q || [r.p.model, r.name, r.sku, r.parentSku, r.p.title, r.id].join(' ').toLowerCase().includes(S.q);
    $('qAct').classList.toggle('hidden', !S.q);
    $('qN').textContent = t('qRes', rows.filter(hit).length);
    // 탭: 전체 · 확인 필요 · 새로 등록 · 제외 — 확인 필요는 빨간 숫자
    const rvSet = new Set(reviewRows().map((r) => r.row));
    const rvN = rvSet.size;
    const newN = S.regOn ? S.reg.length : 0;
    if ((S.tab === 'review' && !rvN) || (S.tab === 'new' && !newN) || (S.tab === 'skip' && !S.skip.length)) S.tab = 'all';
    const tabs = [['all', t('tabAll'), rows.length, ''], ['review', t('tabReview'), rvN, 'rv'], ['new', t('tabNew'), newN, ''], ['skip', t('tabSkip'), S.skip.length, '']]
      .filter(([k, , n]) => k === 'all' || n);
    $('tabs').innerHTML = tabs.map(([k, label, n, cls]) => `<button class="tab ${cls}${S.tab === k ? ' on' : ''}" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${esc(label)}<b>${n}</b></button>`).join('');
    const inTab = (r) => S.tab === 'all' || (S.tab === 'review' && rvSet.has(r.row)) || (S.tab === 'new' && r.kind === 'new');
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
    $('skip').classList.toggle('hidden', !skipTab);
    document.querySelector('.tools').classList.toggle('hidden', skipTab || !rows.length);
    $('shiftTip').classList.toggle('hidden', skipTab || !rows.length);
    $('grpBtn').innerHTML = `${esc(t('grpBtn'))} ▾`;
    // 상황판
    const c = rows.filter((r) => S.sel.has(r.row)), rep = c.filter((r) => r.descLen > 0).length;
    const nNew = c.filter((r) => r.kind === 'new').length;
    $('regE').textContent = S.regOn && nNew ? t('regEst', estMin(nNew, c.length)) : '';
    const j = S.job, running = j && j.status === 'running';
    if (running) {
      const crawling = j.crawlTotal && j.crawlDone < j.crawlTotal;
      $('info').textContent = crawling ? t('progCrawl', j.crawlDone, j.crawlTotal) : t('progMake', j.done, j.total);
      $('prog').firstElementChild.style.width = (100 * (crawling ? j.crawlDone / j.crawlTotal : j.done / Math.max(1, j.total))) + '%';
    } else if (j && j.status === 'ready') $('info').innerHTML = t('done', j.ok, j.replaced, j.failed) + (rvN ? ` <button class="lnk" data-tab="review">${esc(t('rvLink', rvN))}</button>` : '');
    else if (j && j.status === 'failed') $('info').innerHTML = `<span style="color:var(--bad)">${esc(t('expFail') + (j.error || ''))}</span>`;
    else $('info').innerHTML = `<span>${t('info', c.length, rep)}</span>` + (rvN ? ` <button class="lnk" data-tab="review">${esc(t('rvLink', rvN))}</button>` : '');
    $('prog').classList.toggle('hidden', !running);
    // 알림 고르기: 오래 걸릴 작업(새로 등록 포함 또는 상품 40개 초과)에만
    $('ntW').classList.toggle('hidden', !((nNew > 0 || c.length > 40) && !running));
    $('ntMailW').classList.toggle('hidden', !S.cfg.mail);
    $('ntBtnL').textContent = t('ntBtn');
    $('ntBtn').classList.toggle('on', $('ntB').checked || ($('ntMailC').checked && !!S.cfg.mail));
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
  const pop = (btn, box) => { btn.onclick = (e) => { e.stopPropagation(); const open = box.classList.toggle('hidden'); btn.setAttribute('aria-expanded', String(!open)); }; box.onclick = (e) => e.stopPropagation(); };
  pop($('grpBtn'), $('ctl2'));
  pop($('ntBtn'), $('ntPop'));
  document.addEventListener('click', () => { ['ctl2', 'ntPop'].forEach((id) => $(id).classList.add('hidden')); });
  ['ntB', 'ntMailC'].forEach((id) => $(id).addEventListener('change', refresh));
  // 선택
  $('ctl2').addEventListener('click', (e) => $('ctl').onclick(e));
  $('ctl').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || S.busy) return;
    const rows = act();
    if (b.dataset.act === 'all') rows.forEach((r) => S.sel.add(r.row));
    else if (b.dataset.act === 'none') S.sel.clear();
    else if (b.dataset.dv) {
      const rs = rows.filter((r) => r.p.dv === b.dataset.dv && (!b.dataset.grp || r.p.grp === b.dataset.grp));
      const on = rs.every((r) => S.sel.has(r.row));
      rs.forEach((r) => (on ? S.sel.delete(r.row) : S.sel.add(r.row)));
    }
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
    if (b.dataset.a === 'retry') { if (b.dataset.code === 'crawl') S.force.add(row); S.ack.add(`${row}:${b.dataset.code}`); S.sel.add(row); saveAck(); render(false); }
    if (b.dataset.a === 'frame') openFrames(b.dataset.slug);
  });

  // 등록 스위치 · 주소 직접 넣기
  $('regSw').onchange = () => { S.regOn = $('regSw').checked; render(true); };
  $('skipList').addEventListener('click', async (e) => {
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
  $('view').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); };
  setView(VIEW);
  $('q').placeholder = t('search'); $('shiftTip').textContent = t('shift');
  $('qSel').textContent = t('qSel'); $('qDesel').textContent = t('qDesel');
  $('q').oninput = () => { S.q = $('q').value.trim().toLowerCase(); refresh(); };
  $('qAct').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || S.busy) return;
    document.querySelectorAll('#list .item:not(.hidden) input').forEach((x) => (b.id === 'qSel' ? S.sel.add(+x.dataset.row) : S.sel.delete(+x.dataset.row)));
    refresh();
  };

  // ── 동영상 장면 고르기 (자동으로 고른 장면의 1~3위 후보) ──
  async function openFrames(slug) {
    $('frm').classList.remove('hidden');
    $('frmT').textContent = t('frT'); $('frmX').textContent = t('frClose'); $('frmMsg').textContent = '';
    $('frmBody').innerHTML = '<div class="bar2"><i></i></div>';
    try { drawFrames(slug, (await api('/api/v1/bulk/frames?slug=' + encodeURIComponent(slug))).videos); }
    catch (e) { $('frmBody').textContent = e.message; }
  }
  function drawFrames(slug, videos) {
    if (!videos.length) { $('frmBody').textContent = t('frNone'); return; }
    $('frmBody').innerHTML = videos.map((v, i) => `<div class="fv"><div class="fvh">#${i + 1}</div><div class="fo">` +
      v.options.map((o) => `<button class="fopt${o === v.current ? ' on' : ''}" data-v="${esc(v.video)}" data-src="${esc(o)}"><img src="${esc(o)}" alt="" loading="lazy">${o === v.current ? `<span>${esc(t('frCur'))}</span>` : ''}</button>`).join('') + `</div></div>`).join('');
    $('frmBody').onclick = async (e) => {
      const b = e.target.closest('.fopt');
      if (!b) return;
      try {
        const d = await api('/api/v1/bulk/frame', { slug, video: b.dataset.v, src: b.dataset.src });
        drawFrames(slug, d.videos);
        $('frmMsg').textContent = t('frSaved');
        if (d.videos.every((v) => v.confirmed) && S.job) S.job.items.filter((x) => x.slug === slug).forEach((x) => S.ack.add(`${x.row}:frame`));
        saveAck(); render(false);
      } catch (err) { $('frmMsg').textContent = err.message; }
    };
  }
  $('frmX').onclick = () => $('frm').classList.add('hidden');
  $('frm').onclick = (e) => { if (e.target === $('frm')) $('frm').classList.add('hidden'); };

  // ── 내보내기 · 진행 · 알림 ──
  $('ntB').checked = true; $('ntMailC').checked = true;
  try { $('ntMail').value = sessionStorage.getItem('clia_user') || ''; } catch (_) {}
  $('ntL').textContent = t('nt'); $('ntBL').textContent = t('ntBrowser'); $('ntML').textContent = t('ntMail');
  const lastKey = 'clia-bulk-last-' + (CH0 || 'any');
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
    if (S.wantNotify && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('CLIA', { body: S.job.status === 'ready' ? t('notifDone', S.job.ok, S.job.review) : t('notifFail') }); } catch (_) {}
    }
    document.title = (S.job.status === 'ready' ? '✓ ' : '! ') + 'Bulk Excel — CLIA';
    if (S.job.status === 'ready' && S.autoDl) $('dl').click();
  }
  $('export').onclick = async () => {
    const items = act().filter((r) => S.sel.has(r.row)).map((r) => (r.kind === 'new'
      ? { row: r.row, url: r.p.url, register: true, alts: r.p.alts, fuzzy: r.p.fuzzy, force: S.force.has(r.row) }
      : { row: r.row, slug: r.p.slug, force: S.force.has(r.row) }));
    if (S.busy || !items.length) return;
    const longJob = !$('ntW').classList.contains('hidden');
    $('ntPop').classList.add('hidden');
    S.wantNotify = longJob && $('ntB').checked;
    if (S.wantNotify && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (_) {} }
    const email = longJob && S.cfg.mail && $('ntMailC').checked ? $('ntMail').value.trim() : '';
    S.autoDl = !longJob;   // 오래 걸리는 작업은 자동 다운로드 대신 '다시 받기' 버튼 · 알림
    S.busy = true; refresh();
    try {
      const j = await api('/api/v1/bulk/build', { id: S.data.id, channel: S.channel, sheet: S.data.sheet, descCol: S.data.cols.desc, country: home, lang: L, items, notify: email ? { email } : null });
      S.force = new Set(); S.ack = new Set();
      store.set(lastKey, { job: j.id, file: S.data.fileName, at: Date.now() });
      await poll(j);
    } catch (e) { S.busy = false; S.job = { items: [], status: 'failed', error: e.message }; render(false); }
  };

  // ── 이어 보기: 메일 링크(?job=) 또는 이 화면에서 마지막으로 한 작업 ──
  async function resume(id) {
    $('resume').classList.add('hidden');
    show('s2'); $('pmsg').textContent = t('reading'); $('pfile').textContent = '';
    try {
      const j = await api('/api/v1/bulk/jobs/' + id);
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
    const last = store.get(lastKey);
    if (last && last.job && Date.now() - last.at < 7 * 864e5) {
      api('/api/v1/bulk/jobs/' + last.job).then((j) => {
        $('resume').classList.remove('hidden');
        $('resumeT').textContent = t('resumeT', last.file || '') + ' · ' + (j.status === 'running' ? t('resumeRun', j.done, j.total) : t('resumeDone'));
        $('resumeB').textContent = t('resumeBtn');
        $('resumeB').onclick = () => resume(last.job);
      }).catch(() => {});
    }
  }
})();
