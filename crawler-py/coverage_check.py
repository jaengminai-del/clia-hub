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
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

from component_parser import ComponentParser

_ID_RE = re.compile(r"\b(ST|PD|CM|PR|PN|GN|AL|CS)\d{4}\b")
SKIP_PREFIX = ("CM", "GN", "AL", "PN", "CS")
SKIP_IDS = {"PD0001", "PD0002", "PD0004", "PD0006", "PD0044", "PD0056", "PD0012", "PD0033", "ST0010",
            "ST0025", "ST0049", "PD0050",   # ST0025·ST0049·PD0050 = FAQ (하단 비컨텐츠 영역 — 크롤 제외 원칙)
            "PD0016", "PD0022"}   # PD0022 = 추천 상품·액세서리 제목(2026-11-26, 컨텐츠 아님) · PD0016 = 구매처(Where to buy: 매장 찾기·온라인 판매처) — 제품 썸네일이 들어 있지만 컨텐츠가 아님 (2026-11-23, TH FB1209D5M)
_TEXT_TAGS = ("h1", "h2", "h3", "h4", "h5", "p", "li")
_UI_RE = re.compile(r"(^|[-_\s])(button|cta|sr-only|blind|visually-hidden|tablist|pagination|indicator)", re.I)
_ICON_RE = re.compile(r"\.svg($|\?)|/icon|[-_]icon[-_.]|[-_](on|off)\.(png|jpe?g)", re.I)


def _norm(s: str) -> str:
    """비교용 정규화 — 공백을 모두 없앤다 (각주 '3)'·<sup> 앞뒤 띄어쓰기 차이로 오탐하지 않게)."""
    s = re.sub("[\u2122\u00ae\u00a9*\u200b\u00a0]", "", s or "")
    return re.sub(r"\s+", "", s).lower()


# 화면 조작용 글자: 규격 탭 이름, 캐러셀 · 동영상 버튼 글자. 결과 컨텐츠에 일부러 넣지 않으므로 '빠진 글'로 세지 않는다.
# 캐러셀 버튼 글자는 실제 캡션 뒤에 붙어 한 덩어리로 나온다 ("… 캡션 ก่อนหน้า วิดีโอหยุดชั่วคราว ก่อนหน้า วิดีโอหยุดชั่วคราว")
# — 버튼 글자를 떼고 남은 캡션이 결과에 있으면 있는 것으로 본다. (2026-11-20, TH WT2116SHEG·ISC10E 재현)
_UI_CONTROL_RE = re.compile(
    r"(?:ก่อนหน้า|ถัดไป|previous|next|zurück|weiter)?\s*"
    r"(?:วิดีโอ(?:หยุดชั่วคราว|กำลังเล่น|เล่น)|video\s+(?:paused|playing|play)|video\s+(?:pausiert|wiedergabe))", re.I)
_UI_TAB_LABELS = {"สรุป", "สเปคทั้งหมด", "ข้อมูลจำเพาะทั้งหมด", "summary", "all specs", "all specifications",
                  "zusammenfassung", "alle spezifikationen"}


