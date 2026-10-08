# -*- coding: utf-8 -*-
"""
ebay_builder.py — CCG 컴포넌트 기반 eBay 콘텐츠 HTML 빌더

mirror.json에서 CCG 컴포넌트 정보(layout_type, text_alignment 등)를 읽어
LG.com PDP와 유사한 레이아웃의 HTML을 생성합니다.

지원 레이아웃 타입:
- hero_full_width: 전체 너비 히어로 이미지 + 텍스트 오버레이
- text_over_image: 이미지 배경 위에 텍스트
- image_text_left: 이미지 좌측, 텍스트 우측
- image_text_right: 이미지 우측, 텍스트 좌측
- grid_2_column, grid_3_column, grid_4_column: N컬럼 그리드
- icon_grid: 아이콘 그리드 (Key Benefit Summary)
- carousel: 캐러셀/슬라이더
- tab_content: 탭 콘텐츠
- vertical_stack: 수직 스택

사용법:
    python ebay_builder.py <out/slug 디렉토리>
    python ebay_builder.py <out/slug 디렉토리> --preview  # 브라우저에서 미리보기
"""
import argparse
import json
import re
import webbrowser
from pathlib import Path
from typing import Dict, List, Optional
from html import escape


# ── 레이아웃 타입별 HTML 템플릿 ──────────────────────────────────────────

LAYOUT_TEMPLATES = {
    # 히어로: 전체 너비 이미지 + 중앙 또는 좌측 텍스트 오버레이
    "hero_full_width": """
<section class="lg-section lg-hero" style="position: relative; width: 100%; overflow: hidden;">
  <div class="lg-hero-image" style="width: 100%;">
    <img src="{image_url}" alt="{alt_text}" style="width: 100%; height: auto; display: block;">
  </div>
  {text_overlay}
</section>
""",

    # 이미지 배경 위 텍스트
    "text_over_image": """
<section class="lg-section lg-text-over-image" style="position: relative; width: 100%; overflow: hidden;">
  <div class="lg-bg-image" style="width: 100%;">
    <img src="{image_url}" alt="{alt_text}" style="width: 100%; height: auto; display: block;">
  </div>
  <div class="lg-text-overlay" style="position: absolute; top: 50%; {text_position}; transform: translateY(-50%); max-width: 50%; padding: 20px; color: {text_color};">
    {text_content}
  </div>
</section>
""",

    # 이미지 좌측, 텍스트 우측
    "image_text_left": """
<section class="lg-section lg-image-text" style="display: flex; flex-wrap: wrap; align-items: center; padding: 40px 20px;">
  <div class="lg-image-col" style="flex: 1 1 50%; padding: 20px;">
    <img src="{image_url}" alt="{alt_text}" style="width: 100%; height: auto; display: block;">
  </div>
  <div class="lg-text-col" style="flex: 1 1 50%; padding: 20px;">
    {text_content}
  </div>
</section>
""",

    # 이미지 우측, 텍스트 좌측
    "image_text_right": """
<section class="lg-section lg-image-text" style="display: flex; flex-wrap: wrap; align-items: center; padding: 40px 20px;">
  <div class="lg-text-col" style="flex: 1 1 50%; padding: 20px;">
    {text_content}
  </div>
  <div class="lg-image-col" style="flex: 1 1 50%; padding: 20px;">
    <img src="{image_url}" alt="{alt_text}" style="width: 100%; height: auto; display: block;">
  </div>
</section>
""",

    # 2컬럼 그리드
    "grid_2_column": """
<section class="lg-section lg-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; padding: 40px 20px;">
  {grid_items}
</section>
""",

    # 3컬럼 그리드
    "grid_3_column": """
<section class="lg-section lg-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; padding: 40px 20px;">
  {grid_items}
</section>
""",

    # 4컬럼 그리드
    "grid_4_column": """
<section class="lg-section lg-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; padding: 40px 20px;">
  {grid_items}
</section>
""",

    # 아이콘 그리드 (Key Benefit Summary)
    "icon_grid": """
<section class="lg-section lg-icon-grid" style="padding: 40px 20px;">
  <div class="lg-icon-grid-container" style="display: flex; flex-wrap: wrap; justify-content: center; gap: 30px;">
    {icon_items}
  </div>
</section>
""",

    # 캐러셀 (정적 버전 - 가로 스크롤)
    "carousel": """
<section class="lg-section lg-carousel" style="padding: 40px 20px; overflow-x: auto;">
  <div class="lg-carousel-container" style="display: flex; gap: 20px; min-width: max-content;">
    {carousel_items}
  </div>
</section>
""",

    # 탭 콘텐츠 (정적 버전 - 모든 탭 표시)
    "tab_content": """
<section class="lg-section lg-tabs" style="padding: 40px 20px;">
  <div class="lg-tabs-content">
    {tab_items}
  </div>
</section>
""",

    # 수직 스택 (기본)
    "vertical_stack": """
<section class="lg-section lg-vertical" style="padding: 40px 20px; text-align: {text_align};">
  {content}
</section>
""",

    # 스펙 테이블
    "spec_table": """
<section class="lg-section lg-spec" style="padding: 40px 20px;">
  <div class="lg-spec-table" style="max-width: 1200px; margin: 0 auto;">
    {text_content}
  </div>
</section>
""",

    # 제품 갤러리
    "product_gallery": """
<section class="lg-section lg-gallery" style="padding: 40px 20px;">
  <div class="lg-gallery-main" style="text-align: center; margin-bottom: 20px;">
    <img src="{image_url}" alt="{alt_text}" style="max-width: 100%; height: auto;">
  </div>
  {thumbnails}
</section>
""",

    # 아코디언
    "accordion": """
<section class="lg-section lg-accordion" style="padding: 40px 20px;">
  <div class="lg-accordion-container" style="max-width: 1000px; margin: 0 auto;">
    {accordion_items}
  </div>
</section>
""",

    # 기본 폴백 레이아웃
    "unknown": """
<section class="lg-section lg-default" style="padding: 40px 20px;">
  {content}
</section>
"""
}


