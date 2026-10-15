# -*- coding: utf-8 -*-
"""
image_crop.py — 이미지 안의 실제 피사체 영역 찾기 (AI 호출 없음, 픽셀 규칙)

배너 이미지에서 배경과 다른 '세로로 길게 이어진 덩어리'(배지·제품)를 찾아 크롭 영역을 돌려준다.
글자는 세로 길이가 짧아 덩어리로 잡히지 않으므로, 배너 안에 새겨진 문구는 자연히 제외된다.

  find_badge_crop(image) → {"x","y","w","h"} (0~1 비율) + {"iw","ih"} 또는 None
"""
from io import BytesIO
from typing import Optional

import requests
from PIL import Image

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def fetch_image(url: str, timeout: int = 20) -> Optional[Image.Image]:
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Referer": "https://www.lg.com/"}, timeout=timeout)
        r.raise_for_status()
        return Image.open(BytesIO(r.content)).convert("RGB")
    except Exception:
        return None


def find_badge_crop(im: Image.Image, min_extent: float = 0.55, min_density: float = 0.6,
                    pad: float = 0.03) -> Optional[dict]:
    """배너 안의 배지·제품처럼 '위아래로 길게 걸친' 덩어리를 찾는다.
    열마다 배경과 다른 픽셀이 세로로 얼마나 퍼져 있는지(최상단~최하단) 재서,
    이미지 높이의 min_extent 이상 걸친 열이 가장 길게 이어진 구간을 피사체로 본다.
    · 배너 문구는 가운데 몇 줄뿐이라 세로 폭이 짧다 · 바닥 반사 줄무늬는 아래쪽에만 있다 → 둘 다 제외된다.
    · 배지는 속이 꽉 찬 덩어리라 그 세로 구간 안의 피사체 픽셀 비율(min_density)이 높다 (글자 열은 듬성듬성).
    배경 = 이미지 오른쪽 끝 띠의 중앙값 색. 밝기가 비슷해도 색조(파랑 등)가 다르면 피사체."""
    iw, ih = im.size
    sw, sh = max(1, iw // 4), max(1, ih // 4)
    small = im.resize((sw, sh))
    px = small.load()
    band = [px[x, y] for x in range(int(sw * 0.9), sw) for y in range(sh)]
    bg = tuple(sorted(c[i] for c in band)[len(band) // 2] for i in range(3))
    bg_tint = bg[2] - (bg[0] + bg[1]) / 2

    def fg(c):
        tint = c[2] - (c[0] + c[1]) / 2
        return sum(abs(c[i] - bg[i]) for i in range(3)) > 70 or abs(tint - bg_tint) > 18

    extents = []
    for x in range(sw):
        ys = [y for y in range(sh) if fg(px[x, y])]
        extents.append((ys[-1] - ys[0] + 1, ys[0], ys[-1], len(ys)) if ys else (0, 0, 0, 0))
    tall = [x for x in range(sw) if extents[x][0] >= sh * min_extent
            and extents[x][3] >= extents[x][0] * min_density]
    if not tall:
        return None
    runs, start = [], tall[0]
    for a, b in zip(tall, tall[1:] + [None]):
        if b is None or b != a + 1:
            runs.append((start, a))
            start = b
    x0, x1 = max(runs, key=lambda r: r[1] - r[0])
    if x1 - x0 + 1 < sw * 0.03:
        return None
    y0 = min(extents[x][1] for x in range(x0, x1 + 1))
    y1 = max(extents[x][2] for x in range(x0, x1 + 1))
    px_, py_ = (x1 - x0 + 1) * pad, (y1 - y0 + 1) * pad
    x0, x1 = max(0, x0 - px_), min(sw - 1, x1 + px_)
    y0, y1 = max(0, y0 - py_), min(sh - 1, y1 + py_)
    return {"x": round(x0 / sw, 4), "y": round(y0 / sh, 4),
            "w": round((x1 - x0 + 1) / sw, 4), "h": round((y1 - y0 + 1) / sh, 4), "iw": iw, "ih": ih}


def annotate_badge_crops(mirror: dict, min_aspect: float = 2.5) -> int:
    """수상 배너(가로로 긴 이미지 안에 배지 + 문구가 새겨진 것)에서 배지 영역을 찾아 media["crop"]에 기록한다.
    1차 컨텐츠 생성이 배지 카드에서 이 영역만 보여준다. 대상: 파일명에 award/badge 등이 들어간 이미지 중
    가로세로비 min_aspect 이상인 배너 (정사각형 등 일반 이미지는 제외)."""
    import re
    try:
        from component_parser import LEGACY
    except Exception:
        LEGACY = False
    if LEGACY:
        return 0
    name_re = re.compile(r"award|badge|winner|honoree", re.I)
    cache, n = {}, 0
    for s in mirror.get("sections", []) + mirror.get("_feature_cards", []):
        for m in s.get("media", []):
            url = m.get("pc_url") or m.get("unified_url") or ""
            if m.get("crop") or not name_re.search(url.split("?")[0].rsplit("/", 1)[-1]):
                continue
            if url not in cache:
                im = fetch_image(url)
                c = None
                if im is not None and im.size[0] >= im.size[1] * min_aspect:
                    c = find_badge_crop(im)
                    if c and c["w"] > 0.5:          # 배너 대부분이 잡히면 배지를 못 찾은 것
                        c = None
                cache[url] = c
            if cache[url]:
                m["crop"] = dict(cache[url], kind="badge")
                n += 1
    return n
