/**
 * clia-zoom-bar.js — 편집 모드 이미지 확대·축소 막대 (Amazon · eBay(허브·단독) · Shopee/Lazada 공용, 2026-10-16)
 *
 *   [🔍] [−] [100%] [+] [↺]
 *   const bar = CLIAZoomBar.create({ step(d), reset(), value(), corner })   d = +1 / -1 (한 번에 STEP=5%)
 *     corner: 'bottom-right'(기본, Amazon — 모듈 높이 고정) | 'top-left'(eBay·Shopee — 세로로 긴 이미지도 바로 보이게)
 *   wrap.appendChild(bar.el); 값이 바뀔 때마다 bar.update()
 *   CLIAZoomBar.wheelStep(ev, el) → +1 / -1 / 0 : 휠·트랙패드도 5% 단위 (움직인 양을 모아 한 단계씩)
 *   CLIAZoomBar.edgeColor(src, apiBase) → Promise<'rgb(..)'|null> : 축소로 생긴 빈 곳을 채울 이미지 가장자리 평균색
 *
 * 막대는 편집 UI 다 — 잠글 때 각 빌더가 '.img-zoom-bar' 를 지운다 (결과 HTML·다운로드에 남지 않음).
 */
(function () {
  const STEP = 0.05;
  const WHEEL_UNIT = 60;   // 휠·트랙패드 deltaY 를 이만큼 모으면 한 단계

  const ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  const RESET = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';

  function btn(html, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.innerHTML = html;
    b.style.cssText = 'width:24px;height:24px;border:none;border-radius:5px;background:transparent;color:#fff;cursor:pointer;'
      + "display:inline-flex;align-items:center;justify-content:center;font:700 16px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:0;";
    b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,.18)'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    return b;
  }

  function create(opts) {
    const bar = document.createElement('div');
    bar.className = 'img-zoom-bar';
    // top-left: 카드 왼쪽 위의 "Delete card"·↺ 버튼(top 8px, 높이 26px)을 가리지 않게 그 아래 줄에 둔다
    const pos = opts.corner === 'top-left' ? 'left:10px;top:42px;' : 'right:14px;bottom:14px;';
    bar.style.cssText = 'position:absolute;' + pos + 'z-index:70;display:inline-flex;align-items:center;gap:2px;'
      + 'padding:3px 6px;border-radius:8px;background:rgba(20,20,20,.78);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      + "font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;user-select:none;pointer-events:auto;";
    const ico = document.createElement('span');
    ico.innerHTML = ICON;
    ico.style.cssText = 'display:inline-flex;align-items:center;padding:0 3px;opacity:.85;';
    const minus = btn('−', 'Zoom out (5%)');
    const val = document.createElement('span');
    val.style.cssText = 'min-width:42px;text-align:center;font-variant-numeric:tabular-nums;';
    const plus = btn('+', 'Zoom in (5%)');
    const reset = btn(RESET, 'Reset position & zoom');
    bar.append(ico, minus, val, plus, reset);

    // 막대 위 클릭·끌기가 이미지 이동으로 이어지지 않게
    ['mousedown', 'pointerdown', 'click', 'dblclick'].forEach((t) => bar.addEventListener(t, (ev) => ev.stopPropagation()));
    // 누르고 있으면 계속 (0.35초 뒤부터 0.09초마다)
    const hold = (b, d) => {
      let t1 = null, t2 = null;
      const stop = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = null; };
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        opts.step(d); update();
        t1 = setTimeout(() => { t2 = setInterval(() => { opts.step(d); update(); }, 90); }, 350);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => b.addEventListener(t, stop));
    };
    hold(minus, -1);
    hold(plus, +1);
    reset.addEventListener('pointerdown', (ev) => { ev.preventDefault(); opts.reset(); update(); });

    function update() { val.textContent = Math.round((opts.value() || 1) * 100) + '%'; }
    update();
    return { el: bar, update };
  }

  function wheelStep(ev, el) {
    el._cliaWheel = (el._cliaWheel || 0) + (ev.deltaMode === 1 ? ev.deltaY * 30 : ev.deltaY);
    if (Math.abs(el._cliaWheel) < WHEEL_UNIT) return 0;
    const d = el._cliaWheel < 0 ? 1 : -1;     // 위로 굴리면 확대
    el._cliaWheel = 0;
    return d;
  }

  // 이미지 가장자리 평균색 — 100% 아래로 줄여 생긴 빈 곳을 채우는 색 (Amazon _edgeColor 와 같은 규칙: 24×24 로 줄여 바깥 2줄 평균)
  //   직접 읽기(CORS 허용 이미지) → 안 되면 서버 중계(/api/proxy-image) → 그래도 안 되면 null
  const edgeCache = new Map();
  function sample(url) {
    return new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          const N = 24, cv = document.createElement('canvas'); cv.width = cv.height = N;
          const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0, N, N);
          const d = cx.getImageData(0, 0, N, N).data; let r = 0, g = 0, b = 0, n = 0;
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            if (x > 1 && x < N - 2 && y > 1 && y < N - 2) continue;   // 바깥 2줄만
            const i = (y * N + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
          resolve(`rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`);
        } catch (e) { resolve(null); }   // 캔버스 오염(CORS 미허용)
      };
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }
  function edgeColor(src, apiBase) {
    if (!src) return Promise.resolve(null);
    if (!edgeCache.has(src)) {
      const remote = /^https?:/.test(src) && !src.startsWith(location.origin);
      edgeCache.set(src, sample(src).then((c) => c || (remote
        ? sample(`${apiBase || ''}/api/proxy-image?url=${encodeURIComponent(src)}`) : null)));
    }
    return edgeCache.get(src);
  }

  window.CLIAZoomBar = { create, wheelStep, edgeColor, STEP };
})();

