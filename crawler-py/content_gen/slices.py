# -*- coding: utf-8 -*-
"""
slices.py — 1차 컨텐츠 HTML → 세로 슬라이스 이미지 ZIP (Shopee/Lazada 상세 이미지)

server.js /api/render-slices(Node·Puppeteer)를 Python·Playwright로 옮긴 것. 요청·결과 형식은 같다.
  - 이미지는 개별 타임아웃으로 기다리고(느린 DAM 이미지는 포기하고 진행) 폰트 로드까지 대기
  - 가운데 정렬 컨테이너 밖 여백은 잘라내고 콘텐츠 실측 폭만 촬영
  - 자르는 위치: 이상적 등분점에서 가장 가까운 섹션 경계 → 표 행/문단 경계 → 등분점 (글자 중간 절단 방지)
  - 배율: output_width / 콘텐츠 폭 (없으면 ×2)
  - ZIP: 슬라이스 이미지 + 슬라이스별 텍스트(.txt) + 전체 텍스트 + manifest.json

사용 (Node 라우터):
  echo '{"html": "...", "slices": 6, ...}' | python -m content_gen.slices <out.zip>
  → stdout: {"manifest": [...], "images_loaded": "n/m", "log": "..."}
"""
import io
import json
import math
import re
import sys
import time
import zipfile
from pathlib import Path

from . import load_medium

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# ── 페이지 안에서 실행하는 스크립트 (server.js 구현과 동일) ──────────────────

_JS_WAIT_ASSETS = """async (perImgMs) => {
  const imgs = Array.from(document.images);
  const settle = img => new Promise(resolve => {
    if (img.complete) return resolve(img.naturalWidth > 0);
    const done = ok => resolve(ok);
    img.addEventListener('load', () => done(true), { once: true });
    img.addEventListener('error', () => done(false), { once: true });
    setTimeout(() => done(img.naturalWidth > 0), perImgMs);
  });
  const results = await Promise.all(imgs.map(settle));
  if (document.fonts && document.fonts.ready) {
    await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 8000))]);
  }
  return { total: imgs.length, loaded: results.filter(Boolean).length };
}"""

_JS_LAYOUT = """() => {
  const root = document.getElementById('slice-root');
  const H = Math.ceil(root.scrollHeight);
  const rootTop = root.getBoundingClientRect().top + window.scrollY;
  const bottomOf = el => {
    const r = el.getBoundingClientRect();
    return Math.round(r.bottom + window.scrollY - rootTop);
  };
  const collect = sel => {
    const out = [];
    root.querySelectorAll(sel).forEach(el => {
      const b = bottomOf(el);
      if (b > 0 && b < H) out.push(b);
    });
    return Array.from(new Set(out)).sort((a, b) => a - b);
  };
  let left = Infinity, right = -Infinity;
  Array.from(root.children).forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    left = Math.min(left, r.left + window.scrollX);
    right = Math.max(right, r.right + window.scrollX);
  });
  const rootRect = root.getBoundingClientRect();
  if (!isFinite(left) || right <= left) {
    left = rootRect.left + window.scrollX;
    right = rootRect.right + window.scrollX;
  }
  return {
    width: Math.ceil(rootRect.width),
    height: H,
    contentLeft: Math.max(0, Math.floor(left)),
    contentWidth: Math.max(1, Math.ceil(right - left)),
    edges: collect(':scope > *, :scope > * > section, :scope > section'),
    fineEdges: collect('tr, li, p, h1, h2, h3, h4, img, .lg-grid-item'),
  };
}"""

_JS_TEXTS = """() => {
  const root = document.getElementById('slice-root');
  const rootTop = root.getBoundingClientRect().top + window.scrollY;
  const out = [];
  root.querySelectorAll('h1, h2, h3, h4, p, li, tr').forEach(el => {
    if (el.closest('li, tr') && el.closest('li, tr') !== el) return;
    const r = el.getBoundingClientRect();
    if (r.height < 1) return;
    const txt = el.tagName === 'TR'
      ? Array.from(el.cells).map(c => c.innerText.trim()).filter(Boolean).join(': ')
      : el.innerText.replace(/\\s+/g, ' ').trim();
    if (!txt) return;
    out.push({ top: Math.round(r.top + window.scrollY - rootTop), kind: /^H\\d$/.test(el.tagName) ? 'Title' : 'Body', txt });
  });
  return out;
}"""


