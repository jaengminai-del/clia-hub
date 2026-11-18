/* bulk.js — Shopee / Lazada 벌크 엑셀 채우기 화면 (2026-11-18)
   엑셀 올리기 → 열 확인 → 제품 고르기(나라·제품군·세부·모델·크롤 기간·연결 상태) → 설명 칸을 채운 엑셀 받기.
   서버: bulk-routes.js. 이미 설명이 있는 칸은 지우고 바꾸며, 표에 "교체" 로 표시한다. 고르지 않은 행은 그대로 둔다. */
(function () {
  const TX = {
    en: {
      title: 'Bulk Excel', back: '← Back to CLIA',
      lead: 'Upload a Shopee or Lazada bulk Excel. CLIA matches each row’s SKU to a crawled LG.com product and fills the product description column — Shopee: up to 12 image URLs, Lazada: product summary + image HTML. Only the rows you select change; everything else in the file stays as it was.',
      s1: 'Upload the marketplace Excel', s2: 'Check the columns', s3: 'Choose the products',
      drop: '<b>Click or drop an .xlsx file</b><br>Shopee: mass update file (basic info) · Lazada: product export',
      chShopee: 'Description = image URLs, one per line (first 12 images)', chLazada: 'Description = product summary + image HTML',
      colsHint: 'Columns were found from the header rows. Change them if they are wrong — the list is checked again.',
      sheet: 'Sheet', desc: 'Description column (filled)', parentSku: 'Parent SKU', sku: 'SKU', id: 'Product ID', name: 'Product name', headEnd: 'Header ends at row', none: '— none —',
      fCountry: 'Country', fCat: 'Category', fSub: 'Sub-category', fSearch: 'Model / name', fFrom: 'Crawled from', fTo: 'Crawled to', fMatch: 'Match',
      all: 'All', mAll: 'All rows', mOk: 'Matched', mMulti: 'Several candidates', mNo: 'Not matched',
      selShown: 'Select shown', selNone: 'Clear selection',
      cRow: 'Row', cMp: 'Marketplace product', cClia: 'CLIA product', cCat: 'Category', cCrawled: 'Crawled', cDesc: 'Current description', cStatus: 'Result',
      rows: 'rows', matched: 'matched', multi: 'several candidates', unmatched: 'not matched', hasDesc: 'already have a description (will be replaced)',
      shown: (n) => `${n} rows shown`, selected: (n, r) => `<b>${n}</b> rows selected` + (r ? ` · <span class="badge b-rep">${r} will replace an existing description</span>` : ''),
      build: (n) => `Build Excel (${n})`, building: 'Building…', download: '⬇ Download Excel',
      rep: (n) => `Replaces ${n.toLocaleString()} chars`, empty: 'Empty', noMatch: 'No CLIA product', bundle: 'Bundle SKU — check', byName: 'matched by name',
      q: 'Queued', w: 'Making…', ok: 'Filled', okRep: 'Replaced', bad: 'Failed',
      prog: (d, t) => `${d} / ${t} products`, done: (ok, rep, bad) => `✓ ${ok} rows filled` + (rep ? ` · ${rep} replaced an existing description` : '') + (bad ? ` · ${bad} failed` : ''),
      imgs: (n, all) => (all > n ? `${n} of ${all} images` : `${n} images`), upFail: 'Upload failed: ', buildFail: 'Build failed: ', pickCh: 'Choose Shopee or Lazada first.',
      noSummary: 'images only — the product summary could not be made',
      leave: 'The Excel is still being built. Leave this page?', details: 'Show current text',
    },
    th: {
      title: 'Bulk Excel', back: '← กลับไป CLIA',
      lead: 'อัปโหลดไฟล์ Excel แบบ bulk ของ Shopee หรือ Lazada แล้ว CLIA จะจับคู่ SKU ของแต่ละแถวกับสินค้า LG.com ที่ครอว์ลไว้ และเติมคอลัมน์รายละเอียดสินค้าให้ — Shopee: ลิงก์รูปสูงสุด 12 รูป, Lazada: สรุปสินค้า + HTML รูปภาพ เปลี่ยนเฉพาะแถวที่เลือก ส่วนอื่นของไฟล์คงเดิม',
      s1: 'อัปโหลดไฟล์ Excel ของมาร์เก็ตเพลส', s2: 'ตรวจสอบคอลัมน์', s3: 'เลือกสินค้า',
      drop: '<b>คลิกหรือวางไฟล์ .xlsx</b><br>Shopee: ไฟล์ mass update (ข้อมูลพื้นฐาน) · Lazada: ไฟล์ export สินค้า',
      chShopee: 'รายละเอียด = ลิงก์รูป บรรทัดละ 1 ลิงก์ (12 รูปแรก)', chLazada: 'รายละเอียด = สรุปสินค้า + HTML รูปภาพ',
      colsHint: 'ระบบหาคอลัมน์จากแถวหัวตาราง หากไม่ถูกต้องให้เปลี่ยน แล้วรายการจะถูกตรวจใหม่',
      sheet: 'ชีต', desc: 'คอลัมน์รายละเอียด (จะถูกเติม)', parentSku: 'Parent SKU', sku: 'SKU', id: 'รหัสสินค้า', name: 'ชื่อสินค้า', headEnd: 'หัวตารางสิ้นสุดที่แถว', none: '— ไม่มี —',
      fCountry: 'ประเทศ', fCat: 'หมวดหมู่', fSub: 'หมวดย่อย', fSearch: 'รุ่น / ชื่อ', fFrom: 'ครอว์ลตั้งแต่', fTo: 'ครอว์ลถึง', fMatch: 'การจับคู่',
      all: 'ทั้งหมด', mAll: 'ทุกแถว', mOk: 'จับคู่แล้ว', mMulti: 'มีหลายตัวเลือก', mNo: 'ไม่พบคู่',
      selShown: 'เลือกที่แสดง', selNone: 'ล้างการเลือก',
      cRow: 'แถว', cMp: 'สินค้าในมาร์เก็ตเพลส', cClia: 'สินค้าใน CLIA', cCat: 'หมวดหมู่', cCrawled: 'ครอว์ลเมื่อ', cDesc: 'รายละเอียดปัจจุบัน', cStatus: 'ผลลัพธ์',
      rows: 'แถว', matched: 'จับคู่แล้ว', multi: 'มีหลายตัวเลือก', unmatched: 'ไม่พบคู่', hasDesc: 'มีรายละเอียดอยู่แล้ว (จะถูกแทนที่)',
      shown: (n) => `แสดง ${n} แถว`, selected: (n, r) => `เลือก <b>${n}</b> แถว` + (r ? ` · <span class="badge b-rep">${r} แถวจะแทนที่รายละเอียดเดิม</span>` : ''),
      build: (n) => `สร้าง Excel (${n})`, building: 'กำลังสร้าง…', download: '⬇ ดาวน์โหลด Excel',
      rep: (n) => `แทนที่ ${n.toLocaleString()} ตัวอักษร`, empty: 'ว่าง', noMatch: 'ไม่พบใน CLIA', bundle: 'SKU ชุด — โปรดตรวจ', byName: 'จับคู่จากชื่อ',
      q: 'รอคิว', w: 'กำลังสร้าง…', ok: 'เติมแล้ว', okRep: 'แทนที่แล้ว', bad: 'ไม่สำเร็จ',
      prog: (d, t) => `${d} / ${t} สินค้า`, done: (ok, rep, bad) => `✓ เติม ${ok} แถว` + (rep ? ` · แทนที่รายละเอียดเดิม ${rep} แถว` : '') + (bad ? ` · ไม่สำเร็จ ${bad}` : ''),
      imgs: (n, all) => (all > n ? `${n} จาก ${all} รูป` : `${n} รูป`), upFail: 'อัปโหลดไม่สำเร็จ: ', buildFail: 'สร้างไม่สำเร็จ: ', pickCh: 'กรุณาเลือก Shopee หรือ Lazada ก่อน',
      noSummary: 'มีเฉพาะรูป — สร้างสรุปสินค้าไม่สำเร็จ',
      leave: 'กำลังสร้าง Excel อยู่ ต้องการออกจากหน้านี้หรือไม่?', details: 'ดูข้อความปัจจุบัน',
    },
    ko: {
      title: '벌크 엑셀', back: '← CLIA 로 돌아가기',
      lead: 'Shopee·Lazada 벌크 엑셀을 올리면 각 행의 SKU 를 CLIA 에 크롤된 LG.com 제품과 연결하고, 상품 설명 칸을 채워 돌려줍니다 — Shopee: 이미지 주소 최대 12장, Lazada: 제품 요약 + 이미지 HTML. 고른 행만 바뀌고 파일의 나머지는 그대로입니다.',
      s1: '마켓 엑셀 올리기', s2: '열 확인', s3: '제품 고르기',
      drop: '<b>.xlsx 파일을 누르거나 끌어 놓으세요</b><br>Shopee: mass update 파일(기본 정보) · Lazada: 상품 내보내기 파일',
      chShopee: '설명 칸 = 이미지 주소, 한 줄에 하나 (앞 12장)', chLazada: '설명 칸 = 제품 요약 + 이미지 HTML',
      colsHint: '머리글 행에서 열을 찾았습니다. 틀리면 바꾸세요 — 목록을 다시 확인합니다.',
      sheet: '시트', desc: '설명 열 (채울 칸)', parentSku: 'Parent SKU', sku: 'SKU', id: '상품 ID', name: '상품명', headEnd: '머리글 끝 행', none: '— 없음 —',
      fCountry: '나라', fCat: '제품군', fSub: '세부 제품군', fSearch: '모델명 / 이름', fFrom: '크롤 시작일', fTo: '크롤 종료일', fMatch: '연결',
      all: '전체', mAll: '모든 행', mOk: '연결됨', mMulti: '후보 여러 개', mNo: '연결 안 됨',
      selShown: '보이는 행 선택', selNone: '선택 해제',
      cRow: '행', cMp: '마켓 상품', cClia: 'CLIA 제품', cCat: '제품군', cCrawled: '크롤', cDesc: '현재 설명', cStatus: '결과',
      rows: '행', matched: '연결됨', multi: '후보 여러 개', unmatched: '연결 안 됨', hasDesc: '이미 설명 있음 (교체됨)',
      shown: (n) => `${n}행 표시`, selected: (n, r) => `<b>${n}</b>행 선택` + (r ? ` · <span class="badge b-rep">${r}행은 기존 설명을 교체</span>` : ''),
      build: (n) => `엑셀 만들기 (${n})`, building: '만드는 중…', download: '⬇ 엑셀 받기',
      rep: (n) => `기존 ${n.toLocaleString()}자 교체`, empty: '비어 있음', noMatch: 'CLIA 제품 없음', bundle: '묶음 SKU — 확인 필요', byName: '상품명으로 연결',
      q: '대기', w: '만드는 중…', ok: '채움', okRep: '교체함', bad: '실패',
      prog: (d, t) => `${d} / ${t} 제품`, done: (ok, rep, bad) => `✓ ${ok}행 채움` + (rep ? ` · ${rep}행은 기존 설명 교체` : '') + (bad ? ` · ${bad}행 실패` : ''),
      imgs: (n, all) => (all > n ? `${all}장 중 ${n}장` : `${n}장`), upFail: '올리기 실패: ', buildFail: '만들기 실패: ', pickCh: 'Shopee 또는 Lazada 를 먼저 고르세요.',
      noSummary: '요약을 만들지 못해 이미지만 넣음',
      leave: '엑셀을 만드는 중입니다. 이 화면을 나갈까요?', details: '현재 글 보기',
    },
  };
  const qs = new URLSearchParams(location.search);
  // 허브가 넘긴 법인 언어(en·de·th·ar) → 없는 언어는 영어. ?lang=ko 로 한국어
  let L = TX[qs.get('lang')] ? qs.get('lang') : 'en';
  const t = (k, ...a) => { const v = (TX[L] || TX.en)[k] ?? TX.en[k]; return typeof v === 'function' ? v(...a) : v; };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const day = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');

  const S = { channel: qs.get('channel') === 'lazada' ? 'lazada' : (qs.get('channel') === 'shopee' ? 'shopee' : ''), data: null, pick: {}, sel: new Set(), job: null, busy: false };
  const homeCountry = { uk: 'uk', de: 'de', th: 'th', sa: 'sa' }[qs.get('corp') || ''] || '';

  // ── 문구 ──
  function paint() {
    document.documentElement.lang = L;
    document.querySelectorAll('[data-i]').forEach((el) => { el.innerHTML = t(el.dataset.i); });
    $('lang').innerHTML = ['en', 'th', 'ko'].map((k) => `<button data-l="${k}" class="${k === L ? 'on' : ''}">${{ en: 'EN', th: 'ไทย', ko: '한국어' }[k]}</button>`).join('');
    $('chHint').textContent = S.channel ? t(S.channel === 'shopee' ? 'chShopee' : 'chLazada') : t('pickCh');
    document.querySelectorAll('#chSeg button').forEach((b) => b.classList.toggle('on', b.dataset.ch === S.channel));
    if (S.data) { renderCols(); renderFilters(true); renderList(); }
    renderBar();
  }
  $('lang').onclick = (e) => { const k = e.target.dataset && e.target.dataset.l; if (k) { L = k; paint(); } };
  $('chSeg').onclick = (e) => { const c = e.target.dataset && e.target.dataset.ch; if (c && !S.busy) { S.channel = c; paint(); } };
  $('back').onclick = () => { if (S.busy && !confirm(t('leave'))) return; if (history.length > 1) history.back(); else location.href = '/clia/'; };
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });

  // ── 1. 올리기 ──
  const drop = $('drop'), file = $('file');
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
  file.onchange = () => { if (file.files[0]) upload(file.files[0]); file.value = ''; };

  async function upload(f) {
    if (S.busy) return;
    $('upErr').textContent = '';
    $('fileInfo').textContent = '⏳ ' + f.name;
    try {
      const r = await fetch('/api/v1/bulk/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      if (!S.channel && d.channel) S.channel = d.channel;
      $('fileInfo').textContent = '📄 ' + f.name + ' · ' + d.rows.length + ' ' + t('rows');
      setData(d, true);
    } catch (e) { $('fileInfo').textContent = ''; $('upErr').textContent = t('upFail') + e.message; }
  }

  function setData(d, fresh) {
    S.data = d; S.job = null;
    if (fresh) S.sel = new Set();
    // 행마다 쓸 CLIA 제품: 사용자가 고른 것 → 고른 나라의 첫 후보
    const keep = S.pick; S.pick = {};
    for (const r of d.rows) if (keep[r.row] && r.candidates.includes(keep[r.row])) S.pick[r.row] = keep[r.row];
    for (const r of [...S.sel]) if (!d.rows.some((x) => x.row === r)) S.sel.delete(r);
    ['colsCard', 'listCard'].forEach((id) => $(id).classList.remove('hidden'));
    paint();
  }

  // ── 2. 열 ──
  function renderCols() {
    const d = S.data;
    const opt = (v, cur) => `<option value="">${esc(t('none'))}</option>` + d.columns.map((c) => `<option value="${c.col}" ${c.col === cur ? 'selected' : ''}>${c.letter} · ${esc(c.label)}</option>`).join('');
    const sel = (k, label) => `<label class="f"><span>${esc(label)}</span><select data-col="${k}" style="max-width:260px">${opt(0, d.cols[k])}</select></label>`;
    $('colsRow').innerHTML =
      `<label class="f"><span>${esc(t('sheet'))}</span><select id="cSheet">${d.sheets.map((s) => `<option value="${esc(s.path)}" ${s.path === d.sheet ? 'selected' : ''}>${esc(s.name)}${s.hidden ? ' (hidden)' : ''}</option>`).join('')}</select></label>` +
      sel('desc', t('desc')) + sel('parentSku', t('parentSku')) + sel('sku', t('sku')) + sel('id', t('id')) + sel('name', t('name')) +
      `<label class="f"><span>${esc(t('headEnd'))}</span><input type="text" id="cHead" value="${d.headEnd}" style="min-width:70px;width:70px"></label>`;
    $('colsRow').querySelectorAll('select,input').forEach((el) => { el.onchange = reanalyze; });
  }
  async function reanalyze() {
    if (S.busy) return;
    const cols = {};
    $('colsRow').querySelectorAll('select[data-col]').forEach((s) => { cols[s.dataset.col] = s.value ? +s.value : null; });
    const sheet = $('cSheet').value;
    if (sheet !== S.data.sheet) { Object.keys(cols).forEach((k) => delete cols[k]); }   // 다른 시트: 열은 다시 찾는다
    else cols.headEnd = parseInt($('cHead').value, 10) || 0;
    try {
      const r = await fetch('/api/v1/bulk/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: S.data.id, sheet, cols }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      setData(d, false);
    } catch (e) { alert(e.message); }
  }

  // ── 3. 고르기 ──
  const F = { country: null, cat: '', sub: '', q: '', from: '', to: '', match: 'all' };
  const prodOf = (r) => {
    const P = S.data.products;
    if (S.pick[r.row]) return P[S.pick[r.row]];
    const c = r.candidates.map((s) => P[s]).filter(Boolean);
    return (F.country ? c.find((p) => p.country === F.country) : null) || (F.country ? null : c[0]) || null;
  };
  const candsIn = (r) => r.candidates.map((s) => S.data.products[s]).filter((p) => p && (!F.country || p.country === F.country));
  function matchState(r) {
    const c = candsIn(r);
    if (!c.length) return 'no';
    if ((c.length > 1 || r.bundle) && !S.pick[r.row]) return 'multi';
    return 'ok';
  }
  function renderFilters(keep) {
    const d = S.data;
    const P = Object.values(d.products);
    const countries = [...new Set(P.map((p) => p.country))].sort();
    if (F.country === null) {   // 처음: 법인 나라 → 연결이 가장 많은 나라
      const cnt = {}; d.rows.forEach((r) => new Set(r.candidates.map((s) => d.products[s] && d.products[s].country)).forEach((c) => { if (c) cnt[c] = (cnt[c] || 0) + 1; }));
      F.country = cnt[homeCountry] ? homeCountry : (Object.entries(cnt).sort((a, b) => b[1] - a[1])[0] || [''])[0];
    }
    const o = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    $('fCountry').innerHTML = o('', t('all'), F.country) + countries.map((c) => o(c, c.toUpperCase(), F.country)).join('');
    const inC = P.filter((p) => !F.country || p.country === F.country);
    const cats = [...new Set(inC.map((p) => p.cat))].sort();
    if (!cats.includes(F.cat)) F.cat = '';
    $('fCat').innerHTML = o('', t('all'), F.cat) + cats.map((c) => o(c, c, F.cat)).join('');
    const subs = [...new Set(inC.filter((p) => !F.cat || p.cat === F.cat).map((p) => p.sub))].sort();
    if (!subs.includes(F.sub)) F.sub = '';
    $('fSub').innerHTML = o('', t('all'), F.sub) + subs.map((c) => o(c, c, F.sub)).join('');
    $('fMatch').innerHTML = [['all', t('mAll')], ['ok', t('mOk')], ['multi', t('mMulti')], ['no', t('mNo')]].map(([v, l]) => o(v, l, F.match)).join('');
    if (!keep) { $('fSearch').value = F.q; $('fFrom').value = F.from; $('fTo').value = F.to; }
  }
  [['fCountry', 'country'], ['fCat', 'cat'], ['fSub', 'sub'], ['fMatch', 'match'], ['fFrom', 'from'], ['fTo', 'to']].forEach(([id, k]) => {
    $(id).onchange = () => { F[k] = $(id).value; renderFilters(true); renderList(); };
  });
  $('fSearch').oninput = () => { F.q = $('fSearch').value.trim().toLowerCase(); renderList(); };

  function visibleRows() {
    return S.data.rows.filter((r) => {
      const st = matchState(r);
      if (F.match !== 'all' && st !== F.match) return false;
      const p = prodOf(r);
      if ((F.cat || F.sub || F.from || F.to) && !p) return false;
      if (p) {
        if (F.cat && p.cat !== F.cat) return false;
        if (F.sub && p.sub !== F.sub) return false;
        if (F.from && day(p.crawled_at) < F.from) return false;
        if (F.to && day(p.crawled_at) > F.to) return false;
      }
      if (F.q) {
        const hay = [r.sku, r.parentSku, r.name, r.id, p && p.model, p && p.title].join(' ').toLowerCase();
        if (!hay.includes(F.q)) return false;
      }
      return true;
    });
  }
  const selectable = (r) => matchState(r) === 'ok';

  function statusCell(r) {
    const it = S.job && S.job.items.find((x) => x.row === r.row);
    if (!it) return '';
    if (it.status === 'queued') return `<span class="badge b-none">${t('q')}</span>`;
    if (it.status === 'working') return `<span class="badge b-run">${t('w')}</span>`;
    if (it.status === 'failed') return `<span class="badge b-bad">${t('bad')}</span><span class="sub">${esc(it.error)}</span>`;
    const rep = it.prevLen > 0;
    return `<span class="badge ${rep ? 'b-rep' : 'b-ok'}">${rep ? t('okRep') : t('ok')}</span><span class="sub">${esc(t('imgs', it.images, it.allImages))}</span>` +
      (it.summaryErr ? `<span class="sub" style="color:var(--warn)" title="${esc(it.summaryErr)}">${esc(t('noSummary'))}</span>` : '');
  }

  function renderList() {
    const d = S.data;
    const rows = d.rows;
    const st = rows.map(matchState);
    const repSel = rows.filter((r) => S.sel.has(r.row) && r.descLen > 0).length;
    $('stats').innerHTML = [
      `<span class="chip"><b>${rows.length}</b> ${t('rows')}</span>`,
      `<span class="chip"><b>${st.filter((x) => x === 'ok').length}</b> ${t('matched')}</span>`,
      `<span class="chip"><b>${st.filter((x) => x === 'multi').length}</b> ${t('multi')}</span>`,
      `<span class="chip"><b>${st.filter((x) => x === 'no').length}</b> ${t('unmatched')}</span>`,
      `<span class="chip warn"><b>${rows.filter((r) => r.descLen > 0).length}</b> ${t('hasDesc')}</span>`,
    ].join('');
    const vis = visibleRows();
    $('shownInfo').textContent = t('shown', vis.length);
    $('tb').innerHTML = vis.slice(0, 3000).map((r) => {
      const p = prodOf(r), ms = matchState(r), c = candsIn(r);
      const prod = p
        ? `<div class="prod"><img src="${esc(p.thumb || '')}" alt="" loading="lazy"><div><div class="m">${esc(p.model)} <span class="hint">${esc(p.country.toUpperCase())}</span></div><div class="tt">${esc(p.title)}</div>` +
          (c.length > 1 || r.bundle ? `<select data-pick="${r.row}" style="margin-top:4px;max-width:300px">${c.map((x) => `<option value="${esc(x.slug)}" ${x.slug === p.slug ? 'selected' : ''}>${esc(x.model)} · ${esc(x.country.toUpperCase())} · ${esc(x.sub)}</option>`).join('')}</select>` : '') +
          (r.by === 'name' ? `<span class="sub">${t('byName')}</span>` : '') + (r.bundle ? `<span class="sub" style="color:var(--warn)">${t('bundle')}</span>` : '') + `</div></div>`
        : `<span class="badge b-none">${t('noMatch')}</span>`;
      const desc = r.descLen > 0
        ? `<span class="badge b-rep">${esc(t('rep', r.descLen))}</span><details><summary>${t('details')}</summary><div class="hint" style="max-width:240px;white-space:pre-wrap">${esc(r.descHead)}${r.descLen > r.descHead.length ? '…' : ''}</div></details>`
        : `<span class="badge b-new">${t('empty')}</span>`;
      const ok = selectable(r);
      return `<tr class="${ok ? '' : 'off'}"><td class="ck"><input type="checkbox" data-row="${r.row}" ${S.sel.has(r.row) ? 'checked' : ''} ${ok && !S.busy ? '' : 'disabled'}></td>` +
        `<td class="mono">${r.row}</td><td class="mono">${esc(r.parentSku || r.sku || '')}${r.parentSku && r.sku && r.sku !== r.parentSku ? `<span class="sub">${esc(r.sku)}</span>` : ''}${r.id ? `<span class="sub">ID ${esc(r.id)}</span>` : ''}</td>` +
        `<td><div class="mp">${esc(r.name)}</div></td><td>${prod}</td><td>${p ? esc(p.cat) + `<span class="sub">${esc(p.sub)}</span>` : ''}</td>` +
        `<td class="mono">${p ? day(p.crawled_at) : ''}</td><td>${desc}</td><td>${statusCell(r)}</td></tr>`;
    }).join('');
    const visOk = vis.filter(selectable);
    $('ckAll').checked = visOk.length > 0 && visOk.every((r) => S.sel.has(r.row));
    $('ckAll').disabled = S.busy;
    renderBar(repSel);
  }

  $('tb').onchange = (e) => {
    const el = e.target;
    if (el.dataset.row) { const r = +el.dataset.row; if (el.checked) S.sel.add(r); else S.sel.delete(r); renderList(); }
    if (el.dataset.pick) { S.pick[+el.dataset.pick] = el.value; S.sel.add(+el.dataset.pick); renderList(); }
  };
  $('tb').onclick = (e) => { if (e.target.tagName === 'SELECT') e.stopPropagation(); };
  $('ckAll').onchange = () => { visibleRows().filter(selectable).forEach((r) => ($('ckAll').checked ? S.sel.add(r.row) : S.sel.delete(r.row))); renderList(); };
  $('selShown').onclick = () => { if (S.busy) return; visibleRows().filter(selectable).forEach((r) => S.sel.add(r.row)); renderList(); };
  $('selNone').onclick = () => { if (S.busy) return; S.sel.clear(); renderList(); };

  // ── 만들기 ──
  function renderBar(repSel) {
    if (!S.data) { $('bar').style.display = 'none'; return; }
    $('bar').style.display = 'block';
    const n = [...S.sel].filter((r) => { const x = S.data.rows.find((y) => y.row === r); return x && selectable(x); }).length;
    if (repSel == null) repSel = S.data.rows.filter((r) => S.sel.has(r.row) && r.descLen > 0).length;
    const j = S.job;
    $('selInfo').innerHTML = j && j.status !== 'running' ? (j.status === 'ready' ? t('done', j.ok, j.replaced, j.failed) : `<span class="err">${esc(t('buildFail') + (j.error || ''))}</span>`) : t('selected', n, repSel);
    $('prog').classList.toggle('hidden', !(j && j.status === 'running'));
    $('progInfo').textContent = j && j.status === 'running' ? t('prog', new Set(j.items.filter((x) => x.status === 'ok' || x.status === 'failed').map((x) => x.slug)).size, new Set(j.items.map((x) => x.slug)).size) : '';
    if (j) $('prog').firstElementChild.style.width = (100 * j.done / Math.max(1, j.total)) + '%';
    $('build').textContent = S.busy ? t('building') : t('build', n);
    $('build').disabled = S.busy || !n;
    const dl = $('dl');
    dl.classList.toggle('hidden', !(j && j.status === 'ready'));
    if (j && j.file) { dl.href = j.file; dl.setAttribute('download', j.fileName || 'clia-bulk.xlsx'); dl.textContent = t('download'); }
  }

  $('build').onclick = async () => {
    if (S.busy) return;
    if (!S.channel) { alert(t('pickCh')); return; }
    const descCol = S.data.cols.desc;
    if (!descCol) { alert(t('desc') + ' ?'); return; }
    const items = S.data.rows.filter((r) => S.sel.has(r.row) && selectable(r)).map((r) => ({ row: r.row, slug: prodOf(r).slug }));
    if (!items.length) return;
    S.busy = true; S.job = null; renderList();
    try {
      const r = await fetch('/api/v1/bulk/build', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: S.data.id, channel: S.channel, sheet: S.data.sheet, descCol, items }) });
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
      S.job = { ...(S.job || { items: [], total: 0, done: 0 }), status: 'failed', error: e.message };
    } finally {
      S.busy = false; renderList();
      if (S.job && S.job.status === 'ready') $('dl').click();
    }
  };

  paint();
})();
