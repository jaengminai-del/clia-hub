# -*- coding: utf-8 -*-
"""
render_html.py — [C] HTML 렌더러 (1차 컨텐츠 생성)

공통 컨텐츠 모델(model.py)의 블록을 매체 규격(spec.json)의 글자 크기·색·카드 비율·레이아웃 패턴으로 렌더한다.
eBay 설명란처럼 인라인 CSS만 쓰는 정적 HTML을 만든다(JS 없음).

레이아웃 패턴 (spec.json "layouts": layout_type → 패턴)
  centered_stack       이미지(중앙) 위 + 텍스트(중앙) 아래, 단일 카드
  card_list            가로형 카드(이미지 | 텍스트) 세로 나열, 캡션보다 많은 텍스트는 머리말로
  card_list_no_header  card_list와 같되 남는 텍스트는 버림 (Key Benefit Summary)
  image_cards          이미지만 있는 가로형 카드 나열 (캐러셀)
  gallery              대표 이미지 + 썸네일
별도 처리: kv(문서 최상단 히어로) · overlay(텍스트를 이미지 위에 얹는 컴포넌트) · card_row · spec_table
"""
import re
from html import escape

from text_filters import (
    is_image_description,
    content_lines,
    HEADLINE_MAX_CHARS,
)

from .model import best_image_url, usable_media

_MD_HEAD = re.compile(r"^#{1,6}\s*")


class Style:
    """spec.json → 렌더에 쓰는 값 묶음."""

    def __init__(self, spec: dict, guide: dict, overlay_ids: set):
        ty, co = spec["typography"], spec["colors"]
        gp1_fonts = guide.get("gp1_tokens", {}).get("font_family", {})
        self.spec = spec
        self.guide = guide
        self.overlay_ids = overlay_ids
        self.font_headline = gp1_fonts.get("headline", "'LGEIHeadline', Arial, sans-serif")
        self.font_body = gp1_fonts.get("body", "'LGEIText', Arial, sans-serif")
        self.head_lh = ty.get("headline_line_height", 1.25)
        self.body_lh = ty.get("body_line_height", 1.6)
        self.headline_color = co.get("headline", "#111111")
        self.body_color = co.get("body", "#2D2D2D")
        self.disclaimer_color = co.get("disclaimer", "#697072")
        self.stroke = co.get("card_stroke", "#E1E2E5")
        self.table_group_px = ty.get("spec_table", {}).get("group_px", 20)
        self.table_cell_px = ty.get("spec_table", {}).get("cell_px", 18)
        self.card = spec.get("card", {})
        self.award = spec.get("award", {})
        self.stacked = spec.get("stacked_image", {})
        self.compare = spec.get("compare", {})
        self.overlay_image = spec.get("overlay_image", {})
        self.overlay = spec.get("overlay", {})
        self.layouts = spec.get("layouts", {})
        # LG 가이드 폰트는 1440px 캔버스 기준 → 매체 컨테이너 폭으로 비례 축소
        self._scale = spec.get("container_px", 800) / guide.get("_meta", {}).get("reference_canvas_px", 1440)

    def px(self, component_id: str, role: str, guide_default: int) -> int:
        """글자 크기: 고정값이 있으면 고정, 없으면 LG 가이드 desktop_px를 축소 후 클램프."""
        ty = self.spec["typography"]
        fixed = ty.get("fixed_headline_px" if role in ("headline", "title") else "fixed_body_px")
        if fixed:
            return int(fixed)
        comp = self.guide.get("components", {}).get(component_id or "", {})
        px = comp.get("roles", {}).get(role, {}).get("desktop_px", guide_default)
        scaled = round(px * self._scale)
        gs = ty.get("guide_scaling", {})
        if role in ("headline", "title"):
            return max(gs.get("headline_min_px", 18), min(gs.get("headline_max_px", 32), scaled))
        return max(gs.get("body_min_px", 13), min(gs.get("body_max_px", 16), scaled))

    def pattern(self, layout_type: str) -> str:
        return self.layouts.get(layout_type) or self.layouts.get("_default", "centered_stack")


