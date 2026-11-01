# -*- coding: utf-8 -*-
"""edge_trim.py — 모바일 이미지 둘레의 단색 테두리(베이지 여백·둥근 모서리) 자르기 영역 (2026-11-01)

텍스트 div 가 PC 이미지 왼쪽·오른쪽 위에 떠 있던 섹션은 모바일 이미지를 쓰는데(render_html.prefer_mobile_media),
LG.com 모바일 이미지에는 비주얼 둘레에 배경색 테두리가 들어 있는 경우가 많다 → 그리는 단계에서 잘라 낸다.
이미 크롤된 제품에도 적용되도록 그릴 때 계산하고, 결과는 URL 별로 out/_edge_trim.json 에 캐시한다.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor, wait
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


BUDGET_S = float(os.environ.get("CLIA_TRIM_BUDGET", "20"))   # 한 번 그릴 때 이미지 받기에 쓰는 최대 시간 (넘으면 그 이미지는 자르지 않고 그림)


def _fetch(url: str):
    """배포 서버(이미지 중계가 있는 환경)는 중계를 먼저 — LG.com 직접 요청은 막히거나 오래 걸린다."""
    from io import BytesIO
    from urllib.parse import quote
    import requests
    from PIL import Image
    from image_crop import UA, image_proxy
    proxy = image_proxy()
    tries = ([proxy + quote(url, safe="")] if proxy else []) + [url]
    for u in tries:
        try:
            r = requests.get(u, headers={"User-Agent": UA, "Referer": "https://www.lg.com/"}, timeout=8)
            r.raise_for_status()
            return Image.open(BytesIO(r.content)).convert("RGB")
        except Exception:
            continue
    return None


def _compute(url: str, logo: bool = False):
    from image_crop import find_edge_frame_crop
    im = _fetch(url)
    if im is None:
        return "fail"                     # 받기 실패는 캐시하지 않는다 (다음에 다시 시도)
    if logo:   # 로고: 둘레 여백만 정확히 (모서리 추가 자르기 없음) — 로고 실제 크기를 알기 위해 원본 크기는 항상 기록
        c = find_edge_frame_crop(im, corner_inset=0.0, min_band=0.004, min_keep=0.2)
        return dict(c or {"x": 0, "y": 0, "w": 1, "h": 1, "iw": im.width, "ih": im.height}, kind="logo")
    c = find_edge_frame_crop(im)
    return dict(c, kind="edge_trim") if c else None


def _trims(urls: list, logo: bool) -> dict:
    cache = _load()
    key = (lambda u: "logo:" + u) if logo else (lambda u: u)
    todo = [u for u in dict.fromkeys(urls) if u and key(u) not in cache]
    if todo:
        ex = ThreadPoolExecutor(max_workers=8)
        futs = {ex.submit(_compute, u, logo): u for u in todo}
        done, _ = wait(futs, timeout=BUDGET_S)        # 시간 안에 못 받은 이미지는 이번엔 자르지 않는다 (다음에 다시 시도)
        for f in done:
            c = f.result() if not f.exception() else "fail"
            if c != "fail":
                cache[key(futs[f])] = c
        ex.shutdown(wait=False, cancel_futures=True)
        _save(cache)
    return {u: cache.get(key(u)) for u in urls}


def edge_trims(urls: list) -> dict:
    """{url: crop | None}. 캐시에 없는 URL 은 병렬로 받아 계산."""
    return _trims(urls, False)


def logo_trims(urls: list) -> dict:
    """수상·인증 로고 파일의 실제 로고 영역 {url: {x,y,w,h,iw,ih} | None(받기 실패)} — 로고 카드 크기 통일용."""
    return _trims(urls, True)
