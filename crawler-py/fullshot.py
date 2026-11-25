# -*- coding: utf-8 -*-
"""
fullshot.py — lg.com 제품 페이지 전체 화면 캡처 (빌더의 "전체 lg.com 컨텐츠 확인하기" 팝업용, 2026-10-26)

    python fullshot.py <url> <out.jpg>
    → stdout: {"width": 960, "height": ..., "bytes": ..., "seconds": ..., "final": <열린 주소>}
    python fullshot.py --check <url>
    → stdout: {"final": <열린 주소>, "gone": true|false}   (찍지 않고 주소만 — 예전 캡처 확인용, 5~10초)

· 없어진 제품 페이지(단종 · 번들 등)는 lg.com 이 홈(https://www.lg.com/th/)으로 보낸다 → 「페이지가 없음」으로 실패 (2026-11-24)
  홈 화면을 제품 페이지로 찍지 않게. Firecrawl 로 넘기지도 않는다 (같은 홈 화면에 유료 호출).

· PC 화면(1920px)으로 열고 배율 0.5 로 찍어 폭 960px JPEG 로 바로 저장 (원본 PNG 는 20MB 넘게 커져 서버 메모리 부담)
· 페이지 로드는 모든 네트워크 요청이 끝날 때까지 기다리지 않는다 (lg.com 은 60초 넘게 안 끝나는 경우가 있음)
  → 기본 HTML 로드 후 끝까지 스크롤해 지연 로드 이미지를 불러온 뒤 캡처
· 배포 서버(데이터센터 IP)는 lg.com(Akamai)이 "Access Denied" 로 막곤 한다 → 스쿼드 허브 배너 캡처와 같은 브라우저 모양
  (요청 머리글 · 클라이언트 힌트 · 자동화 흔적 숨김 · 403 이면 한 번 더)으로 직접 받고, 그래도 막히면 Firecrawl 전체 캡처로
  (FULLSHOT_VIA=firecrawl 이면 처음부터 Firecrawl, FULLSHOT_VIA=direct 이면 직접만 — Firecrawl 유료 호출 없음)
"""
import os
import json
import sys
import time
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# lg.com(Akamai) 통과 — 스쿼드 허브 배너 캡처(work-automation src/app/api/banner-capture/route.ts)와 같은 브라우저 모양 (2026-11-24)
#   실제 Chrome 과 같은 요청 머리글 · 클라이언트 힌트, 자동화 흔적 숨김, 채팅·동의 스크립트 막기, 403 이면 3초 뒤 한 번 더
HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}
STEALTH = """() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  const q = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) => p.name === 'notifications' ? Promise.resolve({ state: 'denied' }) : q(p);
}"""
BLOCKED_REQUESTS = ["genesys", "liveperson", "salesforceliveagent", "adobe-privacy", "chatbot", "proactive-chat"]
BROWSER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
                "--disable-sync", "--disable-translate", "--disable-default-apps", "--disable-blink-features=AutomationControlled"]

_SCROLL = """async () => {
  await new Promise(res => {
    let y = window.scrollY;
    const t = setInterval(() => {
      window.scrollBy(0, 1200); y += 1200;
      if (y >= document.body.scrollHeight) { clearInterval(t); res(); }
    }, 120);
    setTimeout(() => { clearInterval(t); res(); }, 15000);
  });
}"""


# 이미지 위치 기록 (2026-11-24): 찍을 때 페이지의 이미지 · 동영상마다 주소와 위치(문서 CSS px)를 함께 적는다 → <out>.boxes.json
#   검토 화면의 「같은 영역」을 이미지 주소로 바로 맞춘다 (상세 이미지 HTML 의 img 도 같은 lg.com 주소) — 그림 맞추기보다 빠르고 정확.
#   보이지 않는 것(캐러셀의 다른 장 · 탭)은 보이는 가장 가까운 상위 요소의 위치로.
_JS_BOXES = """() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
    return r.width > 40 && r.height > 40 && r.left < innerWidth - 20 && r.right > 20   // 화면 옆으로 밀려난 캐러셀 장은 안 보임
      && c.display !== 'none' && c.visibility !== 'hidden' && +c.opacity !== 0; };
  const out = [];
  for (const e of document.querySelectorAll('img, picture source, video')) {
    const t = e.tagName === 'SOURCE' ? e.parentElement : e;
    const srcs = [e.currentSrc, e.src, e.getAttribute('data-src'), e.getAttribute('srcset'), e.getAttribute('data-srcset'), e.getAttribute('poster')]
      .filter(Boolean).join(' ');
    if (!srcs) continue;
    let b = t, shown = vis(t);
    if (!shown) { for (b = t.parentElement; b && b !== document.body && !vis(b); b = b.parentElement); if (!b || b === document.body) continue; }
    const r = b.getBoundingClientRect();
    out.push({ srcs: srcs.slice(0, 1500), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), vis: shown });
  }
  return out;
}"""