# ── 텍스트 ───────────────────────────────────────────────────────────────

def clean_line(line: str) -> str:
    """마크다운 잔여물(#, **) 제거한 순수 텍스트."""
    t = _MD_HEAD.sub("", line.strip())
    if t.startswith("**") and t.endswith("**") and len(t) > 4:
        t = t[2:-2]
    return t.strip()


def text_html(st: Style, text: str, component_id: str = "", first_is_title: bool = False) -> str:
    """마크다운 텍스트 → HTML.
    - 헤딩 #의 개수와 무관하게 잔여물 없이 변환 (####도 처리)
    - 동일 문구 반복(eyebrow==headline 중복)은 1회만 출력
    - ## 없는 섹션의 첫 줄은 헤드라인 길이일 때만 제목으로 승격"""
    if not text:
        return ""
    h_px = st.px(component_id, "headline", 36)
    b_px = st.px(component_id, "body", 16)
    h_style = f"font-family: {st.font_headline}; font-weight: 600; font-size: {h_px}px; line-height: {st.head_lh};"
    p_style = f"font-family: {st.font_body}; font-size: {b_px}px; line-height: {st.body_lh};"
    title_pending = first_is_title
    parts, seen = [], set()

    lines = text.split("\n")
    # 같은 문구가 eyebrow(일반 줄)와 헤드라인(## 줄)으로 중복되면 헤드라인만 출력
    heading_keys = {clean_line(l).lower() for l in lines if _MD_HEAD.match(l.strip())}

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        content = clean_line(stripped)
        key = content.lower()
        if not content or key in seen:
            continue
        if key in heading_keys and not _MD_HEAD.match(stripped):
            continue  # 일반 줄 버전은 건너뛰고 헤딩 버전에서 렌더
        if is_image_description(content):   # 이미지 alt(장면 묘사) — 마케팅 카피가 아님
            continue
        seen.add(key)

        if _MD_HEAD.match(stripped):
            title_pending = False   # 명시적 헤딩이 나오면 첫 줄 제목 승격 불필요
            level = len(stripped) - len(stripped.lstrip("#"))
            if level >= 3:
                parts.append(f'<h3 style="{h_style} margin: 8px 0 6px 0; color: {st.headline_color};">{escape(content)}</h3>')
            else:
                parts.append(f'<h2 style="{h_style} margin: 10px 0 8px 0; color: {st.headline_color};">{escape(content)}</h2>')
        elif stripped.startswith("**") and stripped.endswith("**"):
            parts.append(f'<p style="font-family: {st.font_body}; font-weight: 700; font-size: {b_px}px; line-height: {st.body_lh}; margin: 10px 0;">{escape(content)}</p>')
        elif stripped.startswith("*") or stripped.startswith("※"):
            parts.append(f'<p class="disclaimer" style="{p_style} color: {st.disclaimer_color}; margin: 5px 0;">{escape(stripped)}</p>')
        elif title_pending:
            # 긴 서술문(본문/카피)은 헤드라인 폰트로 부풀리지 않고 본문으로 렌더 (폰트 위계 보존)
            title_pending = False
            if len(content) <= HEADLINE_MAX_CHARS:
                parts.append(f'<h2 style="{h_style} margin: 0 0 8px 0; color: {st.headline_color};">{escape(content)}</h2>')
            else:
                parts.append(f'<p style="{p_style} color: {st.body_color}; margin: 10px 0;">{escape(content)}</p>')
        else:
            parts.append(f'<p style="{p_style} color: {st.body_color}; margin: 10px 0;">{escape(content)}</p>')

    return "\n".join(parts)


# ── 레이아웃 패턴 ─────────────────────────────────────────────────────────

