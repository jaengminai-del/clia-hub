# -*- coding: utf-8 -*-
"""
aem_model.py — LG.com 페이지에 실려 오는 AEM 컴포넌트 모델(Next.js flight 데이터)로 미러 섹션 만들기 (2026-11-07)

왜: 예전 형식 PDP(heroimage · keybenefitssummary · imagetextfoldingfeature …)는 CCG 컴포넌트 파서가
    읽지 못해 스펙 표만 남고, 그 뒤 AI 경로는 서버 스크린샷이 LG 봇 차단(Access Denied)에 막혀
    기능 컨텐츠가 통째로 빠졌다 (TH 배치 537개 중 281개가 기능 이미지 0%). 그런데 페이지 HTML 안의
    self.__next_f.push(...) 데이터에 그 페이지의 컴포넌트 모델(글·이미지·순서)이 그대로 들어 있다.
    → 스크린샷·AI 없이 원문 그대로의 섹션을 만든다. 글·주소는 원문 그대로, 생성 서술 없음.

또한 받은 HTML 이 정말 요청한 제품 페이지인지 확인한다 (page_check): Firecrawl 이 가끔 차단 화면이나
LG 홈/프로모션 페이지를 돌려줘서, 엉뚱한 페이지가 그 제품의 미러로 저장되던 문제 (as35ggw10 등).

  page_check(html, url)  → (ok, 이유)
  extract(html, url)     → mirror dict (sections 등) 또는 None (모델 없음)
"""
import html as _html
import json
import re
from urllib.parse import urlparse

BLOCK_RE = re.compile(r"Access Denied|You don't have permission to access|errors\.edgesuite\.net", re.I)

# 컨테이너(안의 컴포넌트를 순서대로 펼침)
CONTAINER_TYPES = re.compile(r"/(parsys|container|responsivegrid|xfpage|experiencefragment|tabs?|productoverview|carousel)$")
# 제품 컨텐츠가 아닌 것: FAQ · 멤버 가입 · 공유 · 구매 버튼 · 분할결제 팝업 · 쇼룸 · 빵부스러기
SKIP_TYPES = re.compile(r"/(faq|joinmembers|socialshare|productcardbuttons|klarnapopup|breadcrumb|"
                        r"reviews?|buyingguide|countdown|cookie|productpage|wheretobuy)$")
# 구독(LG Subscribe) 등 판매 안내 블록 — 제품 기능이 아님
SKIP_PATH = re.compile(r"/subscribe/|/promotion/|/sample/", re.I)
TEXT_KEYS = ("eyebrow", "keyBenefitsTitleText", "imageText", "jcrTitle", "title", "headline", "subTitle", "subtitle",
             "keyBenefitsContentDesc", "description", "bodyCopy", "bodycopy", "desc", "text")
LIST_KEYS = ("keyBenefitsSummaryItems", "blockImageList", "featureIconTabsList", "mediaDescriptionList",
             "mediaContent", "items", "slides", "cards", "tabList", "iconList")
IMG_DESK = ("imageRef", "desktopImageAddr", "keyBenefitsFileRefDesk", "imageRefDesktop", "fileReference",
            "animationThumbnailImageRef", "videoThumbnailImageRef", "iconImageRef")
IMG_MOB = ("imageRefMobile", "keyBenefitsFileRefMob", "mobileImageAddr", "animationThumbnailImageRefMobile",
           "videoThumbnailImageRefMobile")
VIDEO = ("animationRef",)