# lg.com 컴포넌트 기록 (2026-11-25): 크롤러가 읽는 단위(.c-wrapper — component_parser.py)마다 위치 · 제목 · 글 · 이미지 이름.
#   검토 화면이 CLIA 섹션(같은 컴포넌트에서 만든 것)과 컴포넌트를 그대로 짝지어 영역을 정확히 나누고, 영역의 카피를 비교한다.
_JS_COMPS = """() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
    return r.width > 20 && r.height > 20 && c.display !== 'none' && c.visibility !== 'hidden'; };
  const out = [];
  [...document.querySelectorAll('[class*="c-wrapper"]')].forEach((e, i) => {
    if (!/(^|\\s)c-wrapper/.test(e.className || '')) return;
    const r = e.getBoundingClientRect();
    const h = e.querySelector('h1, h2, h3, h4, [class*="headline"], [class*="title"]');
    const imgs = [];
    for (const m of e.querySelectorAll('img, picture source, video')) {
      const u = (m.currentSrc || m.src || m.getAttribute('data-src') || m.getAttribute('srcset') || m.getAttribute('poster') || '').split(/[\\s,]+/)[0];
      if (u && imgs.length < 60 && !imgs.includes(u)) imgs.push(u);
    }
    // 화면에 안 보이는 글(스크린 리더용 이미지 설명 · 숨긴 글자)은 카피가 아니다 — 따로 적어 비교에서 뺀다
    const hidden = [];
    const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const p = n.parentElement, t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!p || t.length < 4) continue;
      const q = p.getBoundingClientRect(), c = getComputedStyle(p);
      if (q.width < 3 || q.height < 3 || /rect\\(0/.test(c.clip || '') || /inset\\(50%/.test(c.clipPath || '') || +c.opacity === 0) { if (hidden.length < 80) hidden.push(t.slice(0, 300)); }
    }
    out.push({ i, hidden, cls: String(e.className).slice(0, 200), id: e.id || '', x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
      w: Math.round(r.width), h: Math.round(r.height), vis: vis(e), head: h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : '',
      text: (e.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n').trim().slice(0, 4000), imgs });
  });
  return out;
}"""

# 화면 단위로 찍어 이어 붙이기 (2026-11-25): 전체 화면 캡처(full_page)는 찍는 동안 뷰포트를 페이지 높이로 늘려, 높이가 화면 높이(vh)를
#   따르는 요소(맨 위 히어로 등)가 그 동안만 커진다 → 아래 내용이 밀리고(SG 27G550B-B 약 1,470px), 미리 잰 높이에서 잘린다.
#   위치 기록은 평소 화면 배치라 캡처와 어긋났다. 뷰포트를 바꾸지 않고 한 화면씩 내려 찍어 붙이면 캡처와 위치가 늘 같은 배치.
#   위에 붙는 요소: sticky 는 제자리(relative)로, fixed(머리글 · 쿠키 띠 · 내리면 붙는 제품 막대)는 첫 화면에만 보이게.
#   내리면 서서히 나타나는 이미지(페이드인)가 반쯤 흐리게 찍히지 않게 애니메이션 · 전환을 끄고, 화면마다 조금 더 기다린다.
_JS_NO_ANIM = """() => { const st = document.createElement('style'); st.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;scroll-behavior:auto!important}'; document.head.appendChild(st); return 1; }"""
_JS_UNSTICK = """() => { let n = 0; for (const e of document.querySelectorAll('body *')) { if (getComputedStyle(e).position === 'sticky') { e.style.setProperty('position', 'relative', 'important'); n++; } } return n; }"""
_JS_HIDE_FIXED = """() => { let n = 0; for (const e of document.querySelectorAll('body *')) { if (getComputedStyle(e).position === 'fixed') { e.style.setProperty('visibility', 'hidden', 'important'); n++; } } return n; }"""
_JS_DOC_H = "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"
STITCH_MAX = 60   # 화면 수 상한 (1080px × 60 = 64,800 CSS px)


def _stitch_paste(canvas, png: bytes, y_css: float, scale: float):
    import io
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("RGB")
    canvas.paste(im, (0, round(y_css * scale)))
    return im.width