/**
 * CLIAPreviewScale — 미리보기를 실제 크기의 80%로 보여 주기 (2026-10-16, 네 빌더 공통)
 *   위아래 카드·모듈이 한 화면에 더 많이 보여 끌어서 옮기기 쉽게. 결과물(HTML·이미지) 크기는 그대로.
 *   apply(frame)       : frame 에 CSS zoom 0.8 + 바로 위에 안내 문구 (eBay·Shopee/Lazada)
 *   note(el, pct)      : el 바로 위에 "실제 크기의 N%로 표시" 문구 (Amazon 은 transform 배율이라 note 만)
 *   factor(el)         : 화면상 크기 ÷ 원래 크기 — 마우스로 끈 거리를 원래 크기 단위로 바꿀 때 나눈다
 */
(function () {
  const SCALE = 0.8;
  const TEXT = {
    en: (p) => `Preview shown at ${p}% of actual size`,
    de: (p) => `Vorschau in ${p} % der tatsächlichen Größe`,
    th: (p) => `แสดงตัวอย่างที่ ${p}% ของขนาดจริง`,
    ar: (p) => `المعاينة بنسبة ${p}% من الحجم الفعلي`,
    ko: (p) => `실제 크기의 ${p}%로 표시`,
  };
  function note(el, pct) {
    if (!el || !el.parentElement) return;
    let n = el.previousElementSibling;
    if (!n || !n.classList.contains('clia-preview-scale-note')) {
      n = document.createElement('div');
      n.className = 'clia-preview-scale-note';
      n.style.cssText = "margin:0 0 8px;padding:6px 10px;border-radius:6px;background:#F4F4F4;color:#555;"
        + "font:600 12px/1.3 'LGEIText',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;text-align:center;";
      el.parentElement.insertBefore(n, el);
    }
    const lang = (window.CLIA_LANG || document.documentElement.lang || 'en').slice(0, 2);
    n.textContent = '🔎 ' + (TEXT[lang] || TEXT.en)(pct);
  }
  function apply(frame) {
    if (!frame) return;
    frame.style.zoom = SCALE;
    note(frame, Math.round(SCALE * 100));
  }
  function factor(el) {
    if (!el || !el.offsetWidth) return 1;
    return el.getBoundingClientRect().width / el.offsetWidth || 1;
  }
  window.CLIAPreviewScale = { SCALE, apply, note, factor };
})();
