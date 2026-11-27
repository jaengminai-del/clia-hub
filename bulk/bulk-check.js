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
      pGone: 'The image that should be here is missing', pBlank: 'This image spot is empty', should: 'The image that should be here', noOrig: "Doesn't open on lg.com either — the original may be gone", pBad: "This image didn't load", pLg: 'This lg.com image is missing from the PDP', pLgN: (n) => `${n} lg.com image${n === 1 ? ' is' : 's are'} missing from the PDP`, pTxt: 'These lg.com lines are missing from the PDP', pSpec: 'No spec table in the PDP', pBadN: (n) => `${n} image${n === 1 ? '' : 's'} missing — place unknown`, probN: (a, b) => `Problem ${a} / ${b}`, nextP: 'Next problem', orig: 'lg.com original', w_lgimg: (n) => `${n} lg.com image${n === 1 ? '' : 's'} not in the PDP`, w_at: 'marked', badM: "Didn't load", w_img: (n) => `${n} image${n === 1 ? '' : 's'} missing in the PDP`, w_txt: (n) => `${n} lg.com lines missing`, w_sum: "Summary couldn't be made",
      w_spec: 'No spec table', w_fail: "Couldn't prepare", w_retried: 'still there after a retry', redo: 'Prepare again', remove: 'Remove from this Excel',
      redoing: 'Preparing again', doneT: (n) => `${n} checked`, removed: (n) => `${n} removed`, skipped: (n) => `${n} not live skipped`, dl: 'Download Excel', err: 'Something went wrong: ' },
    th: { steps: ['แนบไฟล์', 'เตรียม', 'ตรวจ', 'ดาวน์โหลด'], rows: (n) => `${n} แถว`, prep: (a, b) => `กำลังเตรียม ${a} / ${b}`, liveP: 'สินค้าที่ไลฟ์',
      skip: (n) => `ไม่ได้ไลฟ์ ${n} รายการ — ข้ามไป`, view: 'ดู', hide: 'ซ่อน', asOf: (d) => `รายการไลฟ์ ณ ${d}`, byStatus: 'จากคอลัมน์ Status',
      skipRows: (n) => `${n} แถวใน Excel — คงไว้ตามเดิม`, notLive: 'ไม่ได้ไลฟ์', unknown: 'ไม่ทราบ', none: 'ไม่มีสินค้าที่ไลฟ์ในไฟล์นี้',
      pGone: 'รูปที่ควรอยู่ตรงนี้หายไป', pBlank: 'ช่องรูปนี้ว่างเปล่า', should: 'รูปที่ควรอยู่ตรงนี้', noOrig: 'เปิดบน lg.com ไม่ได้เช่นกัน — ต้นฉบับอาจถูกลบไปแล้ว', pBad: 'โหลดรูปนี้ไม่ได้', pLg: 'รูปนี้จาก lg.com ขาดไปจาก PDP', pLgN: (n) => `รูปจาก lg.com ขาดไปจาก PDP ${n} รูป`, pTxt: 'ข้อความเหล่านี้จาก lg.com ขาดไปจาก PDP', pSpec: 'ไม่มีตารางสเปกใน PDP', pBadN: (n) => `รูปหายไป ${n} รูป — ไม่ทราบตำแหน่ง`, probN: (a, b) => `ปัญหา ${a} / ${b}`, nextP: 'ปัญหาถัดไป', orig: 'ต้นฉบับ lg.com', w_lgimg: (n) => `รูปจาก lg.com ไม่อยู่ใน PDP ${n} รูป`, w_at: 'ทำเครื่องหมายไว้ใน PDP', badM: 'โหลดไม่ได้', w_img: (n) => `รูปหายไปจาก PDP ${n} รูป`, w_txt: (n) => `ข้อความจาก lg.com ขาด ${n} บรรทัด`, w_sum: 'สร้างสรุปไม่ได้',
      w_spec: 'ไม่มีตารางสเปก', w_fail: 'เตรียมไม่สำเร็จ', w_retried: 'ลองใหม่แล้วยังเหมือนเดิม', redo: 'เตรียมใหม่', remove: 'นำออกจาก Excel นี้',
      redoing: 'กำลังเตรียมใหม่', doneT: (n) => `ตรวจแล้ว ${n} รายการ`, removed: (n) => `นำออก ${n}`, skipped: (n) => `ข้ามที่ไม่ได้ไลฟ์ ${n}`, dl: 'ดาวน์โหลด Excel', err: 'เกิดข้อผิดพลาด: ' },
    ko: { steps: ['첨부', '준비', 'Check', '받기'], rows: (n) => `${n}행`, prep: (a, b) => `준비 중 ${a} / ${b}`, liveP: '라이브 제품',
      skip: (n) => `라이브 아님 ${n}개 — 건너뜀`, view: '보기', hide: '닫기', asOf: (d) => `라이브 목록 기준일 ${d}`, byStatus: 'Status 칸 기준',
      skipRows: (n) => `엑셀 ${n}행 — 원래 내용 그대로`, notLive: '라이브 아님', unknown: '모름', none: '이 파일에 라이브 제품이 없어요.',
      pGone: '여기 들어갈 이미지가 빠져 있어요', pBlank: '이 자리 이미지가 비어 있어요', should: '원래 들어가야 할 이미지', noOrig: 'lg.com 에서도 열리지 않아요 — 원본이 없어졌을 수 있어요', pBad: '이 이미지 못 불러옴', pLg: 'lg.com 원본에 있는 이 이미지가 빠짐', pLgN: (n) => `lg.com 원본 이미지 ${n}장이 빠짐`, pTxt: 'lg.com 원본에 있는 이 문구가 빠짐', pSpec: 'PDP에 스펙 표가 없음', pBadN: (n) => `이미지 ${n}장이 빠짐 — 자리 모름`, probN: (a, b) => `문제 ${a} / ${b}`, nextP: '다음 문제', orig: 'lg.com 원본', w_lgimg: (n) => `lg.com 이미지 ${n}장이 PDP에 없음`, w_at: '표시함', badM: '못 불러옴', w_img: (n) => `PDP에서 이미지 ${n}장이 빠짐`, w_txt: (n) => `lg.com 문구 ${n}줄 빠짐`, w_sum: '요약을 못 만듦',
      w_spec: '스펙표 없음', w_fail: '준비 못 함', w_retried: '다시 해도 그대로', redo: '다시 준비', remove: '이번 엑셀에서 빼기',
      redoing: '다시 준비하는 중', doneT: (n) => `${n}개 확인 완료`, removed: (n) => `${n}개 뺌`, skipped: (n) => `라이브 아님 ${n}개 건너뜀`, dl: '엑셀 받기', err: '문제가 생겼어요: ' },
    de: { steps: ['Anhängen', 'Vorbereiten', 'Prüfen', 'Herunterladen'], rows: (n) => `${n} Zeilen`, prep: (a, b) => `Vorbereitung ${a} / ${b}`, liveP: 'Live-Produkte',
      skip: (n) => `${n} nicht live — übersprungen`, view: 'Ansehen', hide: 'Ausblenden', asOf: (d) => `Live-Liste vom ${d}`, byStatus: 'Aus der Spalte Status',
      skipRows: (n) => `${n} Zeilen in der Excel — bleiben unverändert`, notLive: 'Nicht live', unknown: 'Unbekannt', none: 'Keine Live-Produkte in dieser Datei.',
      pGone: 'Hier fehlt ein Bild', pBlank: 'Diese Bildstelle ist leer', should: 'Das Bild, das hierher gehört', noOrig: 'Öffnet auch auf lg.com nicht — das Original ist evtl. weg', pBad: 'Dieses Bild wurde nicht geladen', pLg: 'Dieses lg.com-Bild fehlt im PDP', pLgN: (n) => `${n} lg.com-Bild(er) fehlen im PDP`, pTxt: 'Diese lg.com-Zeilen fehlen im PDP', pSpec: 'Keine Spezifikationstabelle im PDP', pBadN: (n) => `${n} Bild(er) fehlen — Stelle unbekannt`, probN: (a, b) => `Problem ${a} / ${b}`, nextP: 'Nächstes Problem', orig: 'lg.com-Original', w_lgimg: (n) => `${n} lg.com-Bild(er) fehlen im PDP`, w_at: 'im PDP markiert', badM: 'Nicht geladen', w_img: (n) => `${n} Bild(er) fehlen im PDP`, w_txt: (n) => `${n} Zeilen von lg.com fehlen`, w_sum: 'Zusammenfassung fehlgeschlagen',
      w_spec: 'Kein Datenblatt', w_fail: 'Vorbereitung fehlgeschlagen', w_retried: 'auch nach erneutem Versuch', redo: 'Neu vorbereiten', remove: 'Aus dieser Excel entfernen',
      redoing: 'Wird neu vorbereitet', doneT: (n) => `${n} geprüft`, removed: (n) => `${n} entfernt`, skipped: (n) => `${n} nicht live übersprungen`, dl: 'Excel herunterladen', err: 'Fehler: ' },
    ar: { steps: ['إرفاق', 'تجهيز', 'تحقق', 'تنزيل'], rows: (n) => `${n} صف`, prep: (a, b) => `جارٍ التجهيز ${a} / ${b}`, liveP: 'منتجات نشطة',
      skip: (n) => `${n} غير نشط — تم تخطيه`, view: 'عرض', hide: 'إخفاء', asOf: (d) => `قائمة النشط بتاريخ ${d}`, byStatus: 'من عمود Status',
      skipRows: (n) => `${n} صف في Excel — يبقى كما هو`, notLive: 'غير نشط', unknown: 'غير معروف', none: 'لا توجد منتجات نشطة في هذا الملف.',
      pGone: 'الصورة التي يجب أن تكون هنا مفقودة', pBlank: 'مكان هذه الصورة فارغ', should: 'الصورة التي يجب أن تكون هنا', noOrig: 'لا تفتح على lg.com أيضًا — ربما حُذف الأصل', pBad: 'تعذّر تحميل هذه الصورة', pLg: 'هذه الصورة من lg.com مفقودة في PDP', pLgN: (n) => `${n} صورة من lg.com مفقودة في PDP`, pTxt: 'هذه الأسطر من lg.com مفقودة في PDP', pSpec: 'لا يوجد جدول مواصفات في PDP', pBadN: (n) => `${n} صورة مفقودة — الموضع غير معروف`, probN: (a, b) => `المشكلة ${a} / ${b}`, nextP: 'المشكلة التالية', orig: 'الأصل من lg.com', w_lgimg: (n) => `${n} صورة من lg.com غير موجودة في PDP`, w_at: 'محدّد في PDP', badM: 'لم يتم التحميل', w_img: (n) => `${n} صورة مفقودة في PDP`, w_txt: (n) => `${n} سطر من lg.com مفقود`, w_sum: 'تعذّر إنشاء الملخص',
      w_spec: 'لا يوجد جدول مواصفات', w_fail: 'تعذّر التجهيز', w_retried: 'ما زال بعد إعادة المحاولة', redo: 'إعادة التجهيز', remove: 'إزالة من ملف Excel هذا',
      redoing: 'جارٍ إعادة التجهيز', doneT: (n) => `تم فحص ${n}`, removed: (n) => `أُزيل ${n}`, skipped: (n) => `تم تخطي ${n} غير نشط`, dl: 'تنزيل Excel', err: 'حدث خطأ: ' },
  };
  // 덱 화면 (2026-11-27) 문구 — 위 TX 에 덧붙인다
  const TXD = {
    en: { rmS: 'Remove', viewAll: (n) => `View all ${n}`, moreBelow: 'More below', back: '← Back', prev: 'Previous', next: 'Next', removedL: 'Removed from this Excel', fReady: 'Ready', fReview: 'Needs review', checkingAll: (n) => `AI is checking all ${n} at once`, sumT: (r, m) => `${r} ready · ${m} need${m === 1 ? 's' : ''} your review`,
      sumS: (n, s, m) => `Checked ${n} in ${s} s — now just ${m === 1 ? 'this one' : 'these ' + m}`, okIn: 'Looks fine · include',
      retryingA: 'Retrying automatically…',
      allDone: 'All checked', colModel: 'Model', colDesc: 'Description', imgsN: (n) => `${n} images`, moreRows: (n) => `+ ${n} more rows`, confirmDl: (n) => `Confirm ${n} & download` },
    th: { rmS: 'นำออก', viewAll: (n) => `ดูทั้งหมด ${n}`, moreBelow: 'ยังมีด้านล่าง', back: '← กลับ', prev: 'ก่อนหน้า', next: 'ถัดไป', removedL: 'นำออกจาก Excel นี้แล้ว', fReady: 'พร้อม', fReview: 'ต้องตรวจสอบ', checkingAll: (n) => `AI กำลังตรวจทั้ง ${n} รายการพร้อมกัน`, sumT: (r, m) => `พร้อม ${r} · ต้องตรวจสอบ ${m}`,
      sumS: (n, s, m) => `ตรวจ ${n} รายการใน ${s} วินาที — เหลือดูแค่ ${m}`, okIn: 'ดูแล้วโอเค · ใส่ไว้',
      retryingA: 'กำลังลองใหม่อัตโนมัติ…',
      allDone: 'ตรวจครบแล้ว', colModel: 'รุ่น', colDesc: 'คำอธิบาย', imgsN: (n) => `${n} รูป`, moreRows: (n) => `+ อีก ${n} แถว`, confirmDl: (n) => `ยืนยัน ${n} และดาวน์โหลด` },
    ko: { rmS: '빼기', viewAll: (n) => `전체 보기 ${n}`, moreBelow: '아래에 더 있음', back: '← 돌아가기', prev: '이전', next: '다음', removedL: '이번 엑셀에서 뺌', fReady: '준비됨', fReview: '검토 필요', checkingAll: (n) => `AI가 ${n}개를 한꺼번에 확인 중`, sumT: (r, m) => `${r}개 준비됨 · ${m}개 검토 필요`,
      sumS: (n, s, m) => `${n}개를 ${s}초에 확인 — 이제 ${m}개만 보면 돼요`, okIn: '괜찮음 · 포함',
      retryingA: '자동으로 다시 시도 중…',
      allDone: '모두 확인함', colModel: '모델', colDesc: '설명', imgsN: (n) => `이미지 ${n}장`, moreRows: (n) => `+ ${n}행 더`, confirmDl: (n) => `${n}개 확인하고 받기` },
    de: { rmS: 'Entfernen', viewAll: (n) => `Alle ${n} ansehen`, moreBelow: 'Weiter unten', back: '← Zurück', prev: 'Zurück', next: 'Weiter', removedL: 'Aus dieser Excel entfernt', fReady: 'Bereit', fReview: 'Zu prüfen', checkingAll: (n) => `KI prüft alle ${n} gleichzeitig`, sumT: (r, m) => `${r} bereit · ${m} zu prüfen`,
      sumS: (n, s, m) => `${n} in ${s} s geprüft — jetzt nur noch ${m}`, okIn: 'Passt · übernehmen',
      retryingA: 'Wird automatisch erneut versucht…',
      allDone: 'Alles geprüft', colModel: 'Modell', colDesc: 'Beschreibung', imgsN: (n) => `${n} Bilder`, moreRows: (n) => `+ ${n} weitere Zeilen`, confirmDl: (n) => `${n} bestätigen & herunterladen` },
    ar: { rmS: 'إزالة', viewAll: (n) => `عرض الكل ${n}`, moreBelow: 'المزيد بالأسفل', back: 'رجوع →', prev: 'السابق', next: 'التالي', removedL: 'أُزيل من ملف Excel هذا', fReady: 'جاهز', fReview: 'بحاجة إلى مراجعة', checkingAll: (n) => `الذكاء الاصطناعي يفحص جميع ${n} معًا`, sumT: (r, m) => `${r} جاهز · ${m} بحاجة إلى مراجعتك`,
      sumS: (n, s, m) => `تم فحص ${n} في ${s} ث — تبقّى ${m} فقط`, okIn: 'يبدو جيدًا · تضمين',
      retryingA: 'جارٍ إعادة المحاولة تلقائيًا…',
      allDone: 'تم فحص الكل', colModel: 'الطراز', colDesc: 'الوصف', imgsN: (n) => `${n} صور`, moreRows: (n) => `+ ${n} صفوف أخرى`, confirmDl: (n) => `تأكيد ${n} والتنزيل` },
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
  function steps(core, step) {
    const T = C.T;
    let st = document.getElementById('ckSteps');
    if (!st) { st = document.createElement('div'); st.id = 'ckSteps'; st.className = 'ck-steps'; document.querySelector('.hd').after(st); }
    st.innerHTML = T.steps.map((x, i) => `<span class="ck-st ${i < step ? 'ck-d' : i === step ? 'ck-o' : ''}">${core.esc(x)}</span>`).join('<span class="ck-sep">›</span>');
  }
  function frame(core, step, full) {   // full: 화면 전체 틀 (검수 · 끝 · 완료 — 버튼 줄이 늘 같은 자리)
    steps(core, step);
    document.querySelector('.body').classList.add('hidden');
    let el = document.getElementById('ck');
    if (!el) { el = document.createElement('div'); el.id = 'ck'; el.className = 'ck'; document.querySelector('.body').after(el); }
    el.classList.toggle('ck-full', step === 2 || !!full);
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
  const ukey = (u) => (u[0].bundle ? 'b:' + u[0].row : u[0].slug || u[0].url || 'r:' + u[0].row);
  const aiRows = (u) => (u[0].status === 'failed' ? [{ k: 'fail', ok: false, msg: u[0].error }] : u[0].ai || []);
  // 이미지: 못 불러옴(PDP 위에 표시) · lg.com 그림이 PDP 에 없음을 따로. 예전 결과(bad · lg 없음)는 개수만
  const whyImg = (x) => x.bad == null && x.lg == null ? C.T.w_img(x.n)
    : [x.bad ? C.T.w_img(x.bad) + (x.at && x.at.length ? ' (' + C.T.w_at + ')' : '') : '', x.lg ? C.T.w_lgimg(x.lg) : ''].filter(Boolean).join(' · ');
  const why = (x) => ({ img: () => whyImg(x), txt: () => C.T.w_txt(x.n), sum: () => C.T.w_sum, spec: () => C.T.w_spec, fail: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : ''), redo: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : '') }[x.k] || (() => x.k))();
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
  function cardEl(core, u) {   // 큰 카드 = 엑셀 설명 칸에 들어가는 상세 이미지 (bulk-market 틀) + 모델 + 이유 한 줄
    const e = core.esc, it = u[0], T = C.T, ai = it.ai || [];
    // 사람이 볼 문제 (2026-11-27): 자리를 아는 것(못 불러온 이미지)은 그 장 위에 굵은 테두리 + 큰 글자,
    // 자리가 없는 것(lg.com 원본에만 있는 그림 · 글, 요약 · 스펙 표)은 PDP 맨 위 문제 칸에 — 원본 그림은 크게
    const img = ai.find((x) => x.k === 'img') || {}, at = img.at || [];
    // 슬라이스를 만들 때 못 가져온 이미지는 크기가 없어 접힌다 → 사람 눈에는 그 자리에 이미지가 '없음'(아래 글이 당겨 올라옴).
    //   그래서 '빈 칸'이 아니라 들어갈 자리에 굵은 선 + '여기 들어갈 이미지가 빠져 있어요', 옆에 lg.com 원본(비교 칸). 크기가 있어 비어 보이는 칸이면 칸 표시
    const kindOf = (b) => b.kind || (b.h < 0.03 ? 'gone' : 'blank');
    const mark = (k) => at.filter((b) => b.slice === k + 1).map((b) => `<span class="dk-bad ${kindOf(b)}" data-src="${e(b.src || '')}" style="top:${(b.y * 100).toFixed(2)}%${kindOf(b) === 'blank' ? `;height:${(b.h * 100).toFixed(2)}%` : ''}"><b>${e(kindOf(b) === 'gone' ? T.pGone : T.pBlank)}</b></span>`).join('');
    const pb = (title, inner) => `<div class="dk-pb"><div class="dk-pt">${e(title)}</div>${inner || ''}</div>`;
    const pbs = [];
    if (!img.ok) {
      if ((img.bad == null ? img.n : img.bad) && !at.length) pbs.push(pb(T.pBadN(img.bad == null ? img.n : img.bad)));
      (img.src || []).forEach((s) => pbs.push(pb(T.pLg, `<figure class="dk-po"><img src="${e(s)}" alt="" decoding="async"><figcaption>${e(T.should)} · ${e(T.orig)}</figcaption></figure>`)));
      if (img.lg > (img.src || []).length) pbs.push(pb(T.pLgN(img.lg - (img.src || []).length)));
    }
    for (const x of ai) {
      if (x.ok) continue;
      if (x.k === 'txt') pbs.push(pb(T.pTxt, x.lines && x.lines.length ? `<ul class="dk-pl">${x.lines.map((l) => `<li>${e(l)}</li>`).join('')}</ul>` : `<p class="dk-pl">${e(T.w_txt(x.n))}</p>`));
      else if (x.k === 'sum') pbs.push(pb(T.w_sum)); else if (x.k === 'spec') pbs.push(pb(T.pSpec));
    }
    const body = `<div class="ck-imgs">${(it.imgs || []).map(small).map((s, k) => { const m = mark(k); return m ? `<span class="dk-si"><img src="${e(s)}" alt="" decoding="async">${m}</span>` : `<img src="${e(s)}" alt="" decoding="async">`; }).join('')}</div>`;
    const pv = window.CliaMarket ? CliaMarket.page(C.job.channel, { body }) : body;
    const el = document.createElement('div'); el.className = 'dk-card';
    el.innerHTML = `<div class="dk-ph"><div class="dk-sc">${pbs.length ? `<div class="dk-pbs">${pbs.join('')}</div>` : ''}${pv}</div></div><div class="dk-mo">${e(it.model || '')}</div><div class="dk-st"></div>`;
    C.dk.root.appendChild(el); cardState(el, u); return el;
  }
  function cardState(el, u) {
    const bad = aiRows(u).filter((x) => !x.ok);
    el.classList.toggle('dk-busy', busy(u)); el.classList.toggle('dk-ok', passed(u)); el.classList.toggle('dk-rm', isRemoved(u));
    // 사람이 정할 문제가 남은 카드: 나머지 장은 어둡게, 문제 장만 선명하게 (CSS .dk-prob)
    el.classList.toggle('dk-prob', !passed(u) && !isRemoved(u) && !busy(u) && !isOk(u) && !!el.querySelector('.dk-pb, .dk-bad'));
    el.querySelector('.dk-st').textContent = isRemoved(u) ? C.T.removedL : busy(u) ? (u.some((x) => x.retrying) ? C.T.retryingA : C.T.redoing)
      : passed(u) ? C.T.fReady : bad.map(why).join(' · ') + (u[0].retried ? ' — ' + C.T.w_retried : '');
  }
  const pileAt = (k) => { const s = rel(document.getElementById('dkLs')); const sc = s.w / CW; return { x: s.x + Math.min(k, 7) * 4, y: s.y + Math.min(k, 7) * 8, s: sc, r: [-2.5, 2, -1, 1.5][k % 4] }; };
  const readyAt = (k) => { const s = rel(document.getElementById('dkRs')); return { x: s.x + (k % 6) * 2, y: s.y + 8 + (k % 6) * 2, s: s.w / 74, r: (k % 5 - 2) * 1.2 }; };
  const deckAt = () => { const d = rel(document.getElementById('dkDeck')); return { x: d.x, y: d.y }; };
  function toReady(core, u, anim) {   // 덱 → (가운데를 스치며 스캔) → 오른쪽 더미. 날아가는 동안만 DOM 에, 더미엔 위 몇 장만
    const D = C.dk, k = D.readyN++;
    if (!anim || reduced()) { bump('dkRn', D.readyN); return; }
    const it = u[0], e = core.esc;
    const m = document.createElement('div'); m.className = 'dk-mini ok';
    m.innerHTML = `<img src="${e(small((it.imgs || [])[0] || ''))}" alt=""><b>${e(it.model || '')}</b>`;   // 상세 첫 장 (갤러리 아님)
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
    const T = C.T, D = C.dk, token = C.flow = {};
    const big = document.getElementById('dkBig');
    if (big) { if (!instant && !reduced()) await big.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(6px)' }], { duration: 220, fill: 'forwards' }).finished.catch(() => {}); big.remove(); }
    await settle(core);
    const total = needs().length;
    if (!total) return finishView(core);
    // 체크가 끝났으면 오른쪽 Ready 더미를 눌러 전체 보기 (선택)
    const rs = document.getElementById('dkRs');
    if (rs) { rs.classList.add('dk-click'); rs.title = T.viewAll(C.units.length); rs.onclick = () => { C.flow = null; viewer(core, 'all', Math.max(0, C.units.findIndex(passed)), 'deck'); }; }
    header(core, T.sumT(D.readyN, total), instant ? '' : T.sumS(C.units.length, D.secs, total));
    if (!instant) await sleep(1100);
    if (C.flow !== token) return;   // 그사이 전체 보기로 들어감
    return viewer(core, 'review', 0, 'deck');
  }

  // ── 검수 화면 (2026-11-27): 검토 필요만(review) · 전체 보기(all, 선택) 같은 화면 ──
  // PDP 는 가운데 크게 · 이전/다음은 양옆 · 위에 'n / N' 과 한 줄(상태 · 모델 · 이유 — 한 번만) · 아래 고정 버튼 셋(빼기 · 다시 준비 · 괜찮음·포함).
  // 검토 필요 카드면 화면 배경부터 다르게 (와인 톤) — 준비됨(기본 톤) · 뺌(회색)과 한눈에 구분. 하나 처리하면 다음 건으로 자동으로.
  // 키보드: ← → 넘기기 · ↑ ↓ · 스페이스로 PDP 내리기 · (전체 보기) Esc 돌아가기
  function viewer(core, mode, start, from) {
    const T = C.T, e = core.esc, rtl = document.documentElement.dir === 'rtl', all = mode === 'all';
    const open = (u) => !isRemoved(u) && !isOk(u) && !passed(u);   // 사람이 아직 정하지 않은 것
    let list = all ? C.units.slice() : needs(), i = Math.max(0, Math.min(list.length - 1, start)), el = null, alive = true, polling = false;
    if (!all) { const j = list.findIndex((u) => open(u) && !busy(u)); if (j >= 0) i = j; }
    const view = frame(core, 2);
    view.innerHTML = '<div class="dk dk-br" id="dk"></div><div id="ckGo"></div>';
    if (all) document.getElementById('ckSteps').insertAdjacentHTML('afterbegin', `<button class="ck-sback" id="dkBack" type="button">${e(T.back)}</button>`);
    C.dk = { root: document.getElementById('dk'), els: new Map(), side: new Map(), pile: [], minis: [], q: [], readyN: 0, shown: 0 };
    const D = C.dk;
    // 위: 'n / N' + 진행 막대 · 그 아래 고정 버튼 셋 · 카드 바로 위 제목(모델 / 상태 · 이유)
    // 가운데: 캐러셀 — 카드가 가로 한 줄, 가운데 카드가 크고 앞뒤 PDP 는 일부만 보이며 끝으로 갈수록 흐려짐. 넘기면 줄 전체가 미끄러지고
    //         카드 안 이미지는 살짝 늦게 따라옴(패럴랙스). 드래그 · 스와이프 · 가로 휠 · ← → 로 넘기기. 라이브러리 없이 CSS 전환 + 포인터 이벤트
    const ARL = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>', ARR = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
    D.root.insertAdjacentHTML('beforeend', `<div class="dk-top"><div class="dk-count"><b id="dkI"></b><span id="dkNn"></span></div><div class="dk-prog"><i id="dkProg"></i></div></div><div class="dk-cap" id="dkCap"></div>
      <div class="dk-car" id="dkCar"><div class="dk-track" id="dkTrack"></div></div>
      <button class="dk-arw" id="dkPrev" type="button" aria-label="${e(rtl ? T.next : T.prev)}">${ARL}</button><button class="dk-arw" id="dkNext" type="button" aria-label="${e(rtl ? T.prev : T.next)}">${ARR}</button>
      <div class="dk-cmp" id="dkCmp" hidden><div class="dk-cmp-h">${e(T.should)}</div><img alt="" decoding="async"><div class="dk-cmp-s">${e(T.orig)}</div></div>
      <div class="dk-bar"><button class="dk-act" data-a="remove" type="button">${e(T.rmS)}</button><button class="dk-act" data-a="retry" type="button">${e(T.redo)}</button><button class="dk-act" data-a="ok" type="button">${e(T.okIn)}</button></div>`);
    const cap = document.getElementById('dkCap'), car = document.getElementById('dkCar'), track = document.getElementById('dkTrack');
    const prevB = document.getElementById('dkPrev'), nextB = document.getElementById('dkNext');   // 왼쪽 · 오른쪽 (아랍어는 왼쪽이 다음)
    prevB.onclick = () => go(rtl ? 1 : -1); nextB.onclick = () => go(rtl ? -1 : 1);
    const acts = [...D.root.querySelectorAll('.dk-act')];
    // 비교 칸: 지금 보는 문제가 '빠진 이미지'면 카드 바로 옆에 lg.com 원본(원래 들어가야 할 이미지)을 표시 선 높이에 맞춰 나란히
    const cmpEl = document.getElementById('dkCmp'), cmpImg = cmpEl.querySelector('img'), cmpS = cmpEl.querySelector('.dk-cmp-s');
    let cmpT = 0;
    function cmp(later) {
      clearTimeout(cmpT); if (later) { cmpEl.hidden = true; cmpT = setTimeout(cmp, later); return; }
      const c = el, p = c && c.classList.contains('dk-prob') ? probs(c)[c._pi || 0] : null, src = p && p.classList.contains('dk-bad') ? p.dataset.src : '';
      if (!src || (drag && drag.on) || !alive) { cmpEl.hidden = true; return; }
      if (cmpImg.dataset.s !== src) {
        cmpImg.dataset.s = src; cmpEl.classList.remove('dk-cmp-x'); cmpS.textContent = T.orig; cmpImg.hidden = false;
        cmpImg.onerror = () => { cmpEl.classList.add('dk-cmp-x'); cmpImg.hidden = true; cmpS.textContent = T.noOrig; cmp(); };
        cmpImg.onload = () => cmp(); cmpImg.src = src;
      }
      const rc = rel(c.querySelector('.dk-ph')), rp = rel(p), W = Math.round(Math.max(200, Math.min(320, G.side + GAP + 6)));   // 캐러셀 가장자리 · 화살표 바로 앞까지
      cmpEl.style.width = W + 'px'; cmpEl.hidden = false;
      const H = cmpEl.offsetHeight, y = Math.round(Math.max(G.y, Math.min(G.y + G.ch - H, rp.y - H * 0.4)));
      cmpEl.style.transform = `translate(${Math.round(rtl ? rc.x - 12 - W : rc.x + rc.w + 12)}px,${y}px)`;
      cmpEl.style.setProperty('--ay', Math.max(18, Math.min(H - 18, rp.y - y)) + 'px');   // 화살표 꼭지가 표시 선을 가리키게
    }
    const sgn = rtl ? -1 : 1, GAP = 28, PAR = 64, WIN = 2;   // 다음 카드 방향 · 카드 사이 · 패럴랙스 폭 · 앞뒤로 둘 카드 수
    // 카드는 화면 높이에 맞춰 크게 (상세 이미지까지 보게) — 폭은 높이의 ~75%, 320~520px, 가운데. 위 164px 는 숫자 · 버튼 · 제목
    const geo = () => { const st = rel(D.root), y = 164, ch = Math.max(340, st.h - y - 16), cw = Math.round(Math.max(320, Math.min(520, ch * 0.75, st.w * 0.36))), x = Math.round((st.w - cw) / 2);
      const side = Math.max(60, Math.min(cw * 0.55, (st.w - cw) / 2 - GAP - 72));   // 앞뒤 카드가 보이는 폭
      return { x, y, ch, cw, w: st.w, side, step: cw + GAP }; };
    let G = geo();
    const cards = new Map();   // list 번호 → 카드 (가운데 ± WIN 장만)
    function place() {   // 캐러셀 틀 · 화살표 · 끝으로 갈수록 흐려지는 가장자리
      G = geo(); const L = G.x - GAP - G.side, W = G.cw + 2 * (GAP + G.side), f = ((G.side + GAP) / W * 100).toFixed(1);
      Object.assign(car.style, { left: L + 'px', top: G.y + 'px', width: W + 'px', height: G.ch + 'px' });
      const m = `linear-gradient(to right, transparent 0%, #000 ${f}%, #000 ${100 - f}%, transparent 100%)`; car.style.webkitMaskImage = m; car.style.maskImage = m;
      prevB.style.top = nextB.style.top = (G.y + G.ch / 2 - 20) + 'px'; prevB.style.left = (L - 52) + 'px'; nextB.style.left = (L + W + 12) + 'px';
    }
    const cardLeft = (k) => G.side + GAP + sgn * k * G.step;
    function mk(k) {
      const c = cardEl(core, list[k]); track.appendChild(c); c.classList.add('dk-cc'); fullCard(c, G);
      c.style.left = cardLeft(k) + 'px'; c.style.top = '0px';
      c.addEventListener('click', () => { if (!moved && k !== i) go(k - i); });
      cards.set(k, c); return c;
    }
    // 패럴랙스: 줄이 미끄러질 때 카드 안 내용이 반대쪽으로 조금 밀렸다가 더 늦게(0.78초) 제자리로 — 쉬고 있을 땐 늘 0 (가장자리가 비지 않게)
    const inners = () => [...cards.values()].map((c) => c.querySelector('.dk-sc > *')).filter(Boolean);
    function parallax(from, anim) {   // from: 움직이기 시작할 때 내용이 뒤처진 정도(px). anim 이 없으면 그 자리 (끄는 중)
      for (const n of inners()) {
        if (!anim || reduced()) { n.style.transition = 'none'; n.style.transform = from ? `translate3d(${from}px,0,0)` : ''; continue; }
        if (from != null) { n.style.transition = 'none'; n.style.transform = `translate3d(${from}px,0,0)`; void n.offsetWidth; }
        n.style.transition = 'transform .78s cubic-bezier(.16,1,.3,1) .04s'; n.style.transform = 'translate3d(0,0,0)';
      }
    }
    function layout(anim, kick) {   // kick: 넘긴 방향(+1 다음 · -1 이전) — 패럴랙스 시작점
      if (anim && !reduced()) track.style.transition = 'transform .52s cubic-bezier(.16,1,.3,1)'; else track.style.transition = 'none';
      track.style.transform = `translate3d(${-sgn * i * G.step}px,0,0)`;
      cmp(anim ? 620 : 60);
      for (let k = i - WIN; k <= i + WIN; k++) if (k >= 0 && k < list.length && !cards.has(k)) mk(k);
      for (const [k, c] of cards) {
        const on = k === i; if (c.classList.contains('dk-on') && !on) setTimeout(() => { const sc = c.querySelector('.dk-sc'); if (sc) sc.scrollTop = 0; }, 560);   // 다시 오면 맨 위부터
        if (on && !c.classList.contains('dk-on')) seek(c);
        c.classList.toggle('dk-on', on);
        if (Math.abs(k - i) > WIN) { cards.delete(k); setTimeout(() => c.remove(), anim ? 560 : 0); }
      }
      el = cards.get(i);
      parallax(kick ? sgn * kick * PAR : null, anim);
      panel();
      for (const v of [list[i + WIN + 1], list[i - WIN - 1]]) if (v) for (const src of (v[0].imgs || []).slice(0, 2).map(small)) { const im = new Image(); im.src = src; }   // 그다음 장 미리
    }
    // 드래그 · 스와이프 (세로로 움직이면 PDP 스크롤에 양보) · 트랙패드 가로 밀기
    let drag = null, moved = false, wheelLock = 0;
    car.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, t: performance.now(), on: false, id: ev.pointerId }; moved = false; });
    car.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.on) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; if (Math.abs(dy) >= Math.abs(dx)) { drag = null; return; } drag.on = true; moved = true; cmpEl.hidden = true; car.setPointerCapture(ev.pointerId); car.classList.add('dk-drag'); }
      const edge = (sgn * dx > 0 && i === 0) || (sgn * dx < 0 && i === list.length - 1), ddx = edge ? dx * 0.3 : dx;   // 끝에서는 덜 끌림
      track.style.transition = 'none'; track.style.transform = `translate3d(${-sgn * i * G.step + ddx}px,0,0)`;
      parallax(-ddx * 0.22, false);   // 끄는 동안 내용은 덜 따라옴
    });
    const endDrag = (ev) => {
      const d = drag; drag = null; car.classList.remove('dk-drag'); if (!d || !d.on) return;
      const dx = ev.clientX - d.x, v = dx / Math.max(1, performance.now() - d.t), s = sgn * dx, sv = sgn * v;
      if ((s < -60 || sv < -0.45) && go(1)) return; if ((s > 60 || sv > 0.45) && go(-1)) return;
      layout(true);   // 제자리로
    };
    car.addEventListener('pointerup', endDrag); car.addEventListener('pointercancel', endDrag);
    car.addEventListener('wheel', (ev) => {
      if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY)) return;
      ev.preventDefault(); const now = performance.now(); if (now < wheelLock || Math.abs(ev.deltaX) < 20) return;
      wheelLock = now + 450; go(sgn * Math.sign(ev.deltaX));
    }, { passive: false });
    const stateOf = (u) => (isRemoved(u) ? 'rm' : busy(u) ? 'busy' : passed(u) || isOk(u) ? 'ok' : 'review');
    const label = { rm: T.removedL, busy: T.redoing, ok: T.fReady, review: T.fReview };
    function panel() {
      const u = list[i], it = u[0], g = G, s = stateOf(u), bad = aiRows(u).filter((x) => !x.ok);
      D.root.dataset.st = s;   // 화면 배경 · 카드 테두리가 상태를 따른다
      document.getElementById('dkI').textContent = i + 1; document.getElementById('dkNn').textContent = ' / ' + list.length;
      document.getElementById('dkProg').style.width = ((i + 1) / list.length * 100) + '%';
      const line = s === 'review' ? T.fReview + (bad.length ? ' — ' + bad.map(why).join(' · ') : '') : label[s];   // 제목 아래 한 줄 (글자만)
      const ps = el && el.classList.contains('dk-prob') ? probs(el) : [];
      const nav = ps.length ? `<div class="dk-pn"><em>${e(T.probN((el._pi || 0) + 1, ps.length))}</em>${ps.length > 1 ? `<button type="button" id="dkNp">${e(T.nextP)} ↓</button>` : ''}</div>` : '';
      cap.innerHTML = `<div class="dk-cr"><b>${e(it.model || '')}</b>${nav}</div><span>${s === 'ok' ? CK : ''}${e(line)}</span>`;
      const np = document.getElementById('dkNp'); if (np) np.onclick = () => seek(el, (el._pi || 0) + 1);
      cap.style.left = g.x + 'px'; cap.style.width = g.cw + 'px';
      (rtl ? nextB : prevB).disabled = !i; (rtl ? prevB : nextB).disabled = i >= list.length - 1;
      // 버튼 셋은 늘 같은 자리 — 상태에 맞지 않는 것은 흐리게
      const can = { remove: s !== 'rm' && s !== 'busy', retry: s !== 'rm' && s !== 'busy', ok: s === 'review' && it.status === 'ok' };
      acts.forEach((b) => { b.disabled = !can[b.dataset.a]; });
    }
    acts.forEach((b) => { b.onclick = async () => {
      const u = list[i], a = b.dataset.a;
      acts.forEach((x) => { x.disabled = true; });
      if (!(await act(core, rowsOf(u), a, a === 'ok' ? { override: true } : null))) { panel(); return; }
      sync();
      if (!alive) return;
      if (all) { if (i < list.length - 1) go(1); return; }
      // 검토: 아직 정하지 않은 다음 건으로 (다시 준비 중인 것은 건너뜀) — 없으면 다시 준비가 끝나길 기다렸다가 완료로
      const n = list.length, j = [...Array(n).keys()].map((k) => (i + 1 + k) % n).find((k) => open(list[k]) && !busy(list[k]));
      if (j != null && j !== i) { const d = Math.sign(j - i); i = j; layout(true, d); return; }
      if (j === i && open(list[i]) && !busy(list[i])) return;
      if (!list.some((x) => open(x))) { leave(); return; }
    }; });
    function sync() {   // 서버 상태로 목록 · 지금 카드 · 줄 다시
      const by = new Map(C.units.map((u) => [ukey(u), u]));
      list = list.map((u) => by.get(ukey(u)) || u);
      for (const [k, c] of cards) cardState(c, list[k]);
      panel();
      if (!polling && list.some((u) => busy(u) && !isRemoved(u))) {
        polling = true;
        (async () => {
          while (alive && list.some((u) => busy(u) && !isRemoved(u))) {
            await sleep(2000); await refresh(core); if (!alive) break; sync();
            if (!all && !list.some((x) => open(x))) { leave(); break; }   // 다시 준비가 통과로 끝나 남은 게 없으면 완료로
            if (!all && busy(list[i]) === false && !open(list[i])) { const j = list.findIndex((x) => open(x) && !busy(x)); if (j >= 0 && j !== i) { const d = Math.sign(j - i); i = j; layout(true, d); } }
          }
          polling = false;
        })();
      }
    }
    function go(d) { const j = i + d; if (j < 0 || j >= list.length) return false; i = j; layout(true, Math.sign(d)); return true; }
    function fullCard(c, g) {   // 크게 + 위치 막대 + '아래에 더 있음' (끝까지 내리면 사라짐)
      c.classList.add('dk-full'); c.style.width = g.cw + 'px';
      const ph = c.querySelector('.dk-ph'), sc = c.querySelector('.dk-sc'); ph.style.height = g.ch + 'px';
      const cm = c.querySelector('.cm'); if (cm) cm.style.zoom = (g.cw / 426).toFixed(3);   // 260px 카드의 .61 과 같은 비율
      const more = document.createElement('div'); more.className = 'dk-more'; more.setAttribute('aria-hidden', 'true'); more.innerHTML = `<span>${e(T.moreBelow)} ↓</span>`;   // 표시만 (누르는 것 아님 — 버튼은 위에만)
      ph.appendChild(more);
      // 위치 막대: 맥은 스크롤바가 숨어 있어서 직접 그린다 (어디쯤인지 · 얼마나 남았는지)
      const rail = document.createElement('div'); rail.className = 'dk-rail'; rail.innerHTML = '<i></i>'; ph.appendChild(rail);
      const upd = () => {
        const max = sc.scrollHeight - sc.clientHeight, k = max > 0 ? sc.scrollTop / max : 0, hh = Math.max(24, rail.clientHeight * sc.clientHeight / Math.max(1, sc.scrollHeight));
        rail.firstChild.style.height = hh + 'px'; rail.firstChild.style.transform = `translateY(${(rail.clientHeight - hh) * k}px)`; rail.hidden = max <= 4;
        more.classList.toggle('dk-end', sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4);
        // 위치 막대 위 빨간 표시 = 문제 자리 (지금 보는 문제는 더 굵게)
        const ps = c.classList.contains('dk-prob') ? probs(c) : [], H = Math.max(1, sc.scrollHeight);
        rail.querySelectorAll('s').forEach((x) => x.remove());
        ps.forEach((p, k) => { const s = document.createElement('s'); if (k === c._pi) s.className = 'on'; s.style.top = (Math.min(1, topIn(sc, p) / H) * 100).toFixed(2) + '%'; rail.appendChild(s); });
      };
      c._upd = upd;
      sc.addEventListener('scroll', () => { upd(); if (c === el) cmp(); }, { passive: true }); setTimeout(upd, 60); c.querySelectorAll('img').forEach((im) => im.addEventListener('load', upd, { once: true }));
    }
    // 문제 보기: 카드가 가운데 오면 첫 문제로 가서 멈춤 (그 위 이미지가 다 불러와져야 자리가 맞다). 다음 문제 버튼 · N 키로 차례로
    const probs = (c) => [...c.querySelectorAll('.dk-pb, .dk-bad')];
    const topIn = (sc, n) => n.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    function seek(c, k) {
      const ps = probs(c); if (!ps.length || !c.classList.contains('dk-prob')) return;
      k = ((k || 0) % ps.length + ps.length) % ps.length; c._pi = k;
      const p = ps[k], hot = p.classList.contains('dk-bad') ? p.closest('.dk-si') : p;
      c.querySelectorAll('.dk-hot').forEach((x) => x.classList.remove('dk-hot')); c.querySelectorAll('.dk-cur').forEach((x) => x.classList.remove('dk-cur'));
      hot.classList.add('dk-hot'); p.classList.add('dk-cur');
      if (c === el) panel();
      const ims = [...c.querySelectorAll('.ck-imgs img')], own = hot.querySelector('img'), upto = own && ims.includes(own) ? ims.slice(0, ims.indexOf(own) + 1) : [];
      Promise.all(upto.map((im) => (im.complete ? 0 : new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); }))))
        .then(() => setTimeout(() => {
          const sc = c.querySelector('.dk-sc'); if (!sc || !c.classList.contains('dk-on') || c._pi !== k) return;
          const y = p.classList.contains('dk-bad') ? topIn(sc, p) - 64 : topIn(sc, hot) - 12;   // 큰 글자(표시 위)까지 보이게
          sc.scrollTo({ top: Math.max(0, y - sc.clientHeight * 0.12), behavior: reduced() ? 'auto' : 'smooth' });
          if (c._upd) setTimeout(c._upd, 400);
          cmp(); setTimeout(() => cmp(), 520);
        }, upto.length ? 560 : 0));
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
      if ((k === 'n' || k === 'N') && el && el.classList.contains('dk-prob')) { ev.preventDefault(); seek(el, (el._pi || 0) + 1); return; }
      if (k === 'ArrowRight') { ev.preventDefault(); go(rtl ? -1 : 1); } else if (k === 'ArrowLeft') { ev.preventDefault(); go(rtl ? 1 : -1); } else if (k === 'Escape' && all) { ev.preventDefault(); leave(); }
    }
    function onResize() { if (!alive) return; cmp(200); place(); for (const [k, c] of cards) { c.style.left = cardLeft(k) + 'px'; c.style.width = G.cw + 'px'; c.querySelector('.dk-ph').style.height = G.ch + 'px'; } layout(false); }
    function leave() {
      if (!alive) return;
      alive = false; document.removeEventListener('keydown', key); removeEventListener('resize', onResize);
      if (all && from === 'deck') rush(core, true); else finishView(core);
    }
    document.addEventListener('keydown', key);
    if (all) document.getElementById('dkBack').onclick = () => leave();
    place(); layout(false); sync();
    addEventListener('resize', onResize);
  }
  async function act(core, rows, action, opts) {
    let who = ''; try { who = sessionStorage.getItem('clia_user') || localStorage.getItem('clia-bulk-mail') || ''; } catch (_) {}
    try {
      C.job = await core.api(`/api/v1/bulk/jobs/${C.job.id}/check`, { rows, action, by: who, override: !!(opts && opts.override) });
      C.units = units(C.job); alertLine(core, ''); return true;
    } catch (e) { alertLine(core, C.T.err + e.message); return false; }
  }
  function alertLine(core, msg) { const g = document.getElementById('ckGo'); if (g) g.innerHTML = msg ? `<div class="ck-why">${core.esc(msg)}</div>` : ''; }
  // 끝 · 완료 (2026-11-27): 검수 화면과 같은 틀 — 맨 위 한 줄(상태) · 그 아래 같은 자리의 버튼 줄 · 본문은 엑셀 시트.
  //   버튼은 늘 위 (벌크 Check 전체 규칙 — 아래에는 누르는 것을 두지 않는다)
  function pageFrame(core, step, line, btns, body) {
    const el = frame(core, step, true);
    el.innerHTML = `<div class="dk dk-br dk-pg" id="dk"><div class="dk-top"><div class="dk-line" id="dkLine">${line}</div></div><div class="dk-bar" id="dkBar">${btns}</div>
      <div class="dk-body"><div class="xs-wrap">${body}</div></div></div><div id="ckGo"></div>`;
    return el;
  }
  const finLine = (core, todo) => { const T = C.T, ck = C.job.check || {}, removed = C.units.filter(isRemoved).length;
    return `<b>${core.esc(T.allDone)}</b><span>${core.esc([T.fReady + ' ' + todo.length, removed ? T.removed(removed) : '', T.skipped(ck.skipModels || 0)].filter(Boolean).join(' · '))}</span>`; };
  const doneLine = (core) => { const T = C.T, ck = C.job.check || {};
    return `${CK}<b>${core.esc(T.doneT(ck.confirmed || 0))}</b><span>${core.esc([ck.removed ? T.removed(ck.removed) : '', T.skipped(ck.skipModels || 0)].filter(Boolean).join(' · '))}</span>`; };
  const dlBtn = (core) => `<a class="dk-act pri" id="ckDl" href="${core.esc(C.job.file || '#')}" download>${core.esc(C.T.dl)}</a>`;
  // 끝: 준비된 것을 한 번에 확인 (승인 기록 via 'bulk' + 본 이미지 해시) → 받기. 시트는 설명 칸이 빈 채로 미리 보이고, 확인하면 채워진다
  async function finishView(core) {
    const T = C.T, e = core.esc;
    // 전체 보기에서 다시 준비한 것: 끝날 때까지 기다렸다가, 걸리면 검토로
    while (C.units.some((u) => busy(u) && !isRemoved(u))) { alertLine(core, T.redoing + '…'); await sleep(2000); await refresh(core); }
    if (C.units.some((u) => !passed(u) && !isRemoved(u) && !isOk(u))) return rush(core, true);
    const todo = C.units.filter((u) => passed(u) && !isOk(u) && !isRemoved(u));
    if (!todo.length) return doneView(core);
    const sh = sheet(core);
    pageFrame(core, 2, finLine(core, todo), `<button class="dk-act" id="ckView" type="button">${e(T.viewAll(C.units.length))}</button><button class="dk-act pri" id="ckAll" type="button">${e(T.confirmDl(todo.length))}</button>`, sh.html);
    document.getElementById('ckView').onclick = () => viewer(core, 'all', 0, 'finish');
    const b = document.getElementById('ckAll'); b.focus();
    b.onclick = async () => {
      document.querySelectorAll('#dkBar .dk-act').forEach((x) => { x.disabled = true; });
      const anim = !reduced(), okP = act(core, todo.flatMap(rowsOf), 'ok');
      if (anim) fillSheet(core, sh, true);   // 시트 연출은 바로, 다운로드는 확인 요청이 끝나는 대로 (연출을 기다리지 않음)
      if (!(await okP)) { const msg = (document.getElementById('ckGo') || {}).textContent || ''; await finishView(core); alertLine(core, msg); return; }
      download(); doneTop(core);
      if (!anim) fillSheet(core, sh, false);
    };
  }
  function download() { if (C.job.file) { const a = document.createElement('a'); a.href = C.job.file; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); } }
  function doneTop(core) {   // 같은 자리에서: 확인 버튼 → 엑셀 받기, 위 한 줄 → 완료
    steps(core, 3);
    const line = document.getElementById('dkLine'), bar = document.getElementById('dkBar'); if (!line || !bar) return;
    line.innerHTML = doneLine(core); bar.innerHTML = dlBtn(core);
    if (!reduced()) [line, bar].forEach((x) => x.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: EZ.out }));
  }
  function doneView(core) { const sh = sheet(core); pageFrame(core, 3, doneLine(core), dlBtn(core), sh.html); fillSheet(core, sh, false); }
  // 엑셀 시트: 행 = 제품(엑셀 순서) · 행 번호 · 모델 · 설명 칸(강조). 9행 넘으면 앞 8행 + '+N행' 막대. 뺀 행은 처음부터 회색 빗금
  function sheet(core) {
    const T = C.T, e = core.esc;
    const rows = C.units.flatMap((u) => u.map((x) => ({ row: x.row, model: x.model || x.title || '', u, rm: isRemoved(u) }))).sort((a, b) => a.row - b.row);
    const MAXR = 9, vis = rows.length > MAXR ? rows.slice(0, MAXR - 1) : rows, rest = rows.slice(vis.length), restOk = rest.filter((r) => !r.rm).length;
    const fill = (r) => (r.rm ? `<span class="xs-rmv">${e(T.removedL)}</span>`
      : `<span class="xs-fill">${(r.u[0].imgs || []).slice(0, 3).map((s) => `<img src="${e(small(s))}" alt="">`).join('')}<em>${e(T.imgsN((r.u[0].imgs || []).length))}</em></span>`);
    const html = `<div class="xs" id="xs"><div class="xs-hd"><i></i>${e(C.fileName || 'result.xlsx')}</div>
      <div class="xs-row xs-h"><span class="xs-n"></span><span class="xs-m">${e(T.colModel)}</span><span class="xs-d">${e(T.colDesc)}</span></div>
      ${vis.map((r, k) => `<div class="xs-row${r.rm ? ' xs-out' : ''}" data-k="${k}"><span class="xs-n">${r.row}</span><span class="xs-m">${e(r.model)}</span><span class="xs-d">${fill(r)}</span></div>`).join('')}
      ${rest.length ? `<div class="xs-row xs-more"><span class="xs-n">…</span><span class="xs-m">${e(T.moreRows(rest.length))}</span><span class="xs-d"><span class="xs-bar"><i id="xsBar"></i></span></span></div>` : ''}</div>`;
    return { html, vis, rest, restOk };
  }
  // 내보내기 (확인하고 받기): 통과한 PDP 카드가 작아지며 그 행의 설명 칸으로 들어가 칸이 채워진다.
  //   앞 몇 장(최대 5)만 날아가고 나머지 행은 한꺼번에 · 아래 행은 막대로 — 100개여도 ~2초. anim 이 없으면 바로 채운 상태
  //   모션: 나타나기 expo.out → 칸으로 power3.out · 시차 90ms · 겹침 (HyperFrames). 아랍어는 칸 오른쪽부터
  async function fillSheet(core, sh, anim) {
    const e = core.esc, rtl = document.documentElement.dir === 'rtl', { vis, rest, restOk } = sh;
    const xs = document.getElementById('xs'); if (!xs) return;
    const wrap = xs.parentNode, rowEl = (k) => xs.querySelector(`.xs-row[data-k="${k}"]`), bar = document.getElementById('xsBar');
    const okRows = vis.map((r, k) => ({ r, k })).filter((x) => !x.r.rm), barTo = (rest.length ? restOk / rest.length * 100 : 100) + '%';
    if (!anim) { okRows.forEach(({ k }) => rowEl(k).classList.add('xs-on', 'xs-now')); if (bar) bar.style.width = barTo; return; }
    const fly = okRows.slice(0, 5), rel2 = (n) => { const a = n.getBoundingClientRect(), b = wrap.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
    const src = rel2(xs), sx = src.x + src.w / 2 - 60, sy = src.y + src.h * 0.5 - 85;   // 카드 120×170 이 시트 가운데에서 나와
    fly.forEach(({ r, k }, n) => {
      const c = document.createElement('div'); c.className = 'xs-card'; c.innerHTML = `<img src="${e(small((r.u[0].imgs || [])[0] || ''))}" alt="">`; wrap.appendChild(c);
      const d = rel2(rowEl(k).querySelector('.xs-d')), s = (d.h - 8) / 170, tx = rtl ? d.x + d.w - 16 - 120 * s : d.x + 6, ty = d.y + 4, x0 = sx + (n - 2) * 14, y0 = sy + Math.abs(n - 2) * 6;
      const a = c.animate([{ transform: `translate(${x0}px,${y0 + 16}px) scale(.86)`, opacity: 0, easing: EZ.out },
        { transform: `translate(${x0}px,${y0}px) scale(1) rotate(${(n - 2) * 2}deg)`, opacity: 1, offset: 0.24, easing: EZ.p3out },
        { transform: `translate(${tx}px,${ty}px) scale(${s})`, opacity: 1 }], { duration: 820, delay: n * 90, fill: 'both' });
      setTimeout(() => rowEl(k).classList.add('xs-on'), n * 90 + 700);   // 칸에 닿을 즈음 채워지기 시작 (겹침)
      a.finished.then(() => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EZ.p3in, fill: 'forwards' }).finished.then(() => c.remove()), () => c.remove());
    });
    await sleep(Math.max(0, fly.length - 1) * 90 + 640);
    okRows.slice(fly.length).forEach(({ k }, n) => setTimeout(() => { const x = rowEl(k); if (x) x.classList.add('xs-on'); }, n * 40));   // 나머지는 한꺼번에
    if (bar) bar.animate([{ width: '0%' }, { width: barTo }], { duration: 520, easing: EZ.out, fill: 'forwards' });
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