def _jsround(x: float) -> int:
    """JavaScript Math.round (0.5는 올림) — Python round()는 짝수 반올림이라 결과가 달라질 수 있다."""
    return math.floor(x + 0.5)


def _int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def options(req: dict) -> dict:
    """요청 값 정리. medium 이 있으면 매체 spec.json 의 slices 를 기본값으로 쓴다."""
    defaults = {"count": 6, "output_width": None, "format": "jpeg", "quality": 88, "viewport_px": 1600}
    medium = req.get("medium")
    if isinstance(medium, str) and re.fullmatch(r"[a-z_]{2,32}", medium):
        try:
            defaults.update({k: v for k, v in load_medium(medium)["spec"].get("slices", {}).items()
                             if not k.startswith("_")})
        except ValueError:
            pass
    pick = lambda *keys: next((req[k] for k in keys if req.get(k) not in (None, "")), None)
    n = max(1, min(_int(pick("slices"), defaults["count"]) or defaults["count"], 20))
    vw = max(600, min(_int(pick("viewportWidth", "width"), defaults["viewport_px"]) or defaults["viewport_px"], 3000))
    ow = _int(pick("outputWidth"), defaults["output_width"] or 0) or 0
    fmt = "png" if (pick("format") or defaults["format"]) == "png" else "jpeg"
    q = max(40, min(_int(pick("quality"), defaults["quality"]) or defaults["quality"], 100))
    name = re.sub(r"[^a-zA-Z0-9_-]", "-", str(req.get("name") or "pdp"))[:60] or "pdp"
    return {"n": n, "vw": vw, "ow": ow, "fmt": fmt, "q": q, "name": name}


def _cuts(layout: dict, n: int) -> list:
    """자를 위치: 이상적인 등분점에서 가장 가까운 섹션 경계로 스냅.
    경계가 너무 멀면(등분 높이의 45% 초과) 표 행/문단 경계, 그래도 없으면 등분점."""
    H = layout["height"]
    ideal = H / n
    cuts = [0]

    def nearest(lst, target, min_y, tol):
        best = None
        for e in lst:
            if e <= min_y + 8:
                continue
            d = abs(e - target)
            if d <= tol and (best is None or d < abs(best - target)):
                best = e
        return best

    for k in range(1, n):
        target = _jsround(ideal * k)
        prev = cuts[-1]
        cut = nearest(layout["edges"], target, prev, ideal * 0.45)
        if cut is None:
            cut = nearest(layout["fineEdges"], target, prev, ideal * 0.45)
        if cut is None:
            cut = target
        cuts.append(max(cut, prev + 8))
    cuts.append(H)
    return cuts


