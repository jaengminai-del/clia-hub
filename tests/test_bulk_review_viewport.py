"""Run Chromium layout checks. Set CLIA_REVIEW_EVIDENCE to record before/after fixtures."""
import contextlib
import functools
import http.server
import os
from pathlib import Path
import subprocess
import threading
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = os.environ.get("CLIA_REVIEW_EVIDENCE")
VIEWPORTS = [(1366, 768, "en"), (700, 450, "en"), (620, 450, "en"), (360, 340, "ar")]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@contextlib.contextmanager
def serve():
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()


def open_review(page, origin, lang, before=False, blocked=False):
    job = {
        "channel": "lazada", "status": "ready", "id": "0000000000001234", "check": {},
        "items": [{
            "row": 2, "model": "CLIA TEST PDP", "status": "ok", "imgs": [origin + "/fixture/export.svg"],
            "reviewImgs": [origin + "/fixture/preview.svg"],
            "ai": [{"k": "txt", "ok": False, "issues": [{"lines": [f"Evidence line {i}" for i in range(30)],
                   "regions": [{"slice": 1, "y": 0.05, "h": 0.1}]}]},
                   {"k": "spec", "ok": False, "issues": [{"lines": ["Source spec evidence"], "regions": []}]}],
        }],
    }
    if blocked:
        job["channel"] = "shopee"
        item = job["items"][0]
        item["unified"] = True
        item["imgs"] += [origin + f"/fixture/export.svg?slice={i}" for i in range(2, 13)]
        item["ai"] = [{"k": "n12", "ok": False, "blocked": True, "used": 12, "all": 13},
                      {"k": "spec", "ok": False, "blocked": True, "issues": [{"lines": ["Screen width: 42 cm"], "regions": []}]}]
    page.route("**/api/v1/bulk/jobs/**", lambda route: route.fulfill(json=job))
    page.route("**/fixture/*.svg*", lambda route: route.fulfill(
        content_type="image/svg+xml",
        body='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1040">'
             '<rect width="400" height="1040" fill="#eef1f3"/>'
             '<text x="32" y="112" font-size="34">PDP fixture</text>'
             '<rect x="26" y="192" width="348" height="157" fill="#bdd1dd"/></svg>',
    ))
    page.route("**/*", lambda route: route.fallback() if route.request.url.startswith(origin) else route.abort())
    if before:
        for name, pattern, kind in [("index.html", "**/bulk/?*", "text/html"), ("bulk-check.js", "**/bulk/bulk-check.js", "text/javascript")]:
            content = subprocess.check_output(["git", "show", f"9ce27fd:bulk/{name}"], cwd=ROOT)
            page.route(pattern, lambda route, *, content=content, kind=kind: route.fulfill(body=content, content_type=kind))
    page.goto(f"{origin}/bulk/?check=1&lang={lang}&job=0000000000001234")
    expect(page.locator("#dkCmp")).to_be_visible()


