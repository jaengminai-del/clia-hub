# -*- coding: utf-8 -*-
"""
fullshot.py — lg.com 제품 페이지 전체 화면 캡처 (빌더의 "전체 lg.com 컨텐츠 확인하기" 팝업용, 2026-10-26)

    python fullshot.py <url> <out.jpg>
    → stdout: {"width": 960, "height": ..., "bytes": ..., "seconds": ...}

· PC 화면(1920px)으로 열고 배율 0.5 로 찍어 폭 960px JPEG 로 바로 저장 (원본 PNG 는 20MB 넘게 커져 서버 메모리 부담)
· 페이지 로드는 모든 네트워크 요청이 끝날 때까지 기다리지 않는다 (lg.com 은 60초 넘게 안 끝나는 경우가 있음)
  → 기본 HTML 로드 후 끝까지 스크롤해 지연 로드 이미지를 불러온 뒤 캡처
· 배포 서버(데이터센터 IP)는 lg.com(Akamai)이 "Access Denied" 로 막는다 → 막힌 화면이면 Firecrawl 전체 캡처로 다시 받는다
  (FULLSHOT_VIA=firecrawl 이면 처음부터 Firecrawl)
"""
import os
import json
import sys
import time
from pathlib import Path

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

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


class Blocked(Exception):
    pass


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
    for _ in range(6):                                  # 지연 로드 이미지
        actions += [{"type": "scroll", "direction": "down"}, {"type": "wait", "milliseconds": 400}]
    actions += [{"type": "executeJavascript", "script": "window.scrollTo(0,0);"}, {"type": "wait", "milliseconds": 1000}]
    r = requests.post("https://api.firecrawl.dev/v1/scrape", headers={"Authorization": f"Bearer {key}"}, timeout=180,
                      json={"url": url, "formats": ["screenshot@fullPage"], "onlyMainContent": False,
                            "waitFor": 3000, "timeout": 120000, "actions": actions})
    j = r.json()
    if not (r.ok and j.get("success") and (j.get("data") or {}).get("screenshot")):
        raise RuntimeError(f"Firecrawl 캡처 실패: {str(j)[:200]}")
    shot = j["data"]["screenshot"]
    data = requests.get(shot, timeout=60).content if shot.startswith("http") else \
        __import__("base64").b64decode(shot.split(",", 1)[-1])
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, "JPEG", quality=quality)
    return {"width": im.width, "height": im.height, "bytes": out.stat().st_size, "seconds": round(time.time() - t0, 1), "via": "firecrawl"}


def capture(url: str, out: Path, scale: float = 0.5, quality: int = 80) -> dict:
    """직접 캡처 → 막혔으면(Access Denied·너무 짧음) Firecrawl."""
    if os.environ.get("FULLSHOT_VIA") != "firecrawl":
        try:
            return capture_direct(url, out, scale, quality)
        except Blocked:
            pass
    return capture_firecrawl(url, out, round(1920 * scale), quality)


def capture_direct(url: str, out: Path, scale: float = 0.5, quality: int = 80) -> dict:
    from playwright.sync_api import sync_playwright
    t0 = time.time()
    with sync_playwright() as p:
        args = ["--disable-blink-features=AutomationControlled", "--no-sandbox"]
        try:   # 실제 Chrome (봇 차단 회피), 없으면 Playwright Chromium
            browser = p.chromium.launch(channel="chrome", headless=True, args=args)
        except Exception:
            browser = p.chromium.launch(headless=True, args=args)
        try:
            ctx = browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=scale, user_agent=UA)
            ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_selector("footer", timeout=8000)
            except Exception:
                pass
            title = (page.title() or "").lower()
            if "access denied" in title or page.evaluate("document.body.scrollHeight") < 1500:
                raise Blocked(title)                    # lg.com 보안 장치가 막은 화면
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
            page.screenshot(path=str(out), full_page=True, type="jpeg", quality=quality)
        finally:
            browser.close()
    from PIL import Image
    with Image.open(out) as im:
        w, h = im.size
    return {"width": w, "height": h, "bytes": out.stat().st_size, "seconds": round(time.time() - t0, 1), "via": "direct"}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        sys.stdout.write(json.dumps(capture(sys.argv[1], Path(sys.argv[2]))))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)[:300]}))
        sys.exit(1)
