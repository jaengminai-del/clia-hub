# -*- coding: utf-8 -*-
"""
features.py — 크롤 결과(mirror.json) → Amazon A+ 선택 화면의 카드 목록

브라우저 빌더(amazon-aplus/index-test3.html)의 다음 함수를 그대로 옮겼다 (2026-10-16, 결과 동일 검증):
  mirrorToFeatures → (headline 또는 이미지 있는 것만) → expandFeaturesForSelection → sanitizeAmazonDeep

  카드 1장 = 생성될 모듈 1개. 카드(feature) 형식은 브라우저와 같다:
    {headline, subheadline, body, bullets, images:[{url, alt, nearText, ...}], cardItems?, layout:{imgsPerRow, ...},
     award?, badges?, stacked?, _splitFrom?, _splitIdx?}
"""
import re

from .jsutil import jlen, js_or, jslice, trim, truthy, ws

_UNDEF = object()   # JS undefined (JSON null 과 구분: undefined === null 은 거짓)

# 배지 파일명 규칙 — component_parser.AWARD_FILE_RE 와 동일 ('award-winning' 기능 이미지는 제외)
AWARD_FILE_RE = re.compile(
    r"(badge|award(?![-_ ]?winning)|reddot|red[-_]dot|testurteil|editors?[-_]?choice|best[-_]?of[-_]?(the[-_]?best|ces|show)|winner)",
    re.I)
_VIDEO_RE = re.compile(r"\.(mp4|webm|mov)(\?|$)", re.I)
_DISC_ORDER_RE = re.compile(r"disclaimer", re.I)
_DISC_TEXT_RE = re.compile(ws(r"^\s*[*※]"))
_HASH_RE = re.compile(ws(r"^#+\s*"))
_HEAD_RE = re.compile(ws(r"^\s*#{1,3}\s"))
_HLINE_RE = re.compile(ws(r"^#{1,3}\s"))
_FOOTNOTE_RE = re.compile(r"^[*※]")


def _best_url(m: dict) -> str:
    return js_or(m.get("pc_url"), m.get("unified_url"), m.get("mobile_url"), "")


def _not_null(v) -> bool:
    return v is not None and v is not _UNDEF


