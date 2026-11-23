/**
 * clia-frame-picker.js — 동영상 장면 고르기 팝업 (빌더 카드 목록 · 벌크 엑셀 공용, 2026-11-23 통합)
 *
 *   CLIAFramePicker.open({ api, video, slug?, page?, at?, guard?, onPicked })
 *     api     : 서버 주소 앞부분 ('' = 같은 서버)
 *     video   : lg.com 동영상 주소 (mp4)
 *     slug | page : 제품 (crawler-py/out/<slug> · 또는 제품 페이지 주소) — 주면 고른 장면을 제품 데이터에도 저장한다
 *                   → 빌더에서 고르든 벌크에서 고르든 다음 생성·내보내기부터 같은 장면
 *     at      : 처음 열 시점(초) — 지금 쓰는 장면
 *     guard() : '이 장면 사용' 전에 확인 — 문자열을 돌려주면 그 안내만 띄우고 멈춘다 (예: 빌더 편집 중)
 *     onPicked({ src, width, height, saved }) : 장면을 뽑은 뒤 (팝업은 닫힌 뒤)
 *
 * 화면: 동영상(재생·막대 이동) + 아래 미리보기 줄 — 맨 앞에 크롤 직후 자동으로 고른 장면 1~3위('자동 선택'·'후보'), 그 뒤 고르게 나눈 8장.
 * 서버: video-frames.js (/api/v1/video · /api/v1/video-frames · POST /api/v1/video-frame)
 */