# ── CCG 디자인 가이드 스펙 (ccg_spec.json — GP1 Content Creation Guideline) ──

_SPEC_PATH = Path(__file__).resolve().parent / "ccg_spec.json"
try:
    CCG_SPEC = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
except Exception:
    CCG_SPEC = {"components": {}, "render_defaults": {}}

# figma-specs 컴포넌트별 스펙 (오버레이 여부·폰트·색상) — build_figma_spec.py 산출물
try:
    FIGMA_SPEC = json.loads((Path(__file__).resolve().parent / "figma_component_spec.json").read_text(encoding="utf-8"))
except Exception:
    FIGMA_SPEC = {}


def is_overlay_component(component_id: str) -> bool:
    """figma 스펙상 텍스트가 이미지 위에 얹히는 오버레이 컴포넌트인가 (ST0004/05/14 등)."""
    return bool(FIGMA_SPEC.get(component_id or "", {}).get("is_overlay"))


_RD = CCG_SPEC.get("render_defaults", {})
# GP1 디자인 시스템 실토큰 (claude.ai/design "LG GP1 Design System" 소싱, gp1_tokens 참고)
_GP1 = CCG_SPEC.get("gp1_tokens", {})
_GP1_COLORS = _GP1.get("colors", {})
_GP1_FONTS = _GP1.get("font_family", {})
FONT_HEADLINE = _GP1_FONTS.get("headline", "'LGEIHeadline', Arial, sans-serif")
FONT_BODY = _GP1_FONTS.get("body", "'LGEIText', Arial, sans-serif")
# 헤드라인 행간 — 컨테이너 본문값(1.6)을 상속하면 제목이 지나치게 벌어져 읽기 불편해진다.
# CCG 가이드의 제목 행간(타이트)에 맞춰 별도 지정.
_HEAD_LH = _RD.get("headline_line_height", 1.25)
_BODY_LH = _RD.get("body_line_height", 1.6)
_STROKE = _RD.get("card_stroke", "#E1E2E5")
_PAGE_BG = _RD.get("page_background", "#FFFFFF")
# 가이드 폰트는 1440px 캔버스 기준 → eBay 컨테이너(800px)로 비례 축소 후 클램프
_SCALE = _RD.get("container_px", 800) / CCG_SPEC.get("_meta", {}).get("reference_canvas_px", 1440)


def spec_px(component_id: str, role: str, guide_default: int) -> int:
    """가이드의 desktop_px를 컨테이너 비율로 축소해 렌더 px 산출.
    render_defaults에 fixed_headline_px / fixed_body_px가 있으면 그 값으로 고정
    (모바일 가독성 — 모든 제목·본문 크기 통일)."""
    fixed = _RD.get("fixed_headline_px" if role in ("headline", "title") else "fixed_body_px")
    if fixed:
        return int(fixed)
    comp = CCG_SPEC.get("components", {}).get(component_id or "", {})
    px = comp.get("roles", {}).get(role, {}).get("desktop_px", guide_default)
    scaled = round(px * _SCALE)
    if role in ("headline", "title"):
        return max(_RD.get("headline_min_px", 18), min(_RD.get("headline_max_px", 32), scaled))
    return max(_RD.get("body_min_px", 13), min(_RD.get("body_max_px", 16), scaled))


# ── 텍스트 파싱 및 HTML 변환 ─────────────────────────────────────────────

_MD_HEAD = re.compile(r"^#{1,6}\s*")


def clean_line(line: str) -> str:
    """마크다운 잔여물(#, **) 제거한 순수 텍스트."""
    t = _MD_HEAD.sub("", line.strip())
    if t.startswith("**") and t.endswith("**") and len(t) > 4:
        t = t[2:-2]
    return t.strip()


# 이미지 alt 묘사문 필터는 3P 공통 모듈(text_filters)에서 단일 소스로 관리.
# make_mirror(소스 정리)와 ebay_builder(렌더)가 동일 규칙을 공유한다.
from text_filters import (  # noqa: E402
    is_image_description,
    content_lines as _content_lines,
    HEADLINE_MAX_CHARS as _HEADLINE_MAX_CHARS,
)


