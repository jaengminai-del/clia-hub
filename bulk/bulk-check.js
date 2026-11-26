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
    en: { wait: 'Waiting', checking: 'Checking…', passed: 'Passed', checkingN: (n) => `AI is checking ${n} products…`, passedN: (n) => `${n} passed`, lookN: (n) => `${n} need${n === 1 ? 's' : ''} a look`, confirm: 'Confirm', steps: ['Attach', 'Prepare', 'Check', 'Download'], rows: (n) => `${n} rows`, prep: (a, b) => `Preparing ${a} / ${b}`, liveP: 'live products',
      skip: (n) => `${n} not live — skipped`, view: 'View', hide: 'Hide', asOf: (d) => `Live list as of ${d}`, byStatus: 'From the Status column',
      skipRows: (n) => `${n} rows in the Excel — left as they are`, notLive: 'Not live', unknown: 'Unknown', none: 'No live products in this file.',
      ai: 'AI check', c_img: 'All images loaded', c_txt: 'Same text as lg.com', c_sum: 'Summary included', c_n12: 'Shopee: 12 images or fewer', c_spec: 'Spec table included',
      used: (u, a) => `${u} of ${a} images used`, w_img: (n) => `${n} image${n === 1 ? '' : 's'} didn't load`, w_txt: (n) => `${n} lg.com lines missing`, w_sum: "Summary couldn't be made",
      w_spec: 'No spec table', w_fail: "Couldn't prepare", w_retried: 'still there after a retry', next: 'Confirm & next →', redo: 'Prepare again', remove: 'Remove from this Excel',
      redoing: 'Preparing again', doneT: (n) => `${n} checked`, removed: (n) => `${n} removed`, skipped: (n) => `${n} not live skipped`, dl: 'Download Excel', err: 'Something went wrong: ' },
    th: { wait: 'รอ', checking: 'กำลังตรวจ…', passed: 'ผ่าน', checkingN: (n) => `AI กำลังตรวจ ${n} รายการ…`, passedN: (n) => `ผ่าน ${n}`, lookN: (n) => `ต้องดู ${n}`, confirm: 'ยืนยัน', steps: ['แนบไฟล์', 'เตรียม', 'ตรวจ', 'ดาวน์โหลด'], rows: (n) => `${n} แถว`, prep: (a, b) => `กำลังเตรียม ${a} / ${b}`, liveP: 'สินค้าที่ไลฟ์',
      skip: (n) => `ไม่ได้ไลฟ์ ${n} รายการ — ข้ามไป`, view: 'ดู', hide: 'ซ่อน', asOf: (d) => `รายการไลฟ์ ณ ${d}`, byStatus: 'จากคอลัมน์ Status',
      skipRows: (n) => `${n} แถวใน Excel — คงไว้ตามเดิม`, notLive: 'ไม่ได้ไลฟ์', unknown: 'ไม่ทราบ', none: 'ไม่มีสินค้าที่ไลฟ์ในไฟล์นี้',
      ai: 'AI ตรวจ', c_img: 'โหลดรูปครบ', c_txt: 'ข้อความตรงกับ lg.com', c_sum: 'มีสรุปสินค้า', c_n12: 'Shopee: ไม่เกิน 12 รูป', c_spec: 'มีตารางสเปก',
      used: (u, a) => `ใช้ ${u} จาก ${a} รูป`, w_img: (n) => `โหลดรูปไม่ได้ ${n} รูป`, w_txt: (n) => `ข้อความจาก lg.com ขาด ${n} บรรทัด`, w_sum: 'สร้างสรุปไม่ได้',
      w_spec: 'ไม่มีตารางสเปก', w_fail: 'เตรียมไม่สำเร็จ', w_retried: 'ลองใหม่แล้วยังเหมือนเดิม', next: 'ยืนยันและถัดไป →', redo: 'เตรียมใหม่', remove: 'นำออกจาก Excel นี้',
      redoing: 'กำลังเตรียมใหม่', doneT: (n) => `ตรวจแล้ว ${n} รายการ`, removed: (n) => `นำออก ${n}`, skipped: (n) => `ข้ามที่ไม่ได้ไลฟ์ ${n}`, dl: 'ดาวน์โหลด Excel', err: 'เกิดข้อผิดพลาด: ' },
    ko: { wait: '대기', checking: '확인 중…', passed: '통과', checkingN: (n) => `AI가 ${n}개 확인 중…`, passedN: (n) => `${n}개 통과`, lookN: (n) => `${n}개 확인 필요`, confirm: '확인', steps: ['첨부', '준비', 'Check', '받기'], rows: (n) => `${n}행`, prep: (a, b) => `준비 중 ${a} / ${b}`, liveP: '라이브 제품',
      skip: (n) => `라이브 아님 ${n}개 — 건너뜀`, view: '보기', hide: '닫기', asOf: (d) => `라이브 목록 기준일 ${d}`, byStatus: 'Status 칸 기준',
      skipRows: (n) => `엑셀 ${n}행 — 원래 내용 그대로`, notLive: '라이브 아님', unknown: '모름', none: '이 파일에 라이브 제품이 없어요.',
      ai: 'AI 체크', c_img: '이미지 다 불러옴', c_txt: 'lg.com 문구와 같음', c_sum: '요약 들어감', c_n12: 'Shopee 12장 이하', c_spec: '스펙표 들어감',
      used: (u, a) => `${a}장 중 ${u}장 사용`, w_img: (n) => `이미지 ${n}장 못 불러옴`, w_txt: (n) => `lg.com 문구 ${n}줄 빠짐`, w_sum: '요약을 못 만듦',
      w_spec: '스펙표 없음', w_fail: '준비 못 함', w_retried: '다시 해도 그대로', next: '확인하고 다음 →', redo: '다시 준비', remove: '이번 엑셀에서 빼기',
      redoing: '다시 준비하는 중', doneT: (n) => `${n}개 확인 완료`, removed: (n) => `${n}개 뺌`, skipped: (n) => `라이브 아님 ${n}개 건너뜀`, dl: '엑셀 받기', err: '문제가 생겼어요: ' },
    de: { wait: 'Wartet', checking: 'Prüft…', passed: 'Bestanden', checkingN: (n) => `KI prüft ${n} Produkte…`, passedN: (n) => `${n} bestanden`, lookN: (n) => `${n} ansehen`, confirm: 'Bestätigen', steps: ['Anhängen', 'Vorbereiten', 'Prüfen', 'Herunterladen'], rows: (n) => `${n} Zeilen`, prep: (a, b) => `Vorbereitung ${a} / ${b}`, liveP: 'Live-Produkte',
      skip: (n) => `${n} nicht live — übersprungen`, view: 'Ansehen', hide: 'Ausblenden', asOf: (d) => `Live-Liste vom ${d}`, byStatus: 'Aus der Spalte Status',
      skipRows: (n) => `${n} Zeilen in der Excel — bleiben unverändert`, notLive: 'Nicht live', unknown: 'Unbekannt', none: 'Keine Live-Produkte in dieser Datei.',
      ai: 'KI-Prüfung', c_img: 'Alle Bilder geladen', c_txt: 'Gleicher Text wie lg.com', c_sum: 'Zusammenfassung enthalten', c_n12: 'Shopee: höchstens 12 Bilder', c_spec: 'Datenblatt enthalten',
      used: (u, a) => `${u} von ${a} Bildern verwendet`, w_img: (n) => `${n} Bild(er) nicht geladen`, w_txt: (n) => `${n} Zeilen von lg.com fehlen`, w_sum: 'Zusammenfassung fehlgeschlagen',
      w_spec: 'Kein Datenblatt', w_fail: 'Vorbereitung fehlgeschlagen', w_retried: 'auch nach erneutem Versuch', next: 'Bestätigen & weiter →', redo: 'Neu vorbereiten', remove: 'Aus dieser Excel entfernen',
      redoing: 'Wird neu vorbereitet', doneT: (n) => `${n} geprüft`, removed: (n) => `${n} entfernt`, skipped: (n) => `${n} nicht live übersprungen`, dl: 'Excel herunterladen', err: 'Fehler: ' },
    ar: { wait: 'بانتظار', checking: 'جارٍ الفحص…', passed: 'ناجح', checkingN: (n) => `الذكاء الاصطناعي يفحص ${n} منتجات…`, passedN: (n) => `${n} ناجح`, lookN: (n) => `${n} يحتاج مراجعة`, confirm: 'تأكيد', steps: ['إرفاق', 'تجهيز', 'تحقق', 'تنزيل'], rows: (n) => `${n} صف`, prep: (a, b) => `جارٍ التجهيز ${a} / ${b}`, liveP: 'منتجات نشطة',
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

  // ── Check: 한 번에 6개 (2026-11-26) ──
  // AI 가 6개를 동시에 훑고(미리 계산한 결과를 스캔 모션으로), 사람은 통과한 것을 Enter 한 번으로 확인 · 걸린 것만 손본다.
  // 부드럽게: 카드에는 작은 미리보기(/media/slices-p/, 400px — 엑셀은 원본), 이미지를 다 받은 뒤에 스캔 시작,
  //          다음 6개는 미리 받아 둔다, 움직임은 transform 으로 (GPU).
  const BATCH = 6;
  const small = (u) => String(u || '').replace('/media/slices/', '/media/slices-p/');
  const smallG = (u) => String(u || '').replace(/([?&])w=\d+/, '$1w=400');
  const ukey = (u) => (u[0].bundle ? 'b:' + u[0].row : u[0].slug || u[0].url || 'r:' + u[0].row);
  const isDone = (u) => u.every((x) => x.check === 'ok' || x.check === 'removed');
  const aiRows = (u) => (u[0].status === 'failed' ? [{ k: 'fail', ok: false, msg: u[0].error }] : u[0].ai || []);
  const why = (x) => ({ img: () => C.T.w_img(x.n), txt: () => C.T.w_txt(x.n), sum: () => C.T.w_sum, spec: () => C.T.w_spec, fail: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : ''), redo: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : '') }[x.k] || (() => x.k))();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const tween = (ms, f) => new Promise((res) => { const t0 = performance.now(); const s = (n) => { const k = Math.min(1, (n - t0) / ms); f(ease(k)); if (k < 1) requestAnimationFrame(s); else res(); }; requestAnimationFrame(s); });
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  const imgsOf = (u) => (u[0].imgs || []).map(small);
  const prefetched = new Set();
  function prefetch(units) {   // 다음 6개 — 사람이 지금 6개를 보는 동안 받아 둔다
    for (const u of units) for (const src of [...imgsOf(u), smallG(((u[0].store || {}).gallery || [])[0])]) {
      if (!src || prefetched.has(src)) continue; prefetched.add(src); const im = new Image(); im.decoding = 'async'; im.src = src;
    }
  }
  function cardHtml(core, u, i) {
    const e = core.esc, it = u[0], so = it.store || {}, j = C.job;
    const body = `<div class="ck-imgs">${imgsOf(u).map((s) => `<img src="${e(s)}" alt="" decoding="async">`).join('')}</div>`;
    const pv = window.CliaMarket ? CliaMarket.page(j.channel, { title: so.title || it.title || it.model || '', gallery: (so.gallery || []).map(smallG), specs: so.specs, body }) : body;
    const n = Math.max(1, aiRows(u).length);
    return `<div class="ck-bc ck-load" data-k="${e(ukey(u))}" style="animation-delay:${i * 60}ms"><div class="ck-bph"><div class="ck-scan"></div><span class="ck-bdg">${CK}</span>
      <div class="ck-bsc"><div class="ck-mv">${pv}</div></div></div>
      <div class="ck-bmeta"><div class="ck-bmo">${e(it.model || '')}</div><div class="ck-bdots">${'<i></i>'.repeat(n)}</div><div class="ck-bst">${e(C.T.wait)}</div>
      <div class="ck-bfx"><button class="clia-btn" data-a="retry" type="button">${e(C.T.redo)}</button><button class="clia-btn" data-a="remove" type="button">${e(C.T.remove)}</button></div></div></div>`;
  }
  // 이미지를 다 받을 때까지(최대 8초) — 그동안 카드는 반짝이는 자리표시
  const ready = (el) => Promise.race([Promise.all([...el.querySelectorAll('img')].map((im) => (im.complete ? Promise.resolve() : im.decode().catch(() => {})))), sleep(8000)]);
  function finalState(el, u) {   // 스캔 없이 결과만 (이미 본 카드)
    const rows = aiRows(u), bad = rows.filter((x) => !x.ok), dots = [...el.querySelectorAll('.ck-bdots i')];
    rows.forEach((x, i) => { if (dots[i]) dots[i].className = x.ok ? 'k' : 'x'; });
    el.classList.remove('ck-load');
    if (u.some((x) => x.status === 'working')) { el.classList.add('ck-busy'); el.querySelector('.ck-bst').textContent = C.T.redoing; return; }
    const n12 = rows.find((x) => x.k === 'n12' && x.all > x.used);
    if (!bad.length) { el.classList.add('ck-pass'); el.querySelector('.ck-bst').textContent = C.T.passed + (n12 ? ' · ' + C.T.used(n12.used, n12.all) : ''); }
    else { el.classList.add('ck-fail'); el.querySelector('.ck-bst').textContent = bad.map(why).join(' · ') + (u[0].retried ? ' — ' + C.T.w_retried : ''); }
  }
  async function scan(el, u, delay) {
    await sleep(delay);
    await ready(el);
    el.classList.remove('ck-load');
    if (reduced() || u.some((x) => x.status === 'working')) return finalState(el, u);
    const sc = el.querySelector('.ck-bsc'), mv = el.querySelector('.ck-mv'), dots = [...el.querySelectorAll('.ck-bdots i')], rows = aiRows(u);
    const dist = Math.max(0, mv.offsetHeight - sc.clientHeight);
    el.querySelector('.ck-scan').classList.add('on'); el.querySelector('.ck-bst').textContent = C.T.checking;
    if (dots[0]) dots[0].className = 'r';
    let n = 0;
    await tween(1300, (k) => {
      mv.style.transform = `translate3d(0,${-dist * k}px,0)`;
      const want = Math.min(rows.length, Math.floor(k * (rows.length + 0.2)));
      while (n < want) { dots[n].className = rows[n].ok ? 'k' : 'x'; n++; if (dots[n]) dots[n].className = 'r'; }
    });
    el.querySelector('.ck-scan').classList.remove('on');
    const bad = rows.some((x) => !x.ok);
    if (!bad) await tween(260, (k) => { mv.style.transform = `translate3d(0,${-dist * (1 - k)}px,0)`; });
    mv.style.transform = '';
    finalState(el, u);
  }
  const seen = new Set();   // 이미 스캔을 보여 준 제품 — 다시 그릴 때 결과만
  async function checkView(core) {
    const T = C.T, e = core.esc, us = C.units;
    const left = us.filter((u) => !isDone(u));
    if (!left.length) return doneView(core);
    const batch = left.slice(0, BATCH), doneN = us.length - left.length;
    const el = frame(core, 2);
    el.innerHTML = `<div class="ck-p"><div class="ck-bar"><i style="width:${doneN / us.length * 100}%"></i></div><span class="ck-c">${doneN} / ${us.length}</span></div>
      <div class="ck-grid" id="ckGrid">${batch.map((u, i) => cardHtml(core, u, i)).join('')}</div>
      <div id="ckGo"></div>`;
    // 확인 버튼은 단계 줄(Attach › … › Download) 오른쪽 끝 — 다른 화면으로 가면 frame() 이 단계 줄을 다시 그려 사라짐
    document.getElementById('ckSteps').insertAdjacentHTML('beforeend', `<div class="ck-sact" id="ckAct"><span class="ck-bsum" id="ckSum">${e(T.checkingN(batch.length))}</span><button class="clia-btn primary" id="ckNext" type="button"></button></div>`);
    prefetch(left.slice(BATCH, BATCH * 2));
    const cards = [...document.querySelectorAll('#ckGrid .ck-bc')];
    cards.forEach((c, i) => c.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => act(core, batch[i].map((x) => x.row), b.dataset.a, b); }));
    const view = C.view = {};
    await Promise.all(cards.map((c, i) => (seen.has(ukey(batch[i])) ? ready(c).then(() => finalState(c, batch[i])) : scan(c, batch[i], i * 90).then(() => seen.add(ukey(batch[i]))))));
    if (C.view !== view) return;   // 그사이 다시 그렸음
    const pass = batch.filter((u) => !u.some((x) => x.status === 'working') && aiRows(u).every((x) => x.ok)), bad = batch.length - pass.length;
    document.getElementById('ckSum').innerHTML = [pass.length ? `<b>${e(T.passedN(pass.length))}</b>` : '', bad ? `<em>${e(T.lookN(bad))}</em>` : ''].filter(Boolean).join(' · ');
    if (batch.some((u) => u.some((x) => x.status === 'working'))) waitRedo(core, batch.filter((u) => u.some((x) => x.status === 'working')));
    if (!pass.length) return;
    const go = document.getElementById('ckNext'); go.textContent = T.confirm;
    document.getElementById('ckAct').classList.add('on'); go.focus();
    go.onclick = async () => {
      go.disabled = true;
      const rows = pass.flatMap((u) => u.map((x) => x.row));
      cards.filter((c) => c.classList.contains('ck-pass')).forEach((c, i) => { c.style.transitionDelay = i * 50 + 'ms'; c.classList.add('ck-out'); });
      await act(core, rows, 'ok', go, 450);
    };
  }
  async function act(core, rows, action, btn, wait) {
    if (btn) btn.disabled = true;
    let who = ''; try { who = sessionStorage.getItem('clia_user') || localStorage.getItem('clia-bulk-mail') || ''; } catch (_) {}
    try {
      const [j] = await Promise.all([core.api(`/api/v1/bulk/jobs/${C.job.id}/check`, { rows, action, by: who }), sleep(wait || (action === 'remove' ? 300 : 0))]);
      C.job = j; C.units = units(C.job);
      if (action === 'retry') { const u = C.units.find((x) => x.some((y) => rows.includes(y.row))); if (u) seen.delete(ukey(u)); }   // 다시 준비한 것은 다시 스캔
      checkView(core);
    } catch (e) {   // 실패: 사라지던 카드를 되돌리고(다시 그림 — 이미 본 카드는 결과만) 아래에 이유 한 줄
      if (btn) btn.disabled = false;
      const msg = C.T.err + e.message;
      await checkView(core);
      alertLine(core, msg);
    }
  }
  function alertLine(core, msg) { const g = document.getElementById('ckGo'); if (g) g.innerHTML = `<div class="ck-why">${core.esc(msg)}</div>`; }
  async function waitRedo(core, us) {
    const rows = us.flatMap((u) => u.map((x) => x.row)), view = C.view;
    while (C.view === view) {
      await sleep(3000);
      try { C.job = await core.api('/api/v1/bulk/jobs/' + C.job.id); } catch (_) { continue; }
      C.units = units(C.job);
      if (!C.job.items.filter((x) => rows.includes(x.row)).some((x) => x.status === 'working')) { us.forEach((u) => seen.delete(ukey(u))); return checkView(core); }
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
