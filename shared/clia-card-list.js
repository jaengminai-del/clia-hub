/**
 * clia-card-list.js — 빌더 오른쪽 "컨텐츠 카드" 목록 (eBay(허브·단독) · Shopee/Lazada 공용, 2026-10-26)
 *
 *   CLIACardList.mount({ container, frame, getUrl, onChange, apiBase })
 *     · 왼쪽 미리보기의 섹션 카드를 순서대로 목록으로 (썸네일 · 제목 · 요약 · 이미지 수)
 *     · 카드를 끌어 순서를 바꾸면 미리보기에도 반영 → onChange(frame) (잠금 상태면 결과 HTML 갱신)
 *     · 썸네일 클릭 → 그 카드에 쓰인 원본 이미지 팝업 (여러 장이면 하단 ‹ 1/3 ›)
 *     · 카드 글자 클릭 → 미리보기에서 그 카드로 이동·강조
 *     · 제목 오른쪽 "전체 lg.com 컨텐츠 확인하기" → 크롤했던 lg.com 페이지 전체 캡처 팝업 (✕ 로 닫기)
 *     · 미리보기가 바뀌면(삭제·되돌리기·순서 변경) 목록도 자동 갱신
 *   CLIACardList.prefetch(url, apiBase) — 미리보기가 만들어질 때 전체 캡처를 미리 시작
 */