def hcard(st: Style, image_url: str, lines: list, component_id: str = "") -> str:
    """가로형 카드 1장: 왼쪽 이미지 / 오른쪽 텍스트 (비율은 spec card).
    좁은 N열 카드에 큰 글자가 들어가지 않는 문제 → 카드를 가로형으로 바꾸고 세로로 나열.
    첫 줄이 헤드라인 길이면 제목(h3), 나머지는 본문(p)."""
    h_px = st.px(component_id, "headline", 36)
    b_px = st.px(component_id, "body", 16)
    lines = [l for l in (lines or []) if l]
    title = lines[0] if lines and len(lines[0]) <= HEADLINE_MAX_CHARS else ""
    body = " ".join(lines[1:] if title else lines)
    h = (f'<h3 style="font-family: {st.font_headline}; font-weight: 600; font-size: {h_px}px; '
         f'line-height: {st.head_lh}; margin: 0 0 10px 0; color: {st.headline_color};">'
         f'{escape(title)}</h3>') if title else ""
    b = (f'<p style="font-family: {st.font_body}; font-size: {b_px}px; line-height: {st.body_lh}; '
         f'margin: 0; color: {st.body_color};">{escape(body)}</p>') if body else ""
    txt = (f'<div class="lg-hcard-text" style="flex: 1 1 {st.card.get("text_width", "60%")}; padding: 20px 24px 20px 0; text-align: left;">{h}{b}</div>'
           if (h or b) else "")
    img_w = st.card.get("image_width", "40%") if txt else "100%"
    return f'''
<div class="lg-hcard" style="display: flex; align-items: center; gap: 24px; background: #FFFFFF; border: 1px solid {st.stroke}; border-radius: 16px; overflow: hidden;">
  <div class="lg-hcard-img" style="flex: 0 0 {img_w}; max-width: {img_w};"><img src="{image_url}" alt="{escape(title)}" style="width: 100%; height: auto; display: block;"></div>
  {txt}
</div>'''


def _cropped_img(image_url: str, crop: dict, alt: str, max_h: int) -> str:
    """이미지의 일부(crop: x·y·w·h 비율 + 원본 iw·ih)만 보이게 — 인라인 CSS만 사용(eBay·Lazada 설명란 호환).
    컨테이너 높이는 padding-top %, 이미지 위치는 margin % (둘 다 컨테이너 '폭' 기준이라 비율이 유지된다)."""
    x, y, w, h = crop["x"], crop["y"], crop["w"], crop["h"]
    ratio = crop.get("ih", 1) / max(1, crop.get("iw", 1))        # 원본 세로/가로
    box_ratio = h * ratio / w                                     # 잘라낸 영역 세로/가로
    max_w = round(max_h / box_ratio) if box_ratio else max_h
    return (f'<div style="display: inline-block; width: 100%; max-width: {max_w}px;">'
            f'<div style="position: relative; width: 100%; padding-top: {box_ratio * 100:.2f}%; overflow: hidden;">'
            f'<img src="{image_url}" alt="{escape(alt)}" style="position: absolute; top: 0; left: 0; '
            f'width: {100 / w:.2f}%; max-width: none; height: auto; '
            f'margin-left: -{x / w * 100:.2f}%; margin-top: -{y * ratio / w * 100:.2f}%;">'
            f'</div></div>')


