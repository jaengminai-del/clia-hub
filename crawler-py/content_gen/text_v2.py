# -*- coding: utf-8 -*-
"""
text_v2.py — 텍스트 v2 렌더 규칙 (Shopee·Lazada, 2026-11-17)

크롤러가 LG.com 글의 역할을 화면 순서대로 남긴 결과(mirror "_gen": 2, 섹션 "text_roles")를 그대로 쓴다.
예전 규칙(첫 줄이 70자 이하면 제목)은 제목 위 작은 이름(eyebrow)까지 제목으로 키웠다.

  eyebrow     제목 위 작은 이름 — 본문과 같은 모양 (spec typography.v2.eyebrow)
  headline    블록의 첫 제목 36px · 같은 블록의 다음 제목(글 목록형 항목 제목)은 subhead 크기
  subcopy     제목 아래 보조 문구
  body        본문 — 문단을 이어 붙이지 않는다
  disclaimer  블록 아래 작은 회색 글 (섹션 "disclaimers")
  각주 번호   '…contrast.6)' → 작은 위첨자

예전 크롤 결과(_gen 없음)에는 쓰지 않는다 — content_gen.generate 가 판단한다.
"""
import re
from html import escape

from text_filters import is_image_description

_MD_HEAD = re.compile(r"^#{1,6}\s*")
# LG 각주 번호(<sup>)가 글에 붙어 들어온 것: 앞 글자에 붙은 1~2자리 숫자 + 닫는 괄호 (반각·전각)
_FOOTNOTE = re.compile(r"(?<=[^\s(（\d])(\d{1,2})[)）](?=\s|$|[.,;:!?。，、])")
EYEBROW_MAX_CHARS = 40


def _v2(st) -> dict:
    return (st.spec.get("typography") or {}).get("v2") or {}


def _slot(st, name: str, px: int, lh: str, weight: int, color: str) -> dict:
    s = _v2(st).get(name) or {}
    return {"px": s.get("px", px), "lh": s.get("line_height", lh), "w": s.get("weight", weight), "color": s.get("color", color)}


def tx(s: str) -> str:
    """보이는 글: 이스케이프 + LG 원문 줄바꿈(U+2028) + 각주 위첨자."""
    out = escape(s or "").replace(" ", "<br>")

    def sup(m):
        before = out[:m.start()]
        if before.count("(") + before.count("（") > before.count(")") + before.count("）"):
            return m.group(0)          # '(2017.08)' 처럼 괄호 안 — 각주 아님
        if re.search(r"\d[.,]$", before):
            return m.group(0)          # '2017.08)' 날짜·소수
        return f'<sup style="font-size: 0.6em; line-height: 0; vertical-align: super;">{m.group(1)})</sup>'
    return _FOOTNOTE.sub(sup, out)


def _clean(line: str) -> str:
    return _MD_HEAD.sub("", (line or "").strip()).strip()


def roles_of(item: dict) -> list:
    """섹션·카드의 글 → [{role, text}]. text_roles 가 있으면 그대로, 없으면(예: 페이지 모델 경로) text 에서 읽는다."""
    roles = item.get("text_roles")
    if roles is not None:
        return [r for r in roles if r.get("text") and r.get("role") != "disclaimer"]
    raw = [l for l in (item.get("text") or "").split("\n") if l.strip()]
    out = []
    for i, l in enumerate(raw):
        c = _clean(l)
        if not c or is_image_description(c) or l.strip().startswith(("*", "※")):
            continue
        if _MD_HEAD.match(l.strip()):
            out.append({"role": "headline", "text": c})
        elif i == 0 and len(raw) > 1 and _MD_HEAD.match(raw[1].strip()) and len(c) <= EYEBROW_MAX_CHARS:
            out.append({"role": "eyebrow", "text": c})
        else:
            out.append({"role": "body", "text": c})
    return out


def disclaimers_of(item: dict) -> list:
    """블록 아래에 넣을 디스클레이머 — 크롤러가 모은 것 + (text_roles 가 없으면) 본문 속 '*'·'※' 줄."""
    out = list(item.get("disclaimers") or [])
    if item.get("text_roles") is None:
        out += [l.strip() for l in (item.get("text") or "").split("\n") if l.strip().startswith(("*", "※"))]
    return out