(function () {
  const T = {
    en: { title: (n) => `Content cards (${n})`, full: 'View full lg.com page', hint: 'Drag cards to reorder — the preview on the left follows the same order. Click a thumbnail to see the original image(s).',
          imgs: (n) => `${n} image${n === 1 ? '' : 's'}`, untitled: '(no title)', capturing: 'Capturing the lg.com page… (usually 10–20 s)',
          failed: 'Could not capture the page.', retry: 'Try again', open: 'Open lg.com', empty: 'No cards yet.', close: 'Close' },
    ko: { title: (n) => `컨텐츠 카드 (${n})`, full: '전체 lg.com 컨텐츠 확인하기', hint: '카드를 끌어서 순서를 바꾸면 왼쪽 미리보기에도 같은 순서로 반영됩니다. 썸네일을 누르면 원본 이미지를 볼 수 있습니다.',
          imgs: (n) => `이미지 ${n}장`, untitled: '(제목 없음)', capturing: 'lg.com 페이지 캡처 중… (보통 10~20초)',
          failed: '페이지를 캡처하지 못했습니다.', retry: '다시 시도', open: 'lg.com 열기', empty: '아직 카드가 없습니다.', close: '닫기' },
    de: { title: (n) => `Inhaltskarten (${n})`, full: 'Gesamte lg.com-Seite ansehen', hint: 'Karten ziehen, um die Reihenfolge zu ändern — die Vorschau links folgt. Vorschaubild anklicken für das Originalbild.',
          imgs: (n) => `${n} Bild${n === 1 ? '' : 'er'}`, untitled: '(ohne Titel)', capturing: 'lg.com-Seite wird erfasst… (meist 10–20 s)',
          failed: 'Seite konnte nicht erfasst werden.', retry: 'Erneut versuchen', open: 'lg.com öffnen', empty: 'Noch keine Karten.', close: 'Schließen' },
    th: { title: (n) => `การ์ดคอนเทนต์ (${n})`, full: 'ดูหน้า lg.com ทั้งหมด', hint: 'ลากการ์ดเพื่อจัดลำดับใหม่ — ตัวอย่างด้านซ้ายจะเรียงตามลำดับเดียวกัน คลิกภาพย่อเพื่อดูรูปต้นฉบับ',
          imgs: (n) => `${n} รูป`, untitled: '(ไม่มีหัวข้อ)', capturing: 'กำลังจับภาพหน้า lg.com… (ปกติ 10–20 วินาที)',
          failed: 'จับภาพหน้าไม่สำเร็จ', retry: 'ลองอีกครั้ง', open: 'เปิด lg.com', empty: 'ยังไม่มีการ์ด', close: 'ปิด' },
  };
  const tr = () => T[(window.CLIA_LANG || document.documentElement.lang || 'en').slice(0, 2)] || T.en;
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const FONT = "'LGEIText',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
  const EDIT_UI = '.img-zoom-bar, .edit-del-btn, .clia-card-del, .clia-card-restore, .img-frame-handle, .ebb-frame-handle, .ebb-del-btn, .edit-reframe-btn';

  // 미리보기의 섹션 카드 (최상위)
  function topCards(frame) {
    const root = frame.querySelector('.lg-container') || frame;
    return Array.from(root.children).filter((el) => !el.matches('style, script, link') && (el.matches('section, .lg-section') || el.querySelector('img, h1, h2, h3, p')));
  }
  function cardInfo(card) {
    const imgs = [];
    card.querySelectorAll('img').forEach((i) => { const s = i.getAttribute('src'); if (s && !i.closest(EDIT_UI) && !imgs.includes(s)) imgs.push(s); });
    const clone = card.cloneNode(true);
    clone.querySelectorAll(EDIT_UI).forEach((x) => x.remove());
    const h = clone.querySelector('h1, h2, h3');
    const p = clone.querySelector('p');
    return { imgs, title: h ? h.textContent.trim() : '', body: p ? p.textContent.trim() : '' };
  }

  // ── 팝업 공통 ───────────────────────────────────────────
  function modal(inner, onClose) {
    const ov = document.createElement('div');
    ov.className = 'clia-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = `position:relative;background:#fff;border-radius:12px;max-width:min(1100px,94vw);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;font:14px/1.4 ${FONT};box-shadow:0 12px 48px rgba(0,0,0,.4);`;
    const x = document.createElement('button');
    x.type = 'button'; x.title = tr().close; x.textContent = '✕';
    x.style.cssText = 'position:absolute;top:10px;right:10px;z-index:3;width:34px;height:34px;border-radius:50%;border:none;background:rgba(20,20,20,.75);color:#fff;font-size:16px;cursor:pointer;';
    box.append(inner, x);
    ov.appendChild(box);
    const close = () => { ov.remove(); document.removeEventListener('keydown', key); if (onClose) onClose(); };
    const key = (e) => { if (e.key === 'Escape') close(); if (ov._key) ov._key(e); };
    x.onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    document.addEventListener('keydown', key);
    document.body.appendChild(ov);
    return ov;
  }

  // 원본 이미지 (여러 장이면 하단 ‹ 1/3 ›)
  function imagePopup(urls, start) {
    let i = start || 0;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
    const stage = document.createElement('div');
    stage.style.cssText = 'background:#F4F4F4;display:flex;align-items:center;justify-content:center;width:min(1100px,94vw);height:calc(92vh - 64px);';
    const img = document.createElement('img');
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
    stage.appendChild(img);
    const bar = document.createElement('div');
    bar.style.cssText = 'height:64px;display:flex;align-items:center;justify-content:center;gap:18px;font-weight:600;font-size:15px;color:#222;';
    const mk = (t) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t;
      b.style.cssText = 'width:38px;height:38px;border-radius:50%;border:1px solid #CFCFCF;background:#fff;font-size:20px;line-height:1;cursor:pointer;'; return b; };
    const prev = mk('‹'), next = mk('›'), num = document.createElement('span');
    num.style.cssText = 'min-width:64px;text-align:center;font-variant-numeric:tabular-nums;';
    bar.append(prev, num, next);
    wrap.append(stage, bar);
    const show = () => {
      img.src = urls[i]; num.textContent = `${i + 1}/${urls.length}`;
      prev.disabled = i === 0; next.disabled = i === urls.length - 1;
      prev.style.opacity = prev.disabled ? '.3' : '1'; next.style.opacity = next.disabled ? '.3' : '1';
    };
    prev.onclick = () => { if (i > 0) { i--; show(); } };
    next.onclick = () => { if (i < urls.length - 1) { i++; show(); } };
    if (urls.length < 2) bar.style.visibility = 'hidden';
    show();
    const ov = modal(wrap);
    ov._key = (e) => { if (e.key === 'ArrowLeft') prev.onclick(); if (e.key === 'ArrowRight') next.onclick(); };
  }

  // 전체 lg.com 캡처
  function fullPopup(url, apiBase) {
    const t = tr();
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:min(1000px,94vw);height:92vh;display:flex;flex-direction:column;';
    const head = document.createElement('div');
    head.style.cssText = 'padding:14px 56px 12px 18px;border-bottom:1px solid #EEE;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    head.textContent = url;
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow:auto;background:#F4F4F4;display:block;';   // flex 이면 긴 캡처가 팝업 높이로 눌려 보임
    wrap.append(head, body);
    let timer = null, stopped = false;
    modal(wrap, () => { stopped = true; clearTimeout(timer); });
    const msg = (html) => { body.innerHTML = `<div style="text-align:center;padding:80px 40px;color:#444;">${html}</div>`; };
    const api = (method, retry) => fetch(`${apiBase || ''}/api/v1/fullshot${method === 'GET' ? `?url=${encodeURIComponent(url)}` : ''}`,
      method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, retry: !!retry }) }).then((r) => r.json());
    const handle = (st) => {
      if (stopped) return;
      if (st.status === 'ready') {
        body.innerHTML = '';
        const img = document.createElement('img');
        img.src = `${apiBase || ''}${st.src}`;
        img.alt = url;
        img.style.cssText = 'width:100%;max-width:960px;height:auto;display:block;margin:0 auto;flex:none;';
        body.appendChild(img);
      } else if (st.status === 'pending') {
        msg(`<div style="font-size:28px;margin-bottom:10px;">⏳</div>${t.capturing}`);
        timer = setTimeout(() => api('GET').then(handle).catch(fail), 2500);
      } else if (st.status === 'none') {
        api('POST').then(handle).catch(fail);
      } else fail();
    };
    const fail = () => {
      if (stopped) return;
      msg(`${t.failed}<br><br><button type="button" data-r style="padding:8px 16px;border-radius:6px;border:1px solid #CCC;background:#fff;cursor:pointer;">${t.retry}</button>
        &nbsp;<a href="${esc(url)}" target="_blank" rel="noopener" style="padding:8px 16px;border-radius:6px;background:#262626;color:#fff;text-decoration:none;">${t.open}</a>`);
      body.querySelector('[data-r]').onclick = () => api('POST', true).then(handle).catch(fail);
    };
    msg(`<div style="font-size:28px;margin-bottom:10px;">⏳</div>${t.capturing}`);
    api('GET').then(handle).catch(fail);
  }

  function prefetch(url, apiBase) {
    if (!url || !/^https:\/\/(www\.)?lg\.com\//i.test(url)) return;
    fetch(`${apiBase || ''}/api/v1/fullshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }).catch(() => {});
  }

  // ── 목록 ─────────────────────────────────────────────────
  const mounted = new WeakMap();
  function mount(opts) {
    const { container, frame } = opts;
    if (!container || !frame) return;
    let st = mounted.get(container);
    if (!st) {
      st = { opts, drag: null, timer: null };
      mounted.set(container, st);
      // 미리보기가 바뀌면(삭제·되돌리기·순서 변경·잠금) 목록 갱신
      const mo = new MutationObserver(() => { if (st.drag) return; clearTimeout(st.timer); st.timer = setTimeout(() => render(st), 400); });
      mo.observe(frame, { childList: true, subtree: true });
      st.mo = mo;
    }
    st.opts = opts;
    render(st);
  }

  function render(st) {
    const { container, frame, getUrl, apiBase } = st.opts;
    const t = tr();
    const cards = topCards(frame);
    container.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 6px;font:700 12px/1.3 ${FONT};color:#7E7C77;text-transform:uppercase;letter-spacing:.06em;`;
    head.innerHTML = `<span>${t.title(cards.length)}</span>`;
    const fullBtn = document.createElement('button');
    fullBtn.type = 'button';
    fullBtn.textContent = '🖥 ' + t.full;
    fullBtn.style.cssText = `flex-shrink:0;padding:6px 12px;border-radius:999px;border:1px solid #262626;background:#fff;color:#262626;font:600 12px/1 ${FONT};cursor:pointer;text-transform:none;letter-spacing:0;`;
    fullBtn.onclick = () => { const u = getUrl && getUrl(); if (u) fullPopup(u, apiBase); };
    head.appendChild(fullBtn);
    const hint = document.createElement('div');
    hint.style.cssText = `margin:0 0 10px;padding:8px 10px;border-radius:8px;background:#FFF8E6;border:1px solid #F1DFB0;color:#6B5A2E;font:12px/1.45 ${FONT};`;
    hint.textContent = '↕ ' + t.hint;
    const list = document.createElement('div');
    list.className = 'clia-card-list';
    container.append(head, hint, list);
    if (!cards.length) { list.innerHTML = `<div style="color:#999;font-size:12px;text-align:center;padding:30px 0;">${t.empty}</div>`; return; }

    cards.forEach((card, idx) => {
      const info = cardInfo(card);
      const item = document.createElement('div');
      item.className = 'clia-card-item';
      item._card = card;
      item.style.cssText = `display:flex;gap:12px;align-items:center;padding:10px;margin-bottom:8px;background:#fff;border:1px solid #E6E1D6;border-radius:12px;cursor:grab;user-select:none;touch-action:none;font:13px/1.35 ${FONT};`;
      const thumb = info.imgs[0]
        ? `<img src="${esc(info.imgs[0])}" alt="" data-thumb style="width:88px;height:66px;object-fit:cover;border-radius:8px;flex-shrink:0;cursor:zoom-in;background:#F2F2F2;">`
        : `<div style="width:88px;height:66px;border-radius:8px;flex-shrink:0;background:#F2F2F2;display:flex;align-items:center;justify-content:center;color:#BBB;font-size:11px;">Text</div>`;
      item.innerHTML = `<span style="color:#B5B5B5;font-size:16px;flex-shrink:0;">⠿</span>${thumb}
        <div style="min-width:0;flex:1;">
          <div style="font-weight:700;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="color:#999;font-weight:600;">${idx + 1}.</span> ${esc(info.title || t.untitled)}</div>
          ${info.body ? `<div style="color:#666;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(info.body)}</div>` : ''}
          <div style="color:#999;font-size:11px;margin-top:2px;">${t.imgs(info.imgs.length)}</div>
        </div>`;
      const th = item.querySelector('[data-thumb]');
      if (th) th.addEventListener('click', (e) => { e.stopPropagation(); if (!st.moved) imagePopup(info.imgs, 0); });
      item.addEventListener('pointerdown', (e) => onDown(st, item, e));
      list.appendChild(item);
    });
  }

  // 미리보기에서 카드로 이동·강조
  function focusCard(card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const o = card.style.outline, oo = card.style.outlineOffset;
    card.style.outline = '3px solid #E53238'; card.style.outlineOffset = '-3px';
    setTimeout(() => { card.style.outline = o; card.style.outlineOffset = oo; }, 1400);
  }

  // ── 끌어서 순서 바꾸기 (목록 → 미리보기) ─────────────────
  function onDown(st, item, e) {
    if (e.button !== 0) return;
    st.moved = false;
    st.drag = { item, y0: e.clientY, started: false, before: null, line: null };
    const move = (ev) => onMove(st, ev);
    const up = (ev) => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); onUp(st, ev); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }
  function onMove(st, e) {
    const d = st.drag; if (!d) return;
    if (!d.started) {
      if (Math.abs(e.clientY - d.y0) < 5) return;
      d.started = true; st.moved = true;
      d.item.style.opacity = '.45';
      document.body.style.cursor = 'grabbing';
      d.line = document.createElement('div');
      d.line.style.cssText = 'position:fixed;z-index:2147483001;height:3px;border-radius:2px;background:#E53238;pointer-events:none;';
      document.body.appendChild(d.line);
    }
    const items = Array.from(d.item.parentElement.children).filter((x) => x !== d.item && x._card);
    let before = null;
    for (const x of items) { const r = x.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = x; break; } }
    d.before = before;
    const ref = (before || items[items.length - 1] || d.item).getBoundingClientRect();
    Object.assign(d.line.style, { left: ref.left + 'px', width: ref.width + 'px', top: (before ? ref.top - 5 : ref.bottom + 3) + 'px' });
    const sc = d.item.closest('[style*="overflow"], .panel-right, .ebb-right, .ebb-sections-panel') || document.scrollingElement;   // 목록 끝에서 자동 스크롤
    const r = sc.getBoundingClientRect ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    if (e.clientY < r.top + 40) sc.scrollTop -= 14; else if (e.clientY > r.bottom - 40) sc.scrollTop += 14;
  }
  function onUp(st, e) {
    const d = st.drag; st.drag = null;
    document.body.style.cursor = '';
    if (!d) return;
    if (d.line) d.line.remove();
    d.item.style.opacity = '';
    if (!d.started) {                       // 클릭 → 미리보기의 그 카드로
      if (!e.target.closest('[data-thumb]')) focusCard(d.item._card);
      return;
    }
    const card = d.item._card, root = card.parentElement;
    const target = d.before ? d.before._card : null;
    const cards = topCards(st.opts.frame);
    const last = cards[cards.length - 1];
    if (target === card || (!target && card === last) || (target && target === card.nextElementSibling)) { render(st); return; }
    if (target) root.insertBefore(card, target); else last.after(card);
    if (st.opts.onChange) st.opts.onChange(st.opts.frame);
    render(st);
    focusCard(card);
  }

  window.CLIACardList = { mount, prefetch, imagePopup, fullPopup };
})();
