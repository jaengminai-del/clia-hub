/* bulk-check.js — 벌크 업로드 Check 단계 (?check=1 일 때만, 2026-11-26)
   흐름: 첨부 › 준비 › Check › 받기. 라이브 제품만 준비 · 결과가 나오는 대로 덱에서 두 더미로(통과 · 검토 필요), 사람은 검토 필요만 하나씩.
   - 라이브: 올린 엑셀에 Status 칸이 있으면 그것(Shopee Live · Lazada Active), 없으면 CLIA 라이브 목록(clia/th-live.json).
     라이브가 아니거나 상태를 모르는 행은 크롤 · 생성하지 않고 엑셀 그 행은 원래 내용 그대로.
   - 건너뛴 수는 제품(모델) 기준 — 진행 막대와 같은 단위. 목록에는 엑셀 행 수도.
   - AI 체크는 서버가 계산(bulk-jobs.js aiChecks) · 화면은 기다리게 하지 않는다 (스캔 띠는 날아가는 카드 위에서만).
   - 확인 = 승인 기록(approvals.js, via 'bulk' + 본 이미지 해시). 실제 다운로드 잠금은 APPROVAL_GATE 켤 때만.
   bulk.js 가 매칭(setData)까지 하고 BulkCheck.begin(core) 로 넘긴다. 기존 벌크 흐름은 그대로. */
