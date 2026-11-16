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
    en: { vid: 'Video', vidTitle: 'Choose a frame from the video', vidHint: 'Play or drag the bar to find a scene, or click a thumbnail — then press “Use this frame”.', vidUse: 'Use this frame', vidLoading: 'Loading video…', vidBusy: 'Extracting frame…', vidLock: 'Please press Lock first to finish editing.', vidFail: 'Could not load the video: ', vidDone: 'Frame replaced',
          title: (n) => `Content cards (${n})`, full: 'View full lg.com page', hint: 'Drag cards to reorder — the preview on the left follows the same order. Click a thumbnail to see the original image(s).',
          imgs: (n) => `${n} image${n === 1 ? '' : 's'}`, untitled: '(no title)', capturing: 'Capturing the lg.com page… (usually 10–40 s)',
          capTitle: 'Snap, snap!', capTips: ['Working hard to capture the lg.com product page…', 'Scrolling down the page, one screen at a time', 'Waiting for every product image to load', 'Long pages take a little longer — almost there!'], capNote: 'Usually 10–40 s',
          failed: 'Could not capture the page.', retry: 'Try again', open: 'Open lg.com', empty: 'No cards yet.', close: 'Close',
          del: 'Delete card', delQ: (n) => `Delete card ${n}?`, delMsg: 'Are you sure? It will also be removed from the preview on the left. To get it back, generate the content again.', cancel: 'Cancel', delOk: 'Delete' },
    ko: { vid: '동영상', vidTitle: '동영상에서 쓸 장면 고르기', vidHint: '재생하거나 막대를 끌어 장면을 찾거나 아래 미리보기를 누른 뒤 “이 장면 사용”을 누르세요.', vidUse: '이 장면 사용', vidLoading: '동영상 불러오는 중…', vidBusy: '장면 추출 중…', vidLock: '편집을 마치려면 먼저 잠금(Lock)을 눌러 주세요.', vidFail: '동영상을 불러오지 못했습니다: ', vidDone: '장면이 바뀌었습니다',
          title: (n) => `컨텐츠 카드 (${n})`, full: '전체 lg.com 컨텐츠 확인하기', hint: '카드를 끌어서 순서를 바꾸면 왼쪽 미리보기에도 같은 순서로 반영됩니다. 썸네일을 누르면 원본 이미지를 볼 수 있습니다.',
          imgs: (n) => `이미지 ${n}장`, untitled: '(제목 없음)', capturing: 'lg.com 페이지 캡처 중… (보통 10~40초)',
          capTitle: '찰칵, 찰칵!', capTips: ['lg.com 제품 페이지를 열심히 캡처하고 있어요…', '페이지를 위에서 아래로 한 화면씩 훑는 중이에요', '제품 이미지가 모두 뜰 때까지 기다리는 중이에요', '긴 페이지는 조금 더 걸려요. 거의 다 왔어요!'], capNote: '보통 10~40초 걸려요',
          failed: '페이지를 캡처하지 못했습니다.', retry: '다시 시도', open: 'lg.com 열기', empty: '아직 카드가 없습니다.', close: '닫기',
          del: '카드 삭제', delQ: (n) => `${n}번 카드를 지울까요?`, delMsg: '정말 지우시겠어요? 왼쪽 미리보기에서도 함께 사라지며, 되살리려면 컨텐츠를 다시 생성해야 합니다.', cancel: '취소', delOk: '삭제' },
    de: { vid: 'Video', vidTitle: 'Szene aus dem Video wählen', vidHint: 'Abspielen oder Leiste ziehen, um eine Szene zu finden, oder Vorschaubild anklicken — dann „Diese Szene verwenden“.', vidUse: 'Diese Szene verwenden', vidLoading: 'Video wird geladen…', vidBusy: 'Szene wird extrahiert…', vidLock: 'Bitte zuerst „Sperren“ drücken.', vidFail: 'Video konnte nicht geladen werden: ', vidDone: 'Szene ersetzt',
          title: (n) => `Inhaltskarten (${n})`, full: 'Gesamte lg.com-Seite ansehen', hint: 'Karten ziehen, um die Reihenfolge zu ändern — die Vorschau links folgt. Vorschaubild anklicken für das Originalbild.',
          imgs: (n) => `${n} Bild${n === 1 ? '' : 'er'}`, untitled: '(ohne Titel)', capturing: 'lg.com-Seite wird erfasst… (meist 10–40 s)',
          capTitle: 'Klick, klick!', capTips: ['Wir erfassen fleißig die lg.com-Produktseite…', 'Die Seite wird Bildschirm für Bildschirm gescrollt', 'Warten, bis alle Produktbilder geladen sind', 'Lange Seiten dauern etwas länger — fast geschafft!'], capNote: 'Meist 10–40 s',
          failed: 'Seite konnte nicht erfasst werden.', retry: 'Erneut versuchen', open: 'lg.com öffnen', empty: 'Noch keine Karten.', close: 'Schließen',
          del: 'Karte löschen', delQ: (n) => `Karte ${n} löschen?`, delMsg: 'Wirklich löschen? Sie wird auch aus der Vorschau links entfernt. Um sie zurückzuholen, Inhalte neu erstellen.', cancel: 'Abbrechen', delOk: 'Löschen' },
    th: { vid: 'วิดีโอ', vidTitle: 'เลือกฉากจากวิดีโอ', vidHint: 'เล่นหรือลากแถบเพื่อหาฉาก หรือคลิกภาพย่อ แล้วกด “ใช้ฉากนี้”', vidUse: 'ใช้ฉากนี้', vidLoading: 'กำลังโหลดวิดีโอ…', vidBusy: 'กำลังดึงภาพฉาก…', vidLock: 'กรุณากดล็อกก่อนเพื่อจบการแก้ไข', vidFail: 'โหลดวิดีโอไม่สำเร็จ: ', vidDone: 'เปลี่ยนฉากแล้ว',
          title: (n) => `การ์ดคอนเทนต์ (${n})`, full: 'ดูหน้า lg.com ทั้งหมด', hint: 'ลากการ์ดเพื่อจัดลำดับใหม่ — ตัวอย่างด้านซ้ายจะเรียงตามลำดับเดียวกัน คลิกภาพย่อเพื่อดูรูปต้นฉบับ',
          imgs: (n) => `${n} รูป`, untitled: '(ไม่มีหัวข้อ)', capturing: 'กำลังจับภาพหน้า lg.com… (ปกติ 10–40 วินาที)',
          capTitle: 'แชะ แชะ!', capTips: ['กำลังตั้งใจจับภาพหน้าสินค้า lg.com…', 'กำลังเลื่อนหน้าลงทีละหน้าจอ', 'รอให้รูปสินค้าโหลดครบทุกรูป', 'หน้ายาวอาจใช้เวลานานขึ้นนิดหน่อย — ใกล้เสร็จแล้ว!'], capNote: 'ปกติ 10–40 วินาที',
          failed: 'จับภาพหน้าไม่สำเร็จ', retry: 'ลองอีกครั้ง', open: 'เปิด lg.com', empty: 'ยังไม่มีการ์ด', close: 'ปิด',
          del: 'ลบการ์ด', delQ: (n) => `ลบการ์ดที่ ${n} ใช่ไหม?`, delMsg: 'แน่ใจหรือไม่? การ์ดจะถูกลบออกจากตัวอย่างด้านซ้ายด้วย หากต้องการคืน ต้องสร้างคอนเทนต์ใหม่', cancel: 'ยกเลิก', delOk: 'ลบ' },
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
    const v = card.querySelector('img[data-video-src]');
    return { imgs, title: h ? h.textContent.trim() : '', body: p ? p.textContent.trim() : '', video: v ? v.getAttribute('data-video-src') : '' };
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

  // 카드 삭제 확인 — "정말 지우시겠어요?" (되돌리기가 없으므로 실수 방지, 기본 포커스는 취소)
  function confirmDelete(title, msg) {
    const t = tr();
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:rgba(38,38,38,.45);display:flex;align-items:center;justify-content:center;padding:24px;';
      ov.innerHTML = `<div role="alertdialog" aria-modal="true" style="width:min(380px,100%);background:#fff;border-radius:24px;padding:28px 28px 22px;text-align:center;box-shadow:0 24px 64px rgba(38,38,38,.25);font:14px/1.4 ${FONT};color:#111;">
        <div style="width:52px;height:52px;border-radius:50%;margin:0 auto 14px;background:#FFECEB;color:#FD312E;display:flex;align-items:center;justify-content:center;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></div>
        <div style="font-size:18px;font-weight:700;margin-bottom:8px;">${esc(title)}</div>
        <div style="font-size:13px;line-height:1.6;color:#6B6B6B;margin-bottom:20px;">${esc(msg)}</div>
        <div style="display:flex;gap:8px;">
          <button type="button" data-a="0" style="flex:1;height:40px;border-radius:999px;border:1px solid #CFCAC0;background:#fff;color:#262626;font:600 14px/1 ${FONT};cursor:pointer;">${esc(t.cancel)}</button>
          <button type="button" data-a="1" style="flex:1;height:40px;border-radius:999px;border:1px solid #FD312E;background:#FD312E;color:#fff;font:600 14px/1 ${FONT};cursor:pointer;">${esc(t.delOk)}</button>
        </div></div>`;
      const done = (v) => { ov.remove(); window.removeEventListener('keydown', key, true); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); done(false); } };
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
      ov.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => done(b.dataset.a === '1'); });
      window.addEventListener('keydown', key, true);
      document.body.appendChild(ov);
      ov.querySelector('[data-a="0"]').focus();
    });
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

  // 동영상 카드: 팝업에서 동영상을 보며 쓸 장면을 고르고 → 서버가 그 장면을 JPG 로 뽑아(공개 주소) 카드 이미지를 바꾼다 (2026-11-11)
  //   (video-frames.js · 카드의 포스터 이미지에 data-video-src 가 붙어 있음)
  function videoPopup(st, card, video) {
    const t = tr(), api = st.opts.apiBase || '';
    const wrap = document.createElement('div');
    wrap.style.cssText = `width:min(980px,94vw);display:flex;flex-direction:column;font:14px/1.4 ${FONT};`;
    wrap.innerHTML = `<div style="padding:18px 60px 10px 22px;"><div style="font-size:18px;font-weight:700;color:#111;">▶ ${esc(t.vidTitle)}</div>
        <div style="font-size:12px;color:#6B6B6B;margin-top:4px;">${esc(t.vidHint)}</div></div>
      <div style="background:#111;display:flex;align-items:center;justify-content:center;height:min(52vh,520px);">
        <video data-v controls preload="auto" playsinline muted style="max-width:100%;max-height:100%;display:block;"></video></div>
      <div data-strip style="display:flex;gap:6px;overflow-x:auto;padding:10px 16px;background:#F6F3EE;min-height:76px;align-items:center;color:#7E7C77;font-size:12px;">${esc(t.vidLoading)}</div>
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid #E6E1D6;">
        <span data-time style="font-variant-numeric:tabular-nums;color:#4A4946;font-size:13px;">0:00.0</span>
        <span data-msg style="flex:1;color:#7E7C77;font-size:12px;"></span>
        <button type="button" data-use style="height:40px;padding:0 22px;border-radius:999px;border:1px solid #FD312E;background:#FD312E;color:#fff;font:600 14px/1 ${FONT};cursor:pointer;">${esc(t.vidUse)}</button></div>`;
    const v = wrap.querySelector('[data-v]'), strip = wrap.querySelector('[data-strip]'), time = wrap.querySelector('[data-time]');
    const msg = wrap.querySelector('[data-msg]'), use = wrap.querySelector('[data-use]');
    const fmt = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
    v.src = `${api}/api/v1/video?url=${encodeURIComponent(video)}`;
    v.addEventListener('timeupdate', () => { time.textContent = fmt(v.currentTime || 0); });
    v.addEventListener('seeked', () => { time.textContent = fmt(v.currentTime || 0); });
    v.addEventListener('error', () => { msg.textContent = t.vidFail + (v.error ? v.error.code : ''); });
    fetch(`${api}/api/v1/video-frames?url=${encodeURIComponent(video)}&n=8`).then((r) => r.json()).then((d) => {
      if (!d.frames) throw new Error(d.error || 'no frames');
      strip.innerHTML = '';
      d.frames.forEach((f) => {
        const b = document.createElement('button');
        b.type = 'button'; b.title = fmt(f.t);
        b.style.cssText = 'flex:0 0 auto;padding:0;border:2px solid transparent;border-radius:6px;background:none;cursor:pointer;position:relative;';
        b.innerHTML = `<img src="${esc(api + f.src)}" alt="" style="height:56px;display:block;border-radius:4px;"><span style="position:absolute;right:3px;bottom:3px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;padding:0 4px;border-radius:3px;">${fmt(f.t)}</span>`;
        b.onclick = () => { v.pause(); v.currentTime = f.t; strip.querySelectorAll('button').forEach((x) => { x.style.borderColor = 'transparent'; }); b.style.borderColor = '#FD312E'; };
        strip.appendChild(b);
      });
    }).catch((e) => { strip.textContent = t.vidFail + e.message; });
    use.onclick = async () => {
      // 편집 중(글자 편집·이미지 확대 막대가 떠 있음)이면 먼저 잠금 — 잠근 뒤에도 남는 틀 클래스(.img-edit-wrap 등)는 기준이 아님
      if (st.opts.frame.querySelector('[contenteditable="true"], .img-zoom-bar')) { alert(t.vidLock); return; }
      use.disabled = true; use.style.opacity = '.6'; msg.textContent = t.vidBusy;
      try {
        const r = await fetch(`${api}/api/v1/video-frame`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: video, t: v.currentTime || 0 }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.src) throw new Error(d.error || `HTTP ${r.status}`);
        replaceVideoFrame(card, video, d.src);
        if (st.opts.onChange) st.opts.onChange(st.opts.frame);
        ov.click();   // 팝업 닫기 (배경 클릭과 같은 경로 — 키 리스너·동영상 정리)
        render(st);
        focusCard(card);
      } catch (e) {
        msg.textContent = t.vidFail + e.message;
        use.disabled = false; use.style.opacity = '1';
      }
    };
    const ov = modal(wrap, () => { v.pause(); v.removeAttribute('src'); v.load(); });
  }

  // 카드의 동영상 포스터 이미지를 고른 장면으로 — 포스터에 맞춰 잘라 보이던 상자(크롭)는 비율이 달라질 수 있어 풀고 전체 장면을 보여 준다
  function replaceVideoFrame(card, video, src) {
    card.querySelectorAll('img[data-video-src]').forEach((img) => {
      if (img.getAttribute('data-video-src') !== video) return;
      // 이 이미지만 담은 틀(잘라 보이는 비율 상자·편집 틀)까지 함께 바꾼다 — 남겨 두면 새 장면이 예전 비율로 잘린다
      let target = img;
      while (target.parentElement && target.parentElement !== card && target.parentElement.children.length === 1
             && (/padding-top|overflow:\s*hidden/.test(target.parentElement.getAttribute('style') || '')
                 || target.parentElement.matches('.img-edit-wrap, .ebb-img-wrap'))) target = target.parentElement;
      const radius = target.style.borderRadius || img.style.borderRadius || '';
      const n = document.createElement('img');
      n.src = src; n.alt = img.alt || '';
      n.setAttribute('data-video-src', video);
      n.style.cssText = `width:100%;max-width:100%;height:auto;display:block;margin:0 auto;${radius ? `border-radius:${radius};` : ''}`;
      target.replaceWith(n);
    });
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
      item.style.cssText = `position:relative;display:flex;gap:12px;align-items:center;padding:10px 40px 10px 10px;margin-bottom:8px;background:#fff;border:1px solid #E6E1D6;border-radius:12px;cursor:grab;user-select:none;touch-action:none;font:13px/1.35 ${FONT};`;
      const thumb = info.imgs[0]
        ? `<span data-thumb style="position:relative;flex-shrink:0;display:block;width:88px;height:66px;cursor:${info.video ? 'pointer' : 'zoom-in'};">`
          + `<img src="${esc(info.imgs[0])}" alt="" style="width:88px;height:66px;object-fit:cover;border-radius:8px;display:block;background:#F2F2F2;">`
          + (info.video ? `<span style="position:absolute;left:4px;bottom:4px;padding:2px 7px;border-radius:999px;background:rgba(17,17,17,.78);color:#fff;font:700 10px/1.4 ${FONT};letter-spacing:.02em;">▶ ${esc(t.vid)}</span>` : '')
          + `</span>`
        : `<div style="width:88px;height:66px;border-radius:8px;flex-shrink:0;background:#F2F2F2;display:flex;align-items:center;justify-content:center;color:#BBB;font-size:11px;">Text</div>`;
      item.innerHTML = `<span style="color:#B5B5B5;font-size:16px;flex-shrink:0;">⠿</span>${thumb}
        <div style="min-width:0;flex:1;">
          <div style="font-weight:700;color:#222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="color:#999;font-weight:600;">${idx + 1}.</span> ${esc(info.title || t.untitled)}</div>
          ${info.body ? `<div style="color:#666;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(info.body)}</div>` : ''}
          <div style="color:#999;font-size:11px;margin-top:2px;">${t.imgs(info.imgs.length)}</div>
        </div>`;
      // 오른쪽 위 ✕ → 확인 후 미리보기에서 카드 삭제 (목록은 MutationObserver 로 다시 그려짐)
      const x = document.createElement('button');
      x.type = 'button'; x.title = t.del; x.setAttribute('aria-label', t.del);
      x.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      x.style.cssText = 'position:absolute;top:8px;right:8px;width:26px;height:26px;border-radius:50%;border:none;background:transparent;color:#A8A49C;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .15s,color .15s;';
      x.onmouseenter = () => { x.style.background = '#FFECEB'; x.style.color = '#FD312E'; item.style.borderColor = '#FD312E'; };
      x.onmouseleave = () => { x.style.background = 'transparent'; x.style.color = '#A8A49C'; item.style.borderColor = '#E6E1D6'; };
      x.addEventListener('pointerdown', (e) => e.stopPropagation());   // 끌기 시작 방지
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await confirmDelete(t.delQ(idx + 1), t.delMsg))) return;
        if (!card.isConnected) return;
        card.remove();
        if (st.opts.onChange) st.opts.onChange(st.opts.frame);   // 잠금 상태면 결과 HTML 갱신
        render(st);
      });
      item.appendChild(x);
      const th = item.querySelector('[data-thumb]');
      if (th) th.addEventListener('click', (e) => {
        e.stopPropagation();
        if (st.moved) return;
        if (info.video) videoPopup(st, card, info.video); else imagePopup(info.imgs, 0);
      });
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
