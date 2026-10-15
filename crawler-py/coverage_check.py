# -*- coding: utf-8 -*-
"""
coverage_check.py — 크롤 누락 자동 점검 (AI 호출 없음)

Gemini 시각 QA 대신, 크롤러가 받은 HTML(pc.html)의 컨텐츠 컴포넌트에 있는 문구·이미지가
최종 컨텐츠(mirror.json)에 모두 들어갔는지 코드로 대조한다. 빠진 항목은 qa_report.json 에 목록으로 남긴다.

제외: 페이지 크롬(CM·PN 등), 추천·리뷰·지원(PD0001/2/4/6/44/56), 갤러리(PD0012/PD0033 — 별도 _gallery),
      디스클레이머(ST0010·*로 시작하는 주석), 버튼·탭 버튼·스크린리더 전용 문구, 아이콘 이미지.

    python coverage_check.py <out/slug 디렉토리>      # 점검 결과 출력
"""
import json
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup

from component_parser import ComponentParser

_ID_RE = re.compile(r"\b(ST|PD|CM|PR|PN|GN|AL|CS)\d{4}\b")
SKIP_PREFIX = ("CM", "GN", "AL", "PN", "CS")
SKIP_IDS = {"PD0001", "PD0002", "PD0004", "PD0006", "PD0044", "PD0056", "PD0012", "PD0033", "ST0010",
            "ST0025", "ST0049", "PD0050"}   # ST0025·ST0049·PD0050 = FAQ (하단 비컨텐츠 영역 — 크롤 제외 원칙)
_TEXT_TAGS = ("h1", "h2", "h3", "h4", "h5", "p", "li")
_UI_RE = re.compile(r"(^|[-_\s])(button|cta|sr-only|blind|visually-hidden|tablist|pagination|indicator)", re.I)
_ICON_RE = re.compile(r"\.svg($|\?)|/icon|[-_]icon[-_.]|[-_](on|off)\.(png|jpe?g)", re.I)


def _norm(s: str) -> str:
    """비교용 정규화 — 공백을 모두 없앤다 (각주 '3)'·<sup> 앞뒤 띄어쓰기 차이로 오탐하지 않게)."""
    s = re.sub("[\u2122\u00ae\u00a9*\u200b\u00a0]", "", s or "")
    return re.sub(r"\s+", "", s).lower()


def _img_key(u: str) -> str:
    u = (u or "").split("?")[0]
    u = re.sub(r"/jcr:content/.*$", "", u)
    k = u.rsplit("/", 1)[-1].lower().replace("%20", " ")
    return re.sub(r"[._-]\d{2,4}x\d{2,4}", "", k)


def _is_ui(el) -> bool:
    for p in [el, *el.parents]:
        if getattr(p, "name", None) in ("button", "script", "style", "noscript"):
            return True
        if p.get("role") in ("tab", "tablist") if hasattr(p, "get") else False:
            return True
        cls = " ".join(p.get("class") or []) if hasattr(p, "get") else ""
        if cls and _UI_RE.search(cls):
            return True
        if getattr(p, "name", None) == "body":
            break
    return False


