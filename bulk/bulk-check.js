/* bulk-check.js — 벌크 업로드 Check 단계 (?check=1 일 때만, 2026-11-26)
   흐름: 첨부 › 준비 › Check › 받기. 라이브 제품만 준비하고, 한 화면에 한 제품씩 확인한다.
   - 라이브: 올린 엑셀에 Status 칸이 있으면 그것(Shopee Live · Lazada Active), 없으면 CLIA 라이브 목록(clia/th-live.json).
     라이브가 아니거나 상태를 모르는 행은 크롤 · 생성하지 않고 엑셀 그 행은 원래 내용 그대로.
   - 건너뛴 수는 제품(모델) 기준 — 진행 막대와 같은 단위. 목록에는 엑셀 행 수도.
   - AI 체크는 서버가 미리 계산(bulk-jobs.js aiChecks) · 화면은 1초 남짓 한 줄씩 ✓ 로 보여 준다.
   - 확인 = 승인 기록(approvals.js, via 'bulk' + 본 이미지 해시). 실제 다운로드 잠금은 APPROVAL_GATE 켤 때만.
   bulk.js 가 매칭(setData)까지 하고 BulkCheck.begin(core) 로 넘긴다. 기존 벌크 흐름은 그대로. */
(function () {
  const TX = {
    en: { steps: ['Attach', 'Prepare', 'Check', 'Download'], rows: (n) => `${n} rows`, prep: (a, b) => `Preparing ${a} / ${b}`, liveP: 'live products',
      skip: (n) => `${n} not live — skipped`, view: 'View', hide: 'Hide', asOf: (d) => `Live list as of ${d}`, byStatus: 'From the Status column',
      skipRows: (n) => `${n} rows in the Excel — left as they are`, notLive: 'Not live', unknown: 'Unknown', none: 'No live products in this file.',
      ai: 'AI check', c_img: 'All images loaded', c_txt: 'Same text as lg.com', c_sum: 'Summary included', c_n12: 'Shopee: 12 images or fewer', c_spec: 'Spec table included',
      used: (u, a) => `${u} of ${a} images used`, w_img: (n) => `${n} image${n === 1 ? '' : 's'} didn't load`, w_txt: (n) => `${n} lg.com lines missing`, w_sum: "Summary couldn't be made",
      w_spec: 'No spec table', w_fail: "Couldn't prepare", w_retried: 'still there after a retry', next: 'Confirm & next →', redo: 'Prepare again', remove: 'Remove from this Excel',
      redoing: 'Preparing again', doneT: (n) => `${n} checked`, removed: (n) => `${n} removed`, skipped: (n) => `${n} not live skipped`, dl: 'Download Excel', err: 'Something went wrong: ' },
    th: { steps: ['แนบไฟล์', 'เตรียม', 'ตรวจ', 'ดาวน์โหลด'], rows: (n) => `${n} แถว`, prep: (a, b) => `กำลังเตรียม ${a} / ${b}`, liveP: 'สินค้าที่ไลฟ์',
      skip: (n) => `ไม่ได้ไลฟ์ ${n} รายการ — ข้ามไป`, view: 'ดู', hide: 'ซ่อน', asOf: (d) => `รายการไลฟ์ ณ ${d}`, byStatus: 'จากคอลัมน์ Status',
      skipRows: (n) => `${n} แถวใน Excel — คงไว้ตามเดิม`, notLive: 'ไม่ได้ไลฟ์', unknown: 'ไม่ทราบ', none: 'ไม่มีสินค้าที่ไลฟ์ในไฟล์นี้',
      ai: 'AI ตรวจ', c_img: 'โหลดรูปครบ', c_txt: 'ข้อความตรงกับ lg.com', c_sum: 'มีสรุปสินค้า', c_n12: 'Shopee: ไม่เกิน 12 รูป', c_spec: 'มีตารางสเปก',
      used: (u, a) => `ใช้ ${u} จาก ${a} รูป`, w_img: (n) => `โหลดรูปไม่ได้ ${n} รูป`, w_txt: (n) => `ข้อความจาก lg.com ขาด ${n} บรรทัด`, w_sum: 'สร้างสรุปไม่ได้',
      w_spec: 'ไม่มีตารางสเปก', w_fail: 'เตรียมไม่สำเร็จ', w_retried: 'ลองใหม่แล้วยังเหมือนเดิม', next: 'ยืนยันและถัดไป →', redo: 'เตรียมใหม่', remove: 'นำออกจาก Excel นี้',
      redoing: 'กำลังเตรียมใหม่', doneT: (n) => `ตรวจแล้ว ${n} รายการ`, removed: (n) => `นำออก ${n}`, skipped: (n) => `ข้ามที่ไม่ได้ไลฟ์ ${n}`, dl: 'ดาวน์โหลด Excel', err: 'เกิดข้อผิดพลาด: ' },
    ko: { steps: ['첨부', '준비', 'Check', '받기'], rows: (n) => `${n}행`, prep: (a, b) => `준비 중 ${a} / ${b}`, liveP: '라이브 제품',
      skip: (n) => `라이브 아님 ${n}개 — 건너뜀`, view: '보기', hide: '닫기', asOf: (d) => `라이브 목록 기준일 ${d}`, byStatus: 'Status 칸 기준',
      skipRows: (n) => `엑셀 ${n}행 — 원래 내용 그대로`, notLive: '라이브 아님', unknown: '모름', none: '이 파일에 라이브 제품이 없어요.',
      ai: 'AI 체크', c_img: '이미지 다 불러옴', c_txt: 'lg.com 문구와 같음', c_sum: '요약 들어감', c_n12: 'Shopee 12장 이하', c_spec: '스펙표 들어감',
      used: (u, a) => `${a}장 중 ${u}장 사용`, w_img: (n) => `이미지 ${n}장 못 불러옴`, w_txt: (n) => `lg.com 문구 ${n}줄 빠짐`, w_sum: '요약을 못 만듦',
      w_spec: '스펙표 없음', w_fail: '준비 못 함', w_retried: '다시 해도 그대로', next: '확인하고 다음 →', redo: '다시 준비', remove: '이번 엑셀에서 빼기',
      redoing: '다시 준비하는 중', doneT: (n) => `${n}개 확인 완료`, removed: (n) => `${n}개 뺌`, skipped: (n) => `라이브 아님 ${n}개 건너뜀`, dl: '엑셀 받기', err: '문제가 생겼어요: ' },
    de: { steps: ['Anhängen', 'Vorbereiten', 'Prüfen', 'Herunterladen'], rows: (n) => `${n} Zeilen`, prep: (a, b) => `Vorbereitung ${a} / ${b}`, liveP: 'Live-Produkte',
      skip: (n) => `${n} nicht live — übersprungen`, view: 'Ansehen', hide: 'Ausblenden', asOf: (d) => `Live-Liste vom ${d}`, byStatus: 'Aus der Spalte Status',
      skipRows: (n) => `${n} Zeilen in der Excel — bleiben unverändert`, notLive: 'Nicht live', unknown: 'Unbekannt', none: 'Keine Live-Produkte in dieser Datei.',
      ai: 'KI-Prüfung', c_img: 'Alle Bilder geladen', c_txt: 'Gleicher Text wie lg.com', c_sum: 'Zusammenfassung enthalten', c_n12: 'Shopee: höchstens 12 Bilder', c_spec: 'Datenblatt enthalten',
      used: (u, a) => `${u} von ${a} Bildern verwendet`, w_img: (n) => `${n} Bild(er) nicht geladen`, w_txt: (n) => `${n} Zeilen von lg.com fehlen`, w_sum: 'Zusammenfassung fehlgeschlagen',
      w_spec: 'Kein Datenblatt', w_fail: 'Vorbereitung fehlgeschlagen', w_retried: 'auch nach erneutem Versuch', next: 'Bestätigen & weiter →', redo: 'Neu vorbereiten', remove: 'Aus dieser Excel entfernen',
      redoing: 'Wird neu vorbereitet', doneT: (n) => `${n} geprüft`, removed: (n) => `${n} entfernt`, skipped: (n) => `${n} nicht live übersprungen`, dl: 'Excel herunterladen', err: 'Fehler: ' },
    ar: { steps: ['إرفاق', 'تجهيز', 'تحقق', 'تنزيل'], rows: (n) => `${n} صف`, prep: (a, b) => `جارٍ التجهيز ${a} / ${b}`, liveP: 'منتجات نشطة',
      skip: (n) => `${n} غير نشط — تم تخطيه`, view: 'عرض', hide: 'إخفاء', asOf: (d) => `قائمة النشط بتاريخ ${d}`, byStatus: 'من عمود Status',
      skipRows: (n) => `${n} صف في Excel — يبقى كما هو`, notLive: 'غير نشط', unknown: 'غير معروف', none: 'لا توجد منتجات نشطة في هذا الملف.',
      ai: 'فحص الذكاء الاصطناعي', c_img: 'تم تحميل كل الصور', c_txt: 'نفس نص lg.com', c_sum: 'الملخص مضمّن', c_n12: 'Shopee: ‏12 صورة أو أقل', c_spec: 'جدول المواصفات مضمّن',
      used: (u, a) => `استُخدمت ${u} من ${a} صورة`, w_img: (n) => `تعذّر تحميل ${n} صورة`, w_txt: (n) => `${n} سطر من lg.com مفقود`, w_sum: 'تعذّر إنشاء الملخص',
      w_spec: 'لا يوجد جدول مواصفات', w_fail: 'تعذّر التجهيز', w_retried: 'ما زال بعد إعادة المحاولة', next: 'تأكيد والتالي ←', redo: 'إعادة التجهيز', remove: 'إزالة من ملف Excel هذا',
      redoing: 'جارٍ إعادة التجهيز', doneT: (n) => `تم فحص ${n}`, removed: (n) => `أُزيل ${n}`, skipped: (n) => `تم تخطي ${n} غير نشط`, dl: 'تنزيل Excel', err: 'حدث خطأ: ' },
  };
  const LIVE_LISTS = { th: '/clia/th-live.json' };   // 법인별 라이브 목록 (허브 Product List 와 같은 파일)
  const liveKey = (u) => String(u || '').trim().split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase() + '/';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CK = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>', XX = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  let C = null;   // { core, T, job, units, idx, skip, el }

  async function liveList(corp) {
    const f = LIVE_LISTS[corp]; if (!f) return null;
    // 채널별: 항목의 on('Shopee only' · 'Lazada only' · 'Shopee+Lazada') — Shopee 엑셀이면 Shopee 에 라이브인 것만
    try { const d = await (await fetch(f, { cache: 'no-cache' })).json(); return d && Array.isArray(d.live) ? { on: new Map(d.live.map((x) => [liveKey(x.url || x), String(x.on || '')])), asOf: d.asOf || d.updated || '' } : null; } catch (_) { return null; }
  }
  const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `${m[2]}/${m[3]}` : s; };   // 11/05
  const modelOf = (r) => (r.p && r.p.model) || String(r.parentSku || r.sku || '').split('.')[0] || String(r.name || '').slice(0, 40) || '—';

  // 행 → 라이브 판단: Status 칸 → 라이브 목록 → 모름
  function classify(core, list) {
    const { S, d } = core;
    const ch = (S.channel || d.channel || 'shopee') === 'lazada' ? 'lazada' : 'shopee';
    const hasStatus = !!(d.cols && d.cols.status);
    const all = [...S.ok, ...S.reg, ...S.skip];
    const urls = (r) => (r.kind === 'bundle' ? r.p.parts.map((x) => x.url).filter(Boolean) : r.p && r.p.url ? [r.p.url] : []);
    const live = [], skip = [];
    for (const r of all) {
      const isProduct = r.kind === 'clia' || r.kind === 'new' || r.kind === 'bundle';
      let st;
      if (hasStatus) st = /^(live|active)$/i.test(String(r.status || '').trim()) ? 'live' : (r.status ? 'not' : 'unknown');
      else if (list) { const u = urls(r); st = !u.length ? 'unknown' : u.some((x) => { const on = list.on.get(liveKey(x)); return on != null && (!on || new RegExp(ch, 'i').test(on)); }) ? 'live' : 'not'; }
      else st = 'unknown';
      if (st === 'live' && isProduct) live.push(r); else skip.push({ r, model: modelOf(r), status: hasStatus && r.status ? r.status : st === 'not' ? null : 'unknown' });
    }
    const models = new Map();
    for (const x of skip) { const k = x.model.toUpperCase(); if (!models.has(k)) models.set(k, { model: x.model, status: x.status, rows: 0 }); models.get(k).rows++; }
    return { live, skip, models: [...models.values()], by: hasStatus ? 'status' : 'list', asOf: hasStatus ? '' : (list && list.asOf) || '' };
  }

  // ── 화면 틀 ──
  function frame(core, step) {
    const T = C.T;
    let st = document.getElementById('ckSteps');
    if (!st) { st = document.createElement('div'); st.id = 'ckSteps'; st.className = 'ck-steps'; document.querySelector('.hd').after(st); }
    st.innerHTML = T.steps.map((x, i) => `<span class="ck-st ${i < step ? 'ck-d' : i === step ? 'ck-o' : ''}">${core.esc(x)}</span>`).join('<span class="ck-sep">›</span>');
    document.querySelector('.body').classList.add('hidden');
    let el = document.getElementById('ck');
    if (!el) { el = document.createElement('div'); el.id = 'ck'; el.className = 'ck'; document.querySelector('.body').after(el); }
    el.classList.toggle('ck-full', step === 2);
    return el;
  }
  const units = (j) => {   // 한 제품 = 같은 제품의 행들 (진행 막대 · 건너뜀 수와 같은 단위)
    const m = new Map();
    for (const it of j.items || []) { const k = it.bundle ? 'b:' + it.row : it.slug || it.url || 'r:' + it.row; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return [...m.values()];
  };
  const uDone = (u) => u.every((x) => x.status === 'ok' || x.status === 'failed' || x.status === 'cancelled');

  function prepView(core) {
    const T = C.T, e = core.esc, j = C.job, us = j ? units(j) : null;
    const total = us ? us.length : C.liveN, done = us ? us.filter(uDone).length : 0;
    const sk = C.skip;
    const el = frame(core, 1);
    el.innerHTML = `<div class="ck-wrap"><div class="ck-card">
      <div class="ck-file"><svg viewBox="0 0 24 24"><path d="M4 3h11l5 5v13H4z"/><path d="M15 3v5h5"/></svg><b>${e(C.fileName)}</b><span>${e(T.rows(C.rowsN))}</span></div>
      ${total ? `<div class="ck-pt">${e(T.prep(done, total))}<span>${e(T.liveP)}</span></div><div class="ck-bar"><i style="width:${total ? done / total * 100 : 0}%"></i></div>` : `<div class="ck-pt">${e(T.none)}</div>`}
      ${sk.n ? `<div class="ck-skip">${e(T.skip(sk.n))} ${sk.models.length ? `<a href="#" id="ckView">${e(C.open ? T.hide : T.view)}</a>` : ''}<span class="ck-src">${e(sk.by === 'status' ? T.byStatus : sk.asOf ? T.asOf(fmtDate(sk.asOf)) : '')}</span></div>
        ${C.open ? `<div class="ck-sl"><div class="ck-slh">${e(T.skipRows(sk.rows))}</div>${sk.models.map((x) => `<div><span>${e(x.model)}</span><span class="ck-m">${e(x.status === 'unknown' ? T.unknown : x.status || T.notLive)}${x.rows > 1 ? ` · ${e(T.rows(x.rows))}` : ''}</span></div>`).join('')}</div>` : ''}` : ''}
    </div></div>`;
    const v = document.getElementById('ckView'); if (v) v.onclick = (ev) => { ev.preventDefault(); C.open = !C.open; prepView(core); };
  }

  // ── Check: 한 화면에 한 제품 ──
  function aiRows(u) {
    const T = C.T, it = u[0];
    if (it.status === 'failed') return [{ k: 'fail', ok: false, msg: it.error }];
    return it.ai || [];
  }
  const label = (x) => ({ img: C.T.c_img, txt: C.T.c_txt, sum: C.T.c_sum, n12: C.T.c_n12, spec: C.T.c_spec, fail: C.T.w_fail, redo: C.T.w_fail }[x.k] || x.k);
  const why = (x) => ({ img: () => C.T.w_img(x.n), txt: () => C.T.w_txt(x.n), sum: () => C.T.w_sum, spec: () => C.T.w_spec, fail: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : ''), redo: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : '') }[x.k] || (() => x.k))();
  async function checkView(core) {
    const T = C.T, e = core.esc, j = C.job, us = C.units;
    const left = us.filter((u) => !u.every((x) => x.check === 'ok' || x.check === 'removed'));
    if (!left.length) return doneView(core);
    const u = left[0], it = u[0], n = us.length - left.length + 1;
    C.cur = it.row;
    const el = frame(core, 2);
    // 왼쪽: 실제로 내려받을 상세 이미지를 LG ELECTRONICS Shopee · Lazada 상품 페이지 틀(bulk-market.js) 안에 — 갤러리 · 제목 · 스펙은 크롤 데이터
    const imgs = (it.imgs || []).map((s) => `<img src="${e(s)}" alt="" loading="lazy">`).join('');
    const so = it.store || {};
    const pv = window.CliaMarket ? CliaMarket.page(j.channel, { title: so.title || it.title || it.model || '', gallery: so.gallery, specs: so.specs, body: `<div class="ck-imgs">${imgs}</div>` }) : imgs;
    el.innerHTML = `<div class="ck-p"><div class="ck-bar"><i style="width:${(n - 1) / us.length * 100}%"></i></div><span class="ck-c">${n} / ${us.length}</span></div>
      <div class="ck-b"><div class="ck-phone"><div class="ck-sc" id="ckSc">${pv}</div></div>
      <div class="ck-side"><h2>${e(it.model || '')}</h2><div class="ck-tt" lang="th">${e(it.title || '')}</div>
      <div class="ck-ai"><div class="ck-h">${e(T.ai)}</div><div id="ckAi"></div></div><div id="ckGo"></div></div></div>`;
    if (u.some((x) => x.status === 'working')) { document.getElementById('ckAi').innerHTML = `<div class="ck-run">${e(T.redoing)}</div>`; return waitRedo(core, u); }
    // AI 체크: 미리 계산한 결과를 1초 남짓 동안 한 줄씩
    const rows = aiRows(u), box = document.getElementById('ckAi');
    box.innerHTML = rows.map((x, i) => `<div class="ck-r ck-wait" data-i="${i}"><em></em><span>${e(label(x))}</span>${x.k === 'n12' && x.all > x.used ? `<small>${e(T.used(x.used, x.all))}</small>` : ''}</div>`).join('');
    const step = Math.max(160, Math.round(1200 / Math.max(1, rows.length)));
    for (let i = 0; i < rows.length; i++) {
      const r = box.querySelector(`[data-i="${i}"]`); if (!r) return;
      r.className = 'ck-r ck-run'; await sleep(step);
      if (!box.isConnected) return;
      r.className = 'ck-r ' + (rows[i].ok ? 'ck-ok' : 'ck-no'); r.querySelector('em').innerHTML = rows[i].ok ? CK : XX;
    }
    const bad = rows.filter((x) => !x.ok), go = document.getElementById('ckGo');
    const rowsOf = u.map((x) => x.row);
    if (!bad.length) {
      go.innerHTML = `<div class="ck-go"><button class="clia-btn primary big" id="ckNext" type="button">${e(T.next)}</button><span class="ck-kbd"><b>Enter</b></span></div>`;
      const b = document.getElementById('ckNext'); b.focus();
      b.onclick = () => act(core, rowsOf, 'ok', b);
    } else {
      go.innerHTML = `<div class="ck-why">${e(bad.map(why).join(' · '))}${it.retried ? ' — ' + e(T.w_retried) : ''}</div>
        <div class="ck-go2"><button class="clia-btn" id="ckRedo" type="button">${e(T.redo)}</button><button class="clia-btn" id="ckRm" type="button">${e(T.remove)}</button></div>`;
      document.getElementById('ckRedo').onclick = (ev) => act(core, rowsOf, 'retry', ev.currentTarget);
      document.getElementById('ckRm').onclick = (ev) => act(core, rowsOf, 'remove', ev.currentTarget);
    }
  }
  async function act(core, rows, action, btn) {
    if (btn) btn.disabled = true;
    let who = ''; try { who = sessionStorage.getItem('clia_user') || localStorage.getItem('clia-bulk-mail') || ''; } catch (_) {}
    try {
      C.job = await core.api(`/api/v1/bulk/jobs/${C.job.id}/check`, { rows, action, by: who });
      C.units = units(C.job);
      checkView(core);
    } catch (e) { if (btn) btn.disabled = false; alertLine(core, C.T.err + e.message); }
  }
  function alertLine(core, msg) { const g = document.getElementById('ckGo'); if (g) g.insertAdjacentHTML('beforeend', `<div class="ck-why">${core.esc(msg)}</div>`); }
  async function waitRedo(core, u) {
    const rows = u.map((x) => x.row);
    while (true) {
      await sleep(3000);
      try { C.job = await core.api('/api/v1/bulk/jobs/' + C.job.id); } catch (_) { continue; }
      C.units = units(C.job);
      const now = C.job.items.filter((x) => rows.includes(x.row));
      if (!now.some((x) => x.status === 'working')) return checkView(core);
    }
  }
  function doneView(core) {
    const T = C.T, e = core.esc, ck = C.job.check || {};
    const el = frame(core, 3);
    const sub = [ck.removed ? T.removed(ck.removed) : '', T.skipped(ck.skipModels || 0)].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="ck-wrap"><div class="ck-card ck-done"><div class="ck-ic">${CK}</div><div class="ck-dt">${e(T.doneT(ck.confirmed || 0))}</div>
      <div class="ck-ds">${e(sub)}</div><a class="clia-btn primary big" href="${e(C.job.file || '#')}" download>${e(T.dl)}</a></div></div>`;
  }

  // ── 시작 · 이어 보기 ──
  async function poll(core) {
    while (C.job.status === 'running' || C.job.status === 'queued') {
      prepView(core);
      await sleep(3000);
      try { C.job = await core.api('/api/v1/bulk/jobs/' + C.job.id); } catch (_) {}
    }
    C.units = units(C.job);
    if (C.job.status !== 'ready') { prepView(core); alertLine(core, C.T.err + (C.job.error || C.job.status)); return; }
    checkView(core);
  }
  async function begin(core) {
    const { S, d } = core;
    if (!d.cols || !d.cols.desc) return false;   // 설명 칸을 못 찾은 파일은 예전 흐름(칸 고르기)으로
    C = { core, T: TX[core.L] || TX.en, job: null, units: [], open: false, fileName: d.fileName, rowsN: d.rows.length };
    const list = await liveList(core.home());
    const k = classify(core, list);
    const liveProducts = new Set(k.live.map((r) => (r.kind === 'bundle' ? 'b:' + r.row : r.p.slug || r.p.url)));
    C.skip = { n: k.models.length, models: k.models, rows: k.skip.length, by: k.by, asOf: k.asOf };
    C.liveN = liveProducts.size;
    prepView(core);
    if (!k.live.length) return true;
    const items = k.live.map((r) => (r.kind === 'bundle'
      ? { row: r.row, title: r.name, bundle: r.p.parts.map((x) => (x.register ? { url: x.url, register: true } : { slug: x.slug })) }
      : r.kind === 'new' ? { row: r.row, url: r.p.url, register: true, alts: r.p.alts, fuzzy: r.p.fuzzy } : { row: r.row, slug: r.p.slug }));
    try {
      C.job = await core.api('/api/v1/bulk/build', { id: d.id, channel: S.channel || d.channel || 'shopee', sheet: d.sheet, descCol: d.cols.desc, country: core.home(), lang: core.L, items,
        check: { skipModels: k.models.length, skipRows: k.skip.length, by: k.by, asOf: k.asOf } });
      core.remember(C.job.id);
      await poll(core);
    } catch (e) { alertLine(core, C.T.err + e.message); }
    return true;
  }
  async function resume(core, job) {
    C = { core, T: TX[core.L] || TX.en, job, units: units(job), open: false, fileName: job.fileName || '', rowsN: 0, liveN: units(job).length,
      // 이어 볼 때는 건너뛴 목록 없이 숫자만
      skip: { n: (job.check && job.check.skipModels) || 0, models: [], rows: (job.check && job.check.skipRows) || 0, by: job.check && job.check.by, asOf: job.check && job.check.asOf } };
    if (job.status === 'running' || job.status === 'queued') return poll(core);
    if (job.status === 'ready') return checkView(core);
    prepView(core); alertLine(core, C.T.err + (job.error || job.status));
  }
  window.BulkCheck = { begin, resume, _classify: classify, _units: units };
})();
