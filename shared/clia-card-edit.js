/**
 * clia-card-edit.js — 편집 모드 "카드 단위 삭제" + 빈 카드 자동 정리 (261008)
 *
 * eBay(허브·단독)·Shopee/Lazada 빌더 공용. 프리뷰 프레임에 붙여 쓴다.
 *   CLIACardEdit.attach(frame)   편집 시작 시: 카드마다 "Delete card" 버튼 표시
 *   CLIACardEdit.detach(frame)   편집 종료(Lock) 시: 버튼 제거 + 빈 카드 정리
 *   CLIACardEdit.cleanup(frame)  빈 카드(이미지·텍스트가 하나도 없는 카드) 제거
 *   CLIACardEdit.snapshot(frame) 미리보기 생성 직후: 카드마다 원본 HTML 저장 → 편집 모드 "원래대로(↺)" 버튼이 그 카드만 되돌림
 *   CLIACardEdit.enableReorder(frame, { onChange }) 카드 손잡이(⋮⋮)로 끌어서 순서 변경 — 잠금·편집 상태 모두.
 *       손잡이·표시선은 프레임 밖(body)에 띄우므로 결과 HTML 에 섞이지 않는다. 순서가 바뀌면 onChange(frame).
 *   attach(frame, { onRestore }) — onRestore(새 카드 요소): 되돌린 카드에 편집 기능(글자 편집·이미지 줌 등) 다시 붙이기
 *
 * 카드 = 크롤러 CCG 렌더의 .lg-hcard(가로형 피처 카드), .lg-section(섹션 카드·카드 묶음).
 * 서버 예비 템플릿처럼 클래스가 없는 결과물은 최상위 컨테이너의 직계 블록을 카드로 본다.
 * 개별 요소의 ✕ 삭제 후에도 자동으로 빈 카드를 정리하므로 테두리만 남지 않는다.
 */
