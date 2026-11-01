# -*- coding: utf-8 -*-
"""edge_trim.py — 모바일 이미지 둘레의 단색 테두리(베이지 여백·둥근 모서리) 자르기 영역 (2026-11-01)

텍스트 div 가 PC 이미지 왼쪽·오른쪽 위에 떠 있던 섹션은 모바일 이미지를 쓰는데(render_html.prefer_mobile_media),
LG.com 모바일 이미지에는 비주얼 둘레에 배경색 테두리가 들어 있는 경우가 많다 → 그리는 단계에서 잘라 낸다.
이미 크롤된 제품에도 적용되도록 그릴 때 계산하고, 결과는 URL 별로 out/_edge_trim.json 에 캐시한다.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CACHE = Path(__file__).resolve().parent.parent / "out" / "_edge_trim.json"
_mem = None


def _load() -> dict:
    global _mem
    if _mem is None:
        try:
            _mem = json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:
            _mem = {}
    return _mem


def _save(d: dict) -> None:
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(d), encoding="utf-8")
        os.replace(tmp, CACHE)
    except Exception:
        pass


def _compute(url: str):
    from image_crop import fetch_image, find_edge_frame_crop
    im = fetch_image(url)
    if im is None:
        return "fail"                     # 받기 실패는 캐시하지 않는다 (다음에 다시 시도)
    c = find_edge_frame_crop(im)
    return dict(c, kind="edge_trim") if c else None


def edge_trims(urls: list) -> dict:
    """{url: crop | None}. 캐시에 없는 URL 은 병렬로 받아 계산."""
    cache = _load()
    todo = [u for u in dict.fromkeys(urls) if u and u not in cache]
    if todo:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for u, c in zip(todo, ex.map(_compute, todo)):
                if c != "fail":
                    cache[u] = c
        _save(cache)
    return {u: cache.get(u) for u in urls}