def _only_ui(t: str, blob: str) -> bool:
    """텍스트가 화면 조작 글자뿐이거나, 그것을 떼면 남는 부분이 모두 결과에 있으면 True."""
    t = (t or "").strip()
    if _norm(t) in {_norm(x) for x in _UI_TAB_LABELS}:
        return True
    parts = [_norm(x) for x in _UI_CONTROL_RE.split(t)]
    parts = [x for x in parts if len(x) >= 2]
    if len(parts) == 0 and _UI_CONTROL_RE.search(t):
        return True
    return bool(_UI_CONTROL_RE.search(t)) and all(x in blob for x in parts)


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
    parser = ComponentParser(html)
    wrapper_class = re.compile(r"c-wrapper")
    wrappers = parser.soup.find_all(class_=wrapper_class)

    def owned_by(node, wrapper):
        return node.find_parent(class_=wrapper_class) is wrapper
    parser.parse_all()
    counts = Counter(cls for w in wrappers for cls in w.get("class", []) if _ID_RE.fullmatch(cls))
    out = []
    for w in wrappers:
        m = _ID_RE.search(" ".join(w.get("class") or []))
        cid = m.group(0) if m else ""
        if cid[:2] in SKIP_PREFIX or cid in SKIP_IDS or (not cid and not w.find_parent(class_=wrapper_class)):
            continue
        texts, seen = [], set()
        for el in w.find_all(_TEXT_TAGS):
            if not owned_by(el, w) or el.find(_TEXT_TAGS) or el.find(class_=wrapper_class) or _is_ui(el):
                continue
            t = re.sub(r"\s+", " ", el.get_text(" ", strip=True))
            k = _norm(t)
            if len(k) < 4 or k in seen or t.lstrip().startswith(("*", "※")) or re.match(r"^\d+\)", t):
                continue
            seen.add(k)
            texts.append(t)
        imgs, iseen = [], set()
        for pic in w.find_all(["picture", "img"]):
            if not owned_by(pic, w):
                continue
            if pic.name == "img" and pic.find_parent("picture"):
                continue
            if _is_ui(pic) or ComponentParser._is_ui_control_media(pic):
                continue                                   # 링크·클릭 동작이 걸린 UI 이미지 — 크롤러와 같은 규칙
            urls = []
            if pic.name == "picture":
                urls = [s.get("srcset", "").split(",")[0].strip() for s in pic.find_all("source") if owned_by(s, w)]
                img = next((im for im in pic.find_all("img") if owned_by(im, w)), None)
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
        specs = []
        if cid in ComponentParser.SPEC_COMPONENT_IDS:
            pairs, _ = parser._parse_spec_pairs(w, owns=lambda node: owned_by(node, w))
            specs = [{"label": pair.label, "value": pair.value} for pair in pairs]
        if texts or imgs or specs:
            out.append({"component_id": cid, "section": cid if counts[cid] == 1 else None,
                        "source_key": parser.source_keys.get(id(w)),
                        "texts": texts, "images": imgs, "specs": specs})
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
    # 크롤러가 일부러 뺀 이미지(LG 가 404·자리표시를 내줌, mirror._dead_media_dropped)는 누락이 아니다.
    # 단 주소가 겹쳐 있던 것(…/wcms/content/dam/channel/wcms/…)은 실제 이미지를 잃은 것이라 세지 않을 이유가 없다.
    dead = set()
    for d in mirror.get("_dead_media_dropped") or []:
        u = d.get("url") or ""
        if re.search(r"(?:/content/dam/channel/wcms){2,}", u):
            continue
        dead |= {_img_key(u), _img_key(unquote(u))}
    missing_t, missing_i, n_t, n_i, n_dead = [], [], 0, 0, 0
    for c in inv:
        for t in c["texts"]:
            n_t += 1
            if _norm(t) not in blob and not _only_ui(t, blob):
                missing_t.append({"component_id": c["component_id"], "section": c["section"], "source_key": c["source_key"], "text": t,
                                  "only_in_cards": _norm(t) in card_blob})
        for im in c["images"]:
            n_i += 1
            if not (set(im["keys"]) & have):
                if set(im["keys"]) & dead:
                    n_dead += 1          # LG 에도 없는 이미지 — 의도한 제외
                    continue
                missing_i.append({"component_id": c["component_id"], "section": c["section"], "source_key": c["source_key"], "image": im["url"],
                                  "only_in_cards": bool(set(im["keys"]) & card_imgs)})
    return {
        "source_ownership": 2,
        "texts_total": n_t, "texts_missing": len(missing_t),
        "images_total": n_i, "images_missing": len(missing_i), "images_dead_on_lg": n_dead,
        "source_specs": [{"component_id": c["component_id"], "section": c["section"], "source_key": c["source_key"], "rows": c["specs"]}
                         for c in inv if c["specs"]],
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
