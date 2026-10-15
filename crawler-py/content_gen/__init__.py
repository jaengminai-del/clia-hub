# -*- coding: utf-8 -*-
"""
content_gen — 1차 컨텐츠 생성 엔진

  크롤 결과(mirror.json)
     → [A] model.build_blocks      공통 컨텐츠 모델 (매체 무관)
     → [B] media/<매체>/spec.json  매체 규격 (글자 크기·색·카드 비율·레이아웃 패턴·규칙)
     → [C] render_html             매체 규격대로 HTML 렌더
     → 1차 컨텐츠

사용:
  from content_gen import generate
  html = generate(mirror, medium="ebay", fragment=True)

매체: ebay, shopee_lazada (Shopee·Lazada 공통 — 2026-10-15 현재 값은 eBay와 동일, 규격 확정 시 교체)
슬라이스 이미지: content_gen/slices.py (spec.json "slices" 기본값, /api/render-slices 가 호출)
매체 추가: media/<매체>/ 에 spec.json + fragment.css + fragment.html + document.html 을 만든다.
"""
import json
import re
from functools import lru_cache
from html import escape
from pathlib import Path

from .model import build_blocks
from .render_html import Style, render_blocks

_HERE = Path(__file__).resolve().parent
_CRAWLER = _HERE.parent


def _read_json(fp: Path, default):
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except Exception:
        return default


@lru_cache(maxsize=None)
def load_medium(medium: str) -> dict:
    """매체 규격과 HTML 틀을 읽는다."""
    d = _HERE / "media" / medium
    if not (d / "spec.json").exists():
        raise ValueError(f"unknown medium: {medium}")
    return {
        "spec": _read_json(d / "spec.json", {}),
        "fragment_css": (d / "fragment.css").read_text(encoding="utf-8"),
        "fragment_html": (d / "fragment.html").read_text(encoding="utf-8"),
        "document_html": (d / "document.html").read_text(encoding="utf-8"),
    }


@lru_cache(maxsize=None)
def _style(medium: str) -> Style:
    # LG 디자인 가이드(컴포넌트별 desktop_px·GP1 폰트)와 figma 오버레이 컴포넌트 목록은 매체 공통
    guide = _read_json(_CRAWLER / "ccg_spec.json", {"components": {}})
    figma = _read_json(_CRAWLER / "figma_component_spec.json", {})
    overlay_ids = {cid for cid, v in figma.items() if isinstance(v, dict) and v.get("is_overlay")}
    return Style(load_medium(medium)["spec"], guide, overlay_ids)


# 마켓 설명란이 차단하는 active content(JS/form/iframe 등) — 출력이 정적 HTML+인라인 CSS만 담도록 강제
_ACTIVE_CONTENT = re.compile(
    r"<\s*(script|iframe|embed|object|applet|form|input|button|select|textarea|link|meta)\b"
    r"|\son\w+\s*=|javascript:|http-equiv",
    re.I,
)


def assert_no_active_content(html: str):
    hits = _ACTIVE_CONTENT.findall(html or "")
    if hits:
        raise ValueError(f"active content 정책 위반 감지: {hits[:5]}")


def _fill(template: str, **values) -> str:
    """{name} 자리표시자를 한 번에 치환 (값 안의 중괄호는 건드리지 않음)."""
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), m.group(0)), template)


def generate(mirror: dict, medium: str = "ebay", fragment: bool = False) -> str:
    """mirror → 매체용 1차 컨텐츠 HTML.
    fragment=True: 설명란 삽입용 조각(<style>+컨테이너), False: 브라우저 미리보기용 완전한 문서."""
    m = load_medium(medium)
    spec, st = m["spec"], _style(medium)
    rules = spec.get("rules", {})
    blocks = build_blocks(mirror, rules)
    sections = "\n".join(render_blocks(st, blocks, rules.get("text_alignment", "center")))
    if fragment:
        body = _fill(m["fragment_html"], sections=sections)
        css = m["fragment_css"]
        out_opts = spec.get("output", {})
        if out_opts.get("inline_css"):
            # 편집기가 <style> 을 지워도 같게 보이도록 모든 규칙을 인라인으로 (style 블록은 그대로 둠)
            from .inline_css import inline
            body = inline(body, re.sub(r"</?style>", "", css))
        ff = out_opts.get("font_face") or {}
        if ff.get("faces") and ff.get("base_url"):
            # LG 글꼴: 배포 서버의 woff2/ttf (<style> 이 허용되는 편집기에서만 적용 — 인라인으로는 불가)
            from .inline_css import font_face_css
            css = css.replace("<style>", "<style>\n" + font_face_css(ff["faces"], ff["base_url"]), 1)
        out = css + body
        if out_opts.get("forbid_active_content"):
            assert_no_active_content(out)
        return out
    return _fill(m["document_html"], product_title=escape(mirror.get("product_title", "LG Product")),
                 sections=sections)
