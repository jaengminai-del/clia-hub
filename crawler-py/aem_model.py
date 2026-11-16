"""
aem_model.py — 구형 LG.com PDP: 피처가 HTML 컴포넌트(ST00xx)가 아니라 페이지 안 Next.js 데이터
(`self.__next_f.push(...)`)의 AEM 컴포넌트 트리(overview-section → heroimage_100x …)에만 있는 경우 (2026-11-09).

예: /de/waeschepflege/trockner/rt80v9w/ — 기존 컴포넌트 파서로는 노출 섹션 1개 → Gemini 경로(14분, 추천상품 혼입).
Firecrawl `html` 은 <script> 를 지우므로 원본 HTML(raw)이 필요하다: fetch_raw_html().

지원 컴포넌트 (overview-section 의 :itemsOrder 순서 그대로):
  heroimage               → hero_full_width  (mediaDescriptionModel 이미지 PC/모바일 + headline/bodycopy)
  carousel > sideimage    → 슬라이드마다 섹션, item_group(같은 dom index) → 1차 컨텐츠에서 한 행 카드
  imagetextfoldingfeature → image_text_right (영상은 썸네일 이미지)
  textblock(disclaimer)·experiencefragment·pdpbundle 등 → 제외
"""
import html as _html
import json
import os
import re
from typing import List, Optional

import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')


# ─────────────────────────────────────────────────────────────────────
# 원본 HTML
# ─────────────────────────────────────────────────────────────────────
def fetch_raw_html(url: str, firecrawl_key: str = "") -> str:
    """직접 요청 → 실패/차단(Railway 403 등)이면 Firecrawl rawHtml."""
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8"}, timeout=45)
        if r.ok and "__next_f" in r.text:
            return r.text
    except Exception:
        pass
    if not firecrawl_key:
        return ""
    try:
        r = requests.post("https://api.firecrawl.dev/v1/scrape",
                          headers={"Authorization": f"Bearer {firecrawl_key}"},
                          json={"url": url, "formats": ["rawHtml"], "onlyMainContent": False, "timeout": 90000},
                          timeout=120)
        j = r.json()
        return (j.get("data") or {}).get("rawHtml", "") if j.get("success") else ""
    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────────────
# Next.js 데이터 → overview-section
# ─────────────────────────────────────────────────────────────────────
def _payload(raw: str) -> str:
    out = []
    for c in _PUSH_RE.findall(raw):
        try:
            out.append(json.loads('"' + c + '"'))
        except Exception:
            pass
    return "".join(out)


def _object_at(t: str, i: int) -> Optional[str]:
    depth, ins, esc = 0, False, False
    for j in range(i, len(t)):
        c = t[j]
        if ins:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                ins = False
            continue
        if c == '"':
            ins = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return t[i:j + 1]
    return None


