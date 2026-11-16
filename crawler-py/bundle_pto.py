"""
bundle_pto.py — LG.com 번들 PTO 페이지 크롤 (2026-11-09)

번들 PTO = `.../<카테고리>-bundles/<a>-<b>/` 페이지. 모델명이 `A.B` 처럼 합쳐져 있고
페이지 자체에는 피처 섹션이 없다. 각 구성품은 자기 단품 PDP 에 콘텐츠가 있으므로
  1) 번들 페이지에서 구성품 단품 PDP URL 을 찾고
  2) 구성품마다 기존 파이프라인(pdp_pipeline.py)을 그대로 돌린 뒤 (out/<단품 slug>/ 재사용)
  3) [번들 헤더] → [구성품1 구분 헤더 + 섹션] → [구성품2 …] → [제품별 스펙] 순서로 한 mirror 로 합친다.

구성품 찾는 순서 (모델명을 쪼개지 않는다 — 번들 코드 ≠ 실제 모델, 예: DS70001 → DS70TY):
  ① #pdp-overview-section 의 단품 링크
  ② 없으면 스펙 영역 규격 문서 라벨 `ENERGY LABEL(TF09TAS)` 의 모델코드 → 국가 sitemap 에서 단품 URL
  ③ 그래도 없으면 스펙 슬라이드의 이름·썸네일만 (status = "no_pdp")

자체 콘텐츠가 있는 구형 번들(예: tone-dfp8-bundle)은 is_bundle_pto() 가 False → 일반 PDP 로 처리.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
_BUNDLE_PATH_RE = re.compile(r"/[a-z0-9-]*bundles?/[^/]+/?$", re.I)
_SPEC_CODE_RE = re.compile(r"\(([A-Z0-9][A-Z0-9.\-]{3,})\)")
_NON_PRODUCT_HREF = re.compile(r"downloadFile|/support/|cedoc|^#|^javascript:|/buy/?$", re.I)


# ─────────────────────────────────────────────────────────────────────
# 감지
# ─────────────────────────────────────────────────────────────────────
def _ld_product(soup) -> dict:
    for sc in soup.find_all("script", type="application/ld+json"):
        try:
            d = json.loads(sc.string or "")
        except Exception:
            continue
        if isinstance(d, dict) and d.get("@type") == "Product":
            return d
    return {}


def _spec_slides(soup) -> list:
    sp = soup.find(id="pdp-specs-section")
    if not sp:
        return []
    return sp.select('[id^="pto-tabs"][role="tab"], .cmp-tabs__tab.cmp-carousel__item')


def is_bundle_pto(url: str, html: str) -> bool:
    """번들 PTO 페이지인가? (URL 경로 + 구성품 스펙 탭/개요 링크 근거, 자체 피처 섹션이 없을 것)"""
    if not _BUNDLE_PATH_RE.search(urlparse(url).path):
        return False
    soup = BeautifulSoup(html, "html.parser")
    if len(set(re.findall(r"\bST\d{4}\b", html))) >= 3:     # 구형 번들 — 자체 콘텐츠 있음
        return False
    return len(_spec_slides(soup)) >= 1 or bool(_overview_links(soup, url))


# ─────────────────────────────────────────────────────────────────────
# 구성품 찾기
# ─────────────────────────────────────────────────────────────────────
def _overview_links(soup, base: str) -> List[str]:
    ov = soup.find(id="pdp-overview-section")
    if not ov:
        return []
    cc = urlparse(base).path.strip("/").split("/")[0]
    seen = []
    for a in ov.find_all("a", href=True):
        h = a["href"].strip()
        if _NON_PRODUCT_HREF.search(h):
            continue
        u = urljoin(base, h).split("?")[0].split("#")[0]
        p = urlparse(u)
        if p.netloc.endswith("lg.com") and p.path.startswith(f"/{cc}/") and "bundles" not in p.path \
                and u not in seen:
            seen.append(u)
    return seen


def _slides_info(soup, origin: str) -> List[dict]:
    """스펙 탭 = 구성품 1개씩: 이름·썸네일·규격 문서 모델코드."""
    out = []
    slides = _spec_slides(soup)
    sp = soup.find(id="pdp-specs-section")
    resources = sp.select(".c-specs-resource") if sp else []
    for i, sl in enumerate(slides):
        img = sl.find("img")
        name = " ".join(sl.get_text(" ", strip=True).split())
        thumb = ""
        if img:
            src = img.get("src") or img.get("data-src") or ""
            thumb = urljoin(origin, src.split("/jcr:content")[0]) if src else ""
        codes = []
        if i < len(resources):
            codes = [c for c in _SPEC_CODE_RE.findall(resources[i].get_text(" ")) if c not in codes]
        if not codes:      # 규격 문서가 없으면 이름 끝 모델코드 ("… I DSTWH", "… | F4WR709G")
            m = re.search(r"(?:\||\bI)\s*([A-Z0-9][A-Z0-9\-]{3,})\s*$", name)
            if m and re.search(r"\d", m.group(1)) or (m and len(m.group(1)) >= 5):
                codes = [m.group(1)]
        out.append({"name": name, "thumb": thumb, "codes": list(dict.fromkeys(codes))})
    return out


def _sitemap_urls(cc: str) -> List[str]:
    """국가 sitemap 의 제품 URL 목록 (하루 캐시)."""
    cache = ROOT / "out" / "_sitemaps" / f"{cc}.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < 86400:
        return json.loads(cache.read_text(encoding="utf-8"))
    sm = f"https://www.lg.com/{cc}/sitemap.xml"
    urls = []
    try:
        r = requests.get(sm, headers={"User-Agent": UA}, timeout=60)
        urls = re.findall(r"<loc>([^<]+)</loc>", r.text) if r.ok else []
    except Exception as e:
        print(f"   ⚠️ sitemap 직접 요청 실패: {str(e)[:100]}")
    if not urls:     # 배포 서버(Railway)는 lg.com 직접 요청이 403 → Firecrawl rawHtml (하루 캐시라 국가당 1회)
        try:
            from aem_model import fetch_raw_html
            urls = re.findall(r"<loc>([^<]+)</loc>", fetch_raw_html(sm, os.getenv("FIRECRAWL_API_KEY", "")))
        except Exception as e:
            print(f"   ⚠️ sitemap Firecrawl 실패: {str(e)[:100]}")
    if urls:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(urls), encoding="utf-8")
    return urls


def _lookup_by_code(code: str, cc: str) -> Optional[str]:
    slug = code.lower().strip(".")
    cands = [u for u in _sitemap_urls(cc)
             if "bundles" not in u and u.rstrip("/").split("/")[-1] == slug]
    return cands[0] if cands else None


def find_components(url: str, html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    p = urlparse(url)
    origin = f"{p.scheme}://{p.netloc}"
    cc = p.path.strip("/").split("/")[0]
    ld = _ld_product(soup)
    # Firecrawl html 에는 <head>(ld+json·title)가 없다 → h1 우선
    h1 = soup.find("h1")
    h1t = " ".join(h1.get_text(" ", strip=True).split()) if h1 else ""
    title = (ld.get("name") or h1t or (soup.title.get_text(strip=True) if soup.title else "")).strip()
    bundle_model = ld.get("mpn") or ""
    if not bundle_model:
        m = re.search(r"\|\s*([A-Z0-9][A-Z0-9\-]*\.[A-Z0-9][A-Z0-9.\-]*)\s*$", h1t)
        bundle_model = m.group(1) if m else urlparse(url).path.rstrip("/").split("/")[-1].upper()
    links = _overview_links(soup, url)
    slides = _slides_info(soup, origin)

    comps = []
    n = max(len(links), len(slides))
    for i in range(n):
        sl = slides[i] if i < len(slides) else {"name": "", "thumb": "", "codes": []}
        c = {"index": i + 1, "name": sl["name"], "thumb": sl["thumb"],
             "model": sl["codes"][0] if sl["codes"] else "", "url": None, "found_by": None}
        if i < len(links) and len(links) == len(slides) or (i < len(links) and not slides):
            c["url"], c["found_by"] = links[i], "overview_link"
        comps.append(c)
    # 개요 링크 수가 슬라이드 수와 다르면(일부만 링크) 모델코드로 링크를 짝지음
    if links and slides and len(links) != len(slides):
        for c in comps:
            for l in links:
                if c["model"] and l.rstrip("/").split("/")[-1] == c["model"].lower():
                    c["url"], c["found_by"] = l, "overview_link"
    for c in comps:
        if not c["url"] and c["model"]:
            u = _lookup_by_code(c["model"], cc)
            if u:
                c["url"], c["found_by"] = u, "spec_code+sitemap"
        if not c["model"] and c["url"]:
            c["model"] = c["url"].rstrip("/").split("/")[-1].upper()
        if not c["url"]:
            c["found_by"] = "none"

    set_images = []
    for g in soup.select(".c-gallery__item--display-image img"):
        u = urljoin(origin, (g.get("src") or g.get("data-src") or "").split("?")[0])
        if u and u not in set_images:
            set_images.append(u)
    if not set_images and isinstance(ld.get("image"), str):
        set_images = [ld["image"]]
    return {"bundle_model": bundle_model, "title": title, "set_image": set_images[0] if set_images else "",
            "set_images": set_images, "components": comps}


# ─────────────────────────────────────────────────────────────────────
# 구성품 크롤 + 합치기
# ─────────────────────────────────────────────────────────────────────
def _crawl_component(url: str, slugify, extra_args: List[str]) -> Optional[Path]:
    out = ROOT / "out" / slugify(url)
    out.mkdir(parents=True, exist_ok=True)
    (out / "source.json").write_text(json.dumps({"url": url, "crawled_at": time.time(),
                                                  "via": "bundle_pto"}, indent=2), encoding="utf-8")
    log = open(out / "pipeline.log", "w", encoding="utf-8")
    t = time.time()
    rc = subprocess.call([sys.executable, str(ROOT / "pdp_pipeline.py"), url, "--cache", *extra_args],
                         cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT,
                         env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    log.close()
    ok = rc == 0 and (out / "mirror.json").exists()
    print(f"   {'✓' if ok else '✗'} {url} ({time.time() - t:.0f}s){'' if ok else ' — pipeline.log 참고'}")
    return out if ok else None


def _media(url: str) -> dict:
    return {"pc_url": url, "mobile_url": "", "unified_url": "", "type": "image", "role": "content"}


def _ufn(name: str, model: str) -> str:
    """UFN(User Friendly Name) = 모델 suffix 를 뗀 전체 제품명. 'Trockner … Kondensator I RT80V9W' → 'Trockner … Kondensator'"""
    n = " ".join((name or "").split())
    if model:
        n = re.sub(r"\s*(?:\||\bI\b|–|-)\s*" + re.escape(model) + r"\s*$", "", n, flags=re.I)
    return n.strip(" |")


def merge(info: dict, parts: List[dict]) -> dict:
    """parts: [{comp, mirror|None}] → 한 mirror."""
    sections, specs_tail, cards, gallery, assets = [], [], [], [], []
    stats = {"components_in": 0, "sections": 0, "renderable": 0, "assets_all": 0}
    sections.append({
        "text": f"## {info['title']}", "specs": [], "media": [_media(info["set_image"])] if info["set_image"] else [],
        "component_id": "BUNDLE_PTO", "component_dom_index": -1, "layout_type": "image_text_right",
        "columns": 1, "column_count": 1, "text_alignment": "left", "bundle_part": 0,
    })
    gallery += [_media(u) for u in info.get("set_images") or []]
    for part in parts:
        c, m = part["comp"], part.get("mirror")
        idx = c["index"]
        name = (m or {}).get("product_title") or c["name"]
        ufn = _ufn(c["name"] or name, c["model"])
        sections.append({
            "text": f"## {name}" + (f"\n{c['model']}" if c["model"] and c["model"] not in name else ""),
            "specs": [], "media": [_media(c["thumb"])] if c["thumb"] else [],
            "component_id": "BUNDLE_PTO_ITEM", "component_dom_index": -1, "layout_type": "image_text_right",
            "columns": 1, "column_count": 1, "text_alignment": "left", "bundle_part": idx,
            "bundle_item": {"index": idx, "total": len(parts), "model": c["model"], "ufn": ufn,
                            "thumb": c["thumb"], "url": c["url"]},
        })
        if not m:
            continue
        for s in m.get("sections", []):
            s = {**s, "bundle_part": idx}
            if s.get("component_dom_index") is not None and s["component_dom_index"] >= 0:
                s["component_dom_index"] = idx * 10000 + s["component_dom_index"]   # 제품 간 카드 병합 방지
            if s.get("specs"):
                txt = s.get("text", "")
                s["text"] = re.sub(r"^## .*", f"## {c['model'] or name} — Spezifikationen", txt, count=1) \
                    if txt.startswith("## ") else txt
                specs_tail.append(s)
            else:
                sections.append(s)
        cards += [{**fc, "bundle_part": idx} for fc in m.get("_feature_cards", [])]
        gallery += [{**g, "bundle_part": idx} for g in m.get("_gallery", [])]
        assets += m.get("_assets_all", [])
        for k in stats:
            stats[k] += (m.get("_cf_stats") or {}).get(k, 0) or 0
    sections += specs_tail
    for i, s in enumerate(sections, 1):
        s["order"] = i
    return {
        "product_title": info["title"],
        "note": "lg.com 번들 PTO — 구성품 단품 PDP 크롤 결과를 위→아래로 결합",
        "bundle_pto": {"bundle_model": info["bundle_model"], "set_image": info["set_image"],
                       "components": [{**p["comp"], "slug_ok": bool(p.get("mirror"))} for p in parts]},
        "sections": sections, "_feature_cards": cards, "_gallery": gallery, "_assets_all": assets,
        "_cf_stats": {**stats, "bundle_components": len(parts)},
    }


def run_bundle(url: str, html: str, out: Path, slugify, write_progress, extra_args: List[str]) -> dict:
    info = find_components(url, html)
    print(f"→ [Bundle PTO] {info['bundle_model']} — 구성품 {len(info['components'])}개")
    for c in info["components"]:
        print(f"   #{c['index']} {c['model'] or '?'} [{c['found_by']}] {c['url'] or c['name'][:60]}")
    (out / "bundle_components.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    parts = []
    n = len(info["components"]) or 1
    for i, c in enumerate(info["components"]):
        write_progress(40 + int(50 * i / n), f"번들 구성품 {i + 1}/{n} 크롤 중: {c['model'] or c['name'][:30]}", "bundle")
        m = None
        if c["url"]:
            d = _crawl_component(c["url"], slugify, extra_args)
            if d:
                m = json.loads((d / "mirror.json").read_text(encoding="utf-8"))
                c["slug"] = d.name
        parts.append({"comp": c, "mirror": m})
    write_progress(92, "번들 구성품 결합 중...", "build")
    return merge(info, parts)