def stitch_shot(page, out: Path, scale: float, quality: int):
    """(동기) 한 화면씩 찍어 붙여 out(JPEG)에 → (폭, 높이)"""
    from PIL import Image
    page.evaluate(_JS_NO_ANIM)
    page.evaluate(_JS_UNSTICK)
    vh = page.evaluate("window.innerHeight")
    H = page.evaluate(_JS_DOC_H)
    canvas = Image.new("RGB", (round(1920 * scale), round(H * scale * 1.5) + 10), "white")
    y, first, width = 0, True, 0
    for _ in range(STITCH_MAX):
        page.evaluate(f"window.scrollTo(0, {y})")
        page.wait_for_timeout(350)
        if not first:   # 내리면 그때 붙는 막대(제품명 · 구매 버튼 등)도 있어 화면마다 다시 숨긴다
            page.evaluate(_JS_HIDE_FIXED)
            page.wait_for_timeout(50)
        sy = page.evaluate("window.scrollY")
        width = _stitch_paste(canvas, page.screenshot(type="png"), sy, scale)
        first = False
        H = page.evaluate(_JS_DOC_H)
        if sy + vh >= H - 1 or round(H * scale) > canvas.height:
            break
        y = sy + vh
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(300)
    canvas.crop((0, 0, width or canvas.width, min(canvas.height, round(H * scale)))).save(str(out), "JPEG", quality=quality)


async def stitch_shot_async(page, out: Path, scale: float, quality: int):
    """(비동기 — fullshot_worker) stitch_shot 과 같다"""
    from PIL import Image
    await page.evaluate(_JS_NO_ANIM)
    await page.evaluate(_JS_UNSTICK)
    vh = await page.evaluate("window.innerHeight")
    H = await page.evaluate(_JS_DOC_H)
    canvas = Image.new("RGB", (round(1920 * scale), round(H * scale * 1.5) + 10), "white")
    y, first, width = 0, True, 0
    for _ in range(STITCH_MAX):
        await page.evaluate(f"window.scrollTo(0, {y})")
        await page.wait_for_timeout(350)
        if not first:   # 내리면 그때 붙는 막대(제품명 · 구매 버튼 등)도 있어 화면마다 다시 숨긴다
            await page.evaluate(_JS_HIDE_FIXED)
            await page.wait_for_timeout(50)
        sy = await page.evaluate("window.scrollY")
        width = _stitch_paste(canvas, await page.screenshot(type="png"), sy, scale)
        first = False
        H = await page.evaluate(_JS_DOC_H)
        if sy + vh >= H - 1 or round(H * scale) > canvas.height:
            break
        y = sy + vh
    await page.evaluate("window.scrollTo(0, 0)")
    await page.wait_for_timeout(300)
    canvas.crop((0, 0, width or canvas.width, min(canvas.height, round(H * scale)))).save(str(out), "JPEG", quality=quality)

def _save_boxes(page, out: Path, scale: float):
    try:
        boxes = page.evaluate(_JS_BOXES)
        doc_h = page.evaluate("document.documentElement.scrollHeight")   # 캡처 높이(× scale)와 다르면 위치 기록이 캡처와 어긋난 것
        try:
            comps = page.evaluate(_JS_COMPS)
        except Exception:   # noqa: BLE001
            comps = None
        Path(str(out) + ".boxes.json").write_text(json.dumps({"scale": scale, "doc_h": doc_h, "after": True, "method": "stitch", "v": 2, "items": boxes, "comps": comps}), encoding="utf-8")
    except Exception as e:   # 위치 기록은 덤 — 실패해도 캡처는 그대로
        print(f"boxes: {e}", file=sys.stderr)


class Blocked(Exception):
    pass


class Gone(Exception):
    """제품 페이지가 없어 lg.com 이 다른 주소(홈 등)로 보냄"""
    pass


def same_page(final: str, url: str) -> bool:
    """같은 제품 페이지인지 — 주소가 같거나, 카테고리만 옮겨 마지막 부분(모델)이 같으면 같은 제품
    (2026-11-24 운영: GN-F392PXAK 가 2-door-refrigerator → top-freezer 로 옮겨 간 것을 「없음」으로 봤다)."""
    from urllib.parse import urlparse
    norm = lambda u: urlparse(str(u or "")).path.rstrip("/").lower()
    a, b = norm(final), norm(url)
    return a == b or (a.rsplit("/", 1)[-1] == b.rsplit("/", 1)[-1] and a.count("/") >= 3)


def gone_message(final: str) -> str:
    return f"lg.com 에 이 제품 페이지가 없음 → {final} 로 넘어감"


