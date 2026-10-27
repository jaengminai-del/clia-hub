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
          imgs: (n) => `${n} image${n === 1 ? '' : 's'}`, untitled: '(no title)', capturing: 'Capturing the lg.com page… (usually 10–40 s)',
          capTitle: 'Snap, snap!', capTips: ['Working hard to capture the lg.com product page…', 'Scrolling down the page, one screen at a time', 'Waiting for every product image to load', 'Long pages take a little longer — almost there!'], capNote: 'Usually 10–40 s',
          failed: 'Could not capture the page.', retry: 'Try again', open: 'Open lg.com', empty: 'No cards yet.', close: 'Close' },
    ko: { title: (n) => `컨텐츠 카드 (${n})`, full: '전체 lg.com 컨텐츠 확인하기', hint: '카드를 끌어서 순서를 바꾸면 왼쪽 미리보기에도 같은 순서로 반영됩니다. 썸네일을 누르면 원본 이미지를 볼 수 있습니다.',
          imgs: (n) => `이미지 ${n}장`, untitled: '(제목 없음)', capturing: 'lg.com 페이지 캡처 중… (보통 10~40초)',
          capTitle: '찰칵, 찰칵!', capTips: ['lg.com 제품 페이지를 열심히 캡처하고 있어요…', '페이지를 위에서 아래로 한 화면씩 훑는 중이에요', '제품 이미지가 모두 뜰 때까지 기다리는 중이에요', '긴 페이지는 조금 더 걸려요. 거의 다 왔어요!'], capNote: '보통 10~40초 걸려요',
          failed: '페이지를 캡처하지 못했습니다.', retry: '다시 시도', open: 'lg.com 열기', empty: '아직 카드가 없습니다.', close: '닫기' },
    de: { title: (n) => `Inhaltskarten (${n})`, full: 'Gesamte lg.com-Seite ansehen', hint: 'Karten ziehen, um die Reihenfolge zu ändern — die Vorschau links folgt. Vorschaubild anklicken für das Originalbild.',
          imgs: (n) => `${n} Bild${n === 1 ? '' : 'er'}`, untitled: '(ohne Titel)', capturing: 'lg.com-Seite wird erfasst… (meist 10–40 s)',
          capTitle: 'Klick, klick!', capTips: ['Wir erfassen fleißig die lg.com-Produktseite…', 'Die Seite wird Bildschirm für Bildschirm gescrollt', 'Warten, bis alle Produktbilder geladen sind', 'Lange Seiten dauern etwas länger — fast geschafft!'], capNote: 'Meist 10–40 s',
          failed: 'Seite konnte nicht erfasst werden.', retry: 'Erneut versuchen', open: 'lg.com öffnen', empty: 'Noch keine Karten.', close: 'Schließen' },
    th: { title: (n) => `การ์ดคอนเทนต์ (${n})`, full: 'ดูหน้า lg.com ทั้งหมด', hint: 'ลากการ์ดเพื่อจัดลำดับใหม่ — ตัวอย่างด้านซ้ายจะเรียงตามลำดับเดียวกัน คลิกภาพย่อเพื่อดูรูปต้นฉบับ',
          imgs: (n) => `${n} รูป`, untitled: '(ไม่มีหัวข้อ)', capturing: 'กำลังจับภาพหน้า lg.com… (ปกติ 10–40 วินาที)',
          capTitle: 'แชะ แชะ!', capTips: ['กำลังตั้งใจจับภาพหน้าสินค้า lg.com…', 'กำลังเลื่อนหน้าลงทีละหน้าจอ', 'รอให้รูปสินค้าโหลดครบทุกรูป', 'หน้ายาวอาจใช้เวลานานขึ้นนิดหน่อย — ใกล้เสร็จแล้ว!'], capNote: 'ปกติ 10–40 วินาที',
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

  // 캡처 대기 화면 — 허브 Coffee Break 와 같은 톤 (플랫 일러스트 + 모션 + 돌아가는 안내 문구)
  const CAP_CSS = `
.clia-cap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100%;padding:56px 32px;box-sizing:border-box;text-align:center;}
.clia-cap-card{background:#fff;border-radius:24px;padding:32px 40px 26px;width:min(440px,100%);box-shadow:0 12px 40px rgba(17,17,17,.08);}
.clia-cap svg{display:block;margin:0 auto 6px;overflow:visible;}
.clia-cap-page{animation:clia-cap-scroll 6s linear infinite;}
@keyframes clia-cap-scroll{from{transform:translateY(0);}to{transform:translateY(-96px);}}
.clia-cap-scan{animation:clia-cap-scan 2.4s ease-in-out infinite alternate;}
@keyframes clia-cap-scan{from{transform:translateY(0);}to{transform:translateY(86px);}}
.clia-cap-cam{transform-box:fill-box;transform-origin:50% 100%;animation:clia-cap-bob 3s ease-in-out infinite;}
@keyframes clia-cap-bob{0%,100%{transform:translateY(0) rotate(-3deg);}50%{transform:translateY(-4px) rotate(3deg);}}
.clia-cap-flash{transform-box:fill-box;transform-origin:50% 50%;opacity:0;animation:clia-cap-flash 3s ease-out infinite;}
@keyframes clia-cap-flash{0%,62%{opacity:0;transform:scale(.4);}68%{opacity:1;transform:scale(1.15);}80%,100%{opacity:0;transform:scale(1.4);}}
.clia-cap-eye{transform-box:fill-box;transform-origin:50% 50%;animation:clia-cap-blink 3s infinite;}
@keyframes clia-cap-blink{0%,64%,72%,100%{transform:scaleY(1);}67%,69%{transform:scaleY(.1);}}
.clia-cap-title{font-family:'LGEIHeadline',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:22px;font-weight:700;color:#111;margin-bottom:8px;}
.clia-cap-msg{font-size:14px;line-height:1.6;color:#4A4946;min-height:46px;margin-bottom:14px;transition:opacity .35s ease,transform .35s ease;}
.clia-cap-msg.out{opacity:0;transform:translateY(6px);}
.clia-cap-bar{height:6px;background:#F0ECE4;border-radius:6px;overflow:hidden;margin-bottom:8px;}
.clia-cap-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#A50034,#EA1917);border-radius:6px;transition:width 1s linear;}
.clia-cap-status{display:flex;justify-content:space-between;font-size:11px;color:#7E7C77;gap:12px;}
@media (prefers-reduced-motion: reduce){.clia-cap *{animation:none !important;transition:none !important;}}`;
  const CAP_SVG = `<svg width="200" height="140" viewBox="0 0 200 140" aria-hidden="true">
  <defs><clipPath id="clia-cap-clip"><rect x="34" y="30" width="112" height="92" rx="2"/></clipPath>
    <linearGradient id="clia-cap-glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EA1917" stop-opacity="0"/><stop offset="1" stop-color="#EA1917" stop-opacity=".22"/></linearGradient></defs>
  <ellipse cx="100" cy="133" rx="70" ry="5" fill="#F0ECE4"/>
  <rect x="28" y="12" width="124" height="116" rx="12" fill="#fff" stroke="#E6E1D6" stroke-width="2"/>
  <path d="M28 24a12 12 0 0 1 12-12h100a12 12 0 0 1 12 12v4H28z" fill="#F0ECE4"/>
  <circle cx="40" cy="20" r="2.6" fill="#EA1917"/><circle cx="49" cy="20" r="2.6" fill="#D9D4CA"/><circle cx="58" cy="20" r="2.6" fill="#D9D4CA"/>
  <rect x="68" y="16.5" width="70" height="7" rx="3.5" fill="#fff"/>
  <g clip-path="url(#clia-cap-clip)"><g class="clia-cap-page">
    <g id="clia-cap-blk"><rect x="40" y="34" width="100" height="40" rx="6" fill="#F6F3EE"/><rect x="72" y="42" width="36" height="26" rx="4" fill="#E6E1D6"/>
      <rect x="40" y="80" width="64" height="6" rx="3" fill="#D9D4CA"/><rect x="40" y="91" width="88" height="4" rx="2" fill="#ECE8E1"/><rect x="40" y="99" width="76" height="4" rx="2" fill="#ECE8E1"/>
      <rect x="40" y="110" width="30" height="10" rx="5" fill="#EA1917" opacity=".85"/><rect x="74" y="110" width="30" height="10" rx="5" fill="#E6E1D6"/></g>
    <use href="#clia-cap-blk" y="96"/><use href="#clia-cap-blk" y="192"/>
  </g>
  <g class="clia-cap-scan"><rect x="34" y="18" width="112" height="16" fill="url(#clia-cap-glow)"/><rect x="34" y="33" width="112" height="2.5" rx="1.25" fill="#EA1917"/></g></g>
  <g class="clia-cap-cam">
    <path d="M150 84h12l4-6h14l4 6h4a8 8 0 0 1 8 8v24a8 8 0 0 1-8 8h-38a8 8 0 0 1-8-8V92a8 8 0 0 1 8-8z" fill="#A50034"/>
    <rect x="182" y="88" width="7" height="4" rx="2" fill="#FFD3DC"/>
    <circle cx="169" cy="104" r="11" fill="#fff"/><circle cx="169" cy="104" r="7" fill="#2B2A28"/><circle cx="166.5" cy="101.5" r="2" fill="#fff"/>
    <ellipse class="clia-cap-eye" cx="155" cy="96" rx="1.8" ry="2.2" fill="#fff"/><ellipse class="clia-cap-eye" cx="183" cy="96" rx="1.8" ry="2.2" fill="#fff"/>
    <path d="M177 117q4 3 8 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="154" cy="117" rx="3.5" ry="2" fill="#FF8FA3" opacity=".8"/>
    <g class="clia-cap-flash"><path d="M185 66l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#FFC93C"/><circle cx="196" cy="70" r="2" fill="#FFC93C"/></g>
  </g></svg>`;
  function captureLoader(body, t) {
    if (!document.getElementById('clia-cap-css')) {
      const st = document.createElement('style'); st.id = 'clia-cap-css'; st.textContent = CAP_CSS; document.head.appendChild(st);
    }
    body.innerHTML = `<div class="clia-cap"><div class="clia-cap-card">${CAP_SVG}
      <div class="clia-cap-title">${esc(t.capTitle)}</div><div class="clia-cap-msg">${esc(t.capTips[0])}</div>
      <div class="clia-cap-bar"><i></i></div><div class="clia-cap-status"><span>${esc(t.capNote)}</span><span data-time>0:00</span></div></div></div>`;
    const msgEl = body.querySelector('.clia-cap-msg'), bar = body.querySelector('.clia-cap-bar i'), time = body.querySelector('[data-time]');
    const t0 = Date.now();
    let tip = 0;
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      bar.style.width = `${Math.round(94 * (1 - Math.exp(-s / 16)))}%`;   // 예상 진행률 (끝까지 차지는 않음)
      if (s > 0 && s % 4 === 0) {
        msgEl.classList.add('out');
        setTimeout(() => { tip = (tip + 1) % t.capTips.length; msgEl.textContent = t.capTips[tip]; msgEl.classList.remove('out'); }, 350);
      }
    };
    const iv = setInterval(() => { if (!body.isConnected || !body.querySelector('.clia-cap')) clearInterval(iv); else tick(); }, 1000);
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
        if (!body.querySelector('.clia-cap')) captureLoader(body, t);   // 폴링마다 다시 그리지 않음 (모션·타이머 유지)
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
    captureLoader(body, t);
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
    document.querySelectorAll('[data-clia-drop-line]').forEach((x) => x.remove());   // 이전 끌기에서 남은 위치 표시
    st.drag = { item, y0: e.clientY, started: false, before: null, line: null };
    const move = (ev) => (ev.buttons === 0 ? end(ev, true) : onMove(st, ev));   // 버튼을 놓친 경우(창 밖에서 뗌) → 취소
    const end = (ev, cancel) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancelFn); window.removeEventListener('blur', cancelFn);
      onUp(st, ev, cancel);
    };
    const up = (ev) => end(ev, false);
    const cancelFn = (ev) => end(ev, true);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancelFn);
    window.addEventListener('blur', cancelFn);
  }
  function onMove(st, e) {
    const d = st.drag; if (!d) return;
    if (!d.started) {
      if (Math.abs(e.clientY - d.y0) < 5) return;
      d.started = true; st.moved = true;
      try { d.item.setPointerCapture(e.pointerId); } catch (_) {}   // 끌기 시작 후: 커서가 목록·창 밖으로 나가도 놓기 이벤트를 받는다
      d.item.style.opacity = '.45';
      document.body.style.cursor = 'grabbing';
      d.line = document.createElement('div');
      d.line.setAttribute('data-clia-drop-line', '');
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
  function onUp(st, e, cancel) {
    const d = st.drag; st.drag = null;
    document.body.style.cursor = '';
    if (!d) return;
    if (d.line) d.line.remove();
    d.item.style.opacity = '';
    if (cancel) { if (d.started) render(st); return; }
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
