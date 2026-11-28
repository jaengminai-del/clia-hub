"""벌크 Check 전체 그리드 (2026-11-28, bulk/bulk-check.js grid) — Chromium 에서 화면 · 동작 확인.

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
        total = PASSED + 4
        expect(page.locator(".gd-it")).to_have_count(total)
        # 다 끝나면: 큰 숫자 준비됨 · 검토 필요 (재시도 중인 것은 아직 검토 필요 쪽)
        expect(page.locator("#gdA")).to_have_text(str(PASSED), timeout=10000)
        expect(page.locator("#gdB")).to_have_text("4")
        expect(page.locator(".gd-ok")).to_have_count(PASSED)
        expect(page.locator(".gd-ok .gd-bdg")).to_have_count(PASSED)
        bad_img = page.locator('.gd-it[data-row="100"]')
        expect(bad_img).to_have_class("gd-it gd-bad")
        expect(bad_img.locator(".gd-mk")).to_have_count(1)
        expect(page.locator('.gd-it[data-row="101"]')).to_have_class("gd-it gd-bad")
        expect(page.locator('.gd-it[data-row="101"] .gd-mk')).to_have_count(0)
        expect(page.locator('.gd-it[data-row="102"] .gd-pdp')).to_have_class("gd-pdp none")
        expect(page.locator('.gd-it[data-row="103"]')).to_have_class("gd-it gd-busy")
        # 문제 자리가 보이게 PDP 를 내려 둠 · 빨간 칸이 썸네일 안에 보인다
        expect(bad_img.locator(".gd-mv")).to_have_attribute("style", re.compile(r"translateY\(-\d+px\)"))
        bad_img.scroll_into_view_if_needed()
        mk, pdp = bad_img.locator(".gd-mk").bounding_box(), bad_img.locator(".gd-pdp").bounding_box()
        self.assertGreaterEqual(mk["y"], pdp["y"] - 1)
        self.assertLessEqual(mk["y"] + mk["height"], pdp["y"] + pdp["height"] + 1)
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
        self.assertLessEqual(page.evaluate("(() => { const l = document.getElementById('gdList'); return l.scrollWidth - l.clientWidth; })()"), 0)

        go, only = page.locator("#gdGo"), page.locator("#gdOnly")
        expect(go).to_be_disabled()
        expect(only).to_be_enabled()
        spot = go.bounding_box()

        def check_buttons(*ids):
            for sel in ids:
                b = page.locator(sel).bounding_box()
                self.assertGreaterEqual(b["x"], 0, sel)
                self.assertLessEqual(b["x"] + b["width"], width + 0.5, sel)
                self.assertGreaterEqual(b["y"], 0, sel)
                self.assertLessEqual(b["y"] + b["height"], height, sel)

        check_buttons("#gdOnly", "#gdGo")
        # 검토 필요만: 통과한 칸은 접히고, 검토 필요만 크게 (칸 아래 버튼 셋)
        only.click()
        expect(only).to_have_attribute("aria-pressed", "true")
        expect(page.locator(".gd-ok.gd-hide")).to_have_count(PASSED)
        expect(page.locator(".gd-it:not(.gd-hide)")).to_have_count(4)
        expect(bad_img.locator('.gd-ra [data-a="ok"]')).to_be_visible()
        expect(page.locator('.gd-it[data-row="101"] .gd-ra [data-a="ok"]')).to_be_enabled()
        expect(page.locator('.gd-it[data-row="102"] .gd-ra [data-a="ok"]')).to_be_disabled()
        self.assertEqual(go.bounding_box(), spot)
        check_buttons("#gdOnly", "#gdGo")
        # 칸을 누르면 자세히 보기 (비교 칸) → 돌아가기는 같은 상태로
        bad_img.locator(".gd-pdp").click()
        expect(page.locator("#dkCmp")).to_be_visible()
        expect(page.locator(".dk-on .ck-imgs img")).to_have_count(4)
        page.locator("#dkBack").click()
        expect(page.locator("#gdOnly")).to_have_attribute("aria-pressed", "true")
        expect(page.locator(".gd-it:not(.gd-hide)")).to_have_count(4)
        # 재시도 중이던 것이 통과 → 준비됨으로 (검토 필요만에서는 빠진다)
        expect(page.locator('.gd-it[data-row="103"]')).to_have_class("gd-it gd-ok gd-hide", timeout=15000)
        expect(page.locator("#gdA")).to_have_text(str(PASSED + 1))
        expect(page.locator("#gdB")).to_have_text("3")
        # 하나씩 정하기: 포함(검토한 해시 · 내용 요약을 같이) · 빼기 · 다시 준비(→ 통과)
        bad_img = page.locator('.gd-it[data-row="100"]')
        bad_img.locator('.gd-ra [data-a="ok"]').click()
        expect(bad_img).to_have_class("gd-it gd-in")
        expect(bad_img.locator(".gd-chip")).to_be_visible()
        self.assertEqual(job.posts[-1], {"rows": [100], "action": "ok", "by": "", "override": True,
                                         "reviewed": {"100": {"hash": "hI", "contentDigest": "dI"}}})
        page.locator('.gd-it[data-row="101"] .gd-ra [data-a="remove"]').click()
        expect(page.locator('.gd-it[data-row="101"]')).to_have_class("gd-it gd-out")
        self.assertEqual(job.posts[-1], {"rows": [101], "action": "remove", "by": "", "override": False})
        page.locator('.gd-it[data-row="102"] .gd-ra [data-a="retry"]').click()
        self.assertEqual(job.posts[-1]["action"], "retry")
        expect(page.locator('.gd-it[data-row="102"]')).to_have_class("gd-it gd-ok gd-hide", timeout=15000)
        expect(page.locator("#gdB")).to_have_text("0")
        expect(go).to_be_enabled()
        self.assertEqual(go.bounding_box(), spot)
        check_buttons("#gdOnly", "#gdGo")
        # 확인하고 받기 → 같은 자리 버튼이 '엑셀 받기'로, 시트가 채워지고 받기
        with page.expect_download() as download:
            go.click()
        self.assertTrue(download.value.url.endswith(f"/api/v1/bulk/jobs/{JOB_ID}/file"))
        expect(page.locator("#ckDl")).to_be_visible()
        dl = page.locator("#ckDl").bounding_box()
        self.assertAlmostEqual(dl["y"], spot["y"], delta=1)
        if width > 1179:
            self.assertAlmostEqual(end_edge(dl, rtl), end_edge(spot, rtl), delta=1)
        check_buttons("#ckDl")
        last = job.posts[-1]
        self.assertEqual(last["action"], "ok")
        self.assertEqual(sorted(last["rows"]), sorted([10 + k for k in range(PASSED)] + [102, 103]))
        self.assertEqual(set(last["reviewed"]), {str(r) for r in last["rows"]})
        expect(page.locator(".xs-row.xs-on")).not_to_have_count(0)
        expect(page.locator("#dkLine")).to_contain_text(str(PASSED + 3))
        self.assertEqual(errors, [])
        page.close()

    def test_grid_flow_counts_marks_filter_actions_and_fixed_buttons(self):
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