def capture_firecrawl(url: str, out: Path, width: int = 960, quality: int = 80) -> dict:
    """Firecrawl 의 전체 화면 캡처(screenshot@fullPage) → 폭 width JPEG."""
    import io
    import requests
    from PIL import Image
    key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
    if not key:
        raise RuntimeError("FIRECRAWL_API_KEY 없음")
    t0 = time.time()
    actions = [{"type": "wait", "milliseconds": 1500}]
    # 지연 로드 이미지: 끝까지 천천히 내린다. 6번(한 화면씩)으로는 긴 PDP 의 기능 섹션이 안 찍혔다
    # (2026-11-24 검토 화면 TH ISC10E 등 — 캡처 3,466px 에 스펙만 남음) → 24번
    # Firecrawl 은 동작(actions)을 50개까지만 받는다 (넘으면 BAD_REQUEST — 2026-11-24 운영: 24번 내리기 = 51개로 모든 Firecrawl 캡처 실패)
    for _ in range(23):
        actions += [{"type": "scroll", "direction": "down"}, {"type": "wait", "milliseconds": 350}]
    actions += [{"type": "executeJavascript", "script": "window.scrollTo(0,0);"}, {"type": "wait", "milliseconds": 1000}]
    actions = actions[:48] + actions[-2:] if len(actions) > 50 else actions
    r = requests.post("https://api.firecrawl.dev/v1/scrape", headers={"Authorization": f"Bearer {key}"}, timeout=180,
                      json={"url": url, "formats": ["screenshot@fullPage"], "onlyMainContent": False,
                            "waitFor": 3000, "timeout": 120000, "actions": actions})
    j = r.json()
    if not (r.ok and j.get("success") and (j.get("data") or {}).get("screenshot")):
        raise RuntimeError(f"Firecrawl 캡처 실패: {str(j)[:200]}")
    final = ((j["data"].get("metadata") or {}).get("url") or "")
    if final and not same_page(final, url):
        raise Gone(gone_message(final))
    shot = j["data"]["screenshot"]
    data = requests.get(shot, timeout=60).content if shot.startswith("http") else \
        __import__("base64").b64decode(shot.split(",", 1)[-1])
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "JPEG", quality=quality)
    return {"width": im.width, "height": im.height, "bytes": out.stat().st_size, "seconds": round(time.time() - t0, 1), "via": "firecrawl",
            "final": final or url}


def capture(url: str, out: Path, scale: float = 0.5, quality: int = 80) -> dict:
    """직접 캡처 → 막혔으면(Access Denied·너무 짧음) Firecrawl.
    FULLSHOT_VIA=firecrawl 이면 처음부터 Firecrawl, FULLSHOT_VIA=direct 이면 직접만 (막히면 실패 — Firecrawl 유료 호출 없음)."""
    via = os.environ.get("FULLSHOT_VIA", "")
    if via != "firecrawl":
        try:
            return capture_direct(url, out, scale, quality)
        except Blocked as e:
            if via == "direct":
                raise RuntimeError(f"lg.com 이 막음 (직접 캡처만): {e}")
    return capture_firecrawl(url, out, round(1920 * scale), quality)


def _launch(p):
    try:   # 실제 Chrome (봇 차단 회피), 없으면 Playwright Chromium
        return p.chromium.launch(channel="chrome", headless=True, args=BROWSER_ARGS)
    except Exception:
        return p.chromium.launch(headless=True, args=BROWSER_ARGS)


def check(url: str) -> dict:
    """찍지 않고 열린 주소만 — 예전 캡처가 제품 페이지였는지 확인 (없어진 제품은 홈으로 넘어간다)."""
    from playwright.sync_api import sync_playwright
    t0 = time.time()
    with sync_playwright() as p:
        browser = _launch(p)
        try:
            ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, user_agent=UA, locale="en-US",
                                      extra_http_headers={k: v for k, v in HEADERS.items() if k.startswith("Sec-CH-UA") or k == "Accept-Language"})
            ctx.add_init_script(f"({STEALTH})()")
            page = ctx.new_page()

            def route(r):
                if r.request.resource_type in ("image", "media", "font", "stylesheet") or any(k in r.request.url.lower() for k in BLOCKED_REQUESTS):
                    return r.abort()
                if r.request.resource_type == "document" and r.request.frame == page.main_frame:
                    return r.continue_(headers={**r.request.headers, **HEADERS})
                return r.continue_()

            page.route("**/*", route)
            resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
            if (resp and resp.status == 403) or "access denied" in (page.title() or "").lower():
                page.wait_for_timeout(3000)
                resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
            if (resp and resp.status == 403) or "access denied" in (page.title() or "").lower():
                raise Blocked("access denied")
            page.wait_for_timeout(2500)   # 스크립트로 넘기는 경우
            final = page.url
        finally:
            browser.close()
    return {"final": final, "gone": not same_page(final, url), "seconds": round(time.time() - t0, 1)}