class ReviewViewportTest(unittest.TestCase):
    def test_evidence_and_next_reachable_with_fixed_actions(self):
        evidence = Path(EVIDENCE) if EVIDENCE else None
        with serve() as origin, sync_playwright() as p:
            options = {"headless": True}
            if os.environ.get("CLIA_CHROMIUM"):
                options["executable_path"] = os.environ["CLIA_CHROMIUM"]
            browser = p.chromium.launch(**options)
            for width, height, lang in VIEWPORTS:
                with self.subTest(width=width, height=height, lang=lang):
                    size = {"width": width, "height": height}
                    context = browser.new_context(viewport=size, reduced_motion="reduce",
                                                  **({"record_video_dir": str(evidence / "raw")} if evidence and lang == "ar" else {}))
                    if evidence:
                        before = context.new_page()
                        open_review(before, origin, lang, before=True)
                        original_toolbar = before.locator(".dk-bar").bounding_box()
                        before.screenshot(path=evidence / f"v2-before-{width}x{height}-{lang}.png")
                        before_video = before.video
                        if before_video:
                            before.wait_for_timeout(4000)
                        before.close()
                        if before_video:
                            before_video.save_as(evidence / "review-ar-before.webm")
                    page = context.new_page()
                    open_review(page, origin, lang)
                    expect(page.locator(".dk-on .ck-imgs img")).to_have_attribute("src", origin + "/fixture/export.svg")
                    expect(page.locator("html")).to_have_attribute("dir", "rtl" if lang == "ar" else "ltr")
                    frame = page.locator("#dk").bounding_box()
                    if height == 340:
                        self.assertLessEqual(frame["height"], 368)
                    toolbar = page.locator(".dk-bar").bounding_box()
                    if evidence and width == 1366:
                        self.assertEqual(toolbar, original_toolbar)
                    for action in page.locator(".dk-bar .dk-act").all():
                        bounds = action.bounding_box()
                        self.assertGreaterEqual(bounds["x"], 0)
                        self.assertLessEqual(bounds["x"] + bounds["width"], width)
                        expect(action).to_be_enabled()
                    body = page.locator(".dk-cmp-b")
                    if page.video:
                        page.wait_for_timeout(2400)
                    body.scroll_into_view_if_needed()
                    if height == 340 and evidence:
                        page.screenshot(path=evidence / "v2-after-360x340-ar-evidence.png")
                    self.assertTrue(body.evaluate("el => el.scrollHeight > el.clientHeight"))
                    body.evaluate("el => { el.scrollTop = el.scrollHeight; }")
                    self.assertGreater(body.evaluate("el => el.scrollTop"), 0)
                    next_button = page.locator(".dk-cnav button")
                    next_button.scroll_into_view_if_needed()
                    self.assertLessEqual(next_button.bounding_box()["y"] + next_button.bounding_box()["height"], height)
                    if evidence:
                        page.screenshot(path=evidence / f"v2-after-{width}x{height}-{lang}.png")
                    if page.video:
                        page.wait_for_timeout(3000)
                    next_button.click()
                    expect(page.locator(".dk-cmp-b")).to_have_text("Source spec evidence")
                    expect(next_button).to_be_focused()
                    self.assertEqual(toolbar, page.locator(".dk-bar").bounding_box())
                    self.assertLess(toolbar["y"] + toolbar["height"], height)
                    video = page.video
                    if video:
                        page.wait_for_timeout(3500)
                    page.close()
                    if video:
                        video.save_as(evidence / "review-ar.webm")
                    context.close()
            browser.close()

    def test_truncated_export_cannot_be_included_from_viewer(self):
        evidence = Path(EVIDENCE) if EVIDENCE else None
        with serve() as origin, sync_playwright() as p:
            options = {"headless": True}
            if os.environ.get("CLIA_CHROMIUM"):
                options["executable_path"] = os.environ["CLIA_CHROMIUM"]
            browser = p.chromium.launch(**options)
            page = browser.new_page(viewport={"width": 1366, "height": 768}, reduced_motion="reduce")
            open_review(page, origin, "en", blocked=True)
            expect(page.locator(".dk-on .ck-imgs img")).to_have_count(12)
            expect(page.locator(".dk-on .ck-imgs img").first).to_have_attribute("src", origin + "/fixture/export.svg")
            expect(page.locator(".dk-cmp-h")).to_have_text("Shopee limits cut off part of the Excel PDP")
            expect(page.locator('[data-a="ok"]')).to_be_disabled()
            expect(page.locator('[data-a="remove"]')).to_be_enabled()
            if evidence:
                page.screenshot(path=evidence / "v2.2-export-limit-blocked.png")
            page.locator(".dk-cnav button").click()
            expect(page.locator(".dk-cmp-b")).to_have_text("Screen width: 42 cm")
            expect(page.locator(".dk-cmp-location")).to_have_text("Location in PDP unknown")
            expect(page.locator(".dk-on .dk-bad")).to_have_count(0)
            expect(page.locator('[data-a="ok"]')).to_be_disabled()
            if evidence:
                page.screenshot(path=evidence / "v2.2-spec-outside-excel.png")
            browser.close()

    def test_stale_approval_refreshes_visible_pdp_without_resubmitting(self):
        evidence = Path(EVIDENCE) if EVIDENCE else None
        guidance = {
            "en": "The PDP changed. Review the updated version before confirming.",
            "th": "PDP มีการเปลี่ยนแปลง โปรดตรวจสอบฉบับล่าสุดก่อนยืนยัน",
            "ko": "PDP가 바뀌었어요. 최신 내용을 다시 보고 확인해 주세요.",
            "de": "Die PDP wurde geändert. Bitte prüfen Sie die aktuelle Version vor der Bestätigung.",
            "ar": "تغيّرت صفحة تفاصيل المنتج. راجع النسخة المحدّثة قبل التأكيد.",
        }
        with serve() as origin, sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=os.environ.get("CLIA_CHROMIUM"))
            for lang, message in guidance.items():
                with self.subTest(lang=lang):
                    context = browser.new_context(viewport={"width": 1366, "height": 768}, reduced_motion="reduce",
                                                  **({"record_video_dir": str(evidence / "raw")} if evidence and lang == "ko" else {}))
                    page = context.new_page()
                    submissions = []
                    def handle(route):
                        if route.request.method == "POST":
                            submissions.append(route.request.post_data_json["reviewed"]["2"])
                            route.fulfill(status=409, json={"error": "changed", "code": "review_changed"})
                            return
                        rev = len(submissions)
                        route.fulfill(json={"channel": "lazada", "status": "ready", "id": "0000000000001234", "check": {},
                            "items": [{"row": 2, "model": "CLIA TEST PDP", "status": "ok", "hash": f"H{rev}",
                                       "contentDigest": f"D{rev}", "imgs": [origin + f"/fixture/export.svg?v={rev}"],
                                       "ai": [{"k": "txt", "ok": False, "issues": [{"lines": [f"Evidence {rev}"], "regions": []}]}]}]})
                    open_review(page, origin, lang)
                    page.route("**/api/v1/bulk/jobs/**", handle)
                    page.reload()
                    expect(page.locator(".dk-cmp-b")).to_have_text("Evidence 0")
                    if evidence and lang == "ko":
                        page.screenshot(path=evidence / "v2.4-stale-before-ko.png")
                        page.wait_for_timeout(900)
                    page.locator('[data-a="ok"]').click()
                    expect(page.locator("#ckGo")).to_have_text(message)
                    expect(page.locator(".dk-cmp-b")).to_have_text("Evidence 1")
                    expect(page.locator(".dk-on .ck-imgs img")).to_have_attribute("src", origin + "/fixture/export.svg?v=1")
                    assert submissions == [{"hash": "H0", "contentDigest": "D0"}]
                    if evidence and lang == "ko":
                        page.screenshot(path=evidence / "v2.4-stale-after-ko.png")
                        page.wait_for_timeout(2000)
                    video = page.video
                    page.close()
                    if video:
                        video.save_as(evidence / "review-stale-ko.webm")
                    context.close()
            browser.close()