def html_inventory(html: str) -> list:
    """컨텐츠 컴포넌트별 문구·이미지 목록."""
    soup = BeautifulSoup(html, "html.parser")
    wrappers = soup.find_all(class_=re.compile(r"c-wrapper"))
    out = []
    for w in wrappers:
        if w.find_parent(class_=re.compile(r"c-wrapper")):
            continue                                   # 중첩 래퍼는 바깥 것에서 함께 본다
        m = _ID_RE.search(" ".join(w.get("class") or []))
        cid = m.group(0) if m else ""
        if not cid or cid[:2] in SKIP_PREFIX or cid in SKIP_IDS:
            continue
        texts, seen = [], set()
        for el in w.find_all(_TEXT_TAGS):
            if el.find(_TEXT_TAGS) or _is_ui(el):
                continue
            t = re.sub(r"\s+", " ", el.get_text(" ", strip=True))
            k = _norm(t)
            if len(k) < 4 or k in seen or t.lstrip().startswith(("*", "※")) or re.match(r"^\d+\)", t):
                continue
            seen.add(k)
            texts.append(t)
        imgs, iseen = [], set()
        for pic in w.find_all(["picture", "img"]):
            if pic.name == "img" and pic.find_parent("picture"):
                continue
            if _is_ui(pic) or ComponentParser._is_ui_control_media(pic):
                continue                                   # 링크·클릭 동작이 걸린 UI 이미지 — 크롤러와 같은 규칙
            urls = []
            if pic.name == "picture":
                urls = [s.get("srcset", "").split(",")[0].strip() for s in pic.find_all("source")]
                img = pic.find("img")
                if img is not None:
                    urls.append(img.get("src") or img.get("data-src") or "")
            else:
                urls = [pic.get("src") or pic.get("data-src") or ""]
            urls = [u for u in urls if u and not u.startswith("data:")]
            if not urls or all(_ICON_RE.search(u) for u in urls):
                continue
            keys = {_img_key(re.sub(r"\s+\d+(\.\d+)?[wx]$", "", u)) for u in urls}
            if keys & iseen:
                continue
            iseen |= keys
            imgs.append({"url": urls[-1], "keys": sorted(keys)})
        if texts or imgs:
            out.append({"component_id": cid, "texts": texts, "images": imgs})
    return out


def check(html: str, mirror: dict) -> dict:
    """HTML 컨텐츠 vs mirror → 누락 목록."""
    # 컨텐츠 = mirror 섹션(+갤러리). 카드 후보(_feature_cards)에만 있는 항목은 컨텐츠에 안 나오므로 누락으로 본다.
    def text_blob(entries):
        return _norm(" ".join(
            (e.get("text") or "") + " " + (e.get("group_heading") or "") + " " +
            " ".join(v.get("label") or "" for v in (e.get("compare") or {}).values()) + " " +
            " ".join(f"{x.get('label', '')} {x.get('value', '')} {x.get('group') or ''}" for x in e.get("specs") or [])
            for e in entries))

    def img_keys(entries):
        return {_img_key(x.get(k)) for e in entries for x in e.get("media", [])
                for k in ("pc_url", "mobile_url", "unified_url") if x.get(k)}

    sections, cards = mirror.get("sections", []), mirror.get("_feature_cards", [])
    blob, card_blob = text_blob(sections), text_blob(cards)
    have, card_imgs = img_keys(sections), img_keys(cards)
    have |= {_img_key(g.get(k)) for g in mirror.get("_gallery") or [] for k in ("pc_url", "mobile_url") if g.get(k)}

    inv = html_inventory(html)
    missing_t, missing_i, n_t, n_i = [], [], 0, 0
    for c in inv:
        for t in c["texts"]:
            n_t += 1
            if _norm(t) not in blob:
                missing_t.append({"component_id": c["component_id"], "text": t[:160],
                                  "only_in_cards": _norm(t) in card_blob})
        for im in c["images"]:
            n_i += 1
            if not (set(im["keys"]) & have):
                missing_i.append({"component_id": c["component_id"], "image": im["url"].split("?")[0][-120:],
                                  "only_in_cards": bool(set(im["keys"]) & card_imgs)})
    return {
        "texts_total": n_t, "texts_missing": len(missing_t),
        "images_total": n_i, "images_missing": len(missing_i),
        "missing_texts": missing_t[:40], "missing_images": missing_i[:40],
    }


if __name__ == "__main__":
    d = Path(sys.argv[1])
    r = check((d / "pc.html").read_text(encoding="utf-8"), json.loads((d / "mirror.json").read_text(encoding="utf-8")))
    print(f"문구 {r['texts_total']}개 중 누락 {r['texts_missing']} · 이미지 {r['images_total']}장 중 누락 {r['images_missing']}")
    for x in r["missing_texts"]:
        print(f"  TEXT [{x['component_id']}]{' (카드후보만)' if x['only_in_cards'] else ''} {x['text'][:110]}")
    for x in r["missing_images"]:
        print(f"  IMG  [{x['component_id']}]{' (카드후보만)' if x['only_in_cards'] else ''} {x['image']}")