def award_card(st: Style, image_url: str, lines: list, component_id: str = "", crop: dict = None) -> str:
    """수상·인증 배지 카드: 작은 로고(왼쪽, 비율 유지) + 제목·본문(오른쪽). 모든 배지를 같은 모양으로 통일."""
    aw = st.award
    h_px = st.px(component_id, "headline", 36)
    b_px = st.px(component_id, "body", 16)
    lines = [l for l in (lines or []) if l]
    title = lines[0] if lines and len(lines[0]) <= HEADLINE_MAX_CHARS else ""
    body = " ".join(lines[1:] if title else lines)
    h = (f'<h3 style="font-family: {st.font_headline}; font-weight: 600; font-size: {h_px}px; '
         f'line-height: {st.head_lh}; margin: 0 0 10px 0; color: {st.headline_color};">{escape(title)}</h3>') if title else ""
    b = (f'<p style="font-family: {st.font_body}; font-size: {b_px}px; line-height: {st.body_lh}; '
         f'margin: 0; color: {st.body_color};">{escape(body)}</p>') if body else ""
    logo_w = aw.get("logo_column_width", "30%")
    logo_max = aw.get("logo_max_px", 180)
    pad = aw.get("logo_padding_px", 24)
    txt = (f'<div class="lg-award-text" style="flex: 1 1 auto; padding: 20px 24px 20px 0; text-align: left;">{h}{b}</div>'
           if (h or b) else "")
    logo = (_cropped_img(image_url, crop, title, logo_max) if crop else
            f'<img src="{image_url}" alt="{escape(title)}" style="max-width: 100%; max-height: {logo_max}px; width: auto; height: auto; display: inline-block;">')
    return f'''
<div class="lg-hcard lg-award" style="display: flex; align-items: center; gap: 24px; background: #FFFFFF; border: 1px solid {st.stroke}; border-radius: 16px; overflow: hidden;">
  <div class="lg-award-logo" style="flex: 0 0 {logo_w}; max-width: {logo_w}; padding: {pad}px; text-align: center;">{logo}</div>
  {txt}
</div>'''


def hcard_list(cards_html: list, heading_html: str = "") -> str:
    """가로형 카드들을 세로로 나열하는 섹션 (카드 자체가 테두리를 가지므로 섹션은 투명)."""
    return f'''
<section class="lg-section lg-grid" style="background: transparent; border: none; padding: 24px 4px;">
  {heading_html}
  <div class="lg-hcards" style="display: flex; flex-direction: column; gap: 16px;">
  {"".join(cards_html)}
  </div>
</section>'''


def overlay_on_image(st: Style, image_url: str, html: str, alignment: str) -> str:
    """텍스트를 이미지 위에 얹는 오버레이 (figma 오버레이 컴포넌트)."""
    html = re.sub(r"color:\s*#[0-9a-fA-F]{3,6}", "color: #FFFFFF", html)
    ov = st.overlay
    if alignment == "right":
        pos, scrim = "right: 0; text-align: right;", ov.get("scrim_right")
    elif alignment == "center":
        pos, scrim = "left: 0; right: 0; text-align: center; align-items: center;", ov.get("scrim_center")
    else:
        pos, scrim = "left: 0; text-align: left;", ov.get("scrim_left")
    w = ov.get("text_width", "55%")
    return f'''
<section class="lg-section lg-hero" style="position: relative; overflow: hidden;">
  <img src="{image_url}" alt="" style="width: 100%; height: auto; display: block;">
  <div class="lg-text-overlay" style="position: absolute; top: 0; bottom: 0; {pos} width: {w}; max-width: {w}; padding: 32px 6%; display: flex; flex-direction: column; justify-content: center; color: #FFFFFF; background: {scrim};">
    {html}
  </div>
</section>'''


def content_img(st, m: dict, style: str) -> str:
    """섹션 이미지 1장. 텍스트가 이미지 위에 떠 있던 히어로는 모바일 이미지 + 텍스트 자리 빈 배경을 잘라 낸 영역
    (crawler image_crop.annotate_overlay_crops 가 기록). spec overlay_image.mode = "pc" 이면 예전처럼 PC 원본."""
    mode = (st.overlay_image.get("mode", "mobile_crop") if st is not None else "pc")
    url, crop = best_image_url(m), None
    if mode != "pc":
        if m.get("use_mobile") and m.get("mobile_crop") and m.get("mobile_url"):
            url, crop = m["mobile_url"], m["mobile_crop"]
        elif (m.get("crop") or {}).get("kind") == "overlay_band":
            crop = m["crop"]
    if not crop:
        return f'<img src="{url}" alt="" style="{style}">'
    x, y, w, h = crop["x"], crop["y"], crop["w"], crop["h"]
    ratio = crop.get("ih", 1) / max(1, crop.get("iw", 1))
    box = h * ratio / w
    radius = re.search(r"border-radius:\s*[^;]+;", style)
    margin = re.search(r"margin:\s*[^;]+;", style)
    return (f'<div style="position: relative; width: 100%; padding-top: {box * 100:.2f}%; overflow: hidden; '
            f'{radius.group(0) if radius else ""} {margin.group(0) if margin else ""}">'
            f'<img src="{url}" alt="" style="position: absolute; top: 0; left: 0; width: {100 / w:.2f}%; max-width: none; '
            f'height: auto; margin-left: -{x / w * 100:.2f}%; margin-top: -{y * ratio / w * 100:.2f}%;"></div>')