def _document(html: str, vw: int, fonts_css: str) -> str:
    link = f'<link rel="stylesheet" href="{fonts_css}">' if fonts_css else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">
{link}
<style>
  html, body {{ margin: 0; padding: 0; background: #FFFFFF; }}
  #slice-root {{ width: {vw}px; background: #FFFFFF; }}
  #slice-root img {{ max-width: 100%; }}
</style></head><body><div id="slice-root">{html}</div></body></html>"""


def _open_page(browser, vw: int, scale: float, doc: str):
    ctx = browser.new_context(viewport={"width": vw, "height": 1400}, device_scale_factor=scale,
                              user_agent=UA, extra_http_headers={"Referer": "https://www.lg.com/"})
    page = ctx.new_page()
    page.set_content(doc, wait_until="domcontentloaded", timeout=60000)
    stat = page.evaluate(_JS_WAIT_ASSETS, 25000)
    time.sleep(0.4)
    return ctx, page, stat


def _launch(p):
    """기본 headless-shell은 LG.com DAM(Akamai)에서 이미지가 차단된다 → 정식 Chromium(신형 headless) 우선,
    없으면 설치된 Chrome, 마지막으로 기본값."""
    args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
            "--font-render-hinting=none", "--disable-blink-features=AutomationControlled"]
    for kw in ({"channel": "chromium"}, {"channel": "chrome"}, {}):
        try:
            return p.chromium.launch(headless=True, args=args, **kw)
        except Exception:
            continue
    raise RuntimeError("Chromium을 실행할 수 없습니다 (playwright install chromium 필요)")


def render(req: dict, zip_path: Path) -> dict:
    """요청(html·slices·outputWidth·format·quality·name·viewportWidth·medium·fontsCss) → ZIP 파일. 메타 반환."""
    html = req.get("html")
    if not isinstance(html, str) or not html:
        raise ValueError("html required")
    o = options(req)
    n, vw, ow, fmt, q, name = o["n"], o["vw"], o["ow"], o["fmt"], o["q"], o["name"]
    doc = _document(html, vw, req.get("fontsCss") or "")

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = _launch(p)
        try:
            # 1) 배율 1로 레이아웃 측정 (CSS px 기준이라 배율과 무관)
            ctx, page, stat = _open_page(browser, vw, 1, doc)
            layout = page.evaluate(_JS_LAYOUT)
            H = layout["height"]
            if not H:
                raise ValueError("렌더 높이가 0 — HTML이 비어있는지 확인하세요")
            cuts = _cuts(layout, n)
            blocks = page.evaluate(_JS_TEXTS)

            # 2) 선명도: 콘텐츠 폭이 좁으면 배율을 올려 촬영 (outputWidth 지정 시 그 폭, 없으면 ×2)
            scale = max(0.5, min(ow / layout["contentWidth"], 4)) if ow else 2
            if scale != 1:
                ctx.close()
                ctx, page, stat = _open_page(browser, vw, scale, doc)

            slice_texts = [[] for _ in range(n)]
            for b in blocks:
                i = next((k for k in range(n) if cuts[k] <= b["top"] < cuts[k + 1]), n - 1)
                slice_texts[i].append(f'{b["kind"]}: {b["txt"]}')

            manifest = []
            buf = io.BytesIO()
            ext = "jpg" if fmt == "jpeg" else "png"
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for i in range(n):
                    y = cuts[i]
                    h = max(1, min(cuts[i + 1], H) - y)
                    if h <= 1:
                        continue
                    shot = page.screenshot(
                        type=fmt, full_page=True,
                        **({"quality": q} if fmt == "jpeg" else {}),
                        clip={"x": layout["contentLeft"], "y": y, "width": layout["contentWidth"], "height": h})
                    fname = f"{name}-{i + 1:02d}.{ext}"
                    tname = re.sub(r"\.(jpg|png)$", ".txt", fname)
                    zf.writestr(fname, shot)
                    zf.writestr(tname, ("\n".join(slice_texts[i]) or "(no text)") + "\n")
                    manifest.append({
                        "file": fname,
                        "width": _jsround(layout["contentWidth"] * scale),
                        "height": _jsround(h * scale),
                        "css_height": h,
                        "bytes": len(shot),
                        "text_file": tname,
                        "slice": i + 1,
                    })
                # 전체 텍스트 한 파일 (슬라이스 순서대로)
                zf.writestr(f"{name}-texts.txt", "\n\n".join(
                    f'=== {m["slice"]:02d} · {m["file"]} ===\n' + ("\n".join(slice_texts[m["slice"] - 1]) or "(no text)")
                    for m in manifest) + "\n")
                images_loaded = f'{stat["loaded"]}/{stat["total"]}'
                zf.writestr(f"{name}-manifest.json", json.dumps({
                    "viewport_width": vw,
                    "content_width_css": layout["contentWidth"],
                    "content_left_css": layout["contentLeft"],
                    "scale": scale,
                    "output_width": _jsround(layout["contentWidth"] * scale),
                    "total_height_css": H,
                    "slices": len(manifest),
                    "format": fmt, "quality": q if fmt == "jpeg" else None,
                    "images_loaded": images_loaded,
                    "images": manifest,
                }, indent=2, ensure_ascii=False))
            ctx.close()
        finally:
            browser.close()

    data = buf.getvalue()
    zip_path.write_bytes(data)
    log = (f'{name}: 콘텐츠 {layout["contentWidth"]}x{H}css (여백 좌 {layout["contentLeft"]}px 제외) x{scale} → '
           f'{_jsround(layout["contentWidth"] * scale)}px 폭 {len(manifest)}장, zip {len(data) / 1024 / 1024:.2f}MB')
    missing = stat["total"] - stat["loaded"]
    if stat["total"] and missing:
        log += f' · 이미지 {missing}/{stat["total"]}장 로드 실패(빈칸)'
    return {"manifest": manifest, "images_loaded": images_loaded, "name": name, "log": log}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        meta = render(json.loads(sys.stdin.buffer.read().decode("utf-8")), Path(sys.argv[1]))
        sys.stdout.write(json.dumps(meta, ensure_ascii=False))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)[:500]}, ensure_ascii=False))
        sys.exit(1)
