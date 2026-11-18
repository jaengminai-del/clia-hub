/* bulk.js — Shopee / Lazada 벌크 엑셀 채우기 화면 (2026-11-18, 단순화판)
   엑셀 올리기 → (자동) 채널·열 찾기, SKU ↔ CLIA 제품 연결 → 채울 상품만 체크 → 엑셀 받기.
   화면 언어는 허브 법인 언어(?lang=, 태국 → 태국어). 이미 설명이 있던 칸은 교체하고 "기존 설명 교체" 로 표시.
   연결이 안 되거나 후보가 여러 개·묶음 SKU 인 행은 "채울 수 없는 상품" 으로 접어 두고 엑셀에서 그대로 둔다. 서버: bulk-routes.js */
(function () {
  const TX = {
    en: {
      title: 'Bulk Excel', back: '← Back to CLIA',
      lead: 'Upload the bulk Excel you downloaded from Shopee or Lazada. CLIA fills the product description of the products you choose and gives the file back — ready to upload to the marketplace.',
      drop: 'Upload a Shopee or Lazada bulk Excel', dropSub: 'Click or drop an .xlsx file here', again: 'Upload another file',
      askCh: 'Which marketplace is this file for?', askDesc: 'The product description column was not found. Choose it:',
      sum: (n, all) => `${n} of ${all} products can be filled with CLIA content`,
      subShopee: 'The product description gets the CLIA image URLs (up to 12). Products you do not tick and all other columns stay as they are.',
      subLazada: 'The product description gets the CLIA product summary and images. Products you do not tick and all other columns stay as they are.',
      all: 'All', search: 'Search model or name', selAll: 'Select all shown',
      rep: 'Replaces current description', skip: (n) => `${n} products cannot be filled — they stay as they are in the Excel`,
      rNone: 'Not in CLIA', rMulti: 'Several CLIA products match', rBundle: 'Bundle (several products)',
      selected: (n, r) => `<b>${n}</b> selected` + (r ? ` · <span class="badge b-rep">${r} replace a current description</span>` : ''),
      build: (n) => `Make Excel (${n})`, rebuild: (n) => `Make again (${n})`, building: 'Making…', dlAgain: 'Download again',
      prog: (d, t) => `Making ${d} / ${t}`, done: (ok, rep, bad) => `✓ ${ok} filled` + (rep ? ` · ${rep} replaced` : '') + (bad ? ` · <span style="color:var(--bad)">${bad} failed</span>` : '') + ' — the Excel was downloaded',
      q: 'Waiting', w: 'Making…', ok: 'Filled', okRep: 'Replaced', bad: 'Failed', imgs: (n) => `${n} images`, noSummary: 'Images only — summary could not be made',
      upFail: 'Could not read the file: ', buildFail: 'Could not make the Excel: ', leave: 'The Excel is still being made. Leave this page?',
      cat: {},
    },
    th: {
      title: 'Bulk Excel', back: '← กลับไป CLIA',
      lead: 'อัปโหลดไฟล์ Excel แบบ bulk ที่ดาวน์โหลดจาก Shopee หรือ Lazada แล้ว CLIA จะเติมรายละเอียดสินค้าให้สินค้าที่คุณเลือก และส่งไฟล์กลับให้พร้อมอัปโหลดขึ้นมาร์เก็ตเพลส',
      drop: 'อัปโหลดไฟล์ Excel แบบ bulk ของ Shopee หรือ Lazada', dropSub: 'คลิกหรือลากไฟล์ .xlsx มาวางที่นี่', again: 'อัปโหลดไฟล์อื่น',
      askCh: 'ไฟล์นี้เป็นของมาร์เก็ตเพลสใด?', askDesc: 'ไม่พบคอลัมน์รายละเอียดสินค้า โปรดเลือก:',
      sum: (n, all) => `เติมคอนเทนต์ CLIA ได้ ${n} จาก ${all} สินค้า`,
      subShopee: 'ช่องรายละเอียดสินค้าจะได้รับลิงก์รูปภาพจาก CLIA (สูงสุด 12 รูป) สินค้าที่ไม่ได้เลือกและคอลัมน์อื่นจะคงเดิม',
      subLazada: 'ช่องรายละเอียดสินค้าจะได้รับสรุปสินค้าและรูปภาพจาก CLIA สินค้าที่ไม่ได้เลือกและคอลัมน์อื่นจะคงเดิม',
      all: 'ทั้งหมด', search: 'ค้นหารุ่นหรือชื่อ', selAll: 'เลือกทั้งหมดที่แสดง',
      rep: 'แทนที่รายละเอียดเดิม', skip: (n) => `${n} สินค้าเติมไม่ได้ — จะคงเดิมในไฟล์ Excel`,
      rNone: 'ไม่มีใน CLIA', rMulti: 'ตรงกับสินค้าใน CLIA หลายรายการ', rBundle: 'สินค้าชุด (หลายรายการ)',
      selected: (n, r) => `เลือก <b>${n}</b> สินค้า` + (r ? ` · <span class="badge b-rep">แทนที่รายละเอียดเดิม ${r} รายการ</span>` : ''),
      build: (n) => `สร้าง Excel (${n})`, rebuild: (n) => `สร้างอีกครั้ง (${n})`, building: 'กำลังสร้าง…', dlAgain: 'ดาวน์โหลดอีกครั้ง',
      prog: (d, t) => `กำลังสร้าง ${d} / ${t}`, done: (ok, rep, bad) => `✓ เติมแล้ว ${ok} รายการ` + (rep ? ` · แทนที่ ${rep}` : '') + (bad ? ` · <span style="color:var(--bad)">ไม่สำเร็จ ${bad}</span>` : '') + ' — ดาวน์โหลด Excel แล้ว',
      q: 'รอคิว', w: 'กำลังสร้าง…', ok: 'เติมแล้ว', okRep: 'แทนที่แล้ว', bad: 'ไม่สำเร็จ', imgs: (n) => `${n} รูป`, noSummary: 'มีเฉพาะรูป — สร้างสรุปสินค้าไม่สำเร็จ',
      upFail: 'อ่านไฟล์ไม่ได้: ', buildFail: 'สร้าง Excel ไม่สำเร็จ: ', leave: 'กำลังสร้าง Excel อยู่ ต้องการออกจากหน้านี้หรือไม่?',
      cat: { TV: 'ทีวี', Audio: 'เครื่องเสียง', Fridge: 'ตู้เย็น', Dishwasher: 'เครื่องล้างจาน', Washer: 'เครื่องซักผ้า', Monitor: 'จอมอนิเตอร์', Laptop: 'แล็ปท็อป', Cooking: 'เครื่องครัว', Air: 'แอร์ & ฟอกอากาศ', 'Vacuum Cleaner': 'เครื่องดูดฝุ่น' },
    },
    ko: {
      title: '벌크 엑셀', back: '← CLIA 로 돌아가기',
      lead: 'Shopee·Lazada 에서 받은 벌크 엑셀을 올리세요. 고른 상품의 상품 설명을 CLIA 콘텐츠로 채워, 마켓에 바로 올릴 수 있는 파일로 돌려드립니다.',
      drop: 'Shopee·Lazada 벌크 엑셀 올리기', dropSub: '.xlsx 파일을 누르거나 끌어 놓으세요', again: '다른 파일 올리기',
      askCh: '어느 마켓 파일인가요?', askDesc: '상품 설명 열을 찾지 못했습니다. 골라 주세요:',
      sum: (n, all) => `${all}개 상품 중 ${n}개를 CLIA 콘텐츠로 채울 수 있습니다`,
      subShopee: '상품 설명 칸에 CLIA 이미지 주소(최대 12장)가 들어갑니다. 고르지 않은 상품과 다른 칸은 그대로입니다.',
      subLazada: '상품 설명 칸에 CLIA 제품 요약과 이미지가 들어갑니다. 고르지 않은 상품과 다른 칸은 그대로입니다.',
      all: '전체', search: '모델명·상품명 검색', selAll: '보이는 상품 모두 선택',
      rep: '기존 설명 교체', skip: (n) => `채울 수 없는 상품 ${n}개 — 엑셀에서 그대로 둡니다`,
      rNone: 'CLIA 에 없음', rMulti: 'CLIA 제품 여러 개와 맞음', rBundle: '묶음 상품',
      selected: (n, r) => `<b>${n}</b>개 선택` + (r ? ` · <span class="badge b-rep">${r}개는 기존 설명 교체</span>` : ''),
      build: (n) => `엑셀 만들기 (${n})`, rebuild: (n) => `다시 만들기 (${n})`, building: '만드는 중…', dlAgain: '다시 받기',
      prog: (d, t) => `만드는 중 ${d} / ${t}`, done: (ok, rep, bad) => `✓ ${ok}개 채움` + (rep ? ` · ${rep}개 교체` : '') + (bad ? ` · <span style="color:var(--bad)">${bad}개 실패</span>` : '') + ' — 엑셀을 받았습니다',
      q: '대기', w: '만드는 중…', ok: '채움', okRep: '교체함', bad: '실패', imgs: (n) => `이미지 ${n}장`, noSummary: '요약을 만들지 못해 이미지만 넣음',
      upFail: '파일을 읽지 못했습니다: ', buildFail: '엑셀을 만들지 못했습니다: ', leave: '엑셀을 만드는 중입니다. 이 화면을 나갈까요?',
      cat: { Audio: '오디오', Fridge: '냉장고', Dishwasher: '식기세척기', Washer: '세탁기·건조기', Monitor: '모니터', Laptop: '노트북', Cooking: '조리기기', Air: '에어컨·공기청정기', 'Vacuum Cleaner': '청소기' },
    },
    de: {
      title: 'Bulk-Excel', back: '← Zurück zu CLIA',
      lead: 'Laden Sie die Bulk-Excel-Datei von Shopee oder Lazada hoch. CLIA füllt die Produktbeschreibung der ausgewählten Produkte und gibt die Datei zum Hochladen zurück.',
      drop: 'Shopee- oder Lazada-Bulk-Excel hochladen', dropSub: '.xlsx-Datei hier klicken oder ablegen', again: 'Andere Datei hochladen',
      askCh: 'Für welchen Marktplatz ist diese Datei?', askDesc: 'Spalte für die Produktbeschreibung nicht gefunden. Bitte wählen:',
      sum: (n, all) => `${n} von ${all} Produkten können mit CLIA-Inhalten gefüllt werden`,
      subShopee: 'Die Produktbeschreibung erhält die CLIA-Bild-URLs (bis zu 12). Nicht ausgewählte Produkte und alle anderen Spalten bleiben unverändert.',
      subLazada: 'Die Produktbeschreibung erhält die CLIA-Zusammenfassung und Bilder. Nicht ausgewählte Produkte und alle anderen Spalten bleiben unverändert.',
      all: 'Alle', search: 'Modell oder Name suchen', selAll: 'Alle angezeigten wählen',
      rep: 'Ersetzt aktuelle Beschreibung', skip: (n) => `${n} Produkte können nicht gefüllt werden — sie bleiben unverändert`,
      rNone: 'Nicht in CLIA', rMulti: 'Mehrere CLIA-Produkte passen', rBundle: 'Set (mehrere Produkte)',
      selected: (n, r) => `<b>${n}</b> ausgewählt` + (r ? ` · <span class="badge b-rep">${r} ersetzen eine Beschreibung</span>` : ''),
      build: (n) => `Excel erstellen (${n})`, rebuild: (n) => `Erneut erstellen (${n})`, building: 'Wird erstellt…', dlAgain: 'Erneut herunterladen',
      prog: (d, t) => `Erstelle ${d} / ${t}`, done: (ok, rep, bad) => `✓ ${ok} gefüllt` + (rep ? ` · ${rep} ersetzt` : '') + (bad ? ` · <span style="color:var(--bad)">${bad} fehlgeschlagen</span>` : '') + ' — Excel heruntergeladen',
      q: 'Wartet', w: 'Wird erstellt…', ok: 'Gefüllt', okRep: 'Ersetzt', bad: 'Fehler', imgs: (n) => `${n} Bilder`, noSummary: 'Nur Bilder — Zusammenfassung fehlgeschlagen',
      upFail: 'Datei konnte nicht gelesen werden: ', buildFail: 'Excel konnte nicht erstellt werden: ', leave: 'Die Excel-Datei wird noch erstellt. Seite verlassen?',
      cat: { Fridge: 'Kühlschrank', Dishwasher: 'Geschirrspüler', Washer: 'Waschmaschine', Cooking: 'Kochen', Air: 'Klima & Luft' },
    },
    ar: {
      title: 'Excel المجمّع', back: '→ العودة إلى CLIA',
      lead: 'ارفع ملف Excel المجمّع الذي نزّلته من Shopee أو Lazada. يملأ CLIA وصف المنتجات التي تختارها ويعيد الملف جاهزاً للرفع.',
      drop: 'ارفع ملف Excel المجمّع من Shopee أو Lazada', dropSub: 'انقر أو أسقط ملف ‎.xlsx هنا', again: 'رفع ملف آخر',
      askCh: 'لأي متجر هذا الملف؟', askDesc: 'لم يتم العثور على عمود وصف المنتج. اختره:',
      sum: (n, all) => `يمكن ملء ${n} من ${all} منتجاً بمحتوى CLIA`,
      subShopee: 'يحصل وصف المنتج على روابط صور CLIA (حتى 12). المنتجات غير المختارة وباقي الأعمدة تبقى كما هي.',
      subLazada: 'يحصل وصف المنتج على ملخص CLIA والصور. المنتجات غير المختارة وباقي الأعمدة تبقى كما هي.',
      all: 'الكل', search: 'ابحث بالطراز أو الاسم', selAll: 'اختيار كل المعروض',
      rep: 'يستبدل الوصف الحالي', skip: (n) => `لا يمكن ملء ${n} منتجات — ستبقى كما هي في الملف`,
      rNone: 'غير موجود في CLIA', rMulti: 'يطابق عدة منتجات في CLIA', rBundle: 'مجموعة منتجات',
      selected: (n, r) => `تم اختيار <b>${n}</b>` + (r ? ` · <span class="badge b-rep">${r} تستبدل وصفاً حالياً</span>` : ''),
      build: (n) => `إنشاء Excel ‏(${n})`, rebuild: (n) => `إنشاء مجدداً ‏(${n})`, building: 'جارٍ الإنشاء…', dlAgain: 'تنزيل مجدداً',
      prog: (d, t) => `جارٍ الإنشاء ${d} / ${t}`, done: (ok, rep, bad) => `✓ تم ملء ${ok}` + (rep ? ` · استبدال ${rep}` : '') + (bad ? ` · <span style="color:var(--bad)">فشل ${bad}</span>` : '') + ' — تم تنزيل الملف',
      q: 'في الانتظار', w: 'جارٍ الإنشاء…', ok: 'تم الملء', okRep: 'تم الاستبدال', bad: 'فشل', imgs: (n) => `${n} صور`, noSummary: 'صور فقط — تعذّر إنشاء الملخص',
      upFail: 'تعذّرت قراءة الملف: ', buildFail: 'تعذّر إنشاء الملف: ', leave: 'لا يزال الملف قيد الإنشاء. مغادرة الصفحة؟',
      cat: { TV: 'تلفزيون', Audio: 'صوتيات', Fridge: 'ثلاجات', Washer: 'غسالات', Monitor: 'شاشات', Air: 'مكيفات وهواء' },
    },
  };
  const qs = new URLSearchParams(location.search);
  const L = TX[qs.get('lang')] ? qs.get('lang') : 'en';   // 허브가 법인 언어를 넘긴다 (en·de·th·ar), 확인용 ?lang=ko
  const T = TX[L];
  const t = (k, ...a) => { const v = T[k] ?? TX.en[k]; return typeof v === 'function' ? v(...a) : v; };
  const catName = (c) => T.cat[c] || c;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const home = { uk: 'uk', de: 'de', th: 'th', sa: 'sa' }[qs.get('corp') || ''] || '';

  const S = { data: null, channel: '', ok: [], skip: [], sel: new Set(), cat: '', q: '', job: null, busy: false };

  document.documentElement.lang = L;
  document.documentElement.dir = L === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i); });
  $('back').onclick = () => { if (S.busy && !confirm(t('leave'))) return; if (history.length > 1) history.back(); else location.href = '/clia/'; };
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });

  // ── 올리기 ──
  const drop = $('drop'), file = $('file');
  drop.onclick = () => file.click();
  $('again').onclick = () => { if (!S.busy) file.click(); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
  file.onchange = () => { if (file.files[0]) upload(file.files[0]); file.value = ''; };

  async function upload(f) {
    if (S.busy) return;
    $('err').textContent = '';
    drop.querySelector('.small').textContent = '⏳ ' + f.name;
    try {
      const r = await fetch('/api/v1/bulk/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      S.channel = d.channel || '';
      S.cat = ''; S.q = ''; S.job = null;
      setData(d, true);
    } catch (e) {
      $('err').textContent = t('upFail') + e.message;
    } finally { drop.querySelector('.small').textContent = t('dropSub'); }
  }

  // 행 나누기: CLIA 제품 하나에 딱 맞는 행만 채울 수 있다 (법인 나라의 제품을 먼저 본다)
  function setData(d, fresh) {
    S.data = d;
    const P = d.products;
    S.ok = []; S.skip = [];
    for (const r of d.rows) {
      let c = r.candidates.map((s) => P[s]).filter(Boolean);
      if (home && c.some((p) => p.country === home)) c = c.filter((p) => p.country === home);
      if (r.bundle) S.skip.push({ ...r, why: 'rBundle' });
      else if (!c.length) S.skip.push({ ...r, why: 'rNone' });
      else if (c.length > 1) S.skip.push({ ...r, why: 'rMulti' });
      else S.ok.push({ ...r, p: c[0] });
    }
    if (fresh) S.sel = new Set(S.ok.map((r) => r.row));   // 처음에는 채울 수 있는 상품 모두 선택
    drop.classList.add('hidden');
    $('after').classList.remove('hidden');
    $('fname').textContent = d.fileName;
    render();
  }

  // 설명 열을 못 찾았을 때만 고르게 한다
  $('descSel').onchange = async () => {
    const v = +$('descSel').value;
    if (!v) return;
    const r = await fetch('/api/v1/bulk/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: S.data.id, sheet: S.data.sheet, cols: { desc: v } }) });
    const d = await r.json();
    if (!r.ok) { $('err').textContent = d.error || 'HTTP ' + r.status; return; }
    setData(d, false);
  };
  $('askCh').onclick = (e) => { const c = e.target.dataset && e.target.dataset.ch; if (c) { S.channel = c; render(); } };

  function shown() {
    return S.ok.filter((r) => (!S.cat || r.p.cat === S.cat) &&
      (!S.q || [r.p.model, r.name, r.sku, r.parentSku, r.p.title].join(' ').toLowerCase().includes(S.q)));
  }

  function itemStatus(r) {
    const it = S.job && S.job.items.find((x) => x.row === r.row);
    if (!it) return r.descLen > 0 ? `<span class="badge b-rep">${esc(t('rep'))}</span>` : '';
    if (it.status === 'queued') return `<span class="badge b-q">${esc(t('q'))}</span>`;
    if (it.status === 'working') return `<span class="badge b-run">${esc(t('w'))}</span>`;
    if (it.status === 'failed') return `<span class="badge b-bad">${esc(t('bad'))}</span><span class="note">${esc(it.error)}</span>`;
    return `<span class="badge ${it.prevLen > 0 ? 'b-rep' : 'b-ok'}">${esc(it.prevLen > 0 ? t('okRep') : t('ok'))}</span><span class="note">${esc(t('imgs', it.images))}</span>` +
      (it.summaryErr ? `<span class="note" style="color:var(--warn)" title="${esc(it.summaryErr)}">${esc(t('noSummary'))}</span>` : '');
  }

  function render() {
    const d = S.data;
    $('ftag').textContent = S.channel ? (S.channel === 'shopee' ? 'Shopee' : 'Lazada') : '?';
    $('askCh').classList.toggle('hidden', !!S.channel);
    $('askDesc').classList.toggle('hidden', !!d.cols.desc);
    if (!d.cols.desc) $('descSel').innerHTML = '<option value="">—</option>' + d.columns.map((c) => `<option value="${c.col}">${c.letter} · ${esc(c.label)}</option>`).join('');
    $('sum').textContent = t('sum', S.ok.length, d.rows.length);
    $('sumSub').textContent = S.channel ? t(S.channel === 'shopee' ? 'subShopee' : 'subLazada') : '';

    // 제품군 칩 + 검색
    const cats = {};
    S.ok.forEach((r) => { cats[r.p.cat] = (cats[r.p.cat] || 0) + 1; });
    const chip = (v, label, n) => `<button class="chip ${S.cat === v ? 'on' : ''}" data-cat="${esc(v)}">${esc(label)}<b>${n}</b></button>`;
    $('tools').innerHTML = chip('', t('all'), S.ok.length) +
      Object.keys(cats).sort().map((c) => chip(c, catName(c), cats[c])).join('') +
      `<input class="search" id="q" type="search" placeholder="${esc(t('search'))}" value="${esc(S.q)}">`;
    $('q').oninput = () => { S.q = $('q').value.trim().toLowerCase(); renderList(); };
    renderList();

    $('skip').classList.toggle('hidden', !S.skip.length);
    $('skipSum').textContent = t('skip', S.skip.length);
    $('skipList').innerHTML = S.skip.map((r) => `<div class="item"><div style="min-width:0"><div class="m">${esc(r.parentSku || r.sku || '—')}</div><div class="s">${esc(r.name)}</div></div>` +
      `<div class="r"><span class="badge b-q">${esc(t(r.why))}</span></div></div>`).join('');
  }

  function renderList() {
    const vis = shown();
    const allOn = vis.length > 0 && vis.every((r) => S.sel.has(r.row));
    $('list').innerHTML = `<label class="head"><input type="checkbox" id="ckAll" ${allOn ? 'checked' : ''} ${S.busy ? 'disabled' : ''}><span></span><span>${esc(t('selAll'))}</span><span></span></label>` +
      vis.map((r) => `<label class="item"><input type="checkbox" data-row="${r.row}" ${S.sel.has(r.row) ? 'checked' : ''} ${S.busy ? 'disabled' : ''}>` +
        `<img src="${esc(r.p.thumb || '')}" alt="" loading="lazy">` +
        `<div style="min-width:0"><div class="m">${esc(r.p.model)}</div><div class="s">${esc(r.name || r.p.title)}</div></div>` +
        `<div class="r">${itemStatus(r)}</div></label>`).join('');
    renderBar();
  }

  $('tools').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) { S.cat = b.dataset.cat; render(); } };
  $('list').onchange = (e) => {
    const el = e.target;
    if (el.id === 'ckAll') shown().forEach((r) => (el.checked ? S.sel.add(r.row) : S.sel.delete(r.row)));
    else if (el.dataset.row) (el.checked ? S.sel.add(+el.dataset.row) : S.sel.delete(+el.dataset.row));
    renderList();
  };

  // ── 만들기 ──
  const chosen = () => S.ok.filter((r) => S.sel.has(r.row));
  function renderBar() {
    $('bar').style.display = S.data ? 'block' : 'none';
    const c = chosen(), n = c.length, rep = c.filter((r) => r.descLen > 0).length;
    const j = S.job;
    const running = j && j.status === 'running';
    if (running) {
      const prods = new Set(j.items.map((x) => x.slug)).size;
      const doneP = new Set(j.items.filter((x) => x.status === 'ok' || x.status === 'failed').map((x) => x.slug)).size;
      $('selInfo').textContent = t('prog', doneP, prods);
      $('prog').firstElementChild.style.width = (100 * doneP / Math.max(1, prods)) + '%';
    } else if (j && j.status === 'ready') $('selInfo').innerHTML = t('done', j.ok, j.replaced, j.failed);
    else if (j && j.status === 'failed') $('selInfo').innerHTML = `<span style="color:var(--bad)">${esc(t('buildFail') + (j.error || ''))}</span>`;
    else $('selInfo').innerHTML = t('selected', n, rep);
    $('prog').classList.toggle('hidden', !running);
    $('build').textContent = S.busy ? t('building') : (j && j.status === 'ready' ? t('rebuild', n) : t('build', n));
    $('build').disabled = S.busy || !n || !S.channel || !S.data.cols.desc;
    const dl = $('dl');
    dl.classList.toggle('hidden', !(j && j.status === 'ready' && !S.busy));
    if (j && j.file) { dl.href = j.file; dl.setAttribute('download', j.fileName || 'clia-bulk.xlsx'); }
  }

  $('build').onclick = async () => {
    const items = chosen().map((r) => ({ row: r.row, slug: r.p.slug }));
    if (S.busy || !items.length) return;
    S.busy = true; S.job = null; renderList();
    try {
      const r = await fetch('/api/v1/bulk/build', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: S.data.id, channel: S.channel, sheet: S.data.sheet, descCol: S.data.cols.desc, items }) });
      let j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      S.job = j; renderList();
      while (j.status === 'running') {
        await new Promise((ok) => setTimeout(ok, 2500));
        const pr = await fetch('/api/v1/bulk/jobs/' + j.id);
        if (!pr.ok) throw new Error((await pr.json().catch(() => ({}))).error || 'HTTP ' + pr.status);
        j = await pr.json();
        S.job = j; renderList();
      }
    } catch (e) {
      S.job = { ...(S.job || { items: [] }), status: 'failed', error: e.message };
    } finally {
      S.busy = false; renderList();
      if (S.job && S.job.status === 'ready') $('dl').click();
    }
  };
})();
