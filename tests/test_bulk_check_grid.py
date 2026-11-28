"""벌크 Check 전체 그리드 (2026-11-28, bulk/bulk-check.js grid) — Chromium 에서 화면 · 동작 확인.

스캔은 그리드로 → 첫 판이 끝나면 바로 결과 화면(확인이 필요한 PDP 만 · 자동 재시도 중인 것도 '다시 준비 중'으로 · '확인이 필요한 PDP N개' · 검토)
→ 재시도가 통과하면 그 칸이 빠지고 숫자가 줄어듦 → 검토 필요는 하나씩(검수 화면 'review').

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

    def __init__(self, origin, clean=False, retry_only=False, retry_states=False, retry_review=False):
        self.img = img = lambda k, n=4: [f"{origin}/fixture/p{k}.svg?s={i}" for i in range(1, n + 1)]
        items = [{"row": 10 + k, "slug": f"p-{k}", "model": f"MODEL-{k:02d}", "status": "ok", "imgs": img(k),
                  "hash": f"h{k}", "contentDigest": f"d{k}", "ai": copy.deepcopy(OK_AI)} for k in range(PASSED)]
        self.posts = []
        self.gets = 0
        self.ready_gets = 0
        if retry_review:   # 검토 필요 하나 + 다시 크롤 중 하나 (몇 번 더 물으면 통과)
            items.append({"row": 100, "slug": "bad-img", "model": "BAD-IMG", "status": "ok", "imgs": img(100), "hash": "hI", "contentDigest": "dI",
                          "ai": [{"k": "img", "ok": False, "n": 1, "bad": 1, "lg": 0, "at": [{"src": "https://www.lg.com/x.jpg", "regions": [{"slice": 2, "y": 0.5, "h": 0.1}]}]}]})
            items.append({"row": 103, "slug": "retry-103", "model": "RETRY-103", "status": "ok", "retrying": 1, "redo": "crawl", "imgs": img(103),
                          "hash": "h103", "contentDigest": "d103", "_passAt": 4,
                          "ai": [{"k": "img", "ok": False, "n": 3, "bad": 3, "lg": 0, "at": [{"src": "https://www.lg.com/x.jpg", "regions": [{"slice": 2, "y": 0.5, "h": 0.1}]}]}]})
            self.items = items
            return
        if retry_states:   # 자동 재시도 셋: lg.com 다시 크롤(먼저 통과) · PDP 다시 그림 · 차례 기다림 (서버 retryLater 의 redo)
            for row, redo, at in [(103, "crawl", 3), (104, "draw", 99), (105, None, 99)]:
                it = {"row": row, "slug": f"retry-{row}", "model": f"RETRY-{row}", "status": "ok", "retrying": 1, "imgs": img(row),
                      "hash": f"h{row}", "contentDigest": f"d{row}", "_passAt": at,
                      "ai": [{"k": "img", "ok": False, "n": 3, "bad": 3, "lg": 0, "at": [{"src": "https://www.lg.com/x.jpg", "regions": [{"slice": 2, "y": 0.5, "h": 0.1}]}]}]}
                if redo:
                    it["redo"] = redo
                items.append(it)
            self.items = items
            return
        if clean or retry_only:   # 검토할 것 없음 · 자동 재시도 하나뿐 (통과하면 모두 준비됨)
            if retry_only:
                items.append({"row": 103, "slug": "retry", "model": "RETRY-OK", "status": "ok", "retrying": 1, "imgs": img(103),
                              "hash": "hR", "contentDigest": "dR",
                              "ai": [{"k": "txt", "ok": False, "n": 1, "issues": [{"lines": ["Line"], "regions": [{"slice": 1, "y": 0.2, "h": 0.1}]}]}]})
            self.items = items
            return
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
                      "ai": [{"k": "txt", "ok": False, "n": 1, "issues": [{"lines": ["Line"], "regions": [{"slice": 1, "y": 0.2, "h": 0.1}]}]}]})
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
            if it.get("retrying") and self.ready_gets > it.get("_passAt", 3):   # 서버처럼 retrying · redo 가 같이 빠진다
                it.pop("retrying")
                it.pop("redo", None)
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


def open_page(browser, origin, width, height, lang, job):
    page = browser.new_page(viewport={"width": width, "height": height}, reduced_motion="reduce")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/api/v1/bulk/jobs/**", job.handle)
    page.route("**/fixture/*.svg*", lambda route: route.fulfill(content_type="image/svg+xml", body=SVG))
    page.route("**/*", lambda route: route.fallback() if route.request.url.startswith(origin) else route.abort())
    page.goto(f"{origin}/bulk/?check=1&lang={lang}&job={JOB_ID}")
    return page, errors


class BulkCheckGridTest(unittest.TestCase):
    def inside(self, page, width, height, *sels):
        for sel in sels:
            for loc in page.locator(sel).all():
                b = loc.bounding_box()
                self.assertGreaterEqual(b["x"], 0, sel)
                self.assertLessEqual(b["x"] + b["width"], width + 0.5, sel)
                self.assertGreaterEqual(b["y"], 0, sel)
                self.assertLessEqual(b["y"] + b["height"], height, sel)

    def run_flow(self, browser, origin, width, height, lang):
        rtl = lang == "ar"
        job = FakeJob(origin)
        page, errors = open_page(browser, origin, width, height, lang, job)
        expect(page.locator("html")).to_have_attribute("dir", "rtl" if rtl else "ltr")
        inside = lambda *sels: self.inside(page, width, height, *sels)
        # 1) 첫 판이 끝나면 바로 결과 화면 — 자동 재시도 중인 것도 줄에 '다시 준비 중'으로 (기다리지 않음), 숫자에 들어감
        head = page.locator("#gdRhH")
        expect(head).to_be_visible(timeout=10000)
        expect(page.locator(".gd-top")).to_be_hidden()
        shown = page.locator(".gd-it:not(.gd-hide)")
        expect(shown).to_have_count(4)
        self.assertEqual(sorted(shown.evaluate_all("ts => ts.map(t => t.dataset.row)")), ["100", "101", "102", "103"])
        retry = page.locator('.gd-it[data-row="103"]')
        expect(retry).to_have_class(re.compile(r"\bgd-busy\b.*\bgd-queue\b"))
        if lang == "en":   # 찾은 문제 · 차례 기다림 · 성공하면 확인됨
            expect(retry.locator(".gd-ov .gd-o2")).to_have_text("Waiting to retry…")   # 그림 위 가운데: 지금 하는 일 · 성공하면 확인됨
            expect(retry.locator(".gd-ov .gd-o3")).to_have_text("Checked when it succeeds")
            expect(retry.locator(".gd-st")).to_have_text("1 missing line")   # 찾은 문제는 다른 칸처럼 칸 아래
        expect(page.locator('.gd-it[data-row="100"] .gd-ov, .gd-it[data-row="100"] .gd-dim')).to_have_count(0)   # 검토 필요 칸엔 덮개 없음
        expect(head.locator("b")).to_have_text("4")
        expect(page.locator("#gdRhGo")).to_be_enabled()
        expect(page.locator(".gd-it:not(.gd-hide) .gd-ra, .gd-it:not(.gd-hide) button")).to_have_count(0)
        bad_img = page.locator('.gd-it[data-row="100"]')
        expect(bad_img).to_have_class(re.compile(r"\bgd-bad\b"))
        expect(bad_img.locator(".gd-mk")).to_have_count(1)
        expect(bad_img.locator(".gd-mv")).to_have_attribute("style", re.compile(r"translateY\(-\d+px\)"))
        mk, pdp = bad_img.locator(".gd-mk").bounding_box(), bad_img.locator(".gd-pdp").bounding_box()
        self.assertGreaterEqual(mk["y"], pdp["y"] - 1)
        self.assertLessEqual(mk["y"] + mk["height"], pdp["y"] + pdp["height"] + 1)
        expect(page.locator('.gd-it[data-row="102"] .gd-pdp')).to_have_class("gd-pdp none")
        # 실패 이유는 짧은 안내만 — 서버의 기술 오류 문구(영어)는 화면에 내지 않음
        expect(page.locator('.gd-it[data-row="102"]')).not_to_contain_text("returned no HTML")
        self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width)
        self.assertLessEqual(page.evaluate("(() => { const l = document.getElementById('gdList'); return l.scrollWidth - l.clientWidth; })()"), 0)
        # 2) 재시도가 통과하면 그 칸은 줄에서 빠지고 숫자가 줄어든다 (머리글은 검정 · 숫자와 글 같은 크기)
        expect(retry.locator(".gd-ov .gd-okl")).to_be_visible(timeout=15000)   # 잠깐 썸네일 가운데 ✓ 확인됨 → 빠짐
        expect(retry).to_have_class(re.compile(r"\bgd-ok\b.*\bgd-hide\b"), timeout=5000)
        expect(shown).to_have_count(3)
        self.assertEqual(sorted(shown.evaluate_all("ts => ts.map(t => t.dataset.row)")), ["100", "101", "102"])
        expect(head.locator("b")).to_have_text("3")
        if lang == "en":
            expect(head).to_have_text("3 PDPs need to be checked")
            expect(page.locator("#gdRhGo")).to_have_text("Review")
        if lang == "ar":
            expect(head).to_have_text("3 صفحات تفاصيل تحتاج إلى مراجعة")
            expect(page.locator("#gdRhGo")).to_have_text("مراجعة")
        style = head.evaluate("h => { const b = h.querySelector('b'), a = getComputedStyle(h), c = getComputedStyle(b); return [a.color, c.color, a.fontSize, c.fontSize, a.fontWeight, c.fontWeight]; }")
        self.assertEqual(style[0], style[1])
        self.assertEqual(style[0], "rgb(38, 38, 38)")   # 검정 (--clia-gray-900)
        self.assertEqual((style[2], style[4]), (style[3], style[5]))
        self.assertFalse(head.evaluate("h => h.scrollWidth > h.clientWidth"))   # 한 줄
        go_box, head_box = page.locator("#gdRhGo").bounding_box(), head.bounding_box()
        # 버튼 글은 큰 버튼에 맞게 (17px · 좁으면 16px, 굵게) — 버튼 크기 · 자리는 검수 화면 버튼과 같게
        self.assertEqual(page.locator("#gdRhGo").evaluate("b => [getComputedStyle(b).fontSize, getComputedStyle(b).fontWeight]"), ["16px" if width <= 420 else "17px", "700"])
        self.assertEqual((go_box["width"], go_box["height"]), (176, 46))
        self.assertAlmostEqual(go_box["x"] + go_box["width"] / 2, width / 2, delta=1)
        inside("#gdRhH", "#gdRhGo")
        page.wait_for_timeout(500)
        expect(page.locator("#dkCmp")).to_have_count(0)   # 저절로 넘어가지 않음
        # 3) 검토(Enter 도) → 장면이 바로 바뀌어 하나씩: 버튼 줄이 결과 화면 버튼과 거의 같은 자리 · 가운데 큰 카드 · 비교 칸
        if width == 700:
            page.keyboard.press("Enter")
        else:
            page.locator("#gdRhGo").click()
        expect(page.locator("#dkCmp")).to_be_visible()
        expect(page.locator("#dkCap b")).to_have_text("BAD-IMG")
        expect(page.locator("#dkNn")).to_have_text(" / 3")
        card = page.locator(".dk-cc.dk-on .dk-ph").bounding_box()
        if width > 700:
            self.assertAlmostEqual(card["x"] + card["width"] / 2, width / 2, delta=2)
        inside(".dk-bar .dk-act", "#dkBack")
        bar = page.locator(".dk-bar").bounding_box()
        mid = page.locator('.dk-bar [data-a="retry"]').bounding_box()
        self.assertAlmostEqual(mid["y"], go_box["y"], delta=3)
        self.assertAlmostEqual(mid["x"] + mid["width"] / 2, go_box["x"] + go_box["width"] / 2, delta=3)
        count = page.locator(".dk-count").bounding_box()
        self.assertAlmostEqual(count["y"] + count["height"] / 2, head_box["y"] + head_box["height"] / 2, delta=6)
        # 돌아가기 → 그리드 (결과 화면은 한 번만 — 이제 위 '검토' 버튼)
        page.locator("#dkBack").click()
        expect(page.locator(".gd-it")).to_have_count(PASSED + 4)
        expect(page.locator("#gdRev")).to_be_enabled()
        expect(page.locator("#gdGo")).to_be_disabled()
        page.wait_for_timeout(700)
        expect(page.locator("#gdRh")).to_have_count(0)
        inside("#gdRev", "#gdGo")
        spot = page.locator("#gdGo").bounding_box()
        # 칸을 누르면 자세히 보기 → 돌아가기
        page.locator('.gd-it[data-row="10"] .gd-pdp').click()
        expect(page.locator(".dk-on .ck-imgs img")).to_have_count(4)
        page.locator("#dkBack").click()
        expect(page.locator(".gd-it")).to_have_count(PASSED + 4)
        expect(page.locator("#gdRh")).to_have_count(0)
        # 4) '검토 3' → 포함(검토한 해시 · 내용 요약) · 빼기 · 다시 준비 — 정하면 다음으로
        page.locator("#gdRev").click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-IMG")
        self.assertEqual(page.locator(".dk-bar").bounding_box(), bar)
        page.locator('.dk-bar [data-a="ok"]').click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-SPEC")
        self.assertEqual(job.posts[-1], {"rows": [100], "action": "ok", "by": "", "override": True,
                                         "reviewed": {"100": {"hash": "hI", "contentDigest": "dI"}}})
        page.locator('.dk-bar [data-a="remove"]').click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-FAIL")
        self.assertEqual(job.posts[-1], {"rows": [101], "action": "remove", "by": "", "override": False})
        expect(page.locator('.dk-bar [data-a="ok"]')).to_be_disabled()
        page.locator('.dk-bar [data-a="retry"]').click()
        self.assertEqual((job.posts[-1]["action"], job.posts[-1]["rows"]), ("retry", [102]))
        # 5) 다 정하면 끝 화면 → 확인하고 받기 → 같은 자리에 엑셀 받기
        confirm = page.locator("#ckAll")
        expect(confirm).to_be_visible(timeout=15000)
        inside("#ckAll", "#ckView")
        self.assertAlmostEqual(confirm.bounding_box()["y"], spot["y"], delta=1)
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
        expect(page.locator("#dkLine")).to_contain_text(str(PASSED + 3))
        self.assertEqual(errors, [])
        page.close()

    def run_clean(self, browser, origin, width, height, lang):
        # 검토할 것이 없으면: '모두 준비됨' + 확인하고 받기 (바로 받기로)
        job = FakeJob(origin, clean=True)
        page, errors = open_page(browser, origin, width, height, lang, job)
        head = page.locator("#gdRhH")
        expect(head).to_be_visible(timeout=10000)
        expect(head.locator("b")).to_have_text(str(PASSED))
        expect(page.locator(".gd-it:not(.gd-hide)")).to_have_count(0)
        if lang == "en":
            expect(head).to_have_text(f"All {PASSED} PDPs are ready")
            expect(page.locator("#gdRhGo")).to_have_text("Confirm & download")
        self.assertEqual(head.evaluate("h => getComputedStyle(h).color"), "rgb(38, 38, 38)")
        self.inside(page, width, height, "#gdRhH", "#gdRhGo")
        go = page.locator("#gdRhGo")   # 긴 글('확인하고 받기')도 한 줄 · 큰 글
        self.assertEqual(go.evaluate("b => getComputedStyle(b).fontSize"), "16px" if width <= 420 else "17px")
        self.assertEqual(go.bounding_box()["height"], 46)
        self.assertFalse(go.evaluate("b => b.scrollWidth > b.clientWidth"))
        with page.expect_download():
            page.locator("#gdRhGo").click()
        expect(page.locator("#ckDl")).to_be_visible()
        self.assertEqual(sorted(job.posts[-1]["rows"]), [10 + k for k in range(PASSED)])
        self.assertEqual(errors, [])
        page.close()

    def run_retry_only(self, browser, origin, width, height, lang):
        # 자동 재시도 하나뿐: 결과 화면에 그것 하나('다시 준비 중') → 통과하면 줄이 비고 '모두 준비됨' + 확인하고 받기 (같은 자리)
        job = FakeJob(origin, retry_only=True)
        page, errors = open_page(browser, origin, width, height, lang, job)
        head, go = page.locator("#gdRhH"), page.locator("#gdRhGo")
        expect(head).to_be_visible(timeout=10000)
        expect(page.locator(".gd-it:not(.gd-hide)")).to_have_count(1)
        expect(page.locator('.gd-it[data-row="103"]')).to_have_class(re.compile(r"\bgd-busy\b"))
        expect(head.locator("b")).to_have_text("1")
        if lang == "en":
            expect(head).to_have_text("1 PDP needs to be checked")
        spot = go.bounding_box()
        expect(page.locator(".gd-it:not(.gd-hide)")).to_have_count(0, timeout=15000)
        expect(head.locator("b")).to_have_text(str(PASSED + 1))
        if lang == "en":
            expect(head).to_have_text(f"All {PASSED + 1} PDPs are ready")
            expect(go).to_have_text("Confirm & download")
        self.assertEqual(go.bounding_box()["y"], spot["y"])
        self.inside(page, width, height, "#gdRhH", "#gdRhGo")
        with page.expect_download():
            go.click()
        expect(page.locator("#ckDl")).to_be_visible()
        self.assertEqual(sorted(job.posts[-1]["rows"]), [10 + k for k in range(PASSED)] + [103])
        self.assertEqual(errors, [])
        page.close()

    def run_retry_states(self, browser, origin, width, height, lang, motion):
        # 자동 재시도 중인 칸: 찾은 문제 · 지금 하는 일(다시 크롤 · 다시 그림 · 기다림) · 성공하면 확인됨, 다시 크롤 · 그림이면 띠가 반복해 훑음
        job = FakeJob(origin, retry_states=True)
        page = browser.new_page(viewport={"width": width, "height": height}, reduced_motion=motion)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/api/v1/bulk/jobs/**", job.handle)
        page.route("**/fixture/*.svg*", lambda route: route.fulfill(content_type="image/svg+xml", body=SVG))
        page.route("**/*", lambda route: route.fallback() if route.request.url.startswith(origin) else route.abort())
        page.goto(f"{origin}/bulk/?check=1&lang={lang}&job={JOB_ID}")
        head = page.locator("#gdRhH")
        expect(head).to_be_visible(timeout=10000)
        expect(head.locator("b")).to_have_text("3")
        tile = lambda row: page.locator(f'.gd-it[data-row="{row}"]')
        for row, cls, line in [(103, "gd-crawl", "Re-crawling from lg.com…"), (104, "gd-draw", "Preparing the PDP again…"), (105, "gd-queue", "Waiting to retry…")]:
            expect(tile(row)).to_have_class(re.compile(rf"\bgd-busy\b.*\b{cls}\b"))
            ov = tile(row).locator(".gd-ov")
            expect(ov.locator(".gd-o1")).to_have_count(0)   # 찾은 문제는 덮개가 아니라 칸 아래
            if lang == "en":
                expect(ov.locator(".gd-o2")).to_have_text(line)
                expect(ov.locator(".gd-o3")).to_have_text("Checked when it succeeds")
                expect(tile(row).locator(".gd-st")).to_have_text("3 missing images")
            else:
                expect(ov.locator(".gd-o2")).not_to_have_text("")
                expect(tile(row).locator(".gd-st")).not_to_have_text("")
            # 썸네일을 어둡게 덮고(막 · 흐림) 글은 정가운데 · 흰 글 · 칸 아래엔 상태 줄 없음
            expect(tile(row).locator(".gd-pdp .gd-dim")).to_have_count(1)
            self.assertEqual(tile(row).locator(".gd-dim").evaluate("d => getComputedStyle(d).backgroundColor"), "rgba(38, 38, 38, 0.74)")
            self.assertIn("blur", tile(row).locator(".gd-mv").evaluate("m => getComputedStyle(m).filter"))
            self.assertEqual(ov.evaluate("o => getComputedStyle(o).color"), "rgb(255, 255, 255)")
            self.assertEqual(tile(row).locator(".gd-st").evaluate("x => getComputedStyle(x).color"), "rgb(165, 0, 52)")   # 다른 검토 필요 칸과 같은 와인색
            tile(row).scroll_into_view_if_needed()
            box, pdp = ov.locator(".gd-ovt").bounding_box(), tile(row).locator(".gd-pdp").bounding_box()
            self.assertAlmostEqual(box["x"] + box["width"] / 2, pdp["x"] + pdp["width"] / 2, delta=3)
            self.assertAlmostEqual(box["y"] + box["height"] / 2, pdp["y"] + pdp["height"] / 2, delta=3)
            self.assertLessEqual(box["height"], pdp["height"])
            self.assertFalse(ov.locator(".gd-o2").evaluate("x => x.scrollWidth > x.clientWidth"))   # 잘리지 않고 줄바꿈
        self.inside(page, width, height, "#gdRhH", "#gdRhGo")
        band = lambda row: tile(row).locator(".gd-band").evaluate("b => getComputedStyle(b).animationName")
        if motion == "reduce":   # 움직이지 않는 표시
            self.assertEqual([band(103), band(104), band(105)], ["none", "none", "none"])
        else:
            expect(tile(103)).to_have_class(re.compile(r"\bgd-vis\b"))
            self.assertEqual([band(103), band(104), band(105)], ["gdloop", "gdloop", "none"])
        # 다시 크롤이 통과하면: 잠깐 ✓ 확인됨 → 줄에서 빠지고 숫자가 줄어든다
        ok = tile(103).locator(".gd-ov .gd-okl")
        expect(ok).to_be_visible(timeout=15000)
        if lang == "en":
            expect(ok).to_have_text("Checked")
        okb, pdp = ok.bounding_box(), tile(103).locator(".gd-pdp").bounding_box()
        self.assertAlmostEqual(okb["x"] + okb["width"] / 2, pdp["x"] + pdp["width"] / 2, delta=3)
        self.assertAlmostEqual(okb["y"] + okb["height"] / 2, pdp["y"] + pdp["height"] / 2, delta=3)
        expect(tile(103)).to_have_class(re.compile(r"\bgd-checked\b"))
        if motion == "reduce":   # 막이 걷힘 (모션이 있으면 0.9초에 걸쳐)
            self.assertEqual(tile(103).locator(".gd-dim").evaluate("d => getComputedStyle(d).opacity"), "0")
        expect(head.locator("b")).to_have_text("3")
        expect(tile(103)).to_have_class(re.compile(r"\bgd-hide\b"), timeout=5000)
        expect(head.locator("b")).to_have_text("2")
        expect(page.locator(".gd-it:not(.gd-hide)")).to_have_count(2)
        self.assertEqual(errors, [])
        page.close()

    def run_review_busy(self, browser, origin, width, height, lang, decide_first):
        # 검수 화면(하나씩)의 다시 크롤 중 카드: 덮개 · 가운데 글 · 버튼 흐림 · 비교 칸 없음 · 'n / N' 에서 빠짐 → 통과하면 ✓ 확인됨 → 다음으로 / 끝 화면
        rtl = lang == "ar"
        job = FakeJob(origin, retry_review=True)
        page, errors = open_page(browser, origin, width, height, lang, job)
        expect(page.locator("#gdRhGo")).to_be_visible(timeout=10000)
        page.locator("#gdRhGo").click()
        expect(page.locator("#dkCap b")).to_have_text("BAD-IMG")
        expect(page.locator("#dkI")).to_have_text("1")
        expect(page.locator("#dkNn")).to_have_text(" / 1")   # 다시 크롤 중인 것은 세지 않음
        if decide_first:   # 정하고 나면 남은 것은 다시 크롤 중 하나 — 그 카드로
            page.locator('.dk-bar [data-a="ok"]').click()
        else:
            page.keyboard.press("ArrowLeft" if rtl else "ArrowRight")
        expect(page.locator("#dkCap b")).to_have_text("RETRY-103")
        page.wait_for_timeout(800)
        card = page.locator(".dk-cc.dk-on")
        expect(card).to_have_class(re.compile(r"\bdk-rd\b"))
        expect(card).to_have_class(re.compile(r"\bdk-crawl\b"))
        expect(page.locator("#dkI")).to_have_text("–")
        expect(page.locator("#dkNn")).to_have_text(" / 1")
        expect(page.locator("#dkCmp")).to_be_hidden()
        for b in page.locator(".dk-bar .dk-act").all():
            expect(b).to_be_disabled()
        ov = card.locator(".dk-ov")
        if lang == "en":
            expect(ov.locator(".dk-o2")).to_have_text("Re-crawling from lg.com…")
            expect(ov.locator(".dk-o3")).to_have_text("Checked when it succeeds")
        self.assertEqual(card.locator(".dk-dim").evaluate("d => getComputedStyle(d).backgroundColor"), "rgba(38, 38, 38, 0.74)")
        self.assertIn("blur", card.locator(".dk-sc").evaluate("x => getComputedStyle(x).filter"))
        box, ph = ov.locator(".dk-ovt").bounding_box(), card.locator(".dk-ph").bounding_box()
        self.assertAlmostEqual(box["x"] + box["width"] / 2, ph["x"] + ph["width"] / 2, delta=3)
        self.assertAlmostEqual(box["y"] + box["height"] / 2, ph["y"] + ph["height"] / 2, delta=3)
        # 통과: 가운데 ✓ 확인됨 → 다음 정할 것으로(정할 것이 남았으면) · 아니면 끝 화면
        ok = page.locator(".dk-cc.dk-on .dk-okl")
        expect(ok).to_be_visible(timeout=15000)
        if lang == "en":
            expect(ok).to_have_text("Checked")
        okb = ok.bounding_box()
        self.assertAlmostEqual(okb["x"] + okb["width"] / 2, ph["x"] + ph["width"] / 2, delta=3)
        if decide_first:
            expect(page.locator("#ckAll")).to_be_visible(timeout=5000)
        else:
            expect(page.locator("#dkCap b")).to_have_text("BAD-IMG", timeout=5000)
            expect(page.locator("#dkNn")).to_have_text(" / 1")
            page.locator('.dk-bar [data-a="ok"]').click()
            expect(page.locator("#ckAll")).to_be_visible(timeout=5000)
        self.assertEqual(errors, [])
        page.close()

    def test_review_viewer_busy_card(self):
        with serve() as origin, sync_playwright() as p:
            options = {"headless": True}
            if os.environ.get("CLIA_CHROMIUM"):
                options["executable_path"] = os.environ["CLIA_CHROMIUM"]
            browser = p.chromium.launch(**options)
            for width, height, lang, first in [(1366, 768, "en", False), (1366, 768, "en", True), (360, 340, "ar", False)]:
                with self.subTest(width=width, height=height, lang=lang, decide_first=first):
                    self.run_review_busy(browser, origin, width, height, lang, first)
            browser.close()

    def test_retry_status_lines_animation_and_checked(self):
        with serve() as origin, sync_playwright() as p:
            options = {"headless": True}
            if os.environ.get("CLIA_CHROMIUM"):
                options["executable_path"] = os.environ["CLIA_CHROMIUM"]
            browser = p.chromium.launch(**options)
            for width, height, lang, motion in [(1366, 768, "en", "no-preference"), (1366, 768, "en", "reduce"), (360, 340, "ar", "reduce")]:
                with self.subTest(width=width, height=height, lang=lang, motion=motion):
                    self.run_retry_states(browser, origin, width, height, lang, motion)
            browser.close()

    def test_grid_scan_result_screen_then_one_by_one_review_and_download(self):
        with serve() as origin, sync_playwright() as p:
            options = {"headless": True}
            if os.environ.get("CLIA_CHROMIUM"):
                options["executable_path"] = os.environ["CLIA_CHROMIUM"]
            browser = p.chromium.launch(**options)
            for width, height, lang in VIEWPORTS:
                with self.subTest(width=width, height=height, lang=lang):
                    self.run_flow(browser, origin, width, height, lang)
                with self.subTest(clean=True, width=width, height=height, lang=lang):
                    self.run_clean(browser, origin, width, height, lang)
            for width, height, lang in [(360, 340, "de"), (700, 450, "th"), (1366, 768, "de")]:   # 긴 '확인하고 받기'
                with self.subTest(clean=True, width=width, height=height, lang=lang):
                    self.run_clean(browser, origin, width, height, lang)
                with self.subTest(retry_only=True, width=width, height=height, lang=lang):
                    self.run_retry_only(browser, origin, width, height, lang)
            browser.close()


if __name__ == "__main__":
    unittest.main()
