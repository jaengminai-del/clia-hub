/**
 * clia-zoom-bar.js — 편집 모드 이미지 확대·축소 막대 (Amazon · eBay(허브·단독) · Shopee/Lazada 공용, 2026-10-16)
 *
 *   [🔍] [−] [100%] [+] [↺]
 *   const bar = CLIAZoomBar.create({ step(d), reset(), value(), corner })   d = +1 / -1 (한 번에 STEP=5%)
 *     corner: 'bottom-right'(기본, Amazon — 모듈 높이 고정) | 'top-left'(eBay·Shopee — 세로로 긴 이미지도 바로 보이게)
 *   wrap.appendChild(bar.el); 값이 바뀔 때마다 bar.update()
 *   CLIAZoomBar.wheelStep(ev, el) → +1 / -1 / 0 : 휠·트랙패드도 5% 단위 (움직인 양을 모아 한 단계씩)
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
    const pos = opts.corner === 'top-left' ? 'left:10px;top:10px;' : 'right:14px;bottom:14px;';
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

  window.CLIAZoomBar = { create, wheelStep, STEP };
})();