def centered_stack(media_list: list, html: str, st=None) -> str:
    """이미지(중앙)를 위에, 텍스트(중앙)를 아래에 쌓는 단일 카드."""
    imgs = "\n".join(
        content_img(st, m, f'max-width: 100%; height: auto; display: block; margin: 0 auto {16 if i else 0}px auto; border-radius: 8px;')
        for i, m in enumerate(media_list))
    txt = (f'<div style="text-align: center; padding: 20px 6% 4px;">{html}</div>'
           if html else "")
    return f'''
<section class="lg-section" style="padding: 24px 20px;">
  {imgs}
  {txt}
</section>'''


def stacked_hero(st: Style, media_list: list, html: str) -> str:
    """여백 없이 이어 붙은 히어로 (LG.com이 이미지 2장을 붙여 한 장처럼 보여주는 구성).
    문구는 위, 이미지들은 틈 없이 위아래로 붙여 한 장처럼 — 둥근 모서리는 합친 이미지의 바깥에만."""
    r = st.stacked.get("radius_px", 12)
    imgs = "".join(f'<img src="{best_image_url(m)}" alt="" style="width: 100%; height: auto; display: block; margin: 0; border: 0;">'
                   for m in media_list)
    txt = (f'<div style="text-align: center; padding: 8px 6% 20px;">{html}</div>' if html else "")
    return f'''
<section class="lg-section lg-stacked" style="padding: 24px 20px;">
  {txt}
  <div class="lg-stacked-image" style="border-radius: {r}px; overflow: hidden; line-height: 0; font-size: 0;">{imgs}</div>
</section>'''


def compare_block(st: Style, section: dict, html: str) -> str:
    """비교 슬라이더(As-is ↔ To-be)를 정적 이미지로: 문구 → As-is 이미지·라벨 → To-be 이미지·라벨(강조).
    spec compare.mode = "after_only" 이면 To-be 만."""
    cp = st.compare
    cmp_ = section["compare"]
    b_px = st.px(section.get("component_id", ""), "body", 16)
    r = cp.get("image_radius_px", 8)

    def item(side, emphasize):
        d = cmp_[side]
        color = cp.get("after_label_color" if emphasize else "before_label_color", "#111111" if emphasize else "#697072")
        weight = cp.get("after_label_weight", 700) if emphasize else 400
        label = (f'<p style="font-family: {st.font_body}; font-size: {b_px}px; line-height: {st.body_lh}; font-weight: {weight}; '
                 f'color: {color}; text-align: center; margin: 10px 0 0 0;">{escape(d["label"])}</p>') if d.get("label") else ""
        return (f'<div class="lg-compare-{side}" style="margin-top: 16px;">'
                f'<img src="{d["pc_url"]}" alt="{escape(d.get("label") or "")}" style="width: 100%; height: auto; display: block; border-radius: {r}px;">'
                f'{label}</div>')

    parts = [] if cp.get("mode") == "after_only" else [item("before", False)]
    parts.append(item("after", True))
    txt = f'<div style="text-align: center; padding: 8px 6% 4px;">{html}</div>' if html else ""
    return f'''
<section class="lg-section lg-compare" style="padding: 24px 20px;">
  {txt}
  {"".join(parts)}
</section>'''


def text_only(html: str, align: str) -> str:
    return f"""
<section class="lg-section lg-vertical" style="padding: 40px 20px; text-align: {align};">
  {html}
</section>
"""