def text_html(st, roles: list, title_tag: str = "h2") -> str:
    """역할별 글 → HTML. 정렬은 감싸는 블록이 정한다."""
    eb = _slot(st, "eyebrow", 24, "36px", 400, st.body_color)
    sc = _slot(st, "subcopy", 28, "40px", 400, st.headline_color)
    sh = _slot(st, "subhead", 30, "42px", 600, st.headline_color)
    h_px, b_px = st.px("", "headline", 36), st.px("", "body", 16)
    parts, heads, seen = [], 0, set()
    for r in roles:
        t = (r.get("text") or "").strip()
        key = (r.get("role"), t.lower())
        if not t or key in seen:
            continue
        seen.add(key)
        role = r.get("role")
        if role == "eyebrow":
            parts.append(f'<p class="eyebrow" style="font-family: {st.font_body}; font-weight: {eb["w"]}; font-size: {eb["px"]}px; '
                         f'line-height: {eb["lh"]}; color: {eb["color"]}; margin: 0 0 4px 0;">{tx(t)}</p>')
        elif role == "headline":
            if heads == 0:
                parts.append(f'<{title_tag} style="font-family: {st.font_headline}; font-weight: 600; font-size: {h_px}px; '
                             f'line-height: {st.head_lh}; margin: 0 0 8px 0; color: {st.headline_color};">{tx(t)}</{title_tag}>')
            else:      # 같은 블록 안의 다음 제목 = 글 목록형 블록의 항목 제목
                parts.append(f'<h3 style="font-family: {st.font_headline}; font-weight: {sh["w"]}; font-size: {sh["px"]}px; '
                             f'line-height: {sh["lh"]}; margin: 20px 0 6px 0; color: {sh["color"]};">{tx(t)}</h3>')
            heads += 1
        elif role == "subcopy":
            parts.append(f'<p style="font-family: {st.font_body}; font-weight: {sc["w"]}; font-size: {sc["px"]}px; '
                         f'line-height: {sc["lh"]}; color: {sc["color"]}; margin: 4px 0 8px 0;">{tx(t)}</p>')
        else:
            parts.append(f'<p style="font-family: {st.font_body}; font-size: {b_px}px; line-height: {st.body_lh}; '
                         f'color: {st.body_color}; margin: 10px 0;">{tx(t)}</p>')
    return "\n".join(parts)


def card_html(st, image_url: str, card: dict) -> str:
    """가로형 카드 (이미지 왼쪽 · 글 오른쪽) — 눈썹 · 제목 · 본문 문단을 따로."""
    inner = text_html(st, roles_of(card), "h3")
    txt = (f'<div class="lg-hcard-text" style="flex: 1 1 {st.card.get("text_width", "60%")}; padding: 20px 24px 20px 0; text-align: left;">{inner}</div>'
           if inner else "")
    img_w = st.card.get("image_width", "40%") if txt else "100%"
    return f'''
<div class="lg-hcard" style="display: flex; align-items: center; gap: 24px; background: #FFFFFF; border: 1px solid {st.stroke}; border-radius: 16px; overflow: hidden;">
  <div class="lg-hcard-img" style="flex: 0 0 {img_w}; max-width: {img_w};"><img src="{image_url}" alt="" style="width: 100%; height: auto; display: block;"></div>
  {txt}
</div>'''


def _split_disclaimer(text: str) -> list:
    """디스클레이머 덩어리 → 줄. LG 는 한 칸에 '*…' 여러 개를 줄바꿈·공백으로 이어 둔다."""
    out = []
    for part in re.split(r" +", text or ""):
        for piece in re.split(r"\s+(?=[*※]\S)", part.strip()):
            if piece.strip():
                out.append(piece.strip())
    return out


def disclaimer_html(st, lines: list) -> str:
    d = _slot(st, "disclaimer", 18, "28px", 400, getattr(st, "disclaimer_color", "#716F6A"))
    items = list(dict.fromkeys(x for l in (lines or []) for x in _split_disclaimer(l)))
    if not items:
        return ""
    ps = "".join(f'<p style="font-family: {st.font_body}; font-size: {d["px"]}px; line-height: {d["lh"]}; color: {d["color"]}; '
                 f'margin: {"6px" if i else "0"} 0 0 0; text-align: left;">{tx(x)}</p>' for i, x in enumerate(items))
    return f'<div class="lg-disclaimer-block" style="padding: 12px 6% 4px; margin-top: 8px; border-top: 1px solid #F0ECE4;">{ps}</div>'


def with_disclaimers(st, html: str, lines: list) -> str:
    """블록 HTML 의 마지막 </section> 안쪽 끝에 디스클레이머를 넣는다."""
    d = disclaimer_html(st, lines)
    if not d:
        return html
    k = html.rfind("</section>")
    return html[:k] + d + "\n" + html[k:] if k >= 0 else html + d
