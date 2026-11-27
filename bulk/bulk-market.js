/* bulk-market.js — 벌크 Check 프리뷰를 Shopee · Lazada 상품 페이지처럼 (2026-11-26) · 모양은 bulk-market.css
 * 벌크 Check(?check=1) 카드에만 쓴다 (bulk-check.js).
 *
 *   CliaMarket.page(ch, { body })  → 상단 바 + '상세' 칸. body 는 엑셀 설명 칸에 들어가는 상세 이미지 그대로.
 *
 * ch: 'shopee' | 'lazada'.
 */
(function (root) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const CART = '<svg class="cm-cart" viewBox="0 0 24 24"><path d="M3 4h2.2l2.3 11h10.8l2.2-8H6.6"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>';
  // 로고는 글자 + 단순한 표시만 (실제 로고 그림은 쓰지 않는다)
  const BAG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M5 8h14l-1 13H6z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>';
  const HEART = '<svg viewBox="0 0 24 24"><defs><linearGradient id="cmLz" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFA000"/><stop offset=".5" stop-color="#FF3D3D"/><stop offset="1" stop-color="#E0007A"/></linearGradient></defs><path fill="url(#cmLz)" d="M12 21 3.5 12.6A5 5 0 0 1 12 6a5 5 0 0 1 8.5 6.6z"/></svg>';
  const T = {
    shopee: { cls: 'sp', logo: `${BAG}<span>Shopee<i>|</i>Mall</span>`, search: 'ค้นหาใน Shopee Mall',
      detail: 'รายละเอียดสินค้า' },
    lazada: { cls: 'lz', logo: `${HEART}<span>Lazada</span>`, search: 'ค้นหาในลาซาด้า',
      detail: 'รายละเอียด' },
  };
  const tOf = (ch) => T[ch === 'lazada' ? 'lazada' : 'shopee'];

  function barHtml(t) {
    return `<div class="cm-bar"><div class="cm-logo">${t.logo}</div><div class="cm-search"><span>${esc(t.search)}</span><b>${SEARCH}</b></div>${CART}</div>`;
  }

  // 엑셀 설명 칸에 들어가는 것만: 상단 바 + 상세 칸 (2026-11-27 — 갤러리 · 제목 · 가격 · 스펙은 엑셀에 안 들어가서 보이지 않는다)
  function page(ch, o) {
    const t = tOf(ch);
    return `<div class="cm ${t.cls}">${barHtml(t)}<div class="cm-dt"><h2 class="cm-bh" lang="th">${t.detail}</h2><div class="cm-body">${(o && o.body) || ''}</div></div></div>`;
  }

  root.CliaMarket = { page };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.CliaMarket || window.CliaMarket;