def parse_text_to_html(text: str, element_roles: Optional[dict] = None,
                       component_id: str = "", first_is_title: bool = False) -> str:
    """마크다운 텍스트를 HTML로 변환합니다.

    - 헤딩 #의 개수와 무관하게 잔여물 없이 변환 (####도 처리)
    - 동일 문구 반복(eyebrow==headline 중복)은 1회만 출력
    - 폰트 크기는 CCG 가이드 스펙(ccg_spec.json)을 컨테이너 비율로 축소해 적용
    """
    if not text:
        return ""

    h_px = spec_px(component_id, "headline", 36)
    b_px = spec_px(component_id, "body", 16)
    title_pending = first_is_title
    html_parts = []
    seen = set()

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
        # 이미지 alt(장면 묘사) 텍스트 차단 — 마케팅 카피가 아님
        if is_image_description(content):
            continue
        seen.add(key)

        if _MD_HEAD.match(stripped):
            title_pending = False   # 명시적 헤딩이 나오면 첫 줄 제목 승격 불필요
            level = len(stripped) - len(stripped.lstrip("#"))
            if level >= 3:
                html_parts.append(f'<h3 style="font-family: {FONT_HEADLINE}; font-weight: 600; font-size: {h_px}px; line-height: {_HEAD_LH}; margin: 8px 0 6px 0; color: {_RD.get("headline_color", "#111111")};">{escape(content)}</h3>')
            else:
                html_parts.append(f'<h2 style="font-family: {FONT_HEADLINE}; font-weight: 600; font-size: {h_px}px; line-height: {_HEAD_LH}; margin: 10px 0 8px 0; color: {_RD.get("headline_color", "#111111")};">{escape(content)}</h2>')
        elif stripped.startswith("**") and stripped.endswith("**"):
            html_parts.append(f'<p style="font-family: {FONT_BODY}; font-weight: 700; font-size: {b_px}px; line-height: {_BODY_LH}; margin: 10px 0;">{escape(content)}</p>')
        elif stripped.startswith("*") or stripped.startswith("※"):
            html_parts.append(f'<p class="disclaimer" style="font-family: {FONT_BODY}; font-size: {b_px}px; line-height: {_BODY_LH}; color: {_RD.get("disclaimer_color", "#697072")}; margin: 5px 0;">{escape(stripped)}</p>')
        elif title_pending:
            # ## 없는 섹션의 첫 컨텐츠 줄 → '헤드라인 길이'일 때만 제목(EI Headline) 승격.
            # 긴 서술문(본문/카피)은 헤드라인 폰트로 부풀리지 않고 본문으로 렌더 (폰트 위계 보존).
            title_pending = False
            if len(content) <= _HEADLINE_MAX_CHARS:
                html_parts.append(f'<h2 style="font-family: {FONT_HEADLINE}; font-weight: 600; font-size: {h_px}px; line-height: {_HEAD_LH}; margin: 0 0 8px 0; color: {_RD.get("headline_color", "#111111")};">{escape(content)}</h2>')
            else:
                html_parts.append(f'<p style="font-family: {FONT_BODY}; font-size: {b_px}px; line-height: {_BODY_LH}; color: {_RD.get("body_color", "#2D2D2D")}; margin: 10px 0;">{escape(content)}</p>')
        else:
            html_parts.append(f'<p style="font-family: {FONT_BODY}; font-size: {b_px}px; line-height: {_BODY_LH}; color: {_RD.get("body_color", "#2D2D2D")}; margin: 10px 0;">{escape(content)}</p>')

    return "\n".join(html_parts)


def get_best_image_url(media: dict) -> str:
    """미디어 객체에서 최적 이미지 URL을 반환합니다."""
    return media.get("pc_url") or media.get("unified_url") or media.get("mobile_url") or ""


def get_text_position_style(alignment: str) -> str:
    """텍스트 정렬에 따른 CSS 위치 스타일을 반환합니다."""
    if alignment == "right":
        return "right: 5%"
    elif alignment == "center":
        return "left: 50%; transform: translate(-50%, -50%)"
    else:  # left 기본값
        return "left: 5%"


def get_text_color_for_bg(bg_type: str, bg_value: str) -> str:
    """배경에 따른 텍스트 색상을 반환합니다."""
    if bg_type == "color":
        # 어두운 배경이면 흰색 텍스트
        dark_colors = ["#000000", "#333333", "#404040"]
        return "#FFFFFF" if bg_value in dark_colors else "#333333"
    # 이미지 배경이면 기본적으로 흰색 (이미지 위 텍스트는 보통 밝은색)
    return "#FFFFFF"


# ── 섹션 HTML 생성 ───────────────────────────────────────────────────────

_VID_EXT = (".mp4", ".webm", ".mov")
# 제품 갤러리 렌디션·탭 ON/OFF 상태 이미지 — eBay 컨텐츠화 금지
_GALLERY_RE = re.compile(r"/gallery/|thum-\d+x\d+", re.I)
_ONOFF_RE = re.compile(r"[_-](on|off)\.(png|jpe?g)$", re.I)


def usable_media(section: dict) -> list:
    """eBay 렌더 대상 미디어만: 아이콘/갤러리/탭상태/비디오 제외."""
    out = []
    for m in section.get("media", []):
        u = get_best_image_url(m)
        low = u.lower().split("?")[0]
        if not u or m.get("role") == "icon" or low.endswith(_VID_EXT):
            continue
        if _GALLERY_RE.search(u) or _ONOFF_RE.search(low):
            continue
        out.append(m)
    return out