(function () {
  const TX = {
    en: { steps: ['Attach', 'Prepare', 'Check', 'Download'], rows: (n) => `${n} rows`, prep: (a, b) => `Preparing ${a} / ${b}`, liveP: 'live products',
      skip: (n) => `${n} not live — skipped`, view: 'View', hide: 'Hide', asOf: (d) => `Live list as of ${d}`, byStatus: 'From the Status column',
      skipRows: (n) => `${n} rows in the Excel — left as they are`, notLive: 'Not live', unknown: 'Unknown', none: 'No live products in this file.',
      w_img: (n) => `${n} image${n === 1 ? '' : 's'} didn't load`, w_txt: (n) => `${n} lg.com lines missing`, w_sum: "Summary couldn't be made",
      w_spec: 'No spec table', w_fail: "Couldn't prepare", w_retried: 'still there after a retry', redo: 'Prepare again', remove: 'Remove from this Excel',
      redoing: 'Preparing again', doneT: (n) => `${n} checked`, removed: (n) => `${n} removed`, skipped: (n) => `${n} not live skipped`, dl: 'Download Excel', err: 'Something went wrong: ' },
    th: { steps: ['แนบไฟล์', 'เตรียม', 'ตรวจ', 'ดาวน์โหลด'], rows: (n) => `${n} แถว`, prep: (a, b) => `กำลังเตรียม ${a} / ${b}`, liveP: 'สินค้าที่ไลฟ์',
      skip: (n) => `ไม่ได้ไลฟ์ ${n} รายการ — ข้ามไป`, view: 'ดู', hide: 'ซ่อน', asOf: (d) => `รายการไลฟ์ ณ ${d}`, byStatus: 'จากคอลัมน์ Status',
      skipRows: (n) => `${n} แถวใน Excel — คงไว้ตามเดิม`, notLive: 'ไม่ได้ไลฟ์', unknown: 'ไม่ทราบ', none: 'ไม่มีสินค้าที่ไลฟ์ในไฟล์นี้',
      w_img: (n) => `โหลดรูปไม่ได้ ${n} รูป`, w_txt: (n) => `ข้อความจาก lg.com ขาด ${n} บรรทัด`, w_sum: 'สร้างสรุปไม่ได้',
      w_spec: 'ไม่มีตารางสเปก', w_fail: 'เตรียมไม่สำเร็จ', w_retried: 'ลองใหม่แล้วยังเหมือนเดิม', redo: 'เตรียมใหม่', remove: 'นำออกจาก Excel นี้',
      redoing: 'กำลังเตรียมใหม่', doneT: (n) => `ตรวจแล้ว ${n} รายการ`, removed: (n) => `นำออก ${n}`, skipped: (n) => `ข้ามที่ไม่ได้ไลฟ์ ${n}`, dl: 'ดาวน์โหลด Excel', err: 'เกิดข้อผิดพลาด: ' },
    ko: { steps: ['첨부', '준비', 'Check', '받기'], rows: (n) => `${n}행`, prep: (a, b) => `준비 중 ${a} / ${b}`, liveP: '라이브 제품',
      skip: (n) => `라이브 아님 ${n}개 — 건너뜀`, view: '보기', hide: '닫기', asOf: (d) => `라이브 목록 기준일 ${d}`, byStatus: 'Status 칸 기준',
      skipRows: (n) => `엑셀 ${n}행 — 원래 내용 그대로`, notLive: '라이브 아님', unknown: '모름', none: '이 파일에 라이브 제품이 없어요.',
      w_img: (n) => `이미지 ${n}장 못 불러옴`, w_txt: (n) => `lg.com 문구 ${n}줄 빠짐`, w_sum: '요약을 못 만듦',
      w_spec: '스펙표 없음', w_fail: '준비 못 함', w_retried: '다시 해도 그대로', redo: '다시 준비', remove: '이번 엑셀에서 빼기',
      redoing: '다시 준비하는 중', doneT: (n) => `${n}개 확인 완료`, removed: (n) => `${n}개 뺌`, skipped: (n) => `라이브 아님 ${n}개 건너뜀`, dl: '엑셀 받기', err: '문제가 생겼어요: ' },
    de: { steps: ['Anhängen', 'Vorbereiten', 'Prüfen', 'Herunterladen'], rows: (n) => `${n} Zeilen`, prep: (a, b) => `Vorbereitung ${a} / ${b}`, liveP: 'Live-Produkte',
      skip: (n) => `${n} nicht live — übersprungen`, view: 'Ansehen', hide: 'Ausblenden', asOf: (d) => `Live-Liste vom ${d}`, byStatus: 'Aus der Spalte Status',
      skipRows: (n) => `${n} Zeilen in der Excel — bleiben unverändert`, notLive: 'Nicht live', unknown: 'Unbekannt', none: 'Keine Live-Produkte in dieser Datei.',
      w_img: (n) => `${n} Bild(er) nicht geladen`, w_txt: (n) => `${n} Zeilen von lg.com fehlen`, w_sum: 'Zusammenfassung fehlgeschlagen',
      w_spec: 'Kein Datenblatt', w_fail: 'Vorbereitung fehlgeschlagen', w_retried: 'auch nach erneutem Versuch', redo: 'Neu vorbereiten', remove: 'Aus dieser Excel entfernen',
      redoing: 'Wird neu vorbereitet', doneT: (n) => `${n} geprüft`, removed: (n) => `${n} entfernt`, skipped: (n) => `${n} nicht live übersprungen`, dl: 'Excel herunterladen', err: 'Fehler: ' },
    ar: { steps: ['إرفاق', 'تجهيز', 'تحقق', 'تنزيل'], rows: (n) => `${n} صف`, prep: (a, b) => `جارٍ التجهيز ${a} / ${b}`, liveP: 'منتجات نشطة',
      skip: (n) => `${n} غير نشط — تم تخطيه`, view: 'عرض', hide: 'إخفاء', asOf: (d) => `قائمة النشط بتاريخ ${d}`, byStatus: 'من عمود Status',
      skipRows: (n) => `${n} صف في Excel — يبقى كما هو`, notLive: 'غير نشط', unknown: 'غير معروف', none: 'لا توجد منتجات نشطة في هذا الملف.',
      w_img: (n) => `تعذّر تحميل ${n} صورة`, w_txt: (n) => `${n} سطر من lg.com مفقود`, w_sum: 'تعذّر إنشاء الملخص',
      w_spec: 'لا يوجد جدول مواصفات', w_fail: 'تعذّر التجهيز', w_retried: 'ما زال بعد إعادة المحاولة', redo: 'إعادة التجهيز', remove: 'إزالة من ملف Excel هذا',
      redoing: 'جارٍ إعادة التجهيز', doneT: (n) => `تم فحص ${n}`, removed: (n) => `أُزيل ${n}`, skipped: (n) => `تم تخطي ${n} غير نشط`, dl: 'تنزيل Excel', err: 'حدث خطأ: ' },
  };
  // 덱 화면 (2026-11-27) 문구 — 위 TX 에 덧붙인다
  const TXD = {
    en: { viewAll: (n) => `View all ${n}`, browseT: 'All products — ← → next card · ↑ ↓ or Space to scroll · Esc back', moreBelow: 'More below', back: '← Back', prev: 'Previous', next: 'Next', removedL: 'Removed from this Excel', fReady: 'Ready', fReview: 'Needs review', checkingAll: (n) => `AI is checking all ${n} at once`, sumT: (r, m) => `${r} ready · ${m} need${m === 1 ? 's' : ''} your review`,
      sumS: (n, s, m) => `Checked ${n} in ${s} s — now just ${m === 1 ? 'this one' : 'these ' + m}`, reviewN: (i, n) => `Review ${i} of ${n}`, okIn: 'Looks fine · include',
      retryingA: 'Retrying automatically…', waitRetry: (n) => `${n} retrying automatically — they come back here when done`, onLg: 'On lg.com · missing here',
      allDone: 'All checked', confirmDl: (n) => `Confirm ${n} & download`, youOk: 'Ready · you checked' },
    th: { viewAll: (n) => `ดูทั้งหมด ${n}`, browseT: 'สินค้าทั้งหมด — ← → การ์ดถัดไป · ↑ ↓ หรือ Space เพื่อเลื่อนลง · Esc กลับ', moreBelow: 'ยังมีด้านล่าง', back: '← กลับ', prev: 'ก่อนหน้า', next: 'ถัดไป', removedL: 'นำออกจาก Excel นี้แล้ว', fReady: 'พร้อม', fReview: 'ต้องตรวจสอบ', checkingAll: (n) => `AI กำลังตรวจทั้ง ${n} รายการพร้อมกัน`, sumT: (r, m) => `พร้อม ${r} · ต้องตรวจสอบ ${m}`,
      sumS: (n, s, m) => `ตรวจ ${n} รายการใน ${s} วินาที — เหลือดูแค่ ${m}`, reviewN: (i, n) => `ตรวจสอบ ${i} จาก ${n}`, okIn: 'ดูแล้วโอเค · ใส่ไว้',
      retryingA: 'กำลังลองใหม่อัตโนมัติ…', waitRetry: (n) => `กำลังลองใหม่อัตโนมัติ ${n} รายการ — เสร็จแล้วจะกลับมาที่นี่`, onLg: 'บน lg.com · ไม่มีที่นี่',
      allDone: 'ตรวจครบแล้ว', confirmDl: (n) => `ยืนยัน ${n} และดาวน์โหลด`, youOk: 'พร้อม · คุณตรวจแล้ว' },
    ko: { viewAll: (n) => `전체 보기 ${n}`, browseT: '전체 제품 — ← → 다음 카드 · ↑ ↓ 나 스페이스로 내리기 · Esc 돌아가기', moreBelow: '아래에 더 있음', back: '← 돌아가기', prev: '이전', next: '다음', removedL: '이번 엑셀에서 뺌', fReady: '준비됨', fReview: '검토 필요', checkingAll: (n) => `AI가 ${n}개를 한꺼번에 확인 중`, sumT: (r, m) => `${r}개 준비됨 · ${m}개 검토 필요`,
      sumS: (n, s, m) => `${n}개를 ${s}초에 확인 — 이제 ${m}개만 보면 돼요`, reviewN: (i, n) => `검토 ${i} / ${n}`, okIn: '괜찮음 · 포함',
      retryingA: '자동으로 다시 시도 중…', waitRetry: (n) => `${n}개 자동으로 다시 시도 중 — 끝나면 여기로 와요`, onLg: 'lg.com 원본 · 여기선 빠짐',
      allDone: '모두 확인함', confirmDl: (n) => `${n}개 확인하고 받기`, youOk: '준비됨 · 직접 확인' },
    de: { viewAll: (n) => `Alle ${n} ansehen`, browseT: 'Alle Produkte — ← → nächste Karte · ↑ ↓ oder Leertaste zum Scrollen · Esc zurück', moreBelow: 'Weiter unten', back: '← Zurück', prev: 'Zurück', next: 'Weiter', removedL: 'Aus dieser Excel entfernt', fReady: 'Bereit', fReview: 'Zu prüfen', checkingAll: (n) => `KI prüft alle ${n} gleichzeitig`, sumT: (r, m) => `${r} bereit · ${m} zu prüfen`,
      sumS: (n, s, m) => `${n} in ${s} s geprüft — jetzt nur noch ${m}`, reviewN: (i, n) => `Prüfung ${i} von ${n}`, okIn: 'Passt · übernehmen',
      retryingA: 'Wird automatisch erneut versucht…', waitRetry: (n) => `${n} werden automatisch erneut versucht — sie kommen hierher zurück`, onLg: 'Auf lg.com · fehlt hier',
      allDone: 'Alles geprüft', confirmDl: (n) => `${n} bestätigen & herunterladen`, youOk: 'Bereit · von dir geprüft' },
    ar: { viewAll: (n) => `عرض الكل ${n}`, browseT: 'كل المنتجات — ← → البطاقة التالية · ↑ ↓ أو المسافة للتمرير · Esc للرجوع', moreBelow: 'المزيد بالأسفل', back: 'رجوع →', prev: 'السابق', next: 'التالي', removedL: 'أُزيل من ملف Excel هذا', fReady: 'جاهز', fReview: 'بحاجة إلى مراجعة', checkingAll: (n) => `الذكاء الاصطناعي يفحص جميع ${n} معًا`, sumT: (r, m) => `${r} جاهز · ${m} بحاجة إلى مراجعتك`,
      sumS: (n, s, m) => `تم فحص ${n} في ${s} ث — تبقّى ${m} فقط`, reviewN: (i, n) => `مراجعة ${i} من ${n}`, okIn: 'يبدو جيدًا · تضمين',
      retryingA: 'جارٍ إعادة المحاولة تلقائيًا…', waitRetry: (n) => `${n} قيد إعادة المحاولة تلقائيًا — ستعود هنا`, onLg: 'على lg.com · مفقود هنا',
      allDone: 'تم فحص الكل', confirmDl: (n) => `تأكيد ${n} والتنزيل`, youOk: 'جاهز · راجعته أنت' },
  };
  const tOf = (L) => Object.assign({}, TX.en, TXD.en, TX[L] || {}, TXD[L] || {});
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

  // ── Check: 덱 + 양쪽 더미 (2026-11-27) ──
  // 서버가 내용을 여러 개 동시에 만들고(bulk-jobs.js CONTENT_CONC) AI 체크 결과가 나오는 대로: 통과는 덱에서 오른쪽 더미로 우르르
  // (나올 때 스캔 띠가 빠르게 훑고 ✓), 검토 필요만 왼쪽에 쌓인다. 연출 때문에 기다리게 하지 않는다 — 결과가 몰리면 간격을 줄인다.
  // 다 끝나면 사람은 검토 필요만 큰 카드로 하나씩 (괜찮음 · 다시 준비 · 빼기). 마지막에 준비된 것을 한 번에 확인 → 받기.
  // 자동 재시도는 서버가 뒤에서 — 고쳐지면 그 카드가 왼쪽에서 오른쪽으로 옮겨 간다.
  const small = (u) => String(u || '').replace('/media/slices/', '/media/slices-p/');
  const smallG = (u) => String(u || '').replace(/([?&])w=\d+/, '$1w=400');
  const ukey = (u) => (u[0].bundle ? 'b:' + u[0].row : u[0].slug || u[0].url || 'r:' + u[0].row);
  const aiRows = (u) => (u[0].status === 'failed' ? [{ k: 'fail', ok: false, msg: u[0].error }] : u[0].ai || []);
  const why = (x) => ({ img: () => C.T.w_img(x.n), txt: () => C.T.w_txt(x.n), sum: () => C.T.w_sum, spec: () => C.T.w_spec, fail: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : ''), redo: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : '') }[x.k] || (() => x.k))();
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  const EZ = { out: 'cubic-bezier(.16,1,.3,1)', p3out: 'cubic-bezier(.33,1,.68,1)', p3in: 'cubic-bezier(.32,0,.67,0)', io: 'cubic-bezier(.45,0,.55,1)' };
  const busy = (u) => u.some((x) => x.status === 'working' || x.retrying);
  const settled = (u) => u.every((x) => x.status === 'ok' || x.status === 'failed' || x.status === 'cancelled');
  const passed = (u) => !busy(u) && u.every((x) => x.status === 'ok') && aiRows(u).every((x) => x.ok);
  const isRemoved = (u) => u.every((x) => x.check === 'removed');
  const isOk = (u) => u.every((x) => x.check === 'ok');
  const rowsOf = (u) => u.map((x) => x.row);
  const CW = 260;   // 큰 카드 폭 (검토 · 왼쪽 더미는 이걸 줄여서)

  function deckView(core) {
    const T = C.T, e = core.esc, N = C.units.length || C.liveN, sk = C.skip;
    const el = frame(core, 2);
    el.innerHTML = `<div class="dk" id="dk">
      <div class="dk-cnt dk-l"><span class="d"></span>${e(T.fReview)}<b id="dkLn">0</b></div><div class="dk-slot dk-ls" id="dkLs"></div>
      <div class="dk-cnt dk-r"><span class="k">${CK}</span>${e(T.fReady)}<b id="dkRn">0</b></div><div class="dk-slot dk-rs" id="dkRs"></div>
      <div class="dk-deck" id="dkDeck"><i style="transform:translate(6px,6px)"></i><i style="transform:translate(4px,4px)"></i><i style="transform:translate(2px,2px)"></i><i></i><span class="dk-sweep"></span></div>
      <div class="dk-big" id="dkBig"><div class="n"><span id="dkN">0</span> <small>/ ${N}</small></div><div class="l">${e(T.checkingAll(N))}</div><div class="ck-bar"><i id="dkBar" style="width:0"></i></div>
        ${sk.n ? `<div class="dk-sk">${e(T.skip(sk.n))}</div>` : ''}</div></div><div id="ckGo"></div>`;
    return document.getElementById('dk');
  }
  const rel = (el) => { const a = el.getBoundingClientRect(), b = C.dk.root.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
  const T3 = (o) => `translate(${o.x}px,${o.y}px) scale(${o.s == null ? 1 : o.s}) rotate(${o.r || 0}deg)`;
  async function moveTo(el, to, ms, ease, extra) {
    const from = el._pos || { x: 0, y: 0, s: 1, r: 0 }; to = { s: 1, r: 0, ...to }; el._pos = to;
    if (reduced()) { el.style.transform = T3(to); return; }
    const a = el.animate([{ transform: T3(from), ...((extra || {}).from || {}) }, { transform: T3(to), ...((extra || {}).to || {}) }], { duration: ms, easing: ease, fill: 'forwards' });
    await a.finished.catch(() => {}); el.style.transform = T3(to); if (!(extra || {}).keep) a.cancel();
  }
  function bump(id, n) {
    const b = document.getElementById(id); if (!b) return; b.textContent = n;
    if (!reduced()) b.animate([{ transform: 'translateY(-60%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: EZ.out });
  }
  function cardEl(core, u) {   // 큰 카드 = 상품 페이지 프리뷰 (bulk-market) + 모델 + 이유 한 줄
    const e = core.esc, it = u[0], so = it.store || {};
    const body = `<div class="ck-imgs">${(it.imgs || []).map(small).map((s) => `<img src="${e(s)}" alt="" decoding="async">`).join('')}</div>`;
    const pv = window.CliaMarket ? CliaMarket.page(C.job.channel, { title: so.title || it.title || it.model || '', gallery: (so.gallery || []).map(smallG), specs: so.specs, body }) : body;
    const el = document.createElement('div'); el.className = 'dk-card';
    el.innerHTML = `<div class="dk-ph"><div class="dk-sc">${pv}</div></div><div class="dk-mo">${e(it.model || '')}</div><div class="dk-st"></div>`;
    C.dk.root.appendChild(el); cardState(el, u); return el;
  }
  function cardState(el, u) {
    const bad = aiRows(u).filter((x) => !x.ok);
    el.classList.toggle('dk-busy', busy(u)); el.classList.toggle('dk-ok', passed(u)); el.classList.toggle('dk-rm', isRemoved(u));
    el.querySelector('.dk-st').textContent = isRemoved(u) ? C.T.removedL : busy(u) ? (u.some((x) => x.retrying) ? C.T.retryingA : C.T.redoing)
      : passed(u) ? C.T.fReady : bad.map(why).join(' · ') + (u[0].retried ? ' — ' + C.T.w_retried : '');
  }
  const pileAt = (k) => { const s = rel(document.getElementById('dkLs')); const sc = s.w / CW; return { x: s.x + Math.min(k, 7) * 4, y: s.y + Math.min(k, 7) * 8, s: sc, r: [-2.5, 2, -1, 1.5][k % 4] }; };
  const readyAt = (k) => { const s = rel(document.getElementById('dkRs')); return { x: s.x + (k % 6) * 2, y: s.y + 8 + (k % 6) * 2, s: s.w / 74, r: (k % 5 - 2) * 1.2 }; };
  const deckAt = () => { const d = rel(document.getElementById('dkDeck')); return { x: d.x, y: d.y }; };
  function toReady(core, u, anim) {   // 덱 → (가운데를 스치며 스캔) → 오른쪽 더미. 날아가는 동안만 DOM 에, 더미엔 위 몇 장만
    const D = C.dk, k = D.readyN++;
    if (!anim || reduced()) { bump('dkRn', D.readyN); return; }
    const it = u[0], so = it.store || {}, e = core.esc;
    const m = document.createElement('div'); m.className = 'dk-mini ok';
    m.innerHTML = `<img src="${e(smallG((so.gallery || [])[0] || ''))}" alt=""><b>${e(it.model || '')}</b>`;
    m.style.zIndex = 30 + (k % 50); D.root.appendChild(m);
    const a = deckAt(), to = readyAt(k), mid = { x: (a.x + to.x) / 2 - 40, y: Math.min(a.y, to.y) + (Math.abs(a.y - to.y) * 0.45) };
    m.animate([{ transform: `translate(${a.x}px,${a.y}px) scale(1)` }, { transform: `translate(${mid.x}px,${mid.y}px) scale(1.4) rotate(-6deg)`, offset: 0.45 }, { transform: T3(to) }], { duration: 520, easing: EZ.p3out, fill: 'forwards' })
      .finished.then(() => { bump('dkRn', D.readyN); D.minis.push(m); if (D.minis.length > 8) D.minis.shift().remove(); }, () => {});
  }
  function toReview(core, u, anim) {   // 덱 → 왼쪽 더미 (큰 카드가 작아져 쌓임)
    const D = C.dk, k = D.pile.length, el = cardEl(core, u);
    el.style.zIndex = 20 + k; el.classList.add('dk-pile'); D.pile.push(ukey(u)); D.els.set(ukey(u), el);
    const to = pileAt(k);
    if (!anim || reduced()) { el._pos = to; el.style.transform = T3(to); bump('dkLn', D.pile.length); return; }
    const a = deckAt(); el._pos = { x: a.x, y: a.y, s: 74 / CW };
    moveTo(el, to, 700, EZ.p3out).then(() => bump('dkLn', D.pile.length));
  }
  function place(core, u, anim) {
    const D = C.dk;
    if (isRemoved(u)) D.side.set(ukey(u), 'removed');   // 이어 볼 때: 이미 뺀 것 · 확인한 것
    else if (passed(u) || isOk(u)) { D.side.set(ukey(u), 'ready'); toReady(core, u, anim); }
    else { D.side.set(ukey(u), 'review'); toReview(core, u, anim); }
    D.shown++; const n = document.getElementById('dkN'); if (n) n.textContent = D.shown;
    const bar = document.getElementById('dkBar'); if (bar) bar.style.width = (D.shown / Math.max(1, C.units.length) * 100) + '%';
  }
  async function refresh(core) { try { C.job = await core.api('/api/v1/bulk/jobs/' + C.job.id); C.units = units(C.job); } catch (_) {} }
  // 결과가 나오는 대로 — 몰려오면 간격을 줄여 화면이 서버를 따라잡게 (연출 때문에 기다리지 않는다)
  async function rush(core, instant) {
    const D = C.dk = { root: null, side: new Map(), els: new Map(), pile: [], minis: [], q: [], readyN: 0, shown: 0, t0: performance.now() };
    C.units = units(C.job);
    D.root = deckView(core);
    D.root.classList.add('dk-run');
    const enqueue = () => { for (const u of C.units) { const k = ukey(u); if (D.side.has(k) || D.q.some((x) => x.k === k) || !settled(u)) continue; D.q.push({ k, u }); } };
    let pumping = true;
    const pump = (async () => {
      while (pumping || D.q.length) {
        const x = D.q.shift();
        if (!x) { await sleep(40); continue; }
        place(core, x.u, !instant);
        if (!instant) await sleep(Math.max(14, Math.min(90, 900 / (D.q.length + 1))));
      }
    })();
    enqueue();
    while (C.job.status === 'running' || C.job.status === 'queued') {
      await sleep(600); await refresh(core); enqueue();
    }
    enqueue(); pumping = false; await pump;
    D.root.classList.remove('dk-run');
    if (C.job.status !== 'ready') { alertLine(core, C.T.err + (C.job.error || C.job.status)); return; }
    D.secs = ((performance.now() - D.t0) / 1000).toFixed(1);
    await sleep(instant ? 0 : 450);   // 마지막 카드가 내려앉게
    return reviewFlow(core, instant);
  }
  // 검토 필요만 하나씩. 자동 재시도 중인 것은 뒤로 — 고쳐지면 오른쪽으로 옮겨 가고, 아니면 차례가 온다
  const needs = () => C.units.filter((u) => C.dk.side.get(ukey(u)) === 'review' && !isRemoved(u) && !isOk(u));
  async function settle(core) {   // 왼쪽에 있다가 (자동 재시도 · 다시 준비로) 통과한 것 → 오른쪽 더미로
    const D = C.dk;
    for (const u of C.units) {
      const k = ukey(u); if (D.side.get(k) !== 'review' || !passed(u)) continue;
      const el = D.els.get(k); D.side.set(k, 'ready'); D.pile = D.pile.filter((x) => x !== k); bump('dkLn', D.pile.length);
      if (el) { cardState(el, u); const r = readyAt(D.readyN); await moveTo(el, { ...r, s: r.s * 74 / CW }, 560, EZ.p3in, { to: { opacity: 0 }, keep: true }); el.remove(); D.els.delete(k); }
      D.readyN++; bump('dkRn', D.readyN);
    }
  }
  function header(core, h, p) {
    let t = document.getElementById('dkTitle');
    if (!t) { t = document.createElement('div'); t.className = 'dk-title'; t.id = 'dkTitle'; C.dk.root.appendChild(t); }
    t.innerHTML = `<h2>${core.esc(h)}</h2>${p ? `<p>${core.esc(p)}</p>` : ''}`;
  }
  async function reviewFlow(core, instant) {
    const T = C.T, D = C.dk;
    const big = document.getElementById('dkBig');
    if (big) { if (!instant && !reduced()) await big.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(6px)' }], { duration: 220, fill: 'forwards' }).finished.catch(() => {}); big.remove(); }
    await settle(core);
    const total = needs().length;
    if (!total) return finishView(core);
    // 체크가 끝났으면 오른쪽 Ready 더미를 눌러 전체 보기 (선택)
    const rs = document.getElementById('dkRs');
    if (rs) { rs.classList.add('dk-click'); rs.title = T.viewAll(C.units.length); rs.onclick = () => { if (C.abortReview) C.abortReview(); browse(core, Math.max(0, C.units.findIndex(passed)), 'deck'); }; }
    header(core, T.sumT(D.readyN, total), instant ? '' : T.sumS(C.units.length, D.secs, total));
    if (!instant) await sleep(1100);
    let n = 0;
    for (;;) {
      await settle(core);
      const left = needs();
      if (!left.length) break;
      const u = left.find((x) => !busy(x));
      if (!u) {   // 남은 건 자동 재시도 · 다시 준비 중 — 끝나면 여기로
        header(core, T.sumT(D.readyN, left.length), T.waitRetry(left.length));
        await sleep(2000); await refresh(core); continue;
      }
      n++;
      const r = await reviewOne(core, u, n, n + left.length - 1);
      if (r === 'abort') return;   // 전체 보기로 나감 — 돌아오면 다시 그림
      await refresh(core);
      if (r === 'error') n--;
    }
    return finishView(core);
  }
  function reviewOne(core, u, n, total) {
    const T = C.T, e = core.esc, D = C.dk, k = ukey(u), it = u[0];
    let el = D.els.get(k); if (!el) { el = cardEl(core, u); D.els.set(k, el); el._pos = pileAt(0); el.style.transform = T3(el._pos); }
    cardState(el, u);
    header(core, T.reviewN(n, total), '');
    const st = rel(D.root), sc = Math.min(1, (st.h - 140) / 540), x = Math.max(st.w * 0.2, 200), y = 70;
    el.style.zIndex = 60; el.classList.remove('dk-pile');
    const go = moveTo(el, { x, y, s: sc }, 620, EZ.io);
    const bad = aiRows(u).filter((x) => !x.ok), img = aiRows(u).find((x) => x.k === 'img' && !x.ok);
    const srcs = (img && img.src) || [];
    const p = document.createElement('div'); p.className = 'dk-panel';
    const px = x + CW * sc + 36, rx = rel(document.getElementById('dkRs')).x - 28;   // 오른쪽 더미 앞까지
    p.style.left = px + 'px'; p.style.top = y + 'px'; p.style.width = Math.max(320, Math.min(600, rx - px)) + 'px';
    p.innerHTML = `<div><div class="dk-q">${e(T.fReview)}</div><h3>${e(it.model || '')}</h3><div class="dk-ti">${e(((it.store || {}).title || it.title || '').slice(0, 80))}</div></div>
      <div class="dk-box">${bad.map((x) => `<div class="dk-r"><i></i><div><b>${e(why(x))}</b>${it.retried ? `<small>${e(T.w_retried)}</small>` : ''}</div></div>`).join('')}
        ${srcs.length ? `<div class="dk-th">${srcs.map((s) => `<figure><img src="${e(s)}" alt="" loading="lazy"><figcaption>${e(T.onLg)}</figcaption></figure>`).join('')}</div>` : ''}</div>
      <div class="dk-acts"><button class="dk-txt" data-a="remove" type="button">${e(T.remove)}</button><button class="clia-btn" data-a="retry" type="button">${e(T.redo)}</button><span class="dk-sp"></span>${it.status === 'ok' ? `<button class="clia-btn dk-ink" data-a="ok" type="button">${e(T.okIn)}</button>` : ''}</div>`;
    D.root.appendChild(p);
    if (!reduced()) p.animate([{ opacity: 0, transform: 'translateX(24px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 520, easing: EZ.out, fill: 'backwards' });
    return new Promise((done) => {
      C.abortReview = () => { C.abortReview = null; done('abort'); };
      p.querySelectorAll('[data-a]').forEach((b) => { b.onclick = async () => {
        C.abortReview = null;
        p.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        const a = b.dataset.a;
        const ok = await act(core, rowsOf(u), a, a === 'ok' ? { override: true } : null);
        if (!ok) { p.querySelectorAll('button').forEach((x) => { x.disabled = false; }); return; }
        await go;
        const fade = reduced() ? Promise.resolve() : p.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(6px)' }], { duration: 200, fill: 'forwards' }).finished.catch(() => {});
        fade.then(() => p.remove());
        if (a === 'ok') {   // 사람이 통과 → ✓ → 오른쪽 더미
          D.side.set(k, 'ready'); D.pile = D.pile.filter((x) => x !== k); bump('dkLn', D.pile.length);
          el.classList.add('dk-ok'); el.querySelector('.dk-st').textContent = T.youOk;
          await sleep(300); const r = readyAt(D.readyN);
          await moveTo(el, { ...r, s: r.s * 74 / CW }, 520, EZ.p3in, { to: { opacity: 0 }, keep: true }); el.remove(); D.els.delete(k);
          D.readyN++; bump('dkRn', D.readyN);
        } else if (a === 'remove') {   // 이번 엑셀에서 빼기 → 아래로 떨어지며
          D.side.set(k, 'removed'); D.pile = D.pile.filter((x) => x !== k); bump('dkLn', D.pile.length);
          await moveTo(el, { x, y: y + 280, s: sc, r: -4 }, 380, EZ.p3in, { to: { opacity: 0, filter: 'blur(8px)' }, keep: true }); el.remove(); D.els.delete(k);
        } else {   // 다시 준비 → 왼쪽 더미 맨 아래로 (끝나면 다시 차례가 오거나 통과면 오른쪽으로)
          const uu = C.units.find((x) => ukey(x) === k) || u; cardState(el, uu);
          el.classList.add('dk-pile'); await moveTo(el, pileAt(Math.max(0, D.pile.length - 1)), 520, EZ.p3out); el.style.zIndex = 19;
        }
        done(a);
      }; });
    });
  }
  // ── 전체 보기 (선택, 2026-11-27): 체크가 끝난 뒤 통과한 것까지 큰 카드로 한 장씩 — 좌우 화살표 · 키보드(← →, Esc) ──
  // 기본 흐름(빠르게)은 그대로. 보다가 문제가 있으면 여기서도 빼기 · 다시 준비 (검토 필요면 괜찮음 · 포함도). 나가면 온 곳으로.
  function browse(core, start, from) {
    const T = C.T, e = core.esc, rtl = document.documentElement.dir === 'rtl';
    let list = C.units.slice(), i = Math.max(0, Math.min(list.length - 1, start)), el = null, alive = true, polling = false;
    const view = frame(core, 2);
    view.innerHTML = `<div class="dk dk-br" id="dk"><a href="#" class="dk-back" id="dkBack">${e(T.back)}</a></div><div id="ckGo"></div>`;
    C.dk = { root: document.getElementById('dk'), els: new Map(), side: new Map(), pile: [], minis: [], q: [], readyN: 0, shown: 0 };
    const D = C.dk, p = document.createElement('div'); p.className = 'dk-panel'; D.root.appendChild(p);
    // 전체 보기 카드는 화면 높이에 맞춰 크게 (상세 이미지까지 보게) — 폭은 높이의 ~75%, 320~520px
    const geo = () => { const st = rel(D.root), y = 104, ch = Math.max(360, st.h - y - 56), cw = Math.round(Math.max(320, Math.min(520, ch * 0.75, st.w * 0.36))), x = Math.max(st.w * 0.08, 40), px = x + cw + 40;
      return { x, y, ch, cw, px, w: Math.max(300, Math.min(620, st.w - px - 48)) }; };
    const kind = (u) => (isRemoved(u) ? T.removedL : busy(u) ? T.redoing : passed(u) || isOk(u) ? T.fReady : T.fReview);
    function panel() {
      const u = list[i], it = u[0], g = geo(), bad = aiRows(u).filter((x) => !x.ok), img = aiRows(u).find((x) => x.k === 'img' && !x.ok), srcs = (img && img.src) || [];
      const canAct = !isRemoved(u) && !busy(u), review = !passed(u) && !isOk(u);
      p.style.left = g.px + 'px'; p.style.top = g.y + 'px'; p.style.width = g.w + 'px';
      p.innerHTML = `<div><div class="dk-q">${e(kind(u))}</div><h3>${e(it.model || '')}</h3><div class="dk-ti">${e(((it.store || {}).title || it.title || '').slice(0, 80))}</div></div>
        ${review && bad.length ? `<div class="dk-box">${bad.map((x) => `<div class="dk-r"><i></i><div><b>${e(why(x))}</b></div></div>`).join('')}
          ${srcs.length ? `<div class="dk-th">${srcs.map((s) => `<figure><img src="${e(s)}" alt="" loading="lazy"><figcaption>${e(T.onLg)}</figcaption></figure>`).join('')}</div>` : ''}</div>` : ''}
        ${canAct ? `<div class="dk-acts"><button class="dk-txt" data-a="remove" type="button">${e(T.remove)}</button><button class="clia-btn" data-a="retry" type="button">${e(T.redo)}</button>
          <span class="dk-sp"></span>${review && it.status === 'ok' ? `<button class="clia-btn dk-ink" data-a="ok" type="button">${e(T.okIn)}</button>` : ''}</div>` : ''}
        <div class="dk-nav"><button class="clia-btn" id="dkPrev" type="button"${i ? '' : ' disabled'}>${rtl ? '›' : '‹'} ${e(T.prev)}</button>
          <span class="dk-pos">${i + 1} / ${list.length}</span><button class="clia-btn" id="dkNext" type="button"${i < list.length - 1 ? '' : ' disabled'}>${e(T.next)} ${rtl ? '‹' : '›'}</button></div>`;
      p.querySelector('#dkPrev').onclick = () => go(-1); p.querySelector('#dkNext').onclick = () => go(1);
      p.querySelectorAll('[data-a]').forEach((b) => { b.onclick = async () => {
        p.querySelectorAll('[data-a]').forEach((x) => { x.disabled = true; });
        if (await act(core, rowsOf(u), b.dataset.a, b.dataset.a === 'ok' ? { override: true } : null)) sync();
        else p.querySelectorAll('[data-a]').forEach((x) => { x.disabled = false; });
      }; });
    }
    function sync() {   // 서버 상태로 목록 · 지금 카드 · 패널 다시
      const by = new Map(C.units.map((u) => [ukey(u), u]));
      list = list.map((u) => by.get(ukey(u)) || u);
      if (el) cardState(el, list[i]);
      panel();
      if (!polling && list.some((u) => busy(u) && !isRemoved(u))) { polling = true; (async () => { while (alive && list.some((u) => busy(u) && !isRemoved(u))) { await sleep(2000); await refresh(core); if (alive) sync(); } polling = false; })(); }
    }
    function show(dir) {   // 한 장씩: 나가는 카드는 짧게 가속하며, 들어오는 카드는 길게 안착 (HyperFrames 규칙)
      const g = geo(), u = list[i], old = el;
      header(core, `${i + 1} / ${list.length}`, T.browseT);
      el = cardEl(core, u); el.style.zIndex = 30; fullCard(el, g);
      const dx = (rtl ? -1 : 1) * 90 * dir;
      el._pos = { x: g.x + dx, y: g.y, s: 1 };
      moveTo(el, { x: g.x, y: g.y, s: 1 }, dir ? 360 : 0, EZ.out, { from: { opacity: dir ? 0 : 1 }, to: { opacity: 1 } });
      if (old) moveTo(old, { x: g.x - dx, y: g.y, s: 1 }, 180, EZ.p3in, { to: { opacity: 0 }, keep: true }).then(() => old.remove());
      panel();
      for (const v of [list[i + 1], list[i - 1]]) if (v) for (const src of (v[0].imgs || []).slice(0, 2).map(small)) { const im = new Image(); im.src = src; }   // 다음 장 미리
    }
    function go(d) { const j = i + d; if (j < 0 || j >= list.length) return; i = j; show(d); }
    function fullCard(c, g) {   // 크게 + 스크롤바 + '아래로 더 있음' (끝까지 내리면 사라짐). 새 카드라 늘 맨 위부터
      c.classList.add('dk-full'); c.style.width = g.cw + 'px';
      const ph = c.querySelector('.dk-ph'), sc = c.querySelector('.dk-sc'); ph.style.height = g.ch + 'px';
      const cm = c.querySelector('.cm'); if (cm) cm.style.zoom = (g.cw / 426).toFixed(3);   // 260px 카드의 .61 과 같은 비율
      const more = document.createElement('button'); more.type = 'button'; more.className = 'dk-more'; more.innerHTML = `<span>${e(T.moreBelow)} ↓</span>`;
      more.onclick = () => scrollBy(1); ph.appendChild(more);
      // 위치 막대: 맥은 스크롤바가 숨어 있어서 직접 그린다 (어디쯤인지 · 얼마나 남았는지)
      const rail = document.createElement('div'); rail.className = 'dk-rail'; rail.innerHTML = '<i></i>'; ph.appendChild(rail);
      const upd = () => {
        const max = sc.scrollHeight - sc.clientHeight, k = max > 0 ? sc.scrollTop / max : 0, hh = Math.max(24, rail.clientHeight * sc.clientHeight / Math.max(1, sc.scrollHeight));
        rail.firstChild.style.height = hh + 'px'; rail.firstChild.style.transform = `translateY(${(rail.clientHeight - hh) * k}px)`; rail.hidden = max <= 4;
        more.classList.toggle('dk-end', sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4);
      };
      sc.addEventListener('scroll', upd, { passive: true }); setTimeout(upd, 60); c.querySelectorAll('img').forEach((im) => im.addEventListener('load', upd, { once: true }));
    }
    function scrollBy(page, px) {   // ↓ · ↑ 조금, 스페이스 · Page Down 한 화면
      const sc = el && el.querySelector('.dk-sc'); if (!sc) return;
      sc.scrollBy({ top: px != null ? px : page * sc.clientHeight * 0.85, behavior: reduced() ? 'auto' : 'smooth' });
    }
    function key(ev) {
      if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
      const k = ev.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { ev.preventDefault(); scrollBy(0, k === 'ArrowDown' ? 160 : -160); return; }
      if (k === ' ' || k === 'PageDown' || k === 'PageUp') { ev.preventDefault(); scrollBy(k === 'PageUp' || (k === ' ' && ev.shiftKey) ? -1 : 1); return; }
      if (k === 'Home' || k === 'End') { ev.preventDefault(); const sc = el && el.querySelector('.dk-sc'); if (sc) sc.scrollTo({ top: k === 'Home' ? 0 : sc.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' }); return; }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); go(rtl ? -1 : 1); } else if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(rtl ? 1 : -1); } else if (ev.key === 'Escape') { ev.preventDefault(); leave(); }
    }
    function leave() {
      alive = false; document.removeEventListener('keydown', key);
      if (from === 'deck') rush(core, true); else finishView(core);
    }
    document.addEventListener('keydown', key);
    document.getElementById('dkBack').onclick = (ev) => { ev.preventDefault(); leave(); };
    show(0); sync();
  }
  async function act(core, rows, action, opts) {
    let who = ''; try { who = sessionStorage.getItem('clia_user') || localStorage.getItem('clia-bulk-mail') || ''; } catch (_) {}
    try {
      C.job = await core.api(`/api/v1/bulk/jobs/${C.job.id}/check`, { rows, action, by: who, override: !!(opts && opts.override) });
      C.units = units(C.job); alertLine(core, ''); return true;
    } catch (e) { alertLine(core, C.T.err + e.message); return false; }
  }
  function alertLine(core, msg) { const g = document.getElementById('ckGo'); if (g) g.innerHTML = msg ? `<div class="ck-why">${core.esc(msg)}</div>` : ''; }
  // 끝: 준비된 것을 한 번에 확인 (승인 기록 via 'bulk' + 본 이미지 해시) → 받기
  async function finishView(core) {
    const T = C.T, e = core.esc, ck = C.job.check || {};
    // 전체 보기에서 다시 준비한 것: 끝날 때까지 기다렸다가, 걸리면 검토로
    while (C.units.some((u) => busy(u) && !isRemoved(u))) { alertLine(core, T.redoing + '…'); await sleep(2000); await refresh(core); }
    if (C.units.some((u) => !passed(u) && !isRemoved(u) && !isOk(u))) return rush(core, true);
    const todo = C.units.filter((u) => passed(u) && !isOk(u) && !isRemoved(u));
    if (!todo.length) return doneView(core);
    const removed = C.units.filter(isRemoved).length;
    const el = frame(core, 2);
    el.innerHTML = `<div class="ck-wrap"><div class="ck-card ck-done"><div class="ck-ic">${CK}</div><div class="ck-dt">${e(T.allDone)}</div>
      <div class="ck-ds">${e([T.fReady + ' ' + todo.length, removed ? T.removed(removed) : '', T.skipped(ck.skipModels || 0)].filter(Boolean).join(' · '))}</div>
      <div class="dk-fin"><button class="clia-btn big" id="ckView" type="button">${e(T.viewAll(C.units.length))}</button><button class="clia-btn primary big" id="ckAll" type="button">${e(T.confirmDl(todo.length))}</button></div></div></div><div id="ckGo"></div>`;
    document.getElementById('ckView').onclick = () => browse(core, 0, 'finish');
    const b = document.getElementById('ckAll'); b.focus();
    b.onclick = async () => {
      b.disabled = true;
      if (!(await act(core, todo.flatMap(rowsOf), 'ok'))) { b.disabled = false; return; }
      doneView(core);
      if (C.job.file) { const a = document.createElement('a'); a.href = C.job.file; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
    };
  }
  function doneView(core) {
    const T = C.T, e = core.esc, ck = C.job.check || {};
    const el = frame(core, 3);
    const sub = [ck.removed ? T.removed(ck.removed) : '', T.skipped(ck.skipModels || 0)].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="ck-wrap"><div class="ck-card ck-done"><div class="ck-ic">${CK}</div><div class="ck-dt">${e(T.doneT(ck.confirmed || 0))}</div>
      <div class="ck-ds">${e(sub)}</div><a class="clia-btn primary big" href="${e(C.job.file || '#')}" download>${e(T.dl)}</a></div></div>`;
  }

  // ── 시작 · 이어 보기 ──
  async function begin(core) {
    const { S, d } = core;
    if (!d.cols || !d.cols.desc) return false;   // 설명 칸을 못 찾은 파일은 예전 흐름(칸 고르기)으로
    C = { core, T: tOf(core.L), job: null, units: [], open: false, fileName: d.fileName, rowsN: d.rows.length };
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
      await rush(core);
    } catch (e) { alertLine(core, C.T.err + e.message); }
    return true;
  }
  async function resume(core, job) {
    C = { core, T: tOf(core.L), job, units: units(job), open: false, fileName: job.fileName || '', rowsN: 0, liveN: units(job).length,
      // 이어 볼 때는 건너뛴 목록 없이 숫자만
      skip: { n: (job.check && job.check.skipModels) || 0, models: [], rows: (job.check && job.check.skipRows) || 0, by: job.check && job.check.by, asOf: job.check && job.check.asOf } };
    if (job.status === 'running' || job.status === 'queued') return rush(core);
    if (job.status === 'ready') return rush(core, true);   // 이어 볼 때는 날아가는 것 없이 바로 더미로
    prepView(core); alertLine(core, C.T.err + (job.error || job.status));
  }
  window.BulkCheck = { begin, resume, _classify: classify, _units: units };
})();
