"""벌크 Check 전체 그리드 (2026-11-28, bulk/bulk-check.js grid) — Chromium 에서 화면 · 동작 확인.

스캔은 그리드로, 끝나면 검토 필요는 하나씩(검수 화면 'review') — 목록으로 늘어놓지 않는다.

작업 API(/api/v1/bulk/jobs/**)는 page.route 로 흉내 낸다: 처음엔 진행 중(반은 아직) → 다 끝남,
자동 재시도 중인 한 제품은 끝난 뒤 몇 번 더 물으면 통과로 바뀐다. 운영 · 승인 기록은 건드리지 않는다.
"""
import contextlib
import copy
import functools
import http.server
import os
import re
from pathlib import Path
import threading
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JOB_ID = "0000000000005678"
VIEWPORTS = [(1366, 768, "en"), (700, 450, "en"), (360, 340, "ar")]
PASSED = 9
SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1040">'
       '<rect width="400" height="1040" fill="#eef1f3"/><text x="32" y="112" font-size="34">PDP</text>'
       '<rect x="26" y="192" width="348" height="157" fill="#bdd1dd"/></svg>')


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


OK_AI = [{"k": "img", "ok": True, "n": 0}, {"k": "txt", "ok": True}, {"k": "spec", "ok": True}]


class FakeJob:
    """GET 할 때마다 한 걸음: 1번째 = 진행 중(뒤 절반은 대기), 2번째부터 다 끝남. 재시도 중인 것은 끝난 뒤 3번 더 물으면 통과."""

    def __init__(self, origin):
        self.img = img = lambda k, n=4: [f"{origin}/fixture/p{k}.svg?s={i}" for i in range(1, n + 1)]
        items = [{"row": 10 + k, "slug": f"p-{k}", "model": f"MODEL-{k:02d}", "status": "ok", "imgs": img(k),
                  "hash": f"h{k}", "contentDigest": f"d{k}", "ai": copy.deepcopy(OK_AI)} for k in range(PASSED)]
        items.insert(2, {"row": 100, "slug": "bad-img", "model": "BAD-IMG", "status": "ok", "imgs": img(100),
                         "hash": "hI", "contentDigest": "dI",
                         "ai": [{"k": "img", "ok": False, "n": 1, "bad": 1, "lg": 0,
                                 "at": [{"src": "https://www.lg.com/x.jpg", "regions": [{"slice": 2, "y": 0.5, "h": 0.1}]}]},
                                {"k": "txt", "ok": True}, {"k": "spec", "ok": True}]})
        items.insert(5, {"row": 101, "slug": "bad-spec", "model": "BAD-SPEC", "status": "ok", "imgs": img(101),
                         "hash": "hS", "contentDigest": "dS",
                         "ai": [{"k": "img", "ok": True, "n": 0}, {"k": "spec", "ok": False, "issues": [{"lines": ["Screen width: 42 cm"], "regions": []}]}]})
        items.insert(7, {"row": 102, "slug": "bad-fail", "model": "BAD-FAIL", "status": "failed", "error": "generate returned no HTML", "imgs": []})
        items.append({"row": 103, "slug": "retry", "model": "RETRY-OK", "status": "ok", "retrying": 1, "imgs": img(103),
                      "hash": "hR", "contentDigest": "dR",
                      "ai": [{"k": "txt", "ok": False, "issues": [{"lines": ["Line"], "regions": [{"slice": 1, "y": 0.2, "h": 0.1}]}]}]})
        self.items = items
        self.gets = 0
        self.ready_gets = 0
        self.posts = []

    def view(self):
        self.gets += 1
        status = "running" if self.gets == 1 else "ready"
        if status == "ready":
            self.ready_gets += 1
        items = []
        for k, it in enumerate(self.items):
            it = dict(it)
            if status == "running" and k >= len(self.items) // 2:
                it.update(status="queued", imgs=[], ai=[])
            if it.get("retrying") and self.ready_gets > 3:
                it.pop("retrying")
                it["ai"] = copy.deepcopy(OK_AI)
                self.items[k] = it
            if "_redo" in it:   # 다시 준비: 두 번 더 물으면 통과
                self.items[k]["_redo"] -= 1
                if self.items[k]["_redo"] < 0:
                    self.items[k].pop("_redo")
                    self.items[k].update(status="ok", imgs=self.img(it["row"]), ai=copy.deepcopy(OK_AI))
                it = dict(self.items[k])
            items.append({key: v for key, v in it.items() if not key.startswith("_")})
        check = {"confirmed": sum(x.get("check") == "ok" for x in self.items),
                 "removed": sum(x.get("check") == "removed" for x in self.items), "skipModels": 2}
        return {"id": JOB_ID, "channel": "shopee", "status": status, "items": items, "check": check,
                "file": f"/api/v1/bulk/jobs/{JOB_ID}/file" if status == "ready" else None}

    def handle(self, route):
        req = route.request
        if req.method == "POST":
            body = req.post_data_json
            self.posts.append(body)
            for it in self.items:
                if it["row"] in body["rows"]:
                    if body["action"] == "ok":
                        it["check"] = "ok"
                    elif body["action"] == "remove":
                        it["check"] = "removed"
                    else:
                        it.update(status="working", _redo=1)
        route.fulfill(json=self.view())


