# -*- coding: utf-8 -*-
"""
text_filters.py — 3P 콘텐츠(eBay·Amazon) 공통 텍스트 필터.

핵심: LG.com 이미지의 alt(접근성 장면 묘사) 텍스트는 마케팅 카피가 아니므로
3P 콘텐츠에서 모두 제거한다. mirror.json 생성 단계(make_mirror)와 렌더 단계
(ebay_builder)가 이 단일 소스를 공유해 eBay·Amazon 어디서든 동일하게 걸러낸다.

예시(차단 대상):
  "A family with children and their grandparents sits together on a sofa in a
   bright living room, holding a remote while watching TV."
  "LG OLED evo AI G6 is shown in a studio as a director works at a control panel."
통과 대상(마케팅 카피): "Perfect Black, Perfect Colour", "The world's first ..."
"""
import re

# 헤드라인으로 승격 가능한 최대 길이 (이보다 길면 서술문 → 본문 처리)
HEADLINE_MAX_CHARS = 70

_MD_HEAD = re.compile(r"^#{1,6}\s*")
# 마크다운 이미지 ![alt](url) — alt(장면 묘사)가 텍스트에 박히는 주요 경로
_MD_IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")

# ── 이미지 alt(장면 묘사) 판정 규칙 — PDP에서 고객이 시각적으로 볼 수 없는 접근성 텍스트 ──
# 강한 마커: "This/The/An image|photo|screenshot ...", "image shows/depicts/of ...",
#            "illustrating/depicting ..." — 이것만으로 alt 확정 (길이·문장수 무관)
_ALT_STRONG = re.compile(
    r"^\s*(this|these|the|an?|its?)\s+(image|images|photo|picture|graphic|graphics|"
    r"illustration|screenshot|screen\s*shot|visual|scene|animation|gif|close-?up|shot|render|diagram)\b"
    r"|\b(image|images|photo|picture|graphic|screenshot|animation|scene)\s+"
    r"(shows?|showing|of|depicts?|depicting|displays?|displaying|illustrat\w*|features?|captures?|portrays?|represents?)\b"
    r"|\billustrat(?:ing|es|e|ion)\b|\bdepict(?:ing|s|ed)\b", re.I)

# 장면/화면/사물 어휘 — 관사·지시어로 시작하는 문장에서 밀도(≥2)로 alt 서술 판정
_SCENE = re.compile(
    r"\b(laptop|smartphone|phone|tablet|screen|display|interface|monitor|desk|table|wall|"
    r"sofa|couch|room|kitchen|bathroom|bedroom|studio|background|"
    r"family|children|grandparent|parent|man|woman|men|women|person|people|couple|kid|boy|girl|user|hand|hands|"
    r"shows?|showing|displays?|displaying|depicts?|placed|positioned|connected|"
    r"sits?|sitting|stands?|standing|holds?|holding|wearing|playing|watching|"
    r"indicating|highlighting|featuring|illustrating|both|while|"
    r"in a|on a|on the|in the|next to|in front of)\b", re.I)
# 내러티브 동사구 — 제품명 등으로 시작하는 장면 설명도 포착
_IMG_DESC_NARRATIVE = re.compile(
    r"\b(is|are)\s+shown\b|\bis\s+displayed\b|\bis\s+pictured\b|\b(can\s+be|is|are)\s+seen\b|"
    r"\bappears?\s+(on|in|as)\b|\blooks?\s+(powered|like|as if)\b|\bshown\s+(in|on)\b|"
    r"\b(is|are)\s+placed\b|\b(is|are)\s+connected\b|\b(is|are)\s+displaying\b|"
    r"\bworks?\s+at\b|\bwhile\s+\w+ing\b|\bthen\b.*\bturns?\s+on\b|"
    r"\bin\s+a\s+(studio|bright|dark|modern|cozy|living|dining)\b", re.I)
# 지시어/관사/수량어 시작 — 장면 밀도 트랙 진입 조건
_DESC_START = re.compile(r"^(a|an|the|this|these|those|two|three|several|both|its?)\b", re.I)


def clean_line(line: str) -> str:
    """마크다운 잔여물(#, **, ![alt](url), 리스트 불릿) 제거한 순수 텍스트."""
    t = (line or "").strip()
    t = _MD_IMG.sub("", t)                 # ![alt](url) 이미지(=alt 묘사) 제거
    t = _MD_HEAD.sub("", t)                # # 헤딩 마커
    t = re.sub(r"^[-*+]\s+", "", t)        # 리스트 불릿
    if t.startswith("**") and t.endswith("**") and len(t) > 4:
        t = t[2:-2]
    return t.strip()


def is_image_description(text: str) -> bool:
    """이미지 alt(장면/화면 묘사)인지 — 고객이 PDP에서 시각적으로 볼 수 없는 접근성 텍스트.
    마케팅 카피(헤드/바디)는 통과, 묘사문만 True.

    판정: ① 강한 마커(This/The image..., image shows/of/depicts, illustrating...)
         ② 내러티브 동사구(is shown/placed/connected, looks powered, while ~ing...)
         ③ 지시어·관사 시작 + 장면 어휘 밀도(≥2). 셋 중 하나면 True (길이 ≥40).
    """
    # ![alt](url)만 있는 줄이면 alt 자체가 묘사 → 원문(마커 포함)으로도 판정
    raw = (text or "").strip()
    if _MD_IMG.search(raw):
        inner = re.findall(r"!\[([^\]]*)\]", raw)
        if inner and any(is_image_description(a) for a in inner):
            return True
    t = clean_line(raw).rstrip(".").strip()
    if len(t) < 40:
        return False
    if _ALT_STRONG.search(t):
        return True
    if _IMG_DESC_NARRATIVE.search(t):
        return True
    if _DESC_START.match(t) and len(_SCENE.findall(t)) >= 2:
        return True
    return False


def content_lines(text: str) -> list:
    """clean_line 적용 + 빈 줄·이미지 묘사문 제거한 순수 컨텐츠 줄 목록."""
    out = []
    for l in (text or "").split("\n"):
        if is_image_description(l):        # 원문 줄(![alt] 포함) 기준 판정 먼저
            continue
        c = clean_line(l)
        if c and not is_image_description(c):
            out.append(c)
    return out


def strip_descriptions(text: str) -> str:
    """멀티라인 텍스트에서 이미지 묘사문 줄 + 마크다운 이미지(![alt](url))를 제거.

    make_mirror가 섹션 text를 만들 때 사용 — mirror.json 자체를 깨끗하게 유지해
    eBay·Amazon 등 모든 소비처에서 alt 묘사문이 카피로 새지 않게 한다.
    반환: 묘사문/이미지 마크다운이 빠진 텍스트. 남는 줄이 없으면 "".
    """
    if not text:
        return text
    kept = []
    for ln in text.split("\n"):
        if is_image_description(ln):
            continue
        stripped = _MD_IMG.sub("", ln)     # 줄 안에 섞인 ![alt](url)도 제거
        if stripped.strip() or not ln.strip():
            kept.append(stripped)
    return "\n".join(kept).strip()