def kv_card(image_url: str, html: str, st=None, media: dict = None) -> str:
    """KV(최상단 히어로): 흰 카드 상단에 중앙 텍스트, 그 아래 이미지가 카드 폭에 꽉 차게."""
    img = (content_img(st, media, "width: 100%; height: auto; display: block;").replace('alt=""', 'alt="Hero Image"', 1)
           if media is not None else f'<img src="{image_url}" alt="Hero Image" style="width: 100%; height: auto; display: block;">')
    return f'''
<section class="lg-section lg-hero">
  <div class="lg-hero-text" style="padding: 36px 8% 24px; text-align: center;">
    {html}
  </div>
  {img}
</section>'''


def gallery(media_list: list) -> str:
    thumbnails = ""
    if len(media_list) > 1:
        items = [f'<img src="{best_image_url(m)}" alt="Thumbnail {i+2}" style="width: 80px; height: 80px; object-fit: cover; cursor: pointer;">'
                 for i, m in enumerate(media_list[1:])]
        thumbnails = f'<div class="lg-gallery-thumbs" style="display: flex; justify-content: center; gap: 10px;">{"".join(items)}</div>'
    return f"""
<section class="lg-section lg-gallery" style="padding: 40px 20px;">
  <div class="lg-gallery-main" style="text-align: center; margin-bottom: 20px;">
    <img src="{best_image_url(media_list[0])}" alt="Product Main Image" style="max-width: 100%; height: auto;">
  </div>
  {thumbnails}
</section>
"""


# ── 블록 렌더 ─────────────────────────────────────────────────────────────

def render_spec_table(st: Style, section: dict) -> str:
    """스펙 섹션을 라벨/값 2열 표로. 라벨과 값이 짝을 잃지 않게 mirror specs를 그대로 행으로."""
    specs = section.get("specs") or []
    if not specs:
        return ""
    h_px = st.px(section.get("component_id", ""), "headline", 36)
    title = ""
    for ln in (section.get("text") or "").split("\n"):
        if ln.strip().startswith("## "):
            title = ln.strip()[3:].strip()
            break
    label_c, body_c, stroke = st.headline_color, st.body_color, st.stroke
    g_px, c_px = st.table_group_px, st.table_cell_px

    rows, cur_group = [], None
    for sp in specs:
        g = (sp.get("group") or "").strip()
        if g and g != cur_group:
            cur_group = g
            rows.append(
                f'<tr><th colspan="2" style="font-family: {st.font_headline}; font-weight: 600; '
                f'font-size: {g_px}px; text-align: left; padding: 16px 10px 8px 10px; '
                f'color: {label_c}; border-bottom: 1px solid {stroke};">{escape(g)}</th></tr>'
            )
        rows.append(
            f'<tr>'
            f'<td style="font-family: {st.font_body}; font-size: {c_px}px; font-weight: 600; '
            f'color: {label_c}; padding: 8px 10px; width: 45%; vertical-align: top; '
            f'border-bottom: 1px solid {stroke};">{escape(sp.get("label", ""))}</td>'
            f'<td style="font-family: {st.font_body}; font-size: {c_px}px; color: {body_c}; '
            f'padding: 8px 10px; vertical-align: top; '
            f'border-bottom: 1px solid {stroke};">{escape(sp.get("value", ""))}</td>'
            f'</tr>'
        )

    # 치수 도면 등 스펙 이미지는 표 위에 배치 (원본 픽셀 폭 초과 확대 금지)
    img_html = ""
    for m in usable_media(section):
        url = best_image_url(m)
        if not url:
            continue
        w = m.get("width") or 0
        cap = f'max-width: {min(int(w), 800)}px;' if w else 'max-width: 100%;'
        img_html = (f'<div style="text-align: center; margin-bottom: 20px;">'
                    f'<img src="{url}" alt="{escape(m.get("alt") or "")}" '
                    f'style="{cap} width: 100%; height: auto;"></div>')
        break

    head = (f'<h2 style="font-family: {st.font_headline}; font-weight: 600; font-size: {h_px}px; '
            f'line-height: {st.head_lh}; margin: 0 0 12px 0; color: {label_c};">{escape(title)}</h2>'
            if title else "")
    return f"""
<section class="lg-section lg-spec" style="padding: 24px 20px;">
  {head}
  {img_html}
  <table class="lg-spec-table" style="width: 100%; border-collapse: collapse; margin: 0 auto;">
    {"".join(rows)}
  </table>
</section>
"""


