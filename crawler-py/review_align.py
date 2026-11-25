# -*- coding: utf-8 -*-
"""
review_align.py — 검토·승인 화면의 「같은 영역」 맞추기 (2026-11-24)

lg.com 전체 화면 캡처(왼쪽)와 Shopee/Lazada 상세 이미지(오른쪽)에서 같은 내용이 시작하는 위치를 짝지어
섹션마다 기준점(앵커)을 만든다. 검토 화면은 앵커 사이 구간마다 두 쪽을 같은 속도로 움직이고,
짧은 쪽은 그 구간 끝에서 긴 쪽이 끝날 때까지 기다린다 (review/index.html layout · update).

  오른쪽: 상세 이미지를 만든 HTML 을 slices.py 와 같은 문서·폭·글꼴로 다시 그려(배율 1) 섹션(section.lg-section)과
          그 안의 이미지 위치를 잰다 → 슬라이스 출력 px = CSS px × (출력 폭 / 콘텐츠 폭). 슬라이스는 위에서부터 이어 자른 것이라 그대로 맞다.
  왼쪽:   그 이미지(화면에 보이는 그대로 잘라 낸 것의 가운데 80%)를 lg.com 캡처의 PDP 범위 안에서 찾는다.
          lg.com 은 배치가 달라 이미지 크기가 다르므로 여러 폭으로 맞춰 보고(정규화 상관, FFT, 1/4 축소),
          이미지 순서가 바뀌지 않는 조합 중 점수 합이 가장 큰 것을 고른다(동적 계획법).
  섹션 앵커: 섹션에서 처음 찾은 이미지 기준 — 왼쪽 = 그 이미지 위치 − (섹션 시작~이미지 거리 × 두 쪽 이미지 크기 비).
          이미지를 하나도 못 찾은 섹션(스펙 표 등)은 앵커를 만들지 않는다 → 앞 구간에 합쳐진다.

review_prep.py 가 부른다 (입력에 html 이 있을 때). 실패하면 앵커 없이 → 화면은 구간 하나(같은 속도 · 짧은 쪽 기다림).
"""
import math
from pathlib import Path

DS = 4                      # 캡처 축소 배율 (960px → 240px)
MIN_SCORE = 0.55            # 1/4 축소에서 후보로 남길 상관
MIN_REFINED = 0.75          # 원래 크기의 절반에서 이미지 전체로 다시 맞춘 상관 — 이보다 낮으면 버린다
# lg.com 캡처(폭 960px)에서 이미지 한 장이 가질 수 있는 폭 — 꽉 찬 배너 ~ 4단 카드
K_MIN, K_MAX = 0.3, 1.6      # lg.com 이미지 폭 / 마켓 HTML 이미지 폭 (CSS px) 의 허용 범위
WIDTHS = [960, 900, 840, 780, 720, 660, 600, 540, 480, 440, 400, 360, 320, 290, 260, 230, 200, 170, 140]

_JS_BLOCKS = """() => {
  const root = document.getElementById('slice-root');
  const rootTop = root.getBoundingClientRect().top + window.scrollY;
  const y = (v) => Math.round(v + window.scrollY - rootTop);
  const shown = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) {
    const c = getComputedStyle(e); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) return false; } return true; };
  let secs = [...root.querySelectorAll('section.lg-section')];
  if (!secs.length) secs = [...root.children];
  return secs.map((s) => {
    const r = s.getBoundingClientRect();
    const h = s.querySelector('h1, h2, h3, h4');
    const imgs = [...s.querySelectorAll('img')].filter((i) => i.naturalWidth > 0 && shown(i)).map((i) => {
      let q = i.getBoundingClientRect(), top = q.top, bot = q.bottom, left = q.left, right = q.right;
      for (let e = i.parentElement; e && e !== s.parentElement; e = e.parentElement) {   // 넘침을 가리는 상위 요소로 잘린 부분은 뺀다
        const c = getComputedStyle(e);
        if (c.overflow !== 'visible') { const b = e.getBoundingClientRect(); top = Math.max(top, b.top); bot = Math.min(bot, b.bottom); left = Math.max(left, b.left); right = Math.min(right, b.right); }
      }
      return { top: y(top), bottom: y(bot), left: Math.round(left + window.scrollX), width: Math.round(right - left), src: i.currentSrc || i.src };
    }).filter((i) => i.width >= 120 && i.bottom - i.top >= 60);
    return { top: y(r.top), bottom: y(r.bottom), head: h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) : '', imgs };
  });
}"""