def _hcard(image_url: str, lines: list, component_id: str = "") -> str:
    """가로형 카드 1장: 왼쪽 이미지 40% / 오른쪽 텍스트 60%.
    좁은 N열 카드에 36/24px 텍스트가 들어가지 않는 문제 → 카드를 가로형으로 바꾸고 세로로 나열.
    첫 줄이 헤드라인 길이면 제목(h3), 나머지는 본문(p)."""
    h_px = spec_px(component_id, "headline", 36)
    b_px = spec_px(component_id, "body", 16)
    lines = [l for l in (lines or []) if l]
    title = lines[0] if lines and len(lines[0]) <= _HEADLINE_MAX_CHARS else ""
    body = " ".join(lines[1:] if title else lines)
    h = (f'<h3 style="font-family: {FONT_HEADLINE}; font-weight: 600; font-size: {h_px}px; '
         f'line-height: {_HEAD_LH}; margin: 0 0 10px 0; color: {_RD.get("headline_color", "#111111")};">'
         f'{escape(title)}</h3>') if title else ""
    b = (f'<p style="font-family: {FONT_BODY}; font-size: {b_px}px; line-height: {_BODY_LH}; '
         f'margin: 0; color: {_RD.get("body_color", "#2D2D2D")};">{escape(body)}</p>') if body else ""
    txt = (f'<div class="lg-hcard-text" style="flex: 1 1 60%; padding: 20px 24px 20px 0; text-align: left;">{h}{b}</div>'
           if (h or b) else "")
    img_w = "40%" if txt else "100%"
    return f'''
<div class="lg-hcard" style="display: flex; align-items: center; gap: 24px; background: #FFFFFF; border: 1px solid {_STROKE}; border-radius: 16px; overflow: hidden;">
  <div class="lg-hcard-img" style="flex: 0 0 {img_w}; max-width: {img_w};"><img src="{image_url}" alt="{escape(title)}" style="width: 100%; height: auto; display: block;"></div>
  {txt}
</div>'''


def _hcard_list(cards_html: list, heading_html: str = "") -> str:
    """가로형 카드들을 세로로 나열하는 섹션 (카드 자체가 테두리를 가지므로 섹션은 투명)."""
    return f'''
<section class="lg-section lg-grid" style="background: transparent; border: none; padding: 24px 4px;">
  {heading_html}
  <div class="lg-hcards" style="display: flex; flex-direction: column; gap: 16px;">
  {"".join(cards_html)}
  </div>
</section>'''


def _overlay_text_on_image(image_url: str, text_html: str, alignment: str) -> str:
    """텍스트를 이미지 위에 얹는 진짜 오버레이 (figma 오버레이 컴포넌트 ST0004/05/14).
    정렬은 크롤된 텍스트 위치(main-pos-left/right)를 그대로 반영."""
    text_html = re.sub(r"color:\s*#[0-9a-fA-F]{3,6}", "color: #FFFFFF", text_html)
    if alignment == "right":
        pos, scrim = "right: 0; text-align: right;", "linear-gradient(270deg, rgba(0,0,0,0.5), rgba(0,0,0,0))"
    elif alignment == "center":
        pos, scrim = "left: 0; right: 0; text-align: center; align-items: center;", "linear-gradient(0deg, rgba(0,0,0,0.5), rgba(0,0,0,0.1))"
    else:
        pos, scrim = "left: 0; text-align: left;", _RD.get("overlay_scrim", "linear-gradient(90deg, rgba(0,0,0,0.5), rgba(0,0,0,0))")
    return f'''
<section class="lg-section lg-hero" style="position: relative; overflow: hidden;">
  <img src="{image_url}" alt="" style="width: 100%; height: auto; display: block;">
  <div class="lg-text-overlay" style="position: absolute; top: 0; bottom: 0; {pos} width: 55%; max-width: 55%; padding: 32px 6%; display: flex; flex-direction: column; justify-content: center; color: #FFFFFF; background: {scrim};">
    {text_html}
  </div>
</section>'''


def _centered_stack(media_list: list, text_html: str) -> str:
    """eBay 표준: 이미지(중앙)를 위에, 텍스트(중앙)를 아래에 쌓는 단일 카드.
    닷컴의 좌/우 분할 대신 모든 컨텐츠를 중앙 정렬로 통일한다."""
    imgs = "\n".join(
        f'<img src="{get_best_image_url(m)}" alt="" style="max-width: 100%; height: auto; '
        f'display: block; margin: 0 auto {16 if i else 0}px auto; border-radius: 8px;">'
        for i, m in enumerate(media_list))
    txt = (f'<div style="text-align: center; padding: 20px 6% 4px;">{text_html}</div>'
           if text_html else "")
    return f'''
<section class="lg-section" style="padding: 24px 20px;">
  {imgs}
  {txt}
</section>'''