def _jsstr(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _media0(sec: dict, key: str):
    """JS sec.media[0]?.key (없으면 None)."""
    return sec["media"][0].get(key) if sec["media"] else None


def _normalize(s: dict) -> dict:
    text = js_or(s.get("text"), "")
    lines = [l for l in (trim(_HASH_RE.sub("", l, count=1)) for l in text.split("\n")) if l]
    eyebrow, headline, body = "", (lines[0] if lines else ""), "\n".join(lines[1:])
    if len(lines) >= 2 and jlen(lines[0]) <= 40 and jlen(lines[1]) > jlen(lines[0]):
        eyebrow, headline, body = lines[0], lines[1], "\n".join(lines[2:])
    # role==='icon': 크롤러가 태깅한 UI 보조 에셋(탭 아이콘·캐러셀 썸네일) — 컨텐츠화 금지
    media = [m for m in (s.get("media") or [])
             if truthy(_best_url(m)) and not _VIDEO_RE.search(_best_url(m)) and m.get("role") != "icon"]
    is_head = bool(_HEAD_RE.search(text))
    # 수상·인증 배지: Award 컴포넌트(ST0053) · 배지 파일명 · 배너에서 잘라낸 배지
    award = len(media) > 0 and (s.get("component_id") == "ST0053" or all(
        (truthy(m.get("crop")) and m["crop"].get("kind") == "badge")
        or AWARD_FILE_RE.search(_best_url(m).split("?")[0].split("/")[-1]) for m in media))
    raw = [l for l in (trim(l) for l in text.split("\n")) if l]
    h_idx = next((k for k, l in enumerate(raw) if _HLINE_RE.search(l)), -1)
    badge_title = _HASH_RE.sub("", raw[h_idx] if h_idx >= 0 else (raw[0] if raw else ""), count=1)
    skip = h_idx if h_idx >= 0 else 0
    badge_body = " ".join(_HASH_RE.sub("", l, count=1) for k, l in enumerate(raw) if k != skip)
    return {"eyebrow": eyebrow, "headline": headline, "body": body, "media": media,
            "cc": js_or(s.get("column_count"), 0), "domIdx": s.get("component_dom_index", _UNDEF),
            "lt": js_or(s.get("layout_type"), ""), "isHead": is_head, "award": award,
            "badgeTitle": badge_title, "badgeBody": badge_body,
            "groupHeading": js_or(s.get("group_heading"), ""), "stacked": truthy(s.get("stacked"))}


def _sources(m: dict):
    """텍스트 오버레이 히어로의 이미지 후보 (C 방식 자동 선택, 2026-10-16).
    PC 원본(빈 영역 자름) · 모바일(빈 띠 자름) — 모듈 칸 비율에 덜 잘리는 쪽을 modules.py 가 고른다."""
    out = []
    pc_crop = m.get("pc_crop") or ((m.get("crop") or {}) if (m.get("crop") or {}).get("kind") == "overlay_band" else None)
    if pc_crop:
        out.append({"url": _best_url(m), "crop": pc_crop})
    if m.get("mobile_crop") and m.get("mobile_url"):
        out.append({"url": m["mobile_url"], "crop": m["mobile_crop"]})
    return out or None


def _to_imgs(media: list) -> list:
    out = []
    for m in media:
        img = {"url": _best_url(m), "alt": "", "nearText": "", "width": 0, "height": 0, "ar": 0}
        src = _sources(m)
        if src:
            img["sources"] = src
        out.append(img)
    return out


def _cardish(lt) -> bool:
    return bool(re.match(r"^grid_", lt or "")) or lt == "icon_grid"


def _promote_heading(feats: list) -> str:
    """직전 텍스트 단독(대제목)을 그룹 헤딩으로 승격 — 디스클레이머/각주는 제외."""
    prev = feats[-1] if feats else None
    if (prev and len(prev["images"]) == 0 and truthy(prev["headline"])
            and not _FOOTNOTE_RE.search(prev["headline"]) and jlen(prev["headline"]) < 60):
        feats.pop()
        return prev["headline"]
    return ""


def mirror_to_features(mirror: dict) -> list:
    secs = [_normalize(s) for s in (mirror.get("sections") or [])
            if not (_DISC_ORDER_RE.search(_jsstr(js_or(s.get("order"), "")))
                    or _DISC_TEXT_RE.search(js_or(s.get("text"), "")))]
    feats = []
    i = 0
    while i < len(secs):
        s = secs[i]
        rg, cols = _media0(s, "row_group"), js_or(_media0(s, "columns"), 0)

        # ★ 수상·인증 배지: 같은 컴포넌트의 배지를 한 카드로 → 개수에 따라 모듈 자동 배정
        if s["award"]:
            badges, j = [], i
            while j < len(secs) and secs[j]["award"] and (
                    j == i or (_not_null(s["domIdx"]) and secs[j]["domIdx"] == s["domIdx"])):
                for m in secs[j]["media"]:
                    badges.append({"imageUrl": _best_url(m), "crop": js_or(m.get("crop"), None),
                                   "title": secs[j]["badgeTitle"], "body": secs[j]["badgeBody"]})
                j += 1
            one = len(badges) == 1
            feats.append({
                "headline": badges[0]["title"] if one else (
                    s["groupHeading"] if (truthy(s["groupHeading"]) and s["groupHeading"] != badges[0]["title"]) else ""),
                "subheadline": "",
                "body": badges[0]["body"] if one else "",
                "bullets": [], "award": True, "badges": badges,
                "images": [{"url": b["imageUrl"], "alt": "", "nearText": b["title"], "crop": b["crop"]} for b in badges],
                "cardItems": [{"imageUrl": b["imageUrl"], "title": b["title"], "body": b["body"]} for b in badges],
                "layout": {"imgsPerRow": min(len(badges), 4), "fullWidth": False},
            })
            i = j
            continue

        # 0) 컴포넌트(domIdx) 기준 카드 그리드 (grid_*/icon_grid)
        if _cardish(s["lt"]) and _not_null(s["domIdx"]):
            cards, heading, j = [], "", i
            while j < len(secs) and secs[j]["domIdx"] == s["domIdx"]:
                nx = secs[j]
                if nx["media"]:
                    for m in nx["media"]:
                        cards.append({"imageUrl": _best_url(m), "title": nx["headline"], "body": nx["body"]})
                elif nx["isHead"] and not truthy(heading):
                    heading = nx["headline"]
                j += 1
            if len(cards) >= 2:
                cc = s["cc"] if s["cc"] >= 2 else min(len(cards), 4)
                for k in range(0, len(cards), cc):
                    chunk = cards[k:k + cc]
                    feats.append({
                        "headline": js_or(heading, "") if k == 0 else "", "subheadline": "", "body": "", "bullets": [],
                        "images": [{"url": c["imageUrl"], "alt": "", "nearText": c["title"]} for c in chunk],
                        "cardItems": chunk,
                        "layout": {"imgsPerRow": cc, "fullWidth": False, "columnCount": cc},
                    })
                i = j
                continue

        # 1) DOM 선언 컬럼(column_count) 최우선
        if s["cc"] >= 2:
            group, j = [s], i + 1
            while (j < len(secs) and secs[j]["cc"] == s["cc"] and secs[j]["media"]
                   and (not _not_null(s["domIdx"]) or secs[j]["domIdx"] == s["domIdx"])):
                group.append(secs[j])
                j += 1
            cards = []
            for g in group:
                if len(g["media"]) <= 1:
                    if g["media"]:
                        cards.append({"imageUrl": _best_url(g["media"][0]), "title": g["headline"], "body": g["body"]})
                else:
                    for k, m in enumerate(g["media"]):
                        cards.append({"imageUrl": _best_url(m), "title": g["headline"] if k == 0 else "",
                                      "body": g["body"] if k == 0 else ""})
            with_img = [c for c in cards if truthy(c["imageUrl"])]
            if len(with_img) >= 2:
                group_headline = _promote_heading(feats)
                ey = group[0]["eyebrow"]
                clean_eyebrow = ey if (truthy(ey) and not _FOOTNOTE_RE.search(ey)) else ""
                for k in range(0, len(with_img), s["cc"]):
                    chunk = with_img[k:k + s["cc"]]
                    feats.append({
                        "headline": js_or(group_headline, clean_eyebrow, "") if k == 0 else "",
                        "subheadline": "", "body": "", "bullets": [],
                        "images": [{"url": c["imageUrl"], "alt": "", "nearText": c["title"]} for c in chunk],
                        "cardItems": chunk,
                        "layout": {"imgsPerRow": s["cc"], "fullWidth": False, "columnCount": s["cc"]},
                    })
                i = j
                continue

        # 2) 가로 행 병합: 인접 섹션들의 media가 같은 row_group → 카드 그룹 하나로
        if truthy(rg) and cols >= 2:
            group, j = [s], i + 1
            while j < len(secs) and _media0(secs[j], "row_group") == rg:
                group.append(secs[j])
                j += 1
            if len(group) >= 2:
                group_headline = _promote_heading(feats)
                feats.append({
                    "headline": js_or(group_headline, group[0]["eyebrow"], "Key Features"),
                    "subheadline": "", "body": "", "bullets": [],
                    "images": _to_imgs([m for g in group for m in g["media"]]),
                    "cardItems": [{"imageUrl": _best_url(g["media"][0] if g["media"] else {}),
                                   "title": g["headline"], "body": g["body"]} for g in group],
                    "layout": {"imgsPerRow": cols, "fullWidth": False},
                })
                i = j
                continue

        # 3) 단독 섹션 → 개별 feature
        f = {}
        if s["stacked"] and len(s["media"]) >= 2:
            f["stacked"] = True            # 이어 붙은 히어로 → 모듈에서 한 장으로 합친다
        col0 = _media0(s, "columns")
        f.update({
            "headline": s["headline"], "subheadline": s["eyebrow"], "body": s["body"], "bullets": [],
            "images": _to_imgs(s["media"]),
            "layout": {"imgsPerRow": js_or(col0, 1 if s["media"] else 0),
                       "fullWidth": len(s["media"]) == 1 and not truthy(col0)},
        })
        feats.append(f)
        i += 1
    # 텍스트만 있는 섹션(이미지 없음) 제외
    return [f for f in feats if f.get("images") or f.get("cardItems")]


def expand_for_selection(features: list) -> list:
    """카드 1장 = 모듈 1개 단위로 펼침 (가로 행이 아닌 다중 이미지 → 이미지별 카드, 배지 2개 → 카드 2장)."""
    out = []
    for f in features:
        if f.get("award"):
            if len(f.get("badges") or []) == 2:
                for b in f["badges"]:
                    out.append({**f, "headline": b["title"], "body": b["body"], "badges": [b],
                                "images": [{"url": b["imageUrl"], "alt": "", "nearText": b["title"], "crop": b["crop"]}],
                                "cardItems": [{"imageUrl": b["imageUrl"], "title": b["title"], "body": b["body"]}],
                                "layout": {"imgsPerRow": 1}})
            else:
                out.append(f)
            continue
        if f.get("stacked"):
            out.append(f)
            continue
        imgs = f.get("images") or []
        per_row = js_or((f.get("layout") or {}).get("imgsPerRow"), 0)
        if per_row == 3 or per_row >= 4 or len(imgs) < 2:
            out.append(f)
            continue
        bullets = f.get("bullets")
        for i, img in enumerate(imgs):
            near, alt = img.get("nearText"), img.get("alt")
            if truthy(near) and jlen(trim(near)) > 2:
                t = trim(near)
            elif truthy(alt) and jlen(trim(alt)) > 2:
                t = trim(alt)
            else:
                t = js_or(f.get("headline") if i == 0 else js_or(bullets[i] if bullets and i < len(bullets) else None,
                                                                  f.get("headline")), "Feature")
            title = jslice(t, 120)
            if truthy(near) and jlen(trim(near)) > 20 and trim(near) != title:
                body = trim(near)
            else:
                body = js_or(f.get("body"), "") if i == 0 else js_or(
                    bullets[i] if bullets and i < len(bullets) else None, "")
            g = {**f}
            g.pop("cardItems", None)        # JS: cardItems: undefined
            g.update({
                "headline": js_or(title, f.get("headline"), "Feature"),
                "subheadline": js_or(f.get("subheadline"), "") if i == 0 else "",
                "body": jslice(js_or(body, ""), 600),
                "bullets": [],
                "images": [img],
                "layout": {"imgsPerRow": 0, "fullWidth": False},
                "_splitFrom": js_or(f.get("headline"), ""),
                "_splitIdx": i,
            })
            out.append(g)
    return out


# Amazon A+ 텍스트 규정: ® ™ © 각주 기호 · 위첨자 · 장식 문자 · 이모지가 있으면 승인 거부 → 제거
_BANNED = re.compile(
    "[®™℠©℗]"
    "|[*＊∗✱⁎]"
    "|[†‡§¶※⁂]"
    "|[¹²³⁰ⁱ⁴-ⁿ]"
    "|[•‣■-◿★☆]"
    "|[←-⇿➔-➿]"
    "|[☀-⛿✀-➓]"
    "|[️​-‍﻿]"
    "|[\U0001F000-\U0001FAFF]")
_EMPTY_PAREN = re.compile(ws(r"\(\s*\)"))
_MULTI_SP = re.compile("[ \t ]{2,}")
_SP_BEFORE_PUNCT = re.compile(r"[ \t]+([,.;:!?%)\]])")
# URL·식별자는 건드리지 않는다
SKIP_KEYS = {"url", "imageUrl", "pc_url", "mobile_url", "unified_url", "src", "srcset",
             "href", "videoUrl", "poster", "thumbnail", "id", "moduleId", "component_id"}


def strip_amazon_symbols(s):
    if not isinstance(s, str) or not s:
        return s
    s = _BANNED.sub("", s)
    s = _EMPTY_PAREN.sub("", s)
    s = _MULTI_SP.sub(" ", s)
    s = _SP_BEFORE_PUNCT.sub(r"\1", s)
    s = "\n".join(trim(l) for l in s.split("\n"))
    return trim(s)


def sanitize_deep(v):
    if isinstance(v, str):
        return strip_amazon_symbols(v)
    if isinstance(v, list):
        return [sanitize_deep(x) for x in v]
    if isinstance(v, dict):
        return {k: (x if k in SKIP_KEYS else sanitize_deep(x)) for k, x in v.items()}
    return v


def build_features(mirror: dict, spec: dict = None) -> list:
    """브라우저 analyzePDP 와 같은 순서: 카드 정리 → 필터 → 펼치기 → 기호 제거.
    이미지 후보(sources)가 있으면 선택 창 썸네일용 previewUrl = 기본 모듈(970×600) 칸 기준 자동 선택 결과."""
    raw = [f for f in mirror_to_features(mirror) if truthy(f.get("headline")) or f.get("images")]
    feats = sanitize_deep(expand_for_selection(raw))
    if spec:
        from .modules import pick_source
        w, h = spec["module_image_specs"][spec["default_module"]][0]
        for f in feats:
            for img in f.get("images") or []:
                if img.get("sources"):
                    best = pick_source(img, w, h)
                    if best:
                        img["previewUrl"] = best[0]
    return feats