def extract_overview(raw: str) -> Optional[dict]:
    t = _payload(raw)
    key = '"overview-section":'
    i = t.find(key)
    if i < 0:
        return None
    s = _object_at(t, i + len(key))
    try:
        return json.loads(s) if s else None
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────
# AEM 컴포넌트 → mirror 섹션
# ─────────────────────────────────────────────────────────────────────
def _plain(s) -> str:
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>|</p>\s*<p[^>]*>", "\n", str(s), flags=re.I)
    s = re.sub(r"<li[^>]*>", "\n- ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s).replace("\r", "")
    return "\n".join(l.strip() for l in s.split("\n") if l.strip())


def _abs(origin: str, u) -> str:
    if not u:
        return ""
    u = str(u)
    return u if u.startswith("http") else origin + (u if u.startswith("/") else "/" + u)


def _media(md: dict, origin: str) -> List[dict]:
    if not isinstance(md, dict):
        return []
    kind = (md.get("mediaTypeItems") or "image").lower()
    if kind == "video":
        pc = md.get("videoThumbnailImageRef")
        mo = md.get("videoThumbnailImageRefMobile")
        if pc and "/sample/" not in pc:
            return [{"pc_url": _abs(origin, pc), "mobile_url": _abs(origin, mo), "unified_url": "",
                     "type": "image", "role": "content",
                     **({"video_id": md["videoID"], "video_source": md.get("videoSource")} if md.get("videoID") else {})}]
        return []
    if kind == "animation" and md.get("animationRef"):
        return [{"pc_url": _abs(origin, md["animationRef"]), "mobile_url": _abs(origin, md.get("animationRefMobile")),
                 "unified_url": "", "type": "video", "role": "content"}]
    pc = md.get("imageRef")
    if not pc:
        return []
    return [{"pc_url": _abs(origin, pc), "mobile_url": _abs(origin, md.get("imageRefMobile")),
             "unified_url": "", "type": "image", "role": "content"}]


def _texts(node: dict) -> str:
    items = node.get(":items") or {}
    order = node.get(":itemsOrder") or list(items)
    eyebrow, head, body = "", "", []
    for k in order:
        it = items.get(k) or {}
        ty = (it.get(":type") or "").split("/")[-1]
        txt = _plain(it.get("text"))
        if not txt or "disclaimer" in k:
            continue
        if ty == "title" or k in ("headline", "title"):
            head = head or txt
        elif k == "eyebrow":
            eyebrow = txt
        else:
            body.append(txt)
    out = []
    if eyebrow:
        out.append(eyebrow)
    if head:
        out.append("## " + head)
    out += body
    return "\n".join(out)


def _section(text: str, media: list, cid: str, dom: int, layout: str, **extra) -> dict:
    return {"text": text, "specs": [], "item_group": False, "group_heading": "", "media": media,
            "component_id": cid, "component_dom_index": dom, "layout_type": layout,
            "columns": 1, "column_count": 1, "text_alignment": "left", "source": "aem_model", **extra}


def _overlay(node: dict) -> Optional[dict]:
    """heroimage 텍스트 위치 (텍스트가 이미지 위에 얹힘) → component_parser._text_overlay 와 같은 형식.
    PC: textBlockHorizontalAlign (c-hero-banner--main-pos-left|right|center)
    모바일: textBlockVerticalIconBlockMobileAlign (text-vertical-top--mobile) / textBlockVerticalMobileAlign"""
    h = str(node.get("textBlockHorizontalAlign") or "")
    pc = next((p for p in ("left", "right", "center") if h.endswith("pos-" + p)), "center")
    mv = " ".join(str(node.get(k) or "") for k in ("textBlockVerticalMobileAlign", "textBlockVerticalIconBlockMobileAlign"))
    mobile = next((p for p in ("top", "bottom", "middle") if p in mv), "top")
    return {"pc": pc, "mobile": mobile}


def to_sections(overview: dict, origin: str = "https://www.lg.com") -> List[dict]:
    items = overview.get(":items") or {}
    order = overview.get(":itemsOrder") or list(items)
    secs = []
    for dom, k in enumerate(order):
        node = items.get(k) or {}
        ty = (node.get(":type") or "").split("/")[-1]
        if ty == "heroimage":
            m = _media(node.get("mediaDescriptionModel"), origin)
            t = _texts(node)
            if m or t:
                ov = _overlay(node) if t else None
                secs.append(_section(t, m, "AEM_HEROIMAGE", 5000 + dom, "hero_full_width",
                                     **({"text_overlay": ov} if ov else {})))
        elif ty == "carousel":
            kids = node.get(":items") or {}
            korder = node.get(":itemsOrder") or list(kids)
            slides = []
            for kk in korder:
                sn = kids.get(kk) or {}
                ml = sn.get("mediaDescriptionList") or [sn.get("mediaDescriptionModel")]
                m = [x for md in ml for x in _media(md, origin)][:1]
                t = _texts(sn)
                if m or t:
                    slides.append((t, m))
            n = len(slides)
            for t, m in slides:
                secs.append(_section(t, m, "AEM_CAROUSEL", 5000 + dom,
                                     "image_text_right" if n == 1 else f"grid_{min(n, 4)}_column",
                                     item_group=n > 1, column_count=min(n, 4)))
        elif ty in ("imagetextfoldingfeature", "imagelayeredtext", "imagectaoverlay", "blockimage"):
            md = node.get("mediaDescriptionModel")
            ml = node.get("mediaDescriptionList") or ([md] if md else [])
            m = [x for d in ml for x in _media(d, origin)]
            t = _texts(node)
            if m or t:
                secs.append(_section(t, m, "AEM_" + ty.upper(), 5000 + dom, "image_text_right"))
    return secs


def build_sections(url: str, firecrawl_key: str = "", raw: str = "") -> List[dict]:
    """URL → AEM 피처 섹션 (없으면 [])."""
    origin = "https://" + url.split("//", 1)[-1].split("/", 1)[0]
    raw = raw or fetch_raw_html(url, firecrawl_key)
    ov = extract_overview(raw) if raw else None
    return to_sections(ov, origin) if ov else []


if __name__ == "__main__":
    import sys
    raw = open(sys.argv[1], encoding="utf-8", errors="ignore").read() if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else ""
    secs = build_sections(sys.argv[-1] if raw == "" else "https://www.lg.com/x", raw=raw)
    for s in secs:
        print(s["component_id"], s["layout_type"], len(s["media"]), "|", s["text"][:80].replace("\n", " / "))
