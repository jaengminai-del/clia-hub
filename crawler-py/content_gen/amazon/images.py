# -*- coding: utf-8 -*-
"""
images.py — Amazon A+ 업로드용 이미지 (Pillow)

브라우저 빌더의 canvas 처리를 옮겼다 (2026-10-16):
  merge_stacked   ← mergeStackedImages  이어 붙은 히어로 이미지들을 같은 폭으로 위아래 이어 붙여 한 장 + 가장자리 평균색
  build_zip       ← downloadImages      모듈 규격(spec.module_image_specs)대로 잘라 JPEG ZIP + aplus-copy.txt
    · fit = contain / contain-full : 배지 파일·합친 히어로 — 칸 안에 전체가 보이게 (배지는 80% + 흰 여백)
    · 배너에서 잘라 낸 배지(textData.crops[url]) : 원래 배너를 칸에 채우고 미리보기 조정값(처음엔 배지 중심) 반영
    · 그 외                       : cover + 사용자가 미리보기에서 조정한 이동·확대(transforms[i] = {tx, ty, z, clipW, clipH})
"""
import base64
import io
import os
import zipfile
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests
from PIL import Image

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
JPEG_QUALITY = 92          # 브라우저 canvas.toBlob('image/jpeg', 0.92)


def load_image(url: str, timeout: int = 20) -> Image.Image:
    """http(s) URL 또는 data URL → RGB 이미지 (실패 시 예외).
    직접 받고, 실패하면(배포 서버에서는 LG.com 이 403) 같은 서버의 이미지 중계(/api/proxy-image)로 받는다 — image_crop.fetch_bytes."""
    if url.startswith("data:"):
        data = base64.b64decode(url.split(",", 1)[1])
    elif "/api/v1/image-crop?" in url:            # 서버가 잘라 주는 주소 → 여기서 바로 자른다 (HTTP 왕복 없이)
        return crop_from_url(url, timeout)
    else:
        from image_crop import fetch_bytes      # 직접 → 실패 시 서버 이미지 중계 (크롤러와 같은 규칙)
        data = fetch_bytes(url, timeout)
    im = Image.open(io.BytesIO(data))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))   # 투명 영역은 흰색 (JPEG 저장 대비)
        im = Image.alpha_composite(bg, im)
    return im.convert("RGB")


def crop_from_url(url: str, timeout: int = 20) -> Image.Image:
    """/api/v1/image-crop?url=<원본>&box=x,y,w,h (0~1 비율) → 잘린 이미지."""
    from urllib.parse import parse_qs, urlsplit
    q = parse_qs(urlsplit(url).query)
    src = q["url"][0]
    x, y, w, h = (float(v) for v in q["box"][0].split(","))
    im = load_image(src, timeout)
    W, H = im.size
    return im.crop((round(x * W), round(y * H), round((x + w) * W), round((y + h) * H)))