def measure(html, medium, fonts_css, need=None):
    """slices.py 와 같은 문서·폭으로 그려 섹션·이미지 위치(CSS px)와 이미지 조각(회색조)을 얻는다.
    need(src) 가 있으면 그것이 True 인 이미지만 잘라 둔다 (주소로 찾은 이미지는 조각이 필요 없다 — 시간이 많이 듦)."""
    import io
    import numpy as np
    from PIL import Image
    from playwright.sync_api import sync_playwright
    from content_gen.slices import options, _document, _open_page, _launch, _JS_LAYOUT
    o = options({"medium": medium})
    doc = _document(html, o["vw"], fonts_css or "")
    with sync_playwright() as p:
        browser = _launch(p)
        try:
            ctx, page, _stat = _open_page(browser, o["vw"], 1, doc)
            layout = page.evaluate(_JS_LAYOUT)
            secs = page.evaluate(_JS_BLOCKS)
            for s in secs:
                for im in s["imgs"]:
                    if need is not None and not need(im["src"]):
                        continue
                    try:   # 페이지 밖으로 나간 이미지 등은 그 이미지만 건너뛴다 (2026-11-24 OLED65C4PSA: Clipped area is either empty)
                        shot = page.screenshot(type="png", full_page=True,
                                               clip={"x": im["left"], "y": im["top"], "width": im["width"], "height": im["bottom"] - im["top"]})
                        im["gray"] = np.asarray(Image.open(io.BytesIO(shot)).convert("L"), dtype=np.float32)
                    except Exception:   # noqa: BLE001
                        pass
            ctx.close()
        finally:
            browser.close()
    return layout, secs