def build_spec_table_html(section: dict) -> str:
    """스펙 섹션을 라벨/값 2열 표로 렌더.

    스펙은 '라벨 → 값'이 짝이어야 정보가 성립한다. 라벨을 제목 스타일로 모아놓고
    값을 아래에 몰아두면 어느 값이 어느 항목인지 알 수 없으므로, mirror의
    specs(짝 목록)를 그대로 표의 행으로 옮긴다.
    """
    specs = section.get("specs") or []
    if not specs:
        return ""

    component_id = section.get("component_id", "")
    h_px = spec_px(component_id, "headline", 36)
    # 섹션 제목: text의 첫 '## ' 줄 (없으면 제목 없이)
    title = ""
    for ln in (section.get("text") or "").split("\n"):
        if ln.strip().startswith("## "):
            title = ln.strip()[3:].strip()
            break

    # 스펙 표: 그룹 제목 20px / 라벨·값 18px (261007 — 본문 24px보다 작게 해 표 길이 유지)
    stroke = _RD.get("card_stroke", "#E1E2E5")
    label_c = _RD.get("headline_color", "#111111")
    body_c = _RD.get("body_color", "#2D2D2D")

    rows, cur_group = [], None
    for sp in specs:
        g = (sp.get("group") or "").strip()
        if g and g != cur_group:
            cur_group = g
            rows.append(
                f'<tr><th colspan="2" style="font-family: {FONT_HEADLINE}; font-weight: 600; '
                f'font-size: 20px; text-align: left; padding: 16px 10px 8px 10px; '
                f'color: {label_c}; border-bottom: 1px solid {stroke};">{escape(g)}</th></tr>'
            )
        rows.append(
            f'<tr>'
            f'<td style="font-family: {FONT_BODY}; font-size: 18px; font-weight: 600; '
            f'color: {label_c}; padding: 8px 10px; width: 45%; vertical-align: top; '
            f'border-bottom: 1px solid {stroke};">{escape(sp.get("label", ""))}</td>'
            f'<td style="font-family: {FONT_BODY}; font-size: 18px; color: {body_c}; '
            f'padding: 8px 10px; vertical-align: top; '
            f'border-bottom: 1px solid {stroke};">{escape(sp.get("value", ""))}</td>'
            f'</tr>'
        )

    # 치수 도면 등 스펙 이미지는 표 위에 배치 (원본 픽셀 폭 초과 확대 금지)
    img_html = ""
    for m in usable_media(section):
        url = get_best_image_url(m)
        if not url:
            continue
        w = m.get("width") or 0
        cap = f'max-width: {min(int(w), 800)}px;' if w else 'max-width: 100%;'
        img_html = (f'<div style="text-align: center; margin-bottom: 20px;">'
                    f'<img src="{url}" alt="{escape(m.get("alt") or "")}" '
                    f'style="{cap} width: 100%; height: auto;"></div>')
        break

    head = (f'<h2 style="font-family: {FONT_HEADLINE}; font-weight: 600; font-size: {h_px}px; '
            f'line-height: {_HEAD_LH}; margin: 0 0 12px 0; color: {label_c};">{escape(title)}</h2>'
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


def build_section_html(section: dict, allow_overlay: bool = False,
                       side_flip: bool = False) -> str:
    """섹션 데이터를 HTML로 변환합니다.

    allow_overlay: 문서 최상단 KV 히어로만 True — CCG 가이드상 텍스트 오버레이는
    Hero(ST0001) KV 전용. 그 외 히어로형 피처는 닷컴처럼 이미지·텍스트를
    한 행 안에서 좌/우 나란히 배치(side_flip으로 교차)해 결합감을 유지한다.
    """
    layout_type = section.get("layout_type", "unknown")
    component_id = section.get("component_id", "")
    text = section.get("text", "")

    # 병합 카드 행은 media_list 대신 cards를 쓰므로 빈-미디어 조기 리턴보다 먼저 처리
    if layout_type == "card_row":
        cards = section.get("cards", [])
        # DOM 선언 컬럼 수(cols)가 있으면 그 수만큼, 없으면 카드 수(최대 4)로
        n = section.get("cols") or max(2, min(len(cards), 4))
        n = max(2, min(n, len(cards), 4))
        h_px = spec_px(component_id, "headline", 36)
        items = [_hcard(c.get("img", ""), _content_lines(c.get("text")), component_id) for c in cards]
        _hd_lines = _content_lines(section.get("heading", ""))
        heading = _hd_lines[0] if _hd_lines else ""
        head_html = (f'<h2 style="font-family: {FONT_HEADLINE}; font-weight: 600; font-size: {h_px}px; line-height: {_HEAD_LH}; '
                     f'text-align: center; margin: 0 0 16px 0; color: {_RD.get("headline_color", "#111111")};">'
                     f'{escape(heading)}</h2>') if heading else ""
        return _hcard_list(items, head_html)

    media_list = usable_media(section)
    # eBay 표준: 모든 컨텐츠 중앙 정렬 (닷컴의 좌/우 정렬을 override)
    text_alignment = "center"
    element_roles = section.get("element_roles")

    # 레이아웃 타입에 따른 HTML 생성
    template = LAYOUT_TEMPLATES.get(layout_type, LAYOUT_TEMPLATES["unknown"])

    # 텍스트 HTML 변환
    text_html = parse_text_to_html(text, element_roles, component_id, first_is_title=True)

    # 미디어가 없는 경우 - 순수 텍스트 섹션
    if not media_list:
        if layout_type in ["hero_full_width", "text_over_image"]:
            # 이미지 없이 텍스트만 있는 경우 vertical_stack으로 폴백
            return LAYOUT_TEMPLATES["vertical_stack"].format(
                text_align=text_alignment,
                content=text_html
            )
        return LAYOUT_TEMPLATES["vertical_stack"].format(
            text_align=text_alignment,
            content=text_html
        )

    # 첫 번째 이미지 URL
    primary_image = get_best_image_url(media_list[0]) if media_list else ""

    # figma 오버레이 컴포넌트(ST0004/05/14): 텍스트를 이미지 위에 얹어 렌더 —
    # 컴포넌트 넘버별 디자인 인지 (단일 이미지 + 텍스트일 때)
    if is_overlay_component(component_id) and text_html and len(media_list) == 1:
        return _overlay_text_on_image(primary_image, text_html, text_alignment)

    # 레이아웃 타입별 처리
    if layout_type in ("hero_full_width", "text_over_image"):
        # KV(최상단 히어로): 닷컴 카드 프레임 그대로 — 흰 카드 상단에 센터 텍스트,
        # 그 아래 이미지가 카드 폭에 꽉 차게 (오버레이 아님)
        if allow_overlay and text_html:
            return f'''
<section class="lg-section lg-hero">
  <div class="lg-hero-text" style="padding: 36px 8% 24px; text-align: center;">
    {text_html}
  </div>
  <img src="{primary_image}" alt="Hero Image" style="width: 100%; height: auto; display: block;">
</section>'''
        # 비-KV 히어로: eBay 표준 중앙 정렬 스택 (닷컴 좌/우 분할 대신)
        return _centered_stack(media_list, text_html)

    elif layout_type in ("image_text_left", "image_text_right", "image_text_side"):
        # 닷컴의 좌/우 사이드 이미지도 eBay에선 중앙 스택으로 통일
        return _centered_stack(media_list, text_html)

    elif layout_type in ["grid_2_column", "grid_3_column", "grid_4_column"]:
        # 그리드: 각 미디어를 가로형 카드로 세로 나열 (캡션은 마크다운 정리 후)
        text_lines = _content_lines(text)
        items = [_hcard(get_best_image_url(m), [text_lines[i]] if i < len(text_lines) else [], component_id)
                 for i, m in enumerate(media_list)]
        # 남은 텍스트가 있으면 카드 목록 앞에 헤더로 추가
        header_html = ""
        if len(text_lines) > len(media_list):
            remaining = text_lines[len(media_list):]
            header_html = f'<div class="lg-grid-header" style="text-align: center; margin-bottom: 16px;">{parse_text_to_html(chr(10).join(remaining), component_id=component_id)}</div>'
        return _hcard_list(items, header_html)

    elif layout_type == "icon_grid":
        # 아이콘 그리드 (Key Benefit Summary) → 가로형 카드 세로 나열
        text_lines = _content_lines(text)
        return _hcard_list([_hcard(get_best_image_url(m), [text_lines[i]] if i < len(text_lines) else [], component_id)
                            for i, m in enumerate(media_list)])

    elif layout_type == "carousel":
        # 캐러셀 → 가로 스크롤 대신 이미지를 세로로 나열
        return _hcard_list([_hcard(get_best_image_url(m), [], component_id) for m in media_list])

    elif layout_type == "product_gallery":
        # 제품 갤러리
        thumbnails = ""
        if len(media_list) > 1:
            thumb_items = []
            for i, media in enumerate(media_list[1:]):
                img_url = get_best_image_url(media)
                thumb_items.append(f'<img src="{img_url}" alt="Thumbnail {i+2}" style="width: 80px; height: 80px; object-fit: cover; cursor: pointer;">')
            thumbnails = f'<div class="lg-gallery-thumbs" style="display: flex; justify-content: center; gap: 10px;">{"".join(thumb_items)}</div>'

        return template.format(
            image_url=primary_image,
            alt_text="Product Main Image",
            thumbnails=thumbnails
        )

    elif layout_type == "vertical_stack":
        # 수직 스택 + 기본 폴백 모두 eBay 중앙 정렬 스택으로 통일
        return _centered_stack(media_list, text_html)

    else:
        return _centered_stack(media_list, text_html)


# ── 전체 HTML 문서 생성 ──────────────────────────────────────────────────

HTML_DOCUMENT_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{product_title} - LG Product Page</title>
  <style>
    * {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}
    body {{
      font-family: 'LGEIText', 'LG EI Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      line-height: 1.28;
      color: #2D2D2D;
      background: #FFFFFF;
    }}
    .lg-container {{
      max-width: 800px;
      margin: 0 auto;
      padding: 16px;
    }}
    .lg-section {{
      background: #FFFFFF;
      border: 1px solid #F0ECE4;
      border-radius: 20px;
      overflow: hidden;
      margin-bottom: 16px;
    }}
    .lg-grid, .lg-disclaimer {{
      background: transparent;
      border: none;
      border-radius: 0;
      overflow: visible;
    }}
    .lg-grid-item {{
      background: #FFFFFF;
      border: 1px solid #F0ECE4;
      border-radius: 16px;
      overflow: hidden;
      padding-bottom: 16px;
    }}
    .lg-grid-item h3, .lg-grid-item p, .lg-grid-item div {{
      padding-left: 12px;
      padding-right: 12px;
    }}
    img {{
      max-width: 100%;
      height: auto;
    }}
    h1, h2, h3 {{
      font-family: 'LGEIHeadline', 'LG EI Headline', 'LGEIText', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      font-weight: 600;
      color: #111111;
    }}
    .disclaimer {{
      color: #697072;
    }}

    /* 반응형 스타일 */
    @media (max-width: 768px) {{
      .lg-image-text {{
        flex-direction: column !important;
      }}
      .lg-grid {{
        grid-template-columns: 1fr !important;
      }}
      .lg-text-overlay {{
        position: static !important;
        transform: none !important;
        max-width: 100% !important;
        background: rgba(0,0,0,0.7);
      }}
    }}
  </style>
</head>
<body>
  <div class="lg-container">
    {sections}
  </div>
</body>
</html>
"""

# eBay 설명란 삽입용 fragment — <!DOCTYPE>/<html>/<head> 없이
# <style>(eBay 허용) + 컨테이너만. JS 없음(eBay active content 금지 준수).
FRAGMENT_STYLE = """<style>
/* 261007: 흰 배경(#FFFFFF) + 섹션별 라운드 흰 카드(1px 웜그레이 #F0ECE4 테두리). 제목 36px / 본문 24px 고정 */
.lg-container { max-width: 800px; margin: 0 auto; font-family: 'LGEIText', 'LG EI Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.28; color: #2D2D2D; background: #FFFFFF; padding: 16px; }
.lg-container img { max-width: 100%; height: auto; }
.lg-container h1, .lg-container h2, .lg-container h3 { font-family: 'LGEIHeadline', 'LG EI Headline', 'LGEIText', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-weight: 600; color: #111111; line-height: 1.0; }
.lg-container .lg-section { background: #FFFFFF; border: 1px solid #F0ECE4; border-radius: 20px; overflow: hidden; margin-bottom: 16px; }
.lg-container .lg-grid, .lg-container .lg-disclaimer { background: transparent; border: none; border-radius: 0; overflow: visible; }
.lg-container .lg-hcard { background: #FFFFFF; border: 1px solid #F0ECE4; border-radius: 16px; overflow: hidden; }
.lg-container .disclaimer { color: #697072; }
@media (max-width: 768px) {
  .lg-container .lg-image-text { flex-direction: column !important; }
}
</style>"""

# 주의: FRAGMENT_STYLE의 CSS 중괄호가 str.format과 충돌하므로 스타일은 포맷 밖에서 결합
HTML_FRAGMENT_TEMPLATE = """
<div class="lg-container">
<!-- LG Product Listing — CCG Component Layout -->
{sections}
</div>
"""


def build_ebay_html(mirror: dict, fragment: bool = False) -> str:
    """mirror.json 데이터를 기반으로 eBay용 HTML을 생성합니다.

    fragment=True: eBay 설명란 삽입용 조각(<style>+컨테이너, 문서 래퍼 없음)
    fragment=False: 브라우저 미리보기용 완전한 HTML 문서
    """
    product_title = mirror.get("product_title", "LG Product")
    sections = mirror.get("sections", [])

    # ── 전처리 1: 제품 갤러리 스킵 (eBay 컨텐츠에 갤러리 썸네일 미포함 원칙)
    sections = [s for s in sections if s.get("layout_type") != "product_gallery"]

    # ── 전처리 2: 연속된 '단일 이미지 grid_N' 섹션 병합 → 한 행 카드(card_row)
    #    (lg.com에선 한 행 비교 카드인데 크롤 구조상 섹션이 갈라지는 케이스 복원)
    #    DOM 선언 컬럼 수(column_count)가 있으면 그 수만큼씩 청크로 나눠 정확히
    #    N열 카드 행을 만든다 (없으면 최대 4열 폴백).
    def _disc(x):
        return isinstance(x.get("order"), str) and "disclaimer" in x["order"]

    def _cardish(x):
        # 카드 그리드형 컴포넌트: N열 그리드 + Key Benefit Summary(icon_grid, ST0027 등
        # column-N 클래스 없이 swiper로 N열 구현하는 컴포넌트)
        # + item_group: 파서가 항목(캐러셀 슬라이드/카드) 단위로 쪼갠 섹션 —
        #   닷컴에서 한 화면에 나란히 보이므로 한 행 카드로 되돌린다.
        lt = x.get("layout_type") or ""
        return lt.startswith("grid_") or lt == "icon_grid" or bool(x.get("item_group"))

    merged, i = [], 0
    while i < len(sections):
        s = sections[i]
        dom = s.get("component_dom_index")
        if _cardish(s) and not _disc(s) and dom is not None and dom >= 0:
            cc = s.get("column_count") or 0
            # 같은 컴포넌트(dom_index)의 연속 섹션을 모두 수집 —
            # 이미지 섹션은 카드로, 중간 텍스트-only 중복은 흡수(##는 행 대제목)
            cards, heading_text, j = [], "", i
            while j < len(sections):
                nx = sections[j]
                if nx.get("component_dom_index") != dom or _disc(nx):
                    break
                um = usable_media(nx)
                if um:
                    for mm in um:
                        cards.append({"img": get_best_image_url(mm), "text": nx.get("text", "")})
                elif nx.get("text", "").strip().startswith("##") and not heading_text:
                    heading_text = nx["text"]      # ## 대제목 → 카드 행 헤딩
                j += 1
            if len(cards) >= 2:
                # 직전 텍스트-only 섹션도 대제목 후보 (컴포넌트 밖 헤딩)
                if not heading_text and merged and merged[-1].get("layout_type") != "card_row" \
                        and not _disc(merged[-1]) and not usable_media(merged[-1]) \
                        and merged[-1].get("text"):
                    heading_text = merged.pop()["text"]
                per = cc if cc in (2, 3, 4) else min(len(cards), 4)
                for k in range(0, len(cards), per):
                    chunk = cards[k:k + per]
                    merged.append({
                        "layout_type": "card_row",
                        "component_id": s.get("component_id", ""),
                        "order": s.get("order"),
                        "cols": per,
                        "heading": heading_text if k == 0 else "",
                        "cards": chunk,
                        "media": [], "text": "",
                    })
                i = j
                continue
        merged.append(s)
        i += 1
    sections = merged

    # ── 렌더: 오버레이는 문서 최상단의 첫 히어로(KV)에만 허용,
    #    비-KV 히어로 피처는 닷컴처럼 좌/우 교차(flip) 배치
    first_hero_seen = False
    side_flip = False
    html_sections = []
    for section in sections:
        order = section.get("order", "")
        # [공통 분류규칙] 디스클레이머 섹션 제외
        if isinstance(order, str) and "disclaimer" in order:
            continue
        # 스펙 짝(라벨/값)이 있으면 2열 표로 렌더 — 짝을 잃지 않게.
        #   스펙 표는 이미지가 없어도 완결된 정보이므로 미디어 필수 조건보다 먼저 처리한다.
        if section.get("specs"):
            spec_html = build_spec_table_html(section)
            if spec_html:
                html_sections.append(spec_html)
                continue

        # [공통 분류규칙] 텍스트만 있는 섹션 제외 (이미지+텍스트 구조만 사용).
        #   카드 행(card_row)은 media=[] 지만 cards 보유 → 예외
        if section.get("layout_type") != "card_row" and not usable_media(section):
            continue

        allow_overlay = False
        is_heroish = section.get("layout_type") in ("hero_full_width", "text_over_image")
        if is_heroish and not first_hero_seen and usable_media(section):
            allow_overlay = True
            first_hero_seen = True

        section_html = build_section_html(section, allow_overlay=allow_overlay,
                                          side_flip=side_flip)
        if section_html:
            html_sections.append(section_html)
            # 좌/우 교차는 실제로 나란히 렌더된 섹션에서만 뒤집기
            if is_heroish and not allow_overlay and "lg-image-text" in section_html:
                side_flip = not side_flip

    if fragment:
        out = FRAGMENT_STYLE + HTML_FRAGMENT_TEMPLATE.format(sections="\n".join(html_sections))
        assert_no_active_content(out)   # eBay 정책: active content 금지 (자동 가드)
        return out
    return HTML_DOCUMENT_TEMPLATE.format(
        product_title=escape(product_title),
        sections="\n".join(html_sections)
    )


# eBay 리스팅 설명란은 active content(JS/form/iframe 등)를 차단한다.
# fragment 출력이 항상 정적 HTML+인라인 CSS만 담도록 강제하는 가드.
_ACTIVE_CONTENT = re.compile(
    r"<\s*(script|iframe|embed|object|applet|form|input|button|select|textarea|link|meta)\b"
    r"|\son\w+\s*=|javascript:|http-equiv",
    re.I,
)


def assert_no_active_content(html: str):
    hits = _ACTIVE_CONTENT.findall(html or "")
    if hits:
        raise ValueError(f"eBay active content 정책 위반 감지: {hits[:5]}")


# ── 메인 실행 ────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="CCG 컴포넌트 기반 eBay HTML 빌더")
    ap.add_argument("slug_dir", help="크롤러 출력 디렉토리 (out/slug)")
    ap.add_argument("--preview", action="store_true", help="브라우저에서 미리보기")
    ap.add_argument("--fragment", action="store_true", help="eBay 설명란 삽입용 조각 출력 (문서 래퍼 없음)")
    ap.add_argument("--output", "-o", help="출력 HTML 파일명 (기본: ebay_content.html)")
    args = ap.parse_args()

    slug_dir = Path(args.slug_dir)
    mirror_file = slug_dir / "mirror.json"

    if not mirror_file.exists():
        print(f"✗ mirror.json이 없습니다: {mirror_file}")
        print("  먼저 pdp_pipeline.py를 실행하여 mirror.json을 생성하세요.")
        return 1

    # mirror.json 로드
    mirror = json.loads(mirror_file.read_text(encoding="utf-8"))

    # HTML 생성
    html_content = build_ebay_html(mirror, fragment=args.fragment)

    # 출력
    output_file = slug_dir / (args.output or "ebay_content.html")
    output_file.write_text(html_content, encoding="utf-8")
    print(f"✓ eBay HTML 생성 완료: {output_file}")

    # 컴포넌트 통계 출력
    component_summary = mirror.get("_component_summary", {})
    if component_summary:
        print(f"   사용된 CCG 컴포넌트: {dict(sorted(component_summary.items()))}")

    # 섹션 통계
    sections = mirror.get("sections", [])
    layout_types = {}
    for s in sections:
        lt = s.get("layout_type", "unknown")
        layout_types[lt] = layout_types.get(lt, 0) + 1
    if any(lt != "unknown" for lt in layout_types):
        print(f"   레이아웃 타입 분포: {dict(sorted((k,v) for k,v in layout_types.items() if k))}")

    # 미리보기
    if args.preview:
        webbrowser.open(f"file://{output_file.absolute()}")
        print("   → 브라우저에서 미리보기 열림")

    return 0


if __name__ == "__main__":
    exit(main())
