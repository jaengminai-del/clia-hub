# -*- coding: utf-8 -*-
"""
listing.py — 제품별 "리스팅 문구"를 1차 컨텐츠 맨 위·맨 아래 카드로 (eBay · Lazada, 2026-10-26)

문구 5종 (허브 제품 상세 화면에서 제품별로 작성·버전 저장, listing-store.js):
  promotion  → 맨 위       (Promotion Details)
  details    → 맨 아래 ①  (Product Details)
  delivery   → 맨 아래 ②  (Delivery & Installation Notice)
  aftercare  → 맨 아래 ③  (After Care Service Information)
  returns    → 맨 아래 ④  (Return Policy)
입력은 일반 텍스트 그대로: "● 제목" 줄은 굵게, "- 설명" 줄은 들여쓰기, 빈 줄은 문단 간격.
비어 있는 칸은 카드를 만들지 않는다. Shopee 는 HTML 대신 plain_text() 를 설명란에 복사한다.
"""
from html import escape

TOP = ("promotion",)
BOTTOM = ("details", "delivery", "aftercare", "returns")
DEFAULT_TITLES = {
    "promotion": "Promotion Details",
    "details": "Product Details",
    "delivery": "Delivery & Installation Notice",
    "aftercare": "After Care Service Information",
    "returns": "Terms & Conditions for Return Policy",
}


def _lines_html(text: str, st) -> str:
    body_px = st.listing.get("body_px", 18)
    base = (f"font-family: {st.font_body}; font-size: {body_px}px; line-height: 1.5; color: {st.body_color}; "
            f"margin: 0; text-align: left;")
    out, gap = [], False
    for raw in (text or "").replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            gap = True
            continue
        mt = "10px" if (gap and out) else "2px"
        gap = False
        s = line.strip()
        if s[:1] in "●•":
            out.append(f'<p style="{base} margin-top: {mt}; font-weight: 600; color: {st.headline_color};">{escape(s)}</p>')
        elif s.startswith("- ") or s.startswith("– "):
            out.append(f'<p style="{base} margin-top: {mt}; padding-left: 18px;">{escape(s)}</p>')
        elif raw[:1] in (" ", "\t"):
            out.append(f'<p style="{base} margin-top: {mt}; padding-left: 18px;">{escape(s)}</p>')
        else:
            out.append(f'<p style="{base} margin-top: {mt};">{escape(s)}</p>')
    return "\n".join(out)


def _card(st, key: str, title: str, text: str) -> str:
    title_px = st.listing.get("title_px", 28)
    return (f'<section class="lg-section lg-listing lg-listing-{key}" style="padding: 28px 32px;">\n'
            f'<h2 style="font-family: {st.font_headline}; font-weight: 600; font-size: {title_px}px; line-height: 1.15; '
            f'margin: 0 0 14px 0; color: {st.headline_color}; text-align: left;">{escape(title)}</h2>\n'
            f'{_lines_html(text, st)}\n</section>')


def render(st, listing: dict, where: str) -> list:
    """listing = {"fields": {...}, "titles": {...}} → 카드 HTML 목록 (where = top | bottom)."""
    if not listing:
        return []
    fields = listing.get("fields") or {}
    titles = {**DEFAULT_TITLES, **{k: v for k, v in (listing.get("titles") or {}).items() if v}}
    keys = TOP if where == "top" else BOTTOM
    return [_card(st, k, titles[k], fields[k]) for k in keys if (fields.get(k) or "").strip()]


def plain_text(listing: dict) -> str:
    """Shopee 설명란용 일반 텍스트 (붙여 주신 Shopee 문구 형식: '제목:' + 빈 줄 + 내용, 칸 사이 빈 줄 3개)."""
    fields = (listing or {}).get("fields") or {}
    titles = {**DEFAULT_TITLES, **{k: v for k, v in ((listing or {}).get("titles") or {}).items() if v}}
    parts = [f"{titles[k]}:\n\n{fields[k].strip()}" for k in TOP + BOTTOM if (fields.get(k) or "").strip()]
    return "\n\n\n\n".join(parts) + ("\n" if parts else "")