def capture_direct(url: str, out: Path, scale: float = 0.5, quality: int = 80) -> dict:
    from playwright.sync_api import sync_playwright
    t0 = time.time()
    with sync_playwright() as p:
        browser = _launch(p)
        try:
            # 요청 머리글은 페이지 문서에만 — CSS·JS 요청에 문서용 머리글(Sec-Fetch-Dest: document 등)이 붙으면 lg.com 이 그 파일들을 막아
            # 디자인 없이 글자만 찍힌다 (2026-11-24 시험). 클라이언트 힌트·언어만 모든 요청에 (위장한 UA 와 맞게)
            ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=scale, user_agent=UA, locale="en-US",
                                      extra_http_headers={k: v for k, v in HEADERS.items() if k.startswith("Sec-CH-UA") or k == "Accept-Language"})
            ctx.add_init_script(f"({STEALTH})()")
            page = ctx.new_page()
            css_bad = []

            def route(r):
                u = r.request.url.lower()
                if any(k in u for k in BLOCKED_REQUESTS):
                    return r.abort()
                if r.request.resource_type == "document" and r.request.frame == page.main_frame:
                    return r.continue_(headers={**r.request.headers, **HEADERS})
                return r.continue_()

            page.route("**/*", route)
            # lg.com 디자인 파일(CSS)이 막히면 글자만 찍힌다 → 막힌 것으로 본다
            page.on("requestfailed", lambda q: css_bad.append(q.url) if q.resource_type == "stylesheet" and "lg.com" in q.url else None)
            page.on("response", lambda q: css_bad.append(q.url) if q.request.resource_type == "stylesheet" and "lg.com" in q.url and q.status >= 400 else None)
            resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
            if (resp and resp.status == 403) or "access denied" in (page.title() or "").lower():
                page.wait_for_timeout(3000)            # Akamai 차단은 간헐적 — 한 번 더
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_selector("footer", timeout=8000)
            except Exception:
                pass
            try:   # 쿠키 동의 띠(OneTrust)가 캡처를 가리지 않게
                page.click("#onetrust-accept-btn-handler", timeout=1500)
            except Exception:
                pass
            title = (page.title() or "").lower()
            final = page.url
            if "access denied" not in title and not same_page(final, url):
                raise Gone(gone_message(final))         # 없어진 제품 페이지 → 홈으로 넘어감 (홈 화면의 CSS 가 막혀 「막음」으로 보이던 것)
            if "access denied" in title or page.evaluate("document.body.scrollHeight") < 1500:
                raise Blocked(title)                    # lg.com 보안 장치가 막은 화면
            if css_bad:
                raise Blocked(f"stylesheet blocked: {css_bad[0][:100]}")
            prev = 0
            for _ in range(2):                          # 끝까지 스크롤 → 지연 로드 이미지
                page.evaluate(_SCROLL)
                page.wait_for_timeout(1000)
                h = page.evaluate("document.body.scrollHeight")
                if h == prev:
                    break
                prev = h
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(1200)
            out.parent.mkdir(parents=True, exist_ok=True)
            # 위치는 찍은 뒤에 기록한다 — 찍기 전에 적으면 그 뒤에 늦게 뜬 이미지가 아래 내용을 밀어 캡처와 어긋난다
            # (2026-11-25 MS4295DIS: 첫 이미지가 늦게 커져 아래 이미지 위치가 450px 위로 적힘)
            stitch_shot(page, out, scale, quality)   # 한 화면씩 찍어 붙임 (full_page 는 찍는 동안 배치가 바뀐다)
            _save_boxes(page, out, scale)
        finally:
            browser.close()
    from PIL import Image
    with Image.open(out) as im:
        w, h = im.size
    return {"width": w, "height": h, "bytes": out.stat().st_size, "seconds": round(time.time() - t0, 1), "via": "direct", "final": final}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        if sys.argv[1] == "--check":
            sys.stdout.write(json.dumps(check(sys.argv[2])))
        else:
            sys.stdout.write(json.dumps(capture(sys.argv[1], Path(sys.argv[2]))))
    except Gone as e:
        sys.stdout.write(json.dumps({"error": str(e)[:300], "gone": True}))
        sys.exit(1)
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)[:300]}))
        sys.exit(1)