# ── flight 데이터 ────────────────────────────────────────────────────
def _flight_text(h: str) -> str:
    return "".join(json.loads(m.group(1)) for m in
                   re.finditer(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', h))


def _flight_rows(t: str) -> list:
    """Next.js RSC flight → JSON 행 목록 (T 텍스트 행은 UTF-8 바이트 길이만큼 건너뜀)."""
    dec, rows, pos, n = json.JSONDecoder(), [], 0, len(t)
    rid = re.compile(r"([0-9a-f]+):")
    while pos < n:
        if t[pos] == "\n":
            pos += 1; continue
        m = rid.match(t, pos)
        if not m:
            break
        pos = m.end()
        if t.startswith("T", pos):
            c = t.index(",", pos); L = int(t[pos + 1:c], 16); pos = c + 1
            lo, hi = 0, min(L, n - pos)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if len(t[pos:pos + mid].encode()) <= L: lo = mid
                else: hi = mid - 1
            pos += lo; continue
        k = pos
        while k < n and t[k].isupper(): k += 1
        try:
            v, end = dec.raw_decode(t, k)
            rows.append(v); pos = end
        except Exception:
            nl = t.find("\n", pos); pos = n if nl < 0 else nl + 1
    return rows


def _walk(o, pred):
    if isinstance(o, dict):
        if pred(o): yield o
        for v in o.values(): yield from _walk(v, pred)
    elif isinstance(o, list):
        for v in o: yield from _walk(v, pred)


def _page_path(url: str) -> str:
    """https://www.lg.com/th/laundry/x/t2515vbtb/ → /content/lge/th/th/laundry/x/t2515vbtb/"""
    parts = [p for p in urlparse(url).path.split("/") if p]
    if not parts: return ""
    cc = parts[0]
    return f"/content/lge/{cc}/{cc}/" + "/".join(parts[1:]).lower() + "/"


def _overview(html: str, url: str):
    want = _page_path(url)
    for row in _flight_rows(_flight_text(html)):
        for d in _walk(row, lambda d: isinstance(d.get("resourcePath"), str) and ":items" in d
                       and d["resourcePath"].lower().startswith(want)
                       and d["resourcePath"].rstrip("/").endswith("/overview-section")):
            return d
    return None


def product_title(html: str) -> str:
    """페이지 제품 데이터의 userFriendlyName (화면 h1 과 같은 제품명). 없으면 ''."""
    m = re.search(r'\\?"userFriendlyName\\?":\\?"((?:[^"\\]|\\.){3,200}?)\\?"', html or "")
    if not m:
        return ""
    try:
        t = json.loads('"' + m.group(1).replace('\\"', '"').replace('"', '\\"') + '"')
    except Exception:
        t = m.group(1)
    t = re.sub(r"\s+", " ", _html.unescape(t)).strip()
    return "" if re.search(r"\bnull\b", t, re.I) else t


def has_overview(html: str, url: str) -> bool:
    """이 페이지에 기능 컨텐츠 영역(overview-section)이 있는가 — 없으면 액세서리 등 기능 소개가 없는 페이지."""
    try:
        ov = _overview(html, url)
        return ov is not None and len(_flatten(ov)) > 0
    except Exception:
        return True


# ── 페이지 확인 ──────────────────────────────────────────────────────
def page_check(html: str, url: str):
    if not html or len(html) < 5000:
        return False, f"HTML too short ({len(html or '')} chars)"
    if BLOCK_RE.search(html[:20000]) and "__next_f" not in html:
        return False, "LG bot-block page (Access Denied)"
    # 요청한 페이지인가: canonical / og:url 의 경로가 요청 경로와 같아야 한다 (나라 무관).
    # 둘 다 없으면 AEM 경로(/content/lge/<cc>/<cc>/…)로, 그것도 없으면 주소 마지막 조각(모델)으로 확인.
    want = urlparse(url).path.rstrip("/").lower()
    for pat in (r'<link[^>]+rel="canonical"[^>]*href="([^"]+)"', r'<link[^>]+href="([^"]+)"[^>]*rel="canonical"',
                r'property="og:url"\s+content="([^"]+)"', r'content="([^"]+)"\s+property="og:url"'):
        m = re.search(pat, html[:300000])
        if m and urlparse(_html.unescape(m.group(1))).path:
            got = urlparse(_html.unescape(m.group(1))).path.rstrip("/").lower()
            return (True, "") if got == want else (False, f"different page (canonical {got} ≠ requested {want})")
    low = html.lower().replace("\\/", "/")
    if _page_path(url) in low:
        return True, ""
    seg = (want.rsplit("/", 1)[-1] or "")
    if seg and low.count(seg) >= 3:
        return True, ""
    return False, "not the requested product page (no canonical, AEM path or model code found)"


# ── 글 ──────────────────────────────────────────────────────────────
def _clean(s: str) -> str:
    s = re.sub(r"(?i)<br\s*/?>", "\n", s or "")
    s = re.sub(r"(?i)</(p|div|li|h\d)>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "• ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s).replace("\xa0", " ")
    s = "\n".join(re.sub(r"[ \t\r]+", " ", ln).strip() for ln in s.split("\n"))
    return re.sub(r"\n{2,}", "\n", s).strip()


def _texts(o, out=None, depth=0):
    """컴포넌트 안의 글을 화면 순서로 (제목 노드 → '## ', 본문 노드 → 그대로)."""
    out = [] if out is None else out
    if depth > 8: return out
    if isinstance(o, dict):
        ty = o.get(":type") or ""
        if ty.endswith("/title") and isinstance(o.get("text"), str):
            t = _clean(o["text"]).replace("\n", " ")
            if t: out.append("## " + t)
            return out
        if ty.endswith("/text") and isinstance(o.get("text"), str):
            t = _clean(o["text"])
            if t: out.append(t)
            return out
        for k in TEXT_KEYS:
            v = o.get(k)
            if isinstance(v, str) and k != "text" and not v.startswith("/content/") and not v.startswith("http"):
                t = _clean(v)
                if t and len(t) > 1: out.append(("## " + t.replace("\n", " ")) if k in ("keyBenefitsTitleText", "jcrTitle", "imageText", "headline", "title") else t)
        order = o.get(":itemsOrder") or []
        items = o.get(":items") or {}
        for k in order:
            if k in items: _texts(items[k], out, depth + 1)
        for k, v in o.items():
            if k in (":items", ":itemsOrder", "dataLayer", "ctaModel", "scheduleUsabilityModel") or k in LIST_KEYS:
                continue
            if isinstance(v, dict) and k == "mediaDescriptionModel":
                _texts(v, out, depth + 1)
    elif isinstance(o, list):
        for v in o: _texts(v, out, depth + 1)
    # 연속 중복 제거
    ded = []
    for t in out:
        if not ded or ded[-1] != t: ded.append(t)
    out[:] = ded
    return out


# ── 이미지 ──────────────────────────────────────────────────────────
def _abs(origin: str, p: str) -> str:
    if not p: return ""
    return p if p.startswith("http") else origin + p


_IMG_EXT = re.compile(r"\.(jpe?g|png|webp|gif)$", re.I)
_VID_EXT = re.compile(r"\.(mp4|webm|mov)$", re.I)
_ONOFF = re.compile(r"[_-](on|off)(\.[a-z]+)$", re.I)


def _fold(p: str) -> str:
    """데스크톱/모바일/태블릿·크기 변형을 한 그림으로."""
    n = p.rsplit("/", 1)[-1].lower()
    n = re.sub(r"\.(jpe?g|png|webp|gif|mp4|webm|mov)$", "", n)
    n = re.sub(r"\((thumbnail)\)", "", n)
    return re.sub(r"([-_ ](desktop|mobile|tablet|pc|mo|d|m|t|v\d+|\d{3,4}(x\d{3,4})?))+$", "", n)


def _all_media(o, origin, out=None, seen=None, depth=0):
    """컴포넌트 안의 모든 DAM 이미지·동영상 (키 이름과 무관). 아이콘·태블릿·탭 ON/OFF·샘플은 제외,
    데스크톱/모바일은 한 장으로 묶는다 (모바일 주소는 mobile_url 로)."""
    out = [] if out is None else out
    seen = {} if seen is None else seen
    if depth > 10: return out
    if isinstance(o, dict):
        mobiles = {}
        for k, v in o.items():
            if not (isinstance(v, str) and v.startswith("/content/dam") and not SKIP_PATH.search(v)):
                continue
            kl = k.lower()
            if "icon" in kl or "tablet" in kl or _ONOFF.search(v):
                continue
            if "mob" in kl:
                mobiles[_fold(v)] = v; continue
            if _VID_EXT.search(v):
                key = "vid:" + _fold(v)
                if key not in seen:
                    seen[key] = True
                    out.append({"pc_url": _abs(origin, v), "mobile_url": "", "unified_url": "", "type": "video", "role": "content"})
                continue
            if not _IMG_EXT.search(v):
                continue
            key = _fold(v)
            if key in seen: continue
            m = {"pc_url": _abs(origin, v), "mobile_url": "", "unified_url": "", "type": "image", "role": "content",
                 "alt": _clean(o.get("imageAltText") or o.get("keyBenefitsFileRefAlt") or o.get("animationThumbnailAltText") or "")[:250]}
            seen[key] = m; out.append(m)
        for fk, mv in mobiles.items():           # 모바일 짝 붙이기 (짝 없는 모바일 전용 이미지는 그 자체로)
            if fk in seen and isinstance(seen[fk], dict):
                seen[fk]["mobile_url"] = seen[fk]["mobile_url"] or _abs(origin, mv)
            elif fk not in seen and _IMG_EXT.search(mv) and not _ONOFF.search(mv):
                m = {"pc_url": _abs(origin, mv), "mobile_url": _abs(origin, mv), "unified_url": "", "type": "image", "role": "content", "alt": ""}
                seen[fk] = m; out.append(m)
        order = o.get(":itemsOrder") or []
        keys = [k for k in o if k != ":items"] + ([":items"] if ":items" in o else [])
        for k in keys:
            v = o[k]
            if k in ("dataLayer", "ctaModel", "scheduleUsabilityModel"): continue
            if k == ":items" and isinstance(v, dict):
                for ik in order or list(v):
                    if ik in v: _all_media(v[ik], origin, out, seen, depth + 1)
            elif isinstance(v, (dict, list)):
                _all_media(v, origin, out, seen, depth + 1)
    elif isinstance(o, list):
        for v in o: _all_media(v, origin, out, seen, depth + 1)
    return out


# ── 컴포넌트 → 섹션 ──────────────────────────────────────────────────
def _flatten(container: dict) -> list:
    out = []
    items = container.get(":items") or {}
    for k in container.get(":itemsOrder") or list(items):
        c = items.get(k)
        if not isinstance(c, dict): continue
        ty = c.get(":type") or ""
        if SKIP_TYPES.search(ty): continue
        if CONTAINER_TYPES.search(ty) and not any(c.get(x) for x in LIST_KEYS):
            out.extend(_flatten(c)); continue
        out.append(c)
    return out


def _list_items(c: dict):
    for k in LIST_KEYS:
        v = c.get(k)
        if isinstance(v, list) and len(v) >= 2 and all(isinstance(x, dict) for x in v):
            return k, v
    return None, None


def _layout(ty: str, media: list) -> str:
    name = ty.rsplit("/", 1)[-1]
    if not media: return "text_block"
    if name in ("heroimage", "imagetextfoldingfeature", "blockimagetextoverlay", "fullwidthimage", "videobanner"):
        return "hero_full_width"
    if name in ("sideimage", "imagetext", "textimage"):
        return "image_text_right"
    return "hero_full_width"


def extract(html: str, url: str):
    """→ mirror dict (product_title 은 호출 쪽에서 채움) 또는 None."""
    ov = _overview(html, url)
    if not ov:
        return None
    origin = "https://" + (urlparse(url).netloc or "www.lg.com")
    sections, order = [], 0
    for idx, c in enumerate(_flatten(ov)):
        ty = c.get(":type") or ""
        name = ty.rsplit("/", 1)[-1]
        rp = (c.get("resourcePath") or "")
        if SKIP_PATH.search(json.dumps(c, ensure_ascii=False)[:4000]) and not _all_media(c, origin):
            continue
        lk, items = _list_items(c)
        cid = "AEM:" + name
        if items:
            head = _texts({":itemsOrder": c.get(":itemsOrder") or [], ":items": c.get(":items") or {}})
            # 목록 밖에 있는 컴포넌트 자체의 이미지(대표 그림) — 목록 항목 이미지와 겹치지 않는 것만
            item_keys = {_fold(m["pc_url"]) for it in items for m in _all_media(it, origin)}
            own = [m for m in _all_media({k: v for k, v in c.items() if k != lk}, origin)
                   if _fold(m["pc_url"]) not in item_keys]
            own_imgs = [m for m in own if m["type"] == "image"]
            if head or own_imgs:
                order += 1
                sections.append({"order": order, "text": "\n".join(head), "specs": [], "item_group": False,
                                 "group_heading": "", "media": own_imgs + [m for m in own if m["type"] == "video"][:1],
                                 # 대표 그림이 있으면 별도 섹션(카드 행에 섞이지 않게), 글만이면 카드 행 대제목으로 쓰이게 같은 묶음
                                 "component_id": cid, "component_dom_index": (-1 - idx) if own_imgs else idx,
                                 "layout_type": _layout(ty, own_imgs) if own_imgs else "text_block",
                                 "columns": 1, "column_count": 1})
            n = len(items)
            cols = n if n <= 4 else (3 if n % 3 == 0 else 4 if n % 4 == 0 else 3)
            for it in items:
                media = [m for m in _all_media(it, origin) if m["type"] == "image"][:1] + \
                        [m for m in _all_media(it, origin) if m["type"] == "video"][:1]
                text = "\n".join(_texts(it))
                if not media and not text: continue
                order += 1
                sections.append({"order": order, "text": text, "specs": [], "item_group": True,
                                 "group_heading": (head[0][3:] if head and head[0].startswith("## ") else ""),
                                 "media": media, "component_id": cid, "component_dom_index": idx,
                                 "layout_type": f"grid_{cols}_column", "columns": cols, "column_count": cols})
            continue
        text = "\n".join(_texts(c))
        media = _all_media(c, origin)
        imgs = [m for m in media if m["type"] == "image" and m["role"] != "icon"]
        if not text and not imgs:
            continue
        order += 1
        disclaimer = name == "textblock" and (c.get("blockType") == "disclaimer")
        sections.append({"order": f"disclaimer-{order}" if disclaimer else order, "text": text, "specs": [],
                         "item_group": False, "group_heading": "", "media": imgs + [m for m in media if m["type"] == "video"][:1],
                         "component_id": cid, "component_dom_index": idx,
                         "layout_type": _layout(ty, imgs), "columns": 1, "column_count": 1,
                         "_aem_path": rp.rsplit("/jcr:content/", 1)[-1][:120]})
    feats = sum(len(s["media"]) for s in sections)
    return {"sections": sections, "note": "lg.com 원문 미러 (페이지 컴포넌트 모델) — 모든 텍스트/URL은 원본 그대로, AI 생성 서술 없음",
            "_aem_stats": {"components": len(_flatten(ov)), "sections": len(sections), "media": feats}}