(function () {
  const T = {
    en: { auto: 'Auto-picked', alt: 'Candidate', title: 'Choose a frame from the video', hint: 'Play or drag the bar to find a scene, or click a thumbnail — then press “Use this frame”.',
          use: 'Use this frame', loading: 'Loading video…', busy: 'Extracting frame…', fail: 'Could not load the video: ', close: 'Close' },
    ko: { auto: '자동 선택', alt: '후보', title: '동영상에서 쓸 장면 고르기', hint: '재생하거나 막대를 끌어 장면을 찾거나 아래 미리보기를 누른 뒤 “이 장면 사용”을 누르세요.',
          use: '이 장면 사용', loading: '동영상 불러오는 중…', busy: '장면 추출 중…', fail: '동영상을 불러오지 못했습니다: ', close: '닫기' },
    de: { auto: 'Automatisch gewählt', alt: 'Alternative', title: 'Szene aus dem Video wählen', hint: 'Abspielen oder Leiste ziehen, um eine Szene zu finden, oder Vorschaubild anklicken — dann „Diese Szene verwenden“.',
          use: 'Diese Szene verwenden', loading: 'Video wird geladen…', busy: 'Szene wird extrahiert…', fail: 'Video konnte nicht geladen werden: ', close: 'Schließen' },
    th: { auto: 'เลือกอัตโนมัติ', alt: 'ตัวเลือก', title: 'เลือกฉากจากวิดีโอ', hint: 'เล่นหรือลากแถบเพื่อหาฉาก หรือคลิกภาพย่อ แล้วกด “ใช้ฉากนี้”',
          use: 'ใช้ฉากนี้', loading: 'กำลังโหลดวิดีโอ…', busy: 'กำลังดึงภาพฉาก…', fail: 'โหลดวิดีโอไม่สำเร็จ: ', close: 'ปิด' },
    ar: { auto: 'تم اختياره تلقائياً', alt: 'بديل', title: 'اختيار مشهد من الفيديو', hint: 'شغّل الفيديو أو اسحب الشريط للعثور على مشهد، أو انقر صورة مصغرة — ثم اضغط «استخدام هذا المشهد».',
          use: 'استخدام هذا المشهد', loading: 'جارٍ تحميل الفيديو…', busy: 'جارٍ استخراج المشهد…', fail: 'تعذّر تحميل الفيديو: ', close: 'إغلاق' },
  };
  const tr = () => T[(window.CLIA_LANG || document.documentElement.lang || 'en').slice(0, 2)] || T.en;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FONT = () => window.CLIA_UI_FONT || "'LGEIText',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";
  const fmt = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;

  function modal(inner, onClose) {
    const ov = document.createElement('div');
    ov.className = 'clia-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = `position:relative;background:#fff;border-radius:12px;max-width:min(1100px,94vw);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;font:14px/1.4 ${FONT()};box-shadow:0 12px 48px rgba(0,0,0,.4);`;
    const x = document.createElement('button');
    x.type = 'button'; x.title = tr().close; x.textContent = '✕';
    x.style.cssText = 'position:absolute;top:10px;right:10px;z-index:3;width:34px;height:34px;border-radius:50%;border:none;background:rgba(20,20,20,.75);color:#fff;font-size:16px;cursor:pointer;';
    box.append(inner, x);
    ov.appendChild(box);
    const close = () => { ov.remove(); document.removeEventListener('keydown', key); if (onClose) onClose(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    x.onclick = close;
    ov.onclick = (e) => { if (e.target === ov) close(); };
    document.addEventListener('keydown', key);
    document.body.appendChild(ov);
    return close;
  }

  function open(o) {
    const t = tr(), api = o.api || '', video = o.video;
    const wrap = document.createElement('div');
    wrap.style.cssText = `width:min(980px,94vw);display:flex;flex-direction:column;font:14px/1.4 ${FONT()};`;
    wrap.innerHTML = `<div style="padding:18px 60px 10px 22px;"><div style="font-size:18px;font-weight:700;color:#111;">▶ ${esc(t.title)}</div>
        <div style="font-size:12px;color:#6B6B6B;margin-top:4px;">${esc(t.hint)}</div></div>
      <div style="background:#111;display:flex;align-items:center;justify-content:center;height:min(52vh,520px);">
        <video data-v controls preload="auto" playsinline muted style="max-width:100%;max-height:100%;display:block;"></video></div>
      <div data-strip style="display:flex;gap:6px;overflow-x:auto;padding:10px 16px;background:#F6F3EE;min-height:76px;align-items:center;color:#7E7C77;font-size:12px;">${esc(t.loading)}</div>
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid #E6E1D6;">
        <span data-time style="font-variant-numeric:tabular-nums;color:#4A4946;font-size:13px;">0:00.0</span>
        <span data-msg style="flex:1;color:#7E7C77;font-size:12px;"></span>
        <button type="button" data-use style="height:40px;padding:0 22px;border-radius:999px;border:1px solid #FD312E;background:#FD312E;color:#fff;font:600 14px/1 ${FONT()};cursor:pointer;">${esc(t.use)}</button></div>`;
    const v = wrap.querySelector('[data-v]'), strip = wrap.querySelector('[data-strip]'), time = wrap.querySelector('[data-time]');
    const msg = wrap.querySelector('[data-msg]'), use = wrap.querySelector('[data-use]');
    const seek = (sec) => { const go = () => { v.currentTime = sec; }; if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true }); };
    v.src = `${api}/api/v1/video?url=${encodeURIComponent(video)}`;
    v.addEventListener('timeupdate', () => { time.textContent = fmt(v.currentTime || 0); });
    v.addEventListener('seeked', () => { time.textContent = fmt(v.currentTime || 0); });
    v.addEventListener('error', () => { msg.textContent = t.fail + (v.error ? v.error.code : ''); });
    if (o.at > 0) seek(o.at);
    fetch(`${api}/api/v1/video-frames?url=${encodeURIComponent(video)}&n=8`).then((r) => r.json()).then((d) => {
      if (!d.frames) throw new Error(d.error || 'no frames');
      strip.innerHTML = '';
      // 크롤 직후 자동으로 고른 장면(LG 포스터가 검은 화면·없을 때) — 맨 앞에 '자동 선택' · 후보 2·3
      const autos = ((d.auto && d.auto.top) || []).map((x, k) => ({ t: x.t, src: x.src, label: k ? `${t.alt} ${k + 1}` : t.auto, auto: !k }));
      if (autos.length && !(o.at > 0)) seek(autos[0].t);   // 처음 0초 장면이 검은 화면인 경우라 자동 선택 장면에서 연다
      [...autos, ...d.frames].forEach((f) => {
        const b = document.createElement('button');
        b.type = 'button'; b.title = fmt(f.t);
        b.style.cssText = 'flex:0 0 auto;padding:0;border:2px solid transparent;border-radius:6px;background:none;cursor:pointer;position:relative;';
        b.innerHTML = `<img src="${esc(api + f.src)}" alt="" style="height:56px;display:block;border-radius:4px;"><span style="position:absolute;right:3px;bottom:3px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;padding:0 4px;border-radius:3px;">${fmt(f.t)}</span>`
          + (f.label ? `<span style="position:absolute;left:3px;top:3px;background:${f.auto ? '#A50034' : 'rgba(0,0,0,.7)'};color:#fff;font-size:10px;font-weight:600;padding:0 5px;border-radius:3px;">${esc(f.label)}</span>` : '');
        if (f.auto) b.style.borderColor = '#A50034';
        b.onclick = () => { v.pause(); v.currentTime = f.t; strip.querySelectorAll('button').forEach((x) => { x.style.borderColor = 'transparent'; }); b.style.borderColor = '#FD312E'; };
        strip.appendChild(b);
      });
    }).catch((e) => { strip.textContent = t.fail + e.message; });
    use.onclick = async () => {
      const stop = o.guard && o.guard();
      if (stop) { alert(stop); return; }
      use.disabled = true; use.style.opacity = '.6'; msg.textContent = t.busy;
      try {
        const body = { url: video, t: v.currentTime || 0 };
        if (o.slug) body.slug = o.slug; else if (o.page) body.page = o.page;
        const r = await fetch(`${api}/api/v1/video-frame`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.src) throw new Error(d.error || `HTTP ${r.status}`);
        close();
        if (o.onPicked) o.onPicked(d);
      } catch (e) {
        msg.textContent = t.fail + e.message;
        use.disabled = false; use.style.opacity = '1';
      }
    };
    const close = modal(wrap, () => { v.pause(); v.removeAttribute('src'); v.load(); });
  }

  window.CLIAFramePicker = { open };
})();