def end_edge(box, rtl):
    return box["x"] if rtl else box["x"] + box["width"]


class BulkCheckGridTest(unittest.TestCase):
    def run_flow(self, browser, origin, width, height, lang):
        rtl = lang == "ar"
        page = browser.new_page(viewport={"width": width, "height": height}, reduced_motion="reduce")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        job = FakeJob(origin)
        page.route("**/api/v1/bulk/jobs/**", job.handle)
        page.route("**/fixture/*.svg*", lambda route: route.fulfill(content_type="image/svg+xml", body=SVG))
        page.route("**/*", lambda route: route.fallback() if route.request.url.startswith(origin) else route.abort())
        page.goto(f"{origin}/bulk/?check=1&lang={lang}&job={JOB_ID}")
        expect(page.locator("html")).to_have_attribute("dir", "rtl" if rtl else "ltr")

        def inside(*sels):
            for sel in sels:
                for loc in page.locator(sel).all():
                    b = loc.bounding_box()
                    self.assertGreaterEqual(b["x"], 0, sel)
                    self.assertLessEqual(b["x"] + b["width"], width + 0.5, sel)
                    self.assertGreaterEqual(b["y"], 0, sel)
                    self.assertLessEqual(b["y"] + b["height"], height, sel)

        # 1) 스캔이 끝나면 저절로 검토 필요 하나씩 — 가운데 큰 카드 · 비교 칸 · 위 고정 버튼 셋 · 돌아가기
        expect(page.locator("#dkCmp")).to_be_visible(timeout=10000)
        expect(page.locator("#dkCap b")).to_have_text("BAD-IMG")
        expect(page.locator("#dkNn")).to_have_text(" / 4")
        expect(page.locator(".gd-it")).to_have_count(0)
        expect(page.locator("#dkBack")).to_be_visible()
        card = page.locator(".dk-cc.dk-on .dk-ph").bounding_box()
        if width > 700:
            self.assertAlmostEqual(card["x"] + card["width"] / 2, width / 2, delta=2)
        inside(".dk-bar .dk-act", "#dkBack")
        bar = page.locator(".dk-bar").bounding_box()
        # 2) 돌아가기 → 그리드 (같은 결과: 큰 숫자 · ✓ · 빨간 테두리 · 문제 자리 빨간 칸)
        page.locator("#dkBack").click()
        expect(page.locator(".gd-it")).to_have_count(PASSED + 4)
        expect(page.locator("#gdA")).to_have_text(str(PASSED))
        expect(page.locator("#gdB")).to_have_text("4")
        expect(page.locator(".gd-ok .gd-bdg")).to_have_count(PASSED)
        bad_img = page.locator('.gd-it[data-row="100"]')
        expect(bad_img).to_have_class("gd-it gd-bad")
        expect(bad_img.locator(".gd-mk")).to_have_count(1)
        expect(bad_img.locator(".gd-mv")).to_have_attribute("style", re.compile(r"translateY\(-\d+px\)"))
        bad_img.scroll_into_view_if_needed()
        mk, pdp = bad_img.locator(".gd-mk").bounding_box(), bad_img.locator(".gd-pdp").bounding_box()
        self.assertGreaterEqual(mk["y"], pdp["y"] - 1)
        self.assertLessEqual(mk["y"] + mk["height"], pdp["y"] + pdp["height"] + 1)
        expect(page.locator('.gd-it[data-row="101"]')).to_have_class("gd-it gd-bad")
        expect(page.locator('.gd-it[data-row="102"] .gd-pdp')).to_have_class("gd-pdp none")
        expect(page.locator('.gd-it[data-row="103"]')).to_have_class("gd-it gd-busy")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
        self.assertLessEqual(page.evaluate("(() => { const l = document.getElementById('gdList'); return l.scrollWidth - l.clientWidth; })()"), 0)
        rev, go = page.locator("#gdRev"), page.locator("#gdGo")
        expect(rev).to_be_enabled()
        expect(go).to_be_disabled()
        inside("#gdRev", "#gdGo")
        spot = go.bounding_box()
        # 칸을 누르면 그 제품의 자세히 보기 → 돌아가기는 그리드로 (다시 저절로 검토로 가지 않음)
        page.locator('.gd-it[data-row="10"] .gd-pdp').click()
        expect(page.locator(".dk-on .ck-imgs img")).to_have_count(4)
        page.locator("#dkBack").click()
        expect(page.locator(".gd-it")).to_have_count(PASSED + 4)
        # 자동 재시도 중이던 것이 통과 → 준비됨으로 (검토할 수도 줄어듦)
        expect(page.locator('.gd-it[data-row="103"]')).to_have_class("gd-it gd-ok", timeout=15000)
        expect(page.locator("#gdA")).to_have_text(str(PASSED + 1))
        expect(page.locator("#gdB")).to_have_text("3")
        now = go.bounding_box()
        self.assertEqual(now["y"], spot["y"])
        self.assertAlmostEqual(now["x"], spot["x"], delta=1)
        page.wait_for_timeout(600)
        self.assertEqual(page.locator('.gd-it[data-row="103"]').get_attribute("class"), "gd-it gd-ok")
        # 3) '검토 N' → 하나씩: 포함(검토한 해시 · 내용 요약을 같이) · 빼기 · 다시 준비 — 정하면 다음으로
        rev.click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-IMG")
        self.assertEqual(page.locator(".dk-bar").bounding_box(), bar)
        page.locator('.dk-bar [data-a="ok"]').click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-SPEC")
        self.assertEqual(job.posts[-1], {"rows": [100], "action": "ok", "by": "", "override": True,
                                         "reviewed": {"100": {"hash": "hI", "contentDigest": "dI"}}})
        self.assertEqual(page.locator(".dk-bar").bounding_box(), bar)
        page.locator('.dk-bar [data-a="remove"]').click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-FAIL")
        self.assertEqual(job.posts[-1], {"rows": [101], "action": "remove", "by": "", "override": False})
        expect(page.locator('.dk-bar [data-a="ok"]')).to_be_disabled()
        page.locator('.dk-bar [data-a="retry"]').click()
        self.assertEqual(job.posts[-1]["action"], "retry")
        self.assertEqual(job.posts[-1]["rows"], [102])
        # 4) 다 정하면(다시 준비가 통과로 끝나면) 끝 화면 → 확인하고 받기 → 같은 자리에 엑셀 받기
        confirm = page.locator("#ckAll")
        expect(confirm).to_be_visible(timeout=15000)
        inside("#ckAll", "#ckView")
        self.assertAlmostEqual(confirm.bounding_box()["y"], spot["y"], delta=1)
        if width > 1179:
            self.assertAlmostEqual(end_edge(confirm.bounding_box(), rtl), end_edge(spot, rtl), delta=1)
        with page.expect_download() as download:
            confirm.click()
        self.assertTrue(download.value.url.endswith(f"/api/v1/bulk/jobs/{JOB_ID}/file"))
        dl = page.locator("#ckDl")
        expect(dl).to_be_visible()
        self.assertAlmostEqual(dl.bounding_box()["y"], spot["y"], delta=1)
        if width > 1179:
            self.assertAlmostEqual(end_edge(dl.bounding_box(), rtl), end_edge(spot, rtl), delta=1)
        inside("#ckDl")
        last = job.posts[-1]
        self.assertEqual(last["action"], "ok")
        self.assertEqual(sorted(last["rows"]), sorted([10 + k for k in range(PASSED)] + [102, 103]))
        self.assertEqual(set(last["reviewed"]), {str(r) for r in last["rows"]})
        expect(page.locator(".xs-row.xs-on")).not_to_have_count(0)
        expect(page.locator("#dkLine")).to_contain_text(str(PASSED + 3))
        self.assertEqual(errors, [])
        page.close()

    def test_grid_scan_then_one_by_one_review_and_download(self):
        with serve() as origin, sync_playwright() as p:
            options = {"headless": True}
            if os.environ.get("CLIA_CHROMIUM"):
                options["executable_path"] = os.environ["CLIA_CHROMIUM"]
            browser = p.chromium.launch(**options)
            for width, height, lang in VIEWPORTS:
                with self.subTest(width=width, height=height, lang=lang):
                    self.run_flow(browser, origin, width, height, lang)
            browser.close()


if __name__ == "__main__":
    unittest.main()
