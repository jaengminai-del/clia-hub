"""Slices load lg.com images through the server copy (CLIA_IMAGE_CACHE), not from lg.com directly.

PYTHONPATH=crawler-py python -m unittest discover -s tests -p test_slice_image_cache.py
"""
import contextlib
import http.server
import io
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

from PIL import Image

from content_gen.slices import render


def png(color):
    buf = io.BytesIO()
    Image.new("RGB", (400, 200), color).save(buf, "PNG")
    return buf.getvalue()


@contextlib.contextmanager
def image_copy(delay=0.0):
    asked = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            url = parse_qs(urlparse(self.path).query).get("url", [""])[0]
            asked.append(url)
            time.sleep(delay)
            if "gone" in url:
                self.send_response(404)
                self.end_headers()
                return
            body = png((200, 30, 30))
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/api/v1/img-cache?url=", asked
    finally:
        server.shutdown()
        worker.join()
        server.server_close()


def page(names):
    imgs = "".join(f'<section style="height:260px"><img src="https://www.lg.com/clia-test/{n}.png" '
                   f'style="width:400px;height:200px"></section>' for n in names)
    return '<style>.lg-container{width:400px}</style><div class="lg-container">' + imgs + "</div>"


class SliceImageCopyTest(unittest.TestCase):
    def render(self, html, cache):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"CLIA_IMAGE_CACHE": cache}):
            started = time.monotonic()
            out = render({"html": html, "medium": "shopee_lazada", "viewportWidth": 400, "outputWidth": 400},
                         Path(tmp, "s.zip"))
            return out, time.monotonic() - started

    def test_lg_images_come_from_the_server_copy_in_parallel(self):
        names = [f"copy-{i}" for i in range(6)]
        with image_copy(delay=1.0) as (cache, asked):
            out, took = self.render(page(names), cache)
        # 이 주소들은 lg.com 에 없다 — 사본으로 받았으니 전부 그려진다
        self.assertEqual(out["images_loaded"], "6/6")
        self.assertEqual(sorted(asked), sorted(f"https://www.lg.com/clia-test/{n}.png" for n in names))
        # 한 장에 1초 걸리는 사본 6장을 한 장씩 차례로 받지 않는다
        self.assertLess(took, 5.5)

    def test_image_the_copy_cannot_get_stays_missing(self):
        with image_copy() as (cache, asked):
            out, _ = self.render(page(["fine", "gone"]), cache)
        self.assertEqual(out["images_loaded"], "1/2")
        self.assertEqual(len(asked), 2)


if __name__ == "__main__":
    unittest.main()