def _box(a, h, w):
    """적분 영상으로 모든 (h, w) 창의 합 — 결과 크기 (H-h+1, W-w+1)."""
    import numpy as np
    c = np.pad(a.astype(np.float64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)   # float64 — float32 는 큰 합에서 자릿수가 무너진다
    return c[h:, w:] - c[:-h, w:] - c[h:, :-w] + c[:-h, :-w]


def ncc(img, tpl, F=None):
    """정규화 상관 (skimage match_template 과 같은 값) — FFT 로. 결과 (H-h+1, W-w+1)."""
    import numpy as np
    H, W = img.shape
    h, w = tpl.shape
    t = tpl - tpl.mean()
    tn = math.sqrt(float((t * t).sum()))
    if tn < 1e-3:
        return None
    shape = (H, W)
    if F is None:
        F = np.fft.rfft2(img.astype(np.float64), shape)
    corr = np.fft.irfft2(F * np.conj(np.fft.rfft2(t, shape)), shape)[:H - h + 1, :W - w + 1]
    n = h * w
    s1 = _box(img, h, w)
    s2 = _box(img * img, h, w)
    var = np.maximum(s2 - s1 * s1 / n, 0)
    den = np.sqrt(var) * tn
    # 거의 단색인 창(표준편차 < 3)은 상관을 믿을 수 없다 → 0
    out = np.where(var > 9.0 * n, corr / np.maximum(den, 1e-9), 0)
    return np.clip(out, -1, 1)


def find(cap_small, tpl_gray, cap_w, cap_full=None, css_w=None):
    """이미지 조각을 축소 캡처에서 찾는다 → 후보 [(점수, 원본 캡처 기준 위 y, 폭)] (점수 높은 순, 최대 4개)."""
    import numpy as np
    from PIL import Image
    th, tw = tpl_gray.shape
    if tw < 20 or th < 20:
        return []
    # 가운데 80% (마켓 HTML 과 lg.com 의 잘림 차이를 피함)
    y0, x0 = int(th * 0.1), int(tw * 0.1)
    core = tpl_gray[y0:th - y0, x0:tw - x0]
    F = np.fft.rfft2(cap_small.astype(np.float64))
    H, W = cap_small.shape
    best = []
    for wfull in WIDTHS:
        if wfull > cap_w:
            continue
        # 크기 비(lg.com 폭 / 마켓 HTML 폭)가 말이 안 되는 후보는 보지 않는다 — 가늘고 긴 회색 띠 같은 엉뚱한 자리 (A9-ACE 폭 132px)
        if css_w and not (K_MIN <= wfull / css_w <= K_MAX):
            continue
        k = wfull / tw                                  # 원본 캡처에서의 배율
        cw, ch = max(6, round(core.shape[1] * k / DS)), max(6, round(core.shape[0] * k / DS))
        if cw >= W or ch >= H or cw < 10 or ch < 8:
            continue
        t = np.asarray(Image.fromarray(core).resize((cw, ch), Image.BILINEAR), dtype=np.float32)
        r = ncc(cap_small, t, F)
        if r is None:
            continue
        for _ in range(3):                              # 봉우리 3개 (가까운 것은 지움)
            i = int(r.argmax())
            yy, xx = divmod(i, r.shape[1])
            sc = float(r[yy, xx])
            if sc < MIN_SCORE:
                break
            best.append((sc, yy * DS - y0 * k, wfull))
            r[max(0, yy - ch):yy + ch, :] = -1
    best.sort(key=lambda x: -x[0])
    best = [refine(cap_full, tpl_gray, c) for c in best[:8]] if cap_full is not None else best
    best = [c for c in best if c and c[0] >= MIN_REFINED]
    best.sort(key=lambda x: -x[0])
    out = []
    for c in best:                                      # 같은 자리(±12px) 중복은 점수 높은 것만
        if all(abs(c[1] - d[1]) > 12 for d in out):
            out.append(c)
        if len(out) >= 4:
            break
    return out


def refine(cap, tpl_gray, c, ds=2):
    """후보 (점수, y, 폭) 를 1/2 축소·이미지 전체로 주변(±16px · 폭 ±6%)에서 다시 맞춘다 → (점수, y, 폭) | None.
    1/4 축소의 가운데 조각만으로는 색·밝기가 비슷한 다른 사진도 높게 나온다 (2026-11-24 A9-ACE 9개 중 4개)."""
    import numpy as np
    from PIL import Image
    _sc, y, w = c
    th, tw = tpl_gray.shape
    best = None
    for f in (0.94, 0.97, 1.0, 1.03, 1.06):
        ww = w * f
        k = ww / tw
        hh = th * k
        y0 = int(max(0, y - 16 - hh * 0.0)); y1 = int(min(cap.shape[0], y + hh + 16))
        if y1 - y0 < hh or ww > cap.shape[1]:
            continue
        reg = cap[y0:y1:ds, ::ds]
        t = np.asarray(Image.fromarray(tpl_gray).resize((max(8, round(ww / ds)), max(8, round(hh / ds))), Image.BILINEAR), dtype=np.float32)
        if t.shape[0] >= reg.shape[0] or t.shape[1] >= reg.shape[1]:
            continue
        r = ncc(reg, t)
        if r is None:
            continue
        i = int(r.argmax()); yy, _xx = divmod(i, r.shape[1])
        sc = float(r.flat[i])
        if not best or sc > best[0]:
            best = (sc, y0 + yy * ds, ww)
    return best


import re as _re


def stem(u: str) -> str:
    """이미지 주소 → 비교용 이름 (파일 이름, 소문자, ?뒤 · 기기 꼬리표 -d/-m/-pc/-mo 뺌)."""
    f = str(u or "").split("?")[0].split("#")[0].rstrip("/").rsplit("/", 1)[-1].lower()
    return _re.sub(r"[-_](d|m|pc|mo|mob|mobile|desktop)(?=\.[a-z0-9]+$)", "", f)


def box_index(boxes_path):
    """캡처 때 적은 이미지 위치 (fullshot.py _save_boxes) → {이름: [(보임, y, x, w, h) 캡처 px]}"""
    import json
    b = json.loads(Path(boxes_path).read_text(encoding="utf-8"))
    sc = float(b.get("scale") or 0.5)
    idx = {}
    for it in b.get("items") or []:
        for u in _re.findall(r"[^\s,]+?\.(?:jpe?g|png|webp|gif|avif|mp4|webm)", it.get("srcs") or "", _re.I):
            k = stem(u)
            v = (bool(it.get("vis")), it["y"] * sc, it["x"] * sc, it["w"] * sc, it["h"] * sc)
            lst = idx.setdefault(k, [])
            if v not in lst:
                lst.append(v)
    return idx


def align(capture_path, top, bottom, html, medium, fonts_css, slice_width, boxes=None, layout_cache=None):
    """섹션 앵커 [{label, L (캡처 px), R (슬라이스 출력 px), score}] — 위에서 아래 순서, L·R 모두 늘어난다.
    boxes (캡처 때 적은 이미지 위치) 가 있으면 이미지 주소로만 찾는다 — 주소가 같으면 같은 이미지라 틀릴 수 없다.
    주소로 못 찾은 이미지는 lg.com 페이지에 없는 것으로 둔다 (그림 맞추기는 닮은 다른 사진을 잘못 고르기도 해서, 2026-11-24).
    이때는 이미지 조각이 필요 없어 HTML 의 섹션 · 이미지 위치만 재고, layout_cache(같은 HTML 해시)에 두고 다시 쓴다 → 브라우저 없이 끝남.
    boxes 가 없으면(예전 캡처) 예전처럼 그림으로 찾는다."""
    import numpy as np
    from PIL import Image
    idx = {}
    if boxes and Path(boxes).exists():
        try:
            idx = box_index(boxes)
        except Exception:   # noqa: BLE001 — 위치 기록이 깨졌으면 그림 맞추기만
            idx = {}
    by_url = lambda src: [b for b in idx.get(stem(src), []) if top - 40 <= b[1] <= bottom]
    cached = False
    if idx:
        import json
        lc = Path(layout_cache) if layout_cache else None
        if lc and lc.exists():
            try:
                c = json.loads(lc.read_text(encoding="utf-8"))
                layout, secs, cached = c["layout"], c["secs"], True
            except Exception:   # noqa: BLE001
                cached = False
        if not cached:
            layout, secs = measure(html, medium, fonts_css, need=lambda src: False)
            if lc:
                try:
                    lc.parent.mkdir(parents=True, exist_ok=True)
                    lc.write_text(json.dumps({"layout": layout, "secs": secs}), encoding="utf-8")
                except Exception:   # noqa: BLE001
                    pass
    else:
        layout, secs = measure(html, medium, fonts_css)
    scale = slice_width / max(1, layout["contentWidth"])         # CSS px → 슬라이스 출력 px
    small = full = None
    cap_w = 960
    if not idx:   # 그림 맞추기용 캡처 (주소로 찾을 때는 필요 없다)
        with Image.open(capture_path) as im:
            cap = np.asarray(im.convert("L"), dtype=np.float32)
        cap_w = cap.shape[1]
        part = cap[top:bottom]
        hh, ww = (part.shape[0] // DS) * DS, (part.shape[1] // DS) * DS
        small = part[:hh, :ww].reshape(hh // DS, DS, ww // DS, DS).mean(axis=(1, 3))
        full = cap[top:bottom]
    # 이미지마다 후보 → 순서를 지키는 최고 점수 조합 (동적 계획법)
    items = [(si, im) for si, s in enumerate(secs) for im in s["imgs"]]
    cands, n_url = [], 0
    for _si, im in items:
        u = by_url(im["src"])
        if u:   # 주소로 찾음 — 보이는 자리를 먼저 (캐러셀의 다른 장 · 숨은 탭은 상위 요소 자리), 점수 1.0 / 0.9
            n_url += 1
            cs = sorted(((1.0 if vis else 0.9), max(0.0, y - top), w) for vis, y, _x, w, _h in u)
            cs.sort(key=lambda c: (-c[0], c[1]))
            cands.append(cs[:4])
        elif not idx and "gray" in im:
            cands.append(find(small, im["gray"], cap_w, full, im["width"]))
        else:
            cands.append([])
    # best[(i, c)] = (점수 합, 이전 (i, c))
    best = {}
    for i, cs in enumerate(cands):
        new = {}
        for c_i, c in enumerate(cs):
            gain = c[0] - MIN_REFINED + 0.05
            # lg.com 에서 같은 줄(카드가 옆으로 나란히)이면 y 가 같다 — 같은 높이도 이어 붙인다 (전에는 더 아래만 → 한 줄에서 하나만 골라
            # 그 줄의 첫 섹션이 빠지고 기준점이 다음 섹션으로 밀렸다, 2026-11-25 OLED48C6PSA 수상 카드 5장 · 기능 카드 5장)
            prev = max(((v[0], key) for key, v in best.items() if cands[key[0]][key[1]][1] <= c[1] + 4),
                       default=(0.0, None))
            new[(i, c_i)] = (prev[0] + gain, prev[1])
        best.update(new)
    chosen = {}
    if best:
        key = max(best, key=lambda k: best[k][0])
        while key is not None:
            chosen[key[0]] = cands[key[0]][key[1]]
            key = best[key][1]
    # 섹션 앵커: 그 섹션에서 찾은 이미지 중 lg.com 에서 가장 위(같은 줄이면 CLIA 에서 먼저 나오는 것)의 윗변 — 양쪽 모두 그 이미지 윗변.
    # 이미지 윗변은 두 쪽 모두 정확히 안다 (lg.com 은 캡처 때 적은 위치, CLIA 는 HTML 을 그려 잰 위치) → 추정 없이 맞는다.
    # 전에는 섹션 제목 자리를 이미지 크기 비로 어림했는데, 글과 이미지의 간격 비가 달라 lg.com 쪽이 위로 크게 어긋났다 (2026-11-25).
    # lg.com 에서 앞 기준점과 같은 줄(카드가 옆으로 나란히)인 섹션은 기준점을 두지 않는다 → 그 줄이 고정된 채 CLIA 카드들이 지나간다.
    anchors, lastL, lastR = [], -1.0, -1.0
    for si, s in enumerate(secs):
        ms = [(chosen[k], im) for k, (sj, im) in enumerate(items) if sj == si and k in chosen]
        if not ms:
            continue
        c0, im0 = min(ms, key=lambda m: (m[0][1], m[1]["top"]))
        sc = max(c[0] for c, _im in ms)
        L = top + c0[1]
        R = im0["top"] * scale
        if L <= lastL + 8 or R <= lastR + 8:
            continue
        anchors.append({"label": s["head"], "L": round(L), "R": round(R), "score": round(sc, 3)})
        lastL, lastR = L, R
    return {"anchors": anchors, "sections": len(secs), "images": len(items), "matched": len(chosen), "by_url": n_url,
            "mode": "url" if idx else "pixel", "layout_cached": cached}


if __name__ == "__main__":     # 시험: python review_align.py <캡처> <top> <bottom> <html> <fonts css> <슬라이스 폭>
    import json
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    a = sys.argv[1:]
    r = align(a[0], int(a[1]), int(a[2]), Path(a[3]).read_text(encoding="utf-8"), "shopee_lazada", a[4], int(a[5]))
    print(json.dumps(r, ensure_ascii=False, indent=1))
