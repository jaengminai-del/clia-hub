# -*- coding: utf-8 -*-
"""
fullshot_worker.py — lg.com 전체 화면 캡처 작업자 (2026-11-24)

서버(server.js)가 한 번 띄워 두고 계속 쓴다. 브라우저(Chrome)를 하나만 띄워 두고 캡처마다 새 탭(컨텍스트)을 연다.
  · 예전: 캡처마다 python + Chrome 을 새로 띄움 → 시작에 2~3초, 동시에 여럿이면 프로세스 · 스레드가 모자라
    「can't start new thread」 · 「Target crashed」 (2026-11-24 운영, 브라우저 9개)
  · 지금: Chrome 하나 + 탭 FULLSHOT_WORKER_CONC 개 (기본 6) → 같은 일을 훨씬 적은 프로세스로

  stdin 한 줄에 작업 하나 (JSON): {"id": 1, "op": "capture", "url": ..., "out": ..., "via": ""|"direct"|"firecrawl"}
                                   {"id": 2, "op": "check", "url": ...}
  stdout 한 줄에 결과 하나 (JSON): {"id": 1, "width": ..., "height": ..., "bytes": ..., "final": ...} | {"id": 1, "error": ..., "gone": true?}

캡처 방법(브라우저 모양 · 머리글 · 없어진 페이지 · 막힘 · 이미지 위치 기록)은 fullshot.py 와 같다 — 그 값을 그대로 가져다 쓴다.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import fullshot as F

CONC = max(1, min(16, int(os.getenv("FULLSHOT_WORKER_CONC", "6") or 6)))
JOB_TIMEOUT = 170        # 초 — 서버는 180초에 포기한다
RECYCLE_AFTER = 150      # 캡처 이만큼 하면 브라우저를 새로 (오래 쓰면 메모리가 는다)


def _ctx_headers():
    return {k: v for k, v in F.HEADERS.items() if k.startswith("Sec-CH-UA") or k == "Accept-Language"}


async def _launch(p):
    try:
        return await p.chromium.launch(channel="chrome", headless=True, args=F.BROWSER_ARGS)
    except Exception:
        return await p.chromium.launch(headless=True, args=F.BROWSER_ARGS)


async def check(browser, url: str) -> dict:
    t0 = time.time()
    ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, user_agent=F.UA, locale="en-US", extra_http_headers=_ctx_headers())
    try:
        await ctx.add_init_script(f"({F.STEALTH})()")
        page = await ctx.new_page()

        async def route(r):
            if r.request.resource_type in ("image", "media", "font", "stylesheet") or any(k in r.request.url.lower() for k in F.BLOCKED_REQUESTS):
                return await r.abort()
            if r.request.resource_type == "document" and r.request.frame == page.main_frame:
                return await r.continue_(headers={**r.request.headers, **F.HEADERS})
            return await r.continue_()

        await page.route("**/*", route)
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        if (resp and resp.status == 403) or "access denied" in ((await page.title()) or "").lower():
            await page.wait_for_timeout(3000)
            resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        if (resp and resp.status == 403) or "access denied" in ((await page.title()) or "").lower():
            raise F.Blocked("access denied")
        await page.wait_for_timeout(2500)
        final = page.url
    finally:
        await ctx.close()
    return {"final": final, "gone": not F.same_page(final, url), "seconds": round(time.time() - t0, 1)}


async def capture_direct(browser, url: str, out: Path, scale: float = 0.5, quality: int = 80) -> dict:
    t0 = time.time()
    ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=scale, user_agent=F.UA, locale="en-US",
                                    extra_http_headers=_ctx_headers())
    try:
        await ctx.add_init_script(f"({F.STEALTH})()")
        page = await ctx.new_page()
        css_bad = []

        async def route(r):
            if any(k in r.request.url.lower() for k in F.BLOCKED_REQUESTS):
                return await r.abort()
            if r.request.resource_type == "document" and r.request.frame == page.main_frame:
                return await r.continue_(headers={**r.request.headers, **F.HEADERS})
            return await r.continue_()

        await page.route("**/*", route)
        page.on("requestfailed", lambda q: css_bad.append(q.url) if q.resource_type == "stylesheet" and "lg.com" in q.url else None)
        page.on("response", lambda q: css_bad.append(q.url) if q.request.resource_type == "stylesheet" and "lg.com" in q.url and q.status >= 400 else None)
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        if (resp and resp.status == 403) or "access denied" in ((await page.title()) or "").lower():
            await page.wait_for_timeout(3000)
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            await page.wait_for_selector("footer", timeout=8000)
        except Exception:
            pass
        try:
            await page.click("#onetrust-accept-btn-handler", timeout=1500)
        except Exception:
            pass
        # 없어진 제품은 문서를 받은 뒤 스크립트로 홈에 보내기도 한다 → 넘어가는 중이면 「Execution context was destroyed」.
        # 넘어가기가 끝날 때까지 기다렸다가 다시 읽는다 (그 다음에 주소로 없어진 페이지인지 본다)
        for _ in range(4):
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=10000)
                title = ((await page.title()) or "").lower()
                await page.evaluate("1")
                break
            except Exception:
                await page.wait_for_timeout(1500)
        else:
            title = ""
        final = page.url
        if "access denied" not in title and not F.same_page(final, url):
            raise F.Gone(F.gone_message(final))
        if "access denied" in title or await page.evaluate("document.body.scrollHeight") < 1500:
            raise F.Blocked(title)
        if css_bad:
            raise F.Blocked(f"stylesheet blocked: {css_bad[0][:100]}")
        prev = 0
        for _ in range(2):
            await page.evaluate(F._SCROLL)
            await page.wait_for_timeout(1000)
            h = await page.evaluate("document.body.scrollHeight")
            if h == prev:
                break
            prev = h
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(1200)
        out.parent.mkdir(parents=True, exist_ok=True)
        # 위치는 찍은 뒤에 기록한다 — 찍기 전에 적으면 그 뒤에 늦게 뜬 이미지가 아래 내용을 밀어 캡처와 어긋난다 (2026-11-25 MS4295DIS)
        await F.stitch_shot_async(page, out, scale, quality)   # 한 화면씩 찍어 붙임 (full_page 는 찍는 동안 배치가 바뀐다 — 2026-11-25 SG 27G550B-B)
        try:
            boxes = await page.evaluate(F._JS_BOXES)
            doc_h = await page.evaluate("document.documentElement.scrollHeight")
            try:
                comps = await page.evaluate(F._JS_COMPS)
            except Exception:   # noqa: BLE001
                comps = None
            Path(str(out) + ".boxes.json").write_text(json.dumps({"scale": scale, "doc_h": doc_h, "after": True, "method": "stitch", "v": 2, "items": boxes, "comps": comps}), encoding="utf-8")
        except Exception as e:   # 위치 기록은 덤
            print(f"boxes: {e}", file=sys.stderr)
    finally:
        await ctx.close()
    from PIL import Image
    with Image.open(out) as im:
        w, h = im.size
    return {"width": w, "height": h, "bytes": out.stat().st_size, "seconds": round(time.time() - t0, 1), "via": "direct", "final": final}


async def capture_or_gone(browser, url: str, out: Path) -> dict:
    """찍는 도중 페이지가 스크립트로 홈에 넘어가면(없어진 제품) 「Execution context was destroyed」 같은 오류가 난다 —
    그때는 주소만 다시 보고, 다른 주소면 없어진 페이지로 (5분 뒤 다시 찍지 않게)."""
    try:
        return await capture_direct(browser, url, out)
    except (F.Gone, F.Blocked):
        raise
    except Exception as e:   # noqa: BLE001
        if "context was destroyed" in str(e) or "navigation" in str(e).lower():
            try:
                c = await check(browser, url)
            except Exception:
                raise e
            if c.get("gone"):
                raise F.Gone(F.gone_message(c["final"]))
        raise


async def run_job(get_browser, job: dict) -> dict:
    url = job["url"]
    if job.get("op") == "check":
        return await check(await get_browser(), url)
    out, via = Path(job["out"]), job.get("via") or ""
    if via != "firecrawl":
        try:
            return await capture_or_gone(await get_browser(), url, out)
        except F.Blocked as e:
            if via == "direct":
                raise RuntimeError(f"lg.com 이 막음 (직접 캡처만): {e}")
    return await asyncio.to_thread(F.capture_firecrawl, url, out, 960, 80)


async def main():
    from playwright.async_api import async_playwright
    sem = asyncio.Semaphore(CONC)
    lock = asyncio.Lock()
    st = {"b": None, "n": 0, "active": 0}
    async with async_playwright() as p:
        async def get_browser():
            async with lock:
                b = st["b"]
                # 오래 썼으면 새 브라우저로 — 돌고 있는 탭은 예전 브라우저에서 마저 끝낸다 (닫지 않고 둠 → 다음에 정리)
                if b is None or not b.is_connected() or (st["n"] >= RECYCLE_AFTER and st["active"] <= 1):
                    if b is not None and b.is_connected() and st["active"] <= 1:
                        try:
                            await b.close()
                        except Exception:
                            pass
                    st["b"], st["n"] = await _launch(p), 0
                st["n"] += 1
                return st["b"]

        async def handle(job):
            async with sem:
                st["active"] += 1
                try:
                    res = await asyncio.wait_for(run_job(get_browser, job), JOB_TIMEOUT)
                    out = {"id": job.get("id"), **res}
                except F.Gone as e:
                    out = {"id": job.get("id"), "error": str(e)[:300], "gone": True}
                except asyncio.TimeoutError:
                    out = {"id": job.get("id"), "error": f"timeout {JOB_TIMEOUT}s"}
                except Exception as e:   # noqa: BLE001
                    out = {"id": job.get("id"), "error": str(e)[:300]}
                finally:
                    st["active"] -= 1
                sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
                sys.stdout.flush()

        loop = asyncio.get_running_loop()
        tasks = set()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            try:
                job = json.loads(line)
            except Exception:
                continue
            t = asyncio.create_task(handle(job))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if st["b"] is not None:
            try:
                await st["b"].close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
