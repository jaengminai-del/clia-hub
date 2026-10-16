# -*- coding: utf-8 -*-
"""
image_crop.py — 이미지 안의 실제 피사체 영역 찾기 (AI 호출 없음, 픽셀 규칙)

배너 이미지에서 배경과 다른 '세로로 길게 이어진 덩어리'(배지·제품)를 찾아 크롭 영역을 돌려준다.
글자는 세로 길이가 짧아 덩어리로 잡히지 않으므로, 배너 안에 새겨진 문구는 자연히 제외된다.

  find_badge_crop(image) → {"x","y","w","h"} (0~1 비율) + {"iw","ih"} 또는 None
"""
import os
from io import BytesIO
from typing import Optional
from urllib.parse import quote

import requests
from PIL import Image

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def image_proxy() -> Optional[str]:
    """같은 서버의 이미지 중계 (/api/proxy-image?url=). 배포 서버(데이터센터 IP)에서는 Python 이 LG.com 이미지를
    직접 요청하면 403 으로 막히고, Node 중계는 통과한다 (2026-10-16 확인). CLIA_IMAGE_PROXY 가 없으면 PORT(서버 포트)로 만든다."""
    p = os.environ.get("CLIA_IMAGE_PROXY")
    if p:
        return p
    port = os.environ.get("PORT")
    return f"http://127.0.0.1:{port}/api/proxy-image?url=" if port else None