def _jpeg(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def _parse_rgb(s: Optional[str]):
    if not s:
        return (255, 255, 255)
    s = s.strip()
    if s.startswith("#") and len(s) == 7:
        return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
    if s.startswith("rgb"):
        return tuple(int(float(v)) for v in s[s.index("(") + 1:s.index(")")].split(",")[:3])
    return (255, 255, 255)


def _draw(canvas: Image.Image, im: Image.Image, sx, sy, sw, sh, dx, dy, dw, dh):
    """canvas.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh) — 캔버스 밖으로 나가는 부분은 잘라 낸다."""
    if dw <= 0 or dh <= 0 or sw <= 0 or sh <= 0:
        return
    W, H = canvas.size
    kx, ky = dw / sw, dh / sh
    x0, y0 = max(0.0, dx), max(0.0, dy)
    x1, y1 = min(float(W), dx + dw), min(float(H), dy + dh)
    if x1 <= x0 or y1 <= y0:
        return
    ix0, iy0, ix1, iy1 = round(x0), round(y0), round(x1), round(y1)
    if ix1 <= ix0 or iy1 <= iy0:
        return
    box = (sx + (ix0 - dx) / kx, sy + (iy0 - dy) / ky, sx + (ix1 - dx) / kx, sy + (iy1 - dy) / ky)
    box = (max(0.0, box[0]), max(0.0, box[1]), min(float(im.width), box[2]), min(float(im.height), box[3]))
    part = im.resize((ix1 - ix0, iy1 - iy0), Image.LANCZOS, box=box)
    canvas.paste(part, (ix0, iy0))


def merge_stacked(urls: list):
    """이어 붙은 히어로 → (한 장 JPEG bytes, 'rgb(r,g,b)' 좌우 가장자리 평균색). 2장 미만이면 None."""
    with ThreadPoolExecutor(4) as ex:
        ims = list(ex.map(load_image, urls))
    if len(ims) < 2:
        return None
    W = ims[0].width
    hs = [round(im.height * W / im.width) for im in ims]
    out = Image.new("RGB", (W, sum(hs)), (0, 0, 0))
    y = 0
    for im, h in zip(ims, hs):
        out.paste(im if im.size == (W, h) else im.resize((W, h), Image.LANCZOS), (0, y))
        y += h
    edge = [out.crop((0, 0, min(4, W), out.height)), out.crop((max(0, W - 4), 0, W, out.height))]
    tot, n = [0, 0, 0], 0
    for e in edge:
        for px in e.getdata():
            tot[0] += px[0]; tot[1] += px[1]; tot[2] += px[2]
            n += 1
    bg = f"rgb({round(tot[0] / n)},{round(tot[1] / n)},{round(tot[2] / n)})"
    return _jpeg(out), bg


def render_slot(im: Image.Image, mod: dict, url: str, w: int, h: int, transform: Optional[dict]) -> Image.Image:
    fit = mod.get("fit")
    c = ((mod.get("textData") or {}).get("crops") or {}).get(url)
    banner_badge = fit == "contain" and c          # 배너에서 잘라 낸 배지 → 채우기 + 미리보기 조정값 (2026-10-16)
    if fit in ("contain", "contain-full") and not banner_badge:
        sx, sy = (c["x"] * im.width, c["y"] * im.height) if c else (0, 0)
        sw, sh = (c["w"] * im.width, c["h"] * im.height) if c else (im.width, im.height)
        k = min(w / sw, h / sh) * (1 if fit == "contain-full" else 0.8)
        cv = Image.new("RGB", (w, h), _parse_rgb(mod.get("bgColor")))
        _draw(cv, im, sx, sy, sw, sh, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k)
        return cv
    t = transform or {}
    tx, ty, z = float(t.get("tx") or 0), float(t.get("ty") or 0), float(t.get("z") or 1)
    cW, cH = float(t.get("clipW") or 0), float(t.get("clipH") or 0)
    scale_out = w / cW if cW > 0 else 1
    s0 = max(cW / im.width, cH / im.height) if cW > 0 else max(w / im.width, h / im.height)
    k = z * s0 * scale_out
    cx, cy = w / 2 + tx * scale_out, h / 2 + ty * scale_out
    cv = Image.new("RGB", (w, h), (255, 255, 255))   # 프레임을 다 못 채우면 흰색
    _draw(cv, im, 0, 0, im.width, im.height, cx - im.width / 2 * k, cy - im.height / 2 * k, im.width * k, im.height * k)
    return cv


def module_copy(m: dict) -> list:
    """buildModuleCopy — 모듈이 실제로 보여주는 문구만 [(라벨, 값)]."""
    td, t, rows = m.get("textData") or {}, m.get("type"), []
    hl = td.get("headline") or ""
    if t == "highlights":
        if hl: rows.append(("헤드카피", hl))
        sh, bd = td.get("subheads") or [], td.get("bodies") or []
        for i in range(3):
            if i < len(sh) and sh[i]: rows.append((f"서브헤드 {i + 1}", sh[i]))
            if i < len(bd) and bd[i]: rows.append((f"바디 {i + 1}", bd[i]))
        if td.get("bulletTitle"): rows.append(("불릿 타이틀", td["bulletTitle"]))
        for i, b in enumerate(td.get("bullets") or []):
            if b: rows.append((f"불릿 {i + 1}", b))
    elif t in ("three-img", "four-text"):
        if hl: rows.append(("헤드카피", hl))
        for i, it in enumerate((td.get("items") or [])[:3 if t == "three-img" else 4]):
            if it.get("title"): rows.append((f"이미지 {i + 1} 타이틀", it["title"]))
            if it.get("body"): rows.append((f"이미지 {i + 1} 바디", it["body"]))
    else:
        if hl: rows.append(("헤드카피", hl))
        if td.get("body"): rows.append(("바디카피", td["body"]))
    return rows


def copy_text(mods: list, spec: dict, pdp_url: str = "", date: str = "") -> str:
    sep = "═══════════════════════════════════════════════════"
    lines = [sep, "Amazon A+ Content — Section Copy", f"Source: {pdp_url}" if pdp_url else "", f"Date: {date}", sep, ""]
    for idx, m in enumerate(mods):
        specs = spec["module_image_specs"].get(m.get("type")) or []
        label = f"{specs[0][0]}×{specs[0][1]}" if specs else ""
        lines.append(f"[{idx + 1:02d}] {m.get('type')}" + (f"  ({label})" if label else ""))
        lines.append("─────────────────────────────────────────────────")
        for k, v in module_copy(m):
            lines.append(f"{k} :  {v}")
        lines.append("")
    return "\n".join(lines)


def build_zip(mods: list, spec: dict, pdp_url: str = "", date: str = ""):
    """→ (ZIP bytes, 이미지 수, 실패 목록). mods[i].transforms[k] = 미리보기에서 조정한 k번째 슬롯 이동·확대."""
    jobs = []
    for mi, m in enumerate(mods):
        specs = spec["module_image_specs"].get(m.get("type"))
        if not specs:
            continue
        items = (m.get("textData") or {}).get("items") or []
        for i, (w, h) in enumerate(specs):
            url = ((m.get("slotImages") or {}).get(f"s{i + 1}")
                   or (items[i].get("imageUrl") if i < len(items) else None) or m.get("imageUrl"))
            if not url:
                continue
            suffix = f"-{i + 1}" if len(specs) > 1 else ""
            name = f"{mi + 1:02d}-{m['type']}{suffix}-{w}x{h}.jpg"
            tr = (m.get("transforms") or [])
            jobs.append((name, m, url, w, h, tr[i] if i < len(tr) else None))
    urls = sorted({j[2] for j in jobs})
    cache, fails = {}, []

    def load(u):
        try:
            return u, load_image(u)
        except Exception as e:
            return u, e
    with ThreadPoolExecutor(8) as ex:
        for u, r in ex.map(load, urls):
            cache[u] = r
    buf = io.BytesIO()
    n = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name, m, url, w, h, tr in jobs:
            im = cache.get(url)
            if isinstance(im, Exception) or im is None:
                fails.append(f"{name}: {im}")
                continue
            z.writestr(name, _jpeg(render_slot(im, m, url, w, h, tr)))
            n += 1
        if n:
            z.writestr("aplus-copy.txt", copy_text(mods, spec, pdp_url, date))
    return buf.getvalue(), n, fails