def render_card_row(st: Style, block: dict) -> str:
    cid = block.get("component_id", "")
    if block.get("award"):
        items = [award_card(st, c.get("img", ""), content_lines(c.get("text")), cid, c.get("crop"))
                 for c in block.get("cards", [])]
    else:
        items = [hcard(st, c.get("img", ""), content_lines(c.get("text")), cid) for c in block.get("cards", [])]
    hd = content_lines(block.get("heading", ""))
    heading = hd[0] if hd else ""
    head_html = (f'<h2 style="font-family: {st.font_headline}; font-weight: 600; font-size: {st.px(cid, "headline", 36)}px; line-height: {st.head_lh}; '
                 f'text-align: center; margin: 0 0 16px 0; color: {st.headline_color};">'
                 f'{escape(heading)}</h2>') if heading else ""
    return hcard_list(items, head_html)


def render_section(st: Style, section: dict, kv: bool, align: str) -> str:
    layout_type = section.get("layout_type", "unknown")
    cid = section.get("component_id", "")
    text = section.get("text", "")
    media_list = usable_media(section)
    html = text_html(st, text, cid, first_is_title=True)

    if not media_list:
        return text_only(html, align)
    primary = best_image_url(media_list[0])

    if section.get("stacked"):           # 이어 붙은 히어로 → 한 장으로
        return stacked_hero(st, media_list, html)
    if section.get("compare") and st.compare.get("mode", "before_after") != "off":
        return compare_block(st, section, html)   # 비교 슬라이더 → As-is 위, To-be 아래

    # 오버레이 컴포넌트: 텍스트를 이미지 위에 (단일 이미지 + 텍스트일 때)
    if cid in st.overlay_ids and html and len(media_list) == 1:
        return overlay_on_image(st, primary, html, align)
    if kv and html and layout_type in ("hero_full_width", "text_over_image"):
        return kv_card(primary, html, st, media_list[0])

    pattern = st.pattern(layout_type)
    if pattern in ("card_list", "card_list_no_header"):
        lines = content_lines(text)
        items = [hcard(st, best_image_url(m), [lines[i]] if i < len(lines) else [], cid)
                 for i, m in enumerate(media_list)]
        header = ""
        if pattern == "card_list" and len(lines) > len(media_list):
            rest = text_html(st, "\n".join(lines[len(media_list):]), cid)
            header = f'<div class="lg-grid-header" style="text-align: center; margin-bottom: 16px;">{rest}</div>'
        return hcard_list(items, header)
    if pattern == "image_cards":
        return hcard_list([hcard(st, best_image_url(m), [], cid) for m in media_list])
    if pattern == "gallery":
        return gallery(media_list)
    return centered_stack(media_list, html, st)


def render_award_section(st: Style, section: dict) -> str:
    """단독 섹션으로 들어온 배지(IFA 등)도 카드 행과 같은 배지 카드로."""
    cid = section.get("component_id", "")
    lines = content_lines(section.get("text", ""))
    media = usable_media(section)
    cards = [award_card(st, best_image_url(m), lines if i == 0 else [], cid, m.get("crop")) for i, m in enumerate(media)]
    return hcard_list(cards)


def render_blocks(st: Style, blocks: list, align: str) -> list:
    out = []
    for b in blocks:
        if b["kind"] == "spec_table":
            h = render_spec_table(st, b["section"])
        elif b["kind"] == "card_row":
            h = render_card_row(st, b)
        elif b.get("award"):
            h = render_award_section(st, b["section"])
        else:
            h = render_section(st, b["section"], b.get("kv", False), align)
        if h:
            out.append(h)
    return out