def fetch_bytes(url: str, timeout: int = 20) -> bytes:
    """LG 이미지 bytes — 직접 받고, 실패하면(403 등) 서버 이미지 중계로 다시 받는다. 둘 다 실패하면 예외."""
    headers = {"User-Agent": UA, "Referer": "https://www.lg.com/"}
    try:
        r = requests.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.content
    except Exception:
        proxy = image_proxy()
        if not proxy:
            raise
        r = requests.get(proxy + quote(url, safe=""), headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.content


def fetch_image(url: str, timeout: int = 20) -> Optional[Image.Image]:
    try:
        return Image.open(BytesIO(fetch_bytes(url, timeout))).convert("RGB")
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


def find_text_band_crop(im: Image.Image, side: str, tol: int = 18, content_ratio: float = 0.06,
                        margin: float = 0.01, min_keep: float = 0.25, min_content_rows: float = 0.4,
                        trim_others: bool = True) -> Optional[dict]:
    """텍스트 자리로 비워 둔 배경 띠(side = top·bottom·left·right 쪽)를 잘라 낸 영역.
    가장자리 색(그 쪽 끝 줄의 중앙값)과 확연히 다른 픽셀이 한 줄의 content_ratio 이상이 되는 첫 줄까지를 빈 띠로 본다.
    남는 영역이 원본의 min_keep 보다 작으면(이미지 대부분이 빈 배경) None — 자르지 않는다."""
    iw, ih = im.size
    sw, sh = max(1, iw // 4), max(1, ih // 4)
    px = im.resize((sw, sh)).load()
    vertical = side in ("top", "bottom")
    n_lines, n_len = (sh, sw) if vertical else (sw, sh)

    def line(i):
        k = i if side in ("top", "left") else n_lines - 1 - i
        return [px[j, k] if vertical else px[k, j] for j in range(n_len)]

    edge = line(0)
    ref = tuple(sorted(c[ch] for c in edge)[len(edge) // 2] for ch in range(3))
    band = 0
    for i in range(n_lines):
        diff = sum(1 for c in line(i) if sum(abs(c[ch] - ref[ch]) for ch in range(3)) > tol * 3)
        if diff >= n_len * content_ratio:
            break
        band = i + 1
    if band == 0:
        return None
    cut = max(0, band - int(n_lines * margin))
    keep = n_lines - cut
    if keep < n_lines * min_keep:
        return None
    # 남는 영역이 거의 배경뿐이면(동영상 자리 표시 이미지 등) 자르지 않는다
    #   (남는 줄 중 내용이 있는 줄이 min_content_rows 미만 — 예: 베이지 화면에 막대 하나)
    rows = [sum(1 for c in line(i) if sum(abs(c[ch] - ref[ch]) for ch in range(3)) > tol * 3) >= n_len * content_ratio
            for i in range(band, n_lines)]
    if sum(rows) < len(rows) * min_content_rows:
        return None
    f = cut / n_lines
    t, b, l, r = {"top": (f, 0, 0, 0), "bottom": (0, f, 0, 0), "left": (0, 0, f, 0), "right": (0, 0, 0, f)}[side]
    if trim_others:
        # 텍스트 반대쪽·양옆에 남은 빈 배경도 잘라 낸다 (텍스트 쪽보다 엄격한 기준 — 옅은 받침대·그림자 보존)
        x0, y0 = int(l * iw), int(t * ih)
        sub = im.crop((x0, y0, iw - int(r * iw), ih - int(b * ih)))
        o = trim_background(sub, skip=side)
        sw_, sh_ = sub.size
        t += o["top"] * sh_ / ih
        b += o["bottom"] * sh_ / ih
        l += o["left"] * sw_ / iw
        r += o["right"] * sw_ / iw
    return {"x": round(l, 4), "y": round(t, 4), "w": round(1 - l - r, 4), "h": round(1 - t - b, 4),
            "iw": iw, "ih": ih, "band": round(f, 4)}


def _edge_band(px, sw: int, sh: int, side: str, tol: int, content_ratio: float) -> float:
    """side 쪽 가장자리 색(끝 줄 중앙값)과 같은 줄이 안쪽으로 몇 % 이어지는지 (0~1)."""
    vertical = side in ("top", "bottom")
    n_lines, n_len = (sh, sw) if vertical else (sw, sh)

    def line(i):
        k = i if side in ("top", "left") else n_lines - 1 - i
        return [px[j, k] if vertical else px[k, j] for j in range(n_len)]

    edge = line(0)
    ref = tuple(sorted(c[ch] for c in edge)[len(edge) // 2] for ch in range(3))
    band = 0
    for i in range(n_lines):
        if sum(1 for c in line(i) if sum(abs(c[ch] - ref[ch]) for ch in range(3)) > tol * 3) >= n_len * content_ratio:
            break
        band = i + 1
    return band / n_lines


def trim_background(im: Image.Image, skip: str = "", tol: int = 8, content_ratio: float = 0.03,
                    min_band: float = 0.02, margin: float = 0.02, min_keep: float = 0.5) -> dict:
    """이미지 가장자리의 단색 빈 배경 비율 {top,bottom,left,right} (skip 쪽은 0).
    · min_band 미만의 띠는 그대로 둔다 · 남는 폭/높이가 min_keep 미만이 되는 축은 자르지 않는다
      (거의 단색인 이미지 — 동영상 자리 표시 등 — 보호) · 피사체 쪽으로 margin 만큼 여유를 남긴다."""
    iw, ih = im.size
    sw, sh = max(1, iw // 4), max(1, ih // 4)
    px = im.resize((sw, sh)).load()
    out = {}
    for side in ("top", "bottom", "left", "right"):
        v = 0.0 if side == skip else _edge_band(px, sw, sh, side, tol, content_ratio)
        out[side] = max(0.0, v - margin) if v >= min_band else 0.0
    for a, z in (("top", "bottom"), ("left", "right")):
        if 1 - out[a] - out[z] < min_keep:
            out[a] = out[z] = 0.0
    return out


def annotate_overlay_crops(mirror: dict) -> int:
    """텍스트가 이미지 위에 떠 있던 히어로(section.text_overlay)의 이미지에서 텍스트 자리 빈 배경을 잘라 낼 영역 기록.
      · 모바일 이미지가 있으면: 모바일 텍스트 위치(위·아래) 쪽 빈 띠 → media.mobile_crop (+ use_mobile)
      · 없으면: PC 텍스트 위치(왼쪽·오른쪽) 쪽 빈 영역 → media.crop (kind=overlay_band)
    빈 띠를 못 찾거나 남는 부분이 거의 배경뿐(동영상 자리 표시 이미지 등)이면 기록하지 않는다 → 원래 이미지 그대로."""
    try:
        from component_parser import LEGACY
    except Exception:
        LEGACY = False
    if LEGACY:
        return 0
    n, cache = 0, {}

    def crop(url, side):
        key = (url, side)
        if key not in cache:
            im = fetch_image(url)
            cache[key] = find_text_band_crop(im, side) if im is not None else None
        return cache[key]

    for s in mirror.get("sections", []):
        ov = s.get("text_overlay")
        if not ov:
            continue
        for m in s.get("media", []):
            if m.get("type") != "image" or (m.get("crop") or {}).get("kind") == "badge":
                continue
            if m.get("mobile_crop"):
                n += annotate_pc_candidate(m, ov, crop)
                continue
            mob, pc = m.get("mobile_url"), m.get("pc_url")
            if mob and mob != pc and ov.get("mobile") in ("top", "bottom"):
                c = crop(mob, ov["mobile"])
                if c:
                    m["mobile_crop"] = dict(c, kind="overlay_band")
                    m["use_mobile"] = True
                    n += 1 + annotate_pc_candidate(m, ov, crop)
                    continue
            if not mob and pc and ov.get("pc") in ("left", "right"):
                c = crop(pc, ov["pc"])
                if c:
                    m["crop"] = dict(c, kind="overlay_band")
                    n += 1
    return n


def annotate_pc_candidate(m: dict, ov: dict, crop=None) -> int:
    """모바일 이미지를 쓰는 오버레이 히어로에도 PC 원본 쪽 후보를 기록 — media.pc_crop (kind=overlay_band).
    Amazon A+ 는 모듈 칸 비율에 PC·모바일 중 덜 잘리는 쪽을 고른다 (eBay·Shopee/Lazada 는 쓰지 않음).
    PC 텍스트 자리(왼쪽·오른쪽) 빈 영역을 자르고, 텍스트 자리 정보가 없으면 가장자리 단색 배경만 자른다.
    잘라 낼 것이 없으면 pc_crop = 전체 영역 (kind=full — 원본 그대로, 비율 비교용 크기만 기록)."""
    pc = m.get("pc_url")
    if not pc or "pc_crop" in m:
        return 0
    c = None
    if ov.get("pc") in ("left", "right"):
        c = crop(pc, ov["pc"]) if crop else None
        if crop is None:
            im = fetch_image(pc)
            c = find_text_band_crop(im, ov["pc"]) if im is not None else None
    if not c:
        im = fetch_image(pc)
        if im is None:
            return 0
        t = trim_background(im)
        if any(t.values()):
            c = {"x": round(t["left"], 4), "y": round(t["top"], 4), "w": round(1 - t["left"] - t["right"], 4),
                 "h": round(1 - t["top"] - t["bottom"], 4), "iw": im.size[0], "ih": im.size[1]}
        else:
            m["pc_crop"] = {"x": 0, "y": 0, "w": 1, "h": 1, "iw": im.size[0], "ih": im.size[1], "kind": "full"}
            return 1
    m["pc_crop"] = dict(c, kind="overlay_band")
    return 1