(function () {
  const BTN = 'clia-card-del';
  const CTRL = '.' + BTN + ', .clia-card-restore, .img-zoom-bar, .edit-del-btn, .edit-resize-bar, .edit-reframe-btn, .ebb-del-btn, .ebb-zoom-badge, .img-zoom-badge';
  const observers = new WeakMap();

  const LABELS = {
    card: { en: 'Delete card', de: 'Karte löschen', th: 'ลบการ์ด', ar: 'حذف البطاقة' },
    group: { en: 'Delete group', de: 'Gruppe löschen', th: 'ลบกลุ่ม', ar: 'حذف المجموعة' },
    restore: { en: 'Restore original', de: 'Original wiederherstellen', th: 'คืนค่าเดิม', ar: 'استعادة الأصل' },
    move: { en: 'Drag to reorder', de: 'Zum Verschieben ziehen', th: 'ลากเพื่อจัดลำดับ', ar: 'اسحب لإعادة الترتيب' },
  };
  const RESTORE = 'clia-card-restore';
  const originals = new WeakMap();   // 카드 요소 → 미리보기 생성 시점의 HTML
  const restoreHooks = new WeakMap(); // frame → onRestore(새 카드)
  const label = (kind) => {
    const lang = (window.CLIA_LANG || document.documentElement.lang || 'en').slice(0, 2);
    return LABELS[kind][lang] || LABELS[kind].en;
  };
  // 투명한 카드 묶음(.lg-section.lg-grid): 제목이 있을 때만 "Delete group" (없으면 카드를 다 지우면 자동 정리)
  const isGroup = (el) => el.matches('.lg-section.lg-grid');

  function cards(frame) {
    const marked = Array.from(frame.querySelectorAll('.lg-hcard, .lg-section'));
    if (marked.length) return marked;
    // 클래스 없는 결과물: 루트 컨테이너(자식이 하나뿐인 래퍼는 한 단계 안으로)의 직계 블록
    let root = frame;
    while (root.children.length === 1 && root.firstElementChild.children.length > 1) root = root.firstElementChild;
    return Array.from(root.children).filter((el) => !el.matches('style, script') && el.offsetHeight > 0);
  }

  // 컨트롤을 뺀 실제 컨텐츠(이미지·영상·텍스트)가 남아 있는가
  function hasContent(el) {
    if (el.querySelector('img, video, iframe, picture')) return true;
    const clone = el.cloneNode(true);
    clone.querySelectorAll(CTRL).forEach((c) => c.remove());
    return clone.textContent.replace(/[\s​✕×]/g, '').length > 0;
  }

  function cleanup(frame) {
    if (!frame) return 0;
    let removed = 0;
    // 안쪽 카드부터 확인 → 피처 카드가 모두 비면 감싼 섹션도 비게 되어 함께 정리
    cards(frame).reverse().forEach((card) => {
      if (card.isConnected && !hasContent(card)) { card.remove(); removed++; }
    });
    return removed;
  }

  function addButton(card, frame) {
    if (card.querySelector(':scope > .' + BTN)) return;
    const group = isGroup(card);
    if (group && !card.querySelector(':scope > h2, :scope > .lg-grid-header')) { addRestoreButton(card, frame, group); return; }
    const kind = group ? 'group' : 'card';
    if (getComputedStyle(card).position === 'static') { card.style.position = 'relative'; card.dataset.cliaPos = '1'; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = BTN;
    b.title = label(kind);
    b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg><span>' + label(kind) + '</span>';
    b.style.cssText = 'position:absolute;top:8px;' + (group ? 'right:8px;' : 'left:8px;') + 'z-index:30;display:inline-flex;align-items:center;gap:5px;'
      + 'height:26px;padding:0 10px;border-radius:999px;border:1px solid #FD312E;background:#fff;color:#FD312E;'
      + "font:600 11px/1 'LGEIHeadline',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;"
      + 'cursor:pointer;opacity:.55;box-shadow:0 1px 4px rgba(0,0,0,.12);transition:opacity .15s,background .15s,color .15s;';
    b.onmouseenter = () => { b.style.opacity = '1'; b.style.background = '#FD312E'; b.style.color = '#fff'; card.style.outline = '2px solid rgba(253,49,46,.55)'; card.style.outlineOffset = '-2px'; };
    b.onmouseleave = () => { b.style.opacity = '.55'; b.style.background = '#fff'; b.style.color = '#FD312E'; card.style.outline = ''; card.style.outlineOffset = ''; };
    b.onclick = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      card.style.transition = 'opacity .2s';
      card.style.opacity = '0';
      setTimeout(() => { card.remove(); cleanup(frame); }, 220);
    };
    card.appendChild(b);
    addRestoreButton(card, frame, group);
  }

  // ── 원래대로(↺): 이 카드만 미리보기 생성 시점으로 ─────────────────
  function snapshot(frame) {
    if (!frame) return;
    cards(frame).forEach((c) => originals.set(c, c.outerHTML));
  }

  function addRestoreButton(card, frame, group) {
    if (!originals.has(card) || card.querySelector(':scope > .' + RESTORE)) return;
    const r = document.createElement('button');
    r.type = 'button';
    r.className = RESTORE;
    r.title = label('restore');
    r.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
    // Delete 버튼 옆 (카드: 왼쪽 위 버튼 오른쪽, 묶음: 오른쪽 위 버튼 왼쪽)
    r.style.cssText = 'position:absolute;top:8px;' + (group ? 'right:132px;' : 'left:128px;') + 'z-index:30;display:inline-flex;align-items:center;justify-content:center;'
      + 'width:26px;height:26px;padding:0;border-radius:999px;border:1px solid #6B6B6B;background:#fff;color:#4A4A4A;'
      + 'cursor:pointer;opacity:.6;box-shadow:0 1px 4px rgba(0,0,0,.12);transition:opacity .15s,background .15s,color .15s;';
    r.onmouseenter = () => { r.style.opacity = '1'; r.style.background = '#4A4A4A'; r.style.color = '#fff'; card.style.outline = '2px dashed rgba(74,74,74,.6)'; card.style.outlineOffset = '-2px'; };
    r.onmouseleave = () => { r.style.opacity = '.6'; r.style.background = '#fff'; r.style.color = '#4A4A4A'; card.style.outline = ''; card.style.outlineOffset = ''; };
    r.onmousedown = (ev) => ev.stopPropagation();
    r.onclick = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const tpl = document.createElement('template');
      tpl.innerHTML = originals.get(card).trim();
      const fresh = tpl.content.firstElementChild;
      if (!fresh) return;
      card.replaceWith(fresh);
      originals.set(fresh, fresh.outerHTML);
      snapshot(fresh);                                     // 안쪽 카드도 원본 등록
      [fresh, ...fresh.querySelectorAll('.lg-hcard, .lg-section')].forEach((c) => { if (!originals.has(c)) originals.set(c, c.outerHTML); });
      const hook = restoreHooks.get(frame);
      if (hook) hook(fresh);                               // 빌더가 편집 기능(글자·이미지) 다시 붙임
      cards(frame).forEach((c) => addButton(c, frame));    // 카드 버튼 다시
    };
    card.appendChild(r);
  }

  function attach(frame, opts) {
    if (!frame) return;
    if (opts && opts.onRestore) restoreHooks.set(frame, opts.onRestore);
    cards(frame).forEach((c) => addButton(c, frame));
    // 개별 요소(✕)를 지워 카드가 비면 바로 정리
    if (!observers.has(frame)) {
      let t = null;
      const mo = new MutationObserver((ms) => {
        if (!ms.some((m) => m.removedNodes.length)) return;
        clearTimeout(t);
        t = setTimeout(() => cleanup(frame), 300);
      });
      mo.observe(frame, { childList: true, subtree: true });
      observers.set(frame, mo);
    }
  }

  function detach(frame) {
    if (!frame) return;
    const mo = observers.get(frame);
    if (mo) { mo.disconnect(); observers.delete(frame); }
    frame.querySelectorAll('.' + BTN + ', .' + RESTORE).forEach((b) => b.remove());
    frame.querySelectorAll('[data-clia-pos]').forEach((el) => { el.style.position = ''; delete el.dataset.cliaPos; });
    frame.querySelectorAll('.lg-hcard, .lg-section').forEach((el) => { el.style.outline = ''; el.style.outlineOffset = ''; });
    cleanup(frame);
  }

  // ── 끌어서 순서 바꾸기 ─────────────────────────────────────────
  //  마우스가 올라간 카드(안쪽 카드)와 그 카드를 감싼 섹션에 손잡이(⋮⋮)를 각각 띄운다 → 같은 부모 안의 형제끼리 이동.
  //  손잡이·표시선은 body 에 붙으므로 결과 HTML 에 섞이지 않는다.
  const reorderState = new WeakMap();
  function enableReorder(frame, opts) {
    if (!frame) return;
    if (reorderState.has(frame)) { reorderState.get(frame).opts = opts || {}; return; }
    const st = { opts: opts || {}, drag: null };
    reorderState.set(frame, st);
    const line = document.createElement('div');
    line.style.cssText = 'position:fixed;z-index:2147483001;display:none;height:3px;background:#FD312E;border-radius:2px;pointer-events:none;box-shadow:0 0 0 2px rgba(253,49,46,.18);';
    document.body.appendChild(line);
    const scroller = () => {
      for (let el = frame; el && el !== document.body; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      }
      return document.scrollingElement;
    };
    const siblings = (card) => {
      const all = cards(frame);
      return Array.from(card.parentElement.children).filter((el) => all.includes(el));
    };
    const grips = [0, 1].map((level) => {
      const g = document.createElement('div');
      g.className = 'clia-reorder-grip';
      g.title = label('move');
      g.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
      g.style.cssText = 'position:fixed;z-index:2147483002;display:none;width:26px;height:26px;border-radius:6px;background:#fff;color:#4A4A4A;'
        + 'border:1px solid #CFCFCF;box-shadow:0 1px 4px rgba(0,0,0,.18);align-items:center;justify-content:center;cursor:grab;touch-action:none;';
      g._card = null;
      document.body.appendChild(g);
      g.addEventListener('mouseenter', () => { if (g._card) { g._card.style.outline = '2px dashed rgba(74,74,74,.55)'; g._card.style.outlineOffset = '-2px'; } });
      g.addEventListener('mouseleave', () => { if (g._card && !st.drag) { g._card.style.outline = ''; g._card.style.outlineOffset = ''; } });
      g.addEventListener('pointerdown', (ev) => {
        if (!g._card) return;
        ev.preventDefault();
        g.setPointerCapture(ev.pointerId);
        st.drag = { grip: g, card: g._card, y0: ev.clientY, started: false, target: null };
      });
      g.addEventListener('pointermove', (ev) => move(ev));
      g.addEventListener('pointerup', end);
      g.addEventListener('pointercancel', end);
      return g;
    });
    const hide = () => grips.forEach((g) => { g.style.display = 'none'; });
    const place = (g, card, dy) => {
      g._card = card;
      if (!card || !card.isConnected) { g.style.display = 'none'; return; }
      const r = card.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      if (r.bottom < Math.max(fr.top, 0) || r.top > Math.min(fr.bottom, innerHeight) || siblings(card).length < 2) { g.style.display = 'none'; return; }
      g.style.display = 'flex';
      g.style.left = Math.max(fr.left + 2, r.left - 30) + 'px';
      g.style.top = Math.min(Math.max(fr.top + 2, 2, r.top + 2 + dy), r.bottom - 28) + 'px';
    };
    frame.addEventListener('mousemove', (ev) => {
      if (st.drag) return;
      const all = cards(frame);
      const hits = [];
      let el = ev.target;
      while (el && el !== frame) { if (all.includes(el)) hits.push(el); el = el.parentElement; }
      if (!hits.length) return;
      const inner = hits[0], outer = hits.find((h) => h !== inner) || null;
      place(grips[0], inner, 0);
      place(grips[1], outer, outer && Math.abs(outer.getBoundingClientRect().top - inner.getBoundingClientRect().top) < 30 ? 30 : 0);
    });
    frame.addEventListener('mouseleave', (ev) => { if (!st.drag && !grips.includes(ev.relatedTarget) && !grips.some((g) => g.contains(ev.relatedTarget))) hide(); });
    frame.addEventListener('scroll', () => { if (!st.drag) hide(); }, true);
    window.addEventListener('scroll', () => { if (!st.drag) hide(); }, true);

    function move(ev) {
      const d = st.drag; if (!d) return;
      if (!d.started && Math.abs(ev.clientY - d.y0) < 5) return;     // 5px 넘게 움직여야 끌기 시작 (클릭과 구분)
      if (!d.started) {
        d.started = true; d.card.style.opacity = '.45'; d.grip.style.cursor = 'grabbing'; document.body.style.cursor = 'grabbing';
        grips.forEach((g) => { if (g !== d.grip) g.style.display = 'none'; });
      }
      d.grip.style.top = (ev.clientY - 13) + 'px';
      // 마우스보다 세로 중심이 아래인 첫 형제 앞에 넣는다 (없으면 맨 뒤)
      const sib = siblings(d.card).filter((x) => x !== d.card);
      let before = null;
      for (const x of sib) { const r = x.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { before = x; break; } }
      d.target = before;
      const ref = (before || sib[sib.length - 1] || d.card).getBoundingClientRect();
      line.style.display = 'block'; line.style.left = ref.left + 'px'; line.style.width = ref.width + 'px';
      line.style.top = (before ? ref.top - 6 : ref.bottom + 4) + 'px';
      const sc = scroller(), sr = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
      if (ev.clientY < sr.top + 40) sc.scrollTop -= 18; else if (ev.clientY > sr.bottom - 40) sc.scrollTop += 18;   // 위·아래 끝에서 자동 스크롤
    }
    function end() {
      const d = st.drag; st.drag = null;
      line.style.display = 'none'; document.body.style.cursor = '';
      if (!d) return;
      d.grip.style.cursor = 'grab';
      d.card.style.opacity = ''; d.card.style.outline = ''; d.card.style.outlineOffset = '';
      if (!d.started) return;
      const sib = siblings(d.card), last = sib[sib.length - 1];
      const moved = d.target ? d.target !== d.card.nextElementSibling : d.card !== last;
      if (!moved) return;
      if (d.target) d.card.parentElement.insertBefore(d.card, d.target);
      else last.after(d.card);
      hide();
      if (st.opts.onChange) st.opts.onChange(frame);
    }
  }

  window.CLIACardEdit = { attach, detach, cleanup, snapshot, enableReorder };
})();
