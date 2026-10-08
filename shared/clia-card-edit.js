/**
 * clia-card-edit.js — 편집 모드 "카드 단위 삭제" + 빈 카드 자동 정리 (261008)
 *
 * eBay(허브·단독)·Shopee/Lazada 빌더 공용. 프리뷰 프레임에 붙여 쓴다.
 *   CLIACardEdit.attach(frame)   편집 시작 시: 카드마다 "Delete card" 버튼 표시
 *   CLIACardEdit.detach(frame)   편집 종료(Lock) 시: 버튼 제거 + 빈 카드 정리
 *   CLIACardEdit.cleanup(frame)  빈 카드(이미지·텍스트가 하나도 없는 카드) 제거
 *
 * 카드 = 크롤러 CCG 렌더의 .lg-hcard(가로형 피처 카드), .lg-section(섹션 카드·카드 묶음).
 * 서버 예비 템플릿처럼 클래스가 없는 결과물은 최상위 컨테이너의 직계 블록을 카드로 본다.
 * 개별 요소의 ✕ 삭제 후에도 자동으로 빈 카드를 정리하므로 테두리만 남지 않는다.
 */
(function () {
  const BTN = 'clia-card-del';
  const CTRL = '.' + BTN + ', .edit-del-btn, .edit-resize-bar, .edit-reframe-btn, .ebb-del-btn, .ebb-zoom-badge, .img-zoom-badge';
  const observers = new WeakMap();

  const LABELS = {
    card: { en: 'Delete card', de: 'Karte löschen', th: 'ลบการ์ด', ar: 'حذف البطاقة' },
    group: { en: 'Delete group', de: 'Gruppe löschen', th: 'ลบกลุ่ม', ar: 'حذف المجموعة' },
  };
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
    if (group && !card.querySelector(':scope > h2, :scope > .lg-grid-header')) return;
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
  }

  function attach(frame) {
    if (!frame) return;
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
    frame.querySelectorAll('.' + BTN).forEach((b) => b.remove());
    frame.querySelectorAll('[data-clia-pos]').forEach((el) => { el.style.position = ''; delete el.dataset.cliaPos; });
    frame.querySelectorAll('.lg-hcard, .lg-section').forEach((el) => { el.style.outline = ''; el.style.outlineOffset = ''; });
    cleanup(frame);
  }

  window.CLIACardEdit = { attach, detach, cleanup };
})();
