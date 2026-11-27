/* bulk-market.js — 벌크 Check 프리뷰를 Shopee · Lazada 상품 페이지처럼 (2026-11-26) · 모양은 bulk-market.css
 * 벌크 Check(?check=1)의 왼쪽 프리뷰에만 쓴다 (bulk-check.js). 서버(bulk-jobs.js)도 galleryOf · specsOf 를 같이 쓴다.
 *
 *   CliaMarket.page(ch, { title, gallery, specs, body })  → 전체 틀 HTML. body 는 '상세' 칸에 그대로 들어간다.
 *   CliaMarket.page(ch, { detailOnly: true, body })        → 상단 바 + '상세' 칸만 (엑셀에 들어가는 것만)
 *   CliaMarket.specsOf(mirror) · CliaMarket.galleryOf(mirror) → 크롤 데이터(mirror.json)에서 스펙 · 갤러리
 *
 * ch: 'shopee' | 'lazada'. 가격 · 별점 · 판매 수는 실제 데이터가 없어 회색 자리표시.
 * 판매자는 둘 다 LG 공식 스토어(LG ELECTRONICS) — Shopee Mall / LazMall 배지.
 */
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const CART = '<svg class="cm-cart" viewBox="0 0 24 24"><path d="M3 4h2.2l2.3 11h10.8l2.2-8H6.6"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>';
  // 로고는 글자 + 단순한 표시만 (실제 로고 그림은 쓰지 않는다)
  const BAG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M5 8h14l-1 13H6z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>';
  const HEART = '<svg viewBox="0 0 24 24"><defs><linearGradient id="cmLz" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFA000"/><stop offset=".5" stop-color="#FF3D3D"/><stop offset="1" stop-color="#E0007A"/></linearGradient></defs><path fill="url(#cmLz)" d="M12 21 3.5 12.6A5 5 0 0 1 12 6a5 5 0 0 1 8.5 6.6z"/></svg>';
  const T = {
    shopee: { cls: 'sp', logo: `${BAG}<span>Shopee<i>|</i>Mall</span>`, search: 'ค้นหาใน Shopee Mall', badge: 'Mall',
      cart: 'เพิ่มไปยังรถเข็น', buy: 'ซื้อสินค้า', spec: 'ข้อมูลจำเพาะของสินค้า', detail: 'รายละเอียดสินค้า', online: 'ออนไลน์' },
    lazada: { cls: 'lz', logo: `${HEART}<span>Lazada</span>`, search: 'ค้นหาในลาซาด้า', badge: 'LazMall',
      cart: 'เพิ่มลงในรถเข็น', buy: 'ซื้อเลย', spec: 'ข้อมูลจำเพาะ', detail: 'รายละเอียด', tabs: ['รีวิว', 'รายละเอียดสินค้า', 'สินค้าแนะนำ'] },
  };
  const tOf = (ch) => T[ch === 'lazada' ? 'lazada' : 'shopee'];

  function barHtml(t) {
    return `<div class="cm-bar"><div class="cm-logo">${t.logo}</div><div class="cm-search"><span>${esc(t.search)}</span><b>${SEARCH}</b></div>${CART}</div>`;
  }

  function page(ch, o) {
    const t = tOf(ch), lz = t.cls === 'lz';
    // detailOnly: 엑셀 설명 칸에 들어가는 것(상세)만 — 갤러리 · 제목 · 가격 · 스펙 없이 (벌크 Check 큰 카드, 2026-11-27)
    if (o.detailOnly) return `<div class="cm ${t.cls}">${barHtml(t)}<div class="cm-dt"><h2 class="cm-bh" lang="th">${t.detail}</h2><div class="cm-body">${o.body || ''}</div></div></div>`;
    const gal = (o.gallery || []).filter(Boolean);
    const main = gal[0] ? `<img src="${esc(gal[0])}" alt="" loading="lazy">` : '<span class="cm-noimg">—</span>';
    const thumbs = gal.slice(0, 5).map((u) => `<span><img src="${esc(u)}" alt="" loading="lazy"></span>`).join('');
    const ph = (w) => `<span class="cm-ph" style="width:${w}px"></span>`;
    const specs = (o.specs || []).length
      ? `<dl class="cm-specs">${o.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
    const top = `<div class="cm-card"><div class="cm-top">
        <div class="cm-gal"><div class="cm-main">${main}</div>${thumbs ? `<div class="cm-thumbs">${thumbs}</div>` : ''}</div>
        <div class="cm-info"><h1 class="cm-title" lang="th"><span class="cm-badge">${t.badge}</span>${esc(o.title || '')}</h1>
          <div class="cm-meta">${ph(70)}${ph(56)}${ph(64)}</div>
          <div class="cm-price"><span class="cur">฿</span><span class="cm-ph"></span></div>
          <div class="cm-btns" lang="th">${lz ? `<span>${t.buy}</span><span class="f">${t.cart}</span>` : `<span>${t.cart}</span><span class="f">${t.buy}</span>`}</div>
        </div></div></div>
      <div class="cm-card"><div class="cm-store"><span class="lgo">LG</span><div><div class="nm">LG ELECTRONICS${lz ? '<span class="cm-badge">LazMall</span>' : ''}</div>
        <div class="st" lang="th">${lz ? ph(90) : `<i></i>${t.online}`}</div></div></div></div>`;
    const detail = lz
      ? `<div class="cm-dt"><div class="cm-tabs" lang="th">${t.tabs.map((x, i) => `<span${i === 1 ? ' class="on"' : ''}>${x}</span>`).join('')}</div>
          ${specs ? `<div class="cm-sub" lang="th">${t.spec}</div>${specs}<div class="cm-sep"></div>` : ''}
          <div class="cm-sub" lang="th">${t.detail}</div><div class="cm-body">${o.body || ''}</div></div>`
      : `${specs ? `<div class="cm-dt"><h2 class="cm-bh" lang="th">${t.spec}</h2>${specs}</div>` : ''}
         <div class="cm-dt"><h2 class="cm-bh" lang="th">${t.detail}</h2><div class="cm-body">${o.body || ''}</div></div>`;
    return `<div class="cm ${t.cls}">${barHtml(t)}${top}${detail}</div>`;
  }

  // 크롤 데이터 → 갤러리 (동영상 · 아이콘 · 썸네일 빼고) · 스펙 (그룹 없는 주요 스펙 먼저, 같은 이름은 한 번)
  function galleryOf(m) {
    return ((m && m._gallery) || []).filter((x) => x && x.pc_url && x.type !== 'video' && x.role !== 'icon' && !/thumbnail/i.test(x.pc_url))
      .map((x) => x.pc_url).slice(0, 8);
  }
  function specsOf(m, max) {
    const all = [];
    ((m && m.sections) || []).forEach((s) => (s.specs || []).forEach((x) => { if (x && x.label && x.value) all.push(x); }));
    const seen = new Set(), out = [];
    const add = (label, value) => { const k = label.trim(); if (!k || seen.has(k)) return; seen.add(k); out.push([k, String(value).trim()]); };
    all.filter((x) => !x.group).forEach((x) => add(x.label, x.value));
    if (out.length < 6) all.filter((x) => x.group).forEach((x) => add(String(x.label).split(' - ').pop(), x.value));
    return out.slice(0, max || 12);
  }

  root.CliaMarket = { page, galleryOf, specsOf };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.CliaMarket || window.CliaMarket;
