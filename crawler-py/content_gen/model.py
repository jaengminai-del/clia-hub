# -*- coding: utf-8 -*-
"""
model.py — [A] 공통 컨텐츠 모델 (1차 컨텐츠 생성)

크롤 결과(mirror.json)를 매체와 무관한 '블록' 목록으로 정리한다. 매체별 렌더러는 이 블록만 보고
매체 규격(media/<매체>/spec.json)에 맞춰 HTML·이미지를 만든다.

블록 종류
  {"kind": "spec_table", "section": s}                      라벨/값 스펙 표
  {"kind": "card_row", "component_id", "cols", "heading", "cards": [{"img", "text"}]}
                                                             같은 컴포넌트의 N열 카드 행 (닷컴 한 행 복원)
  {"kind": "section", "section": s, "kv": bool}             일반 섹션 (kv = 문서 최상단 히어로)

규칙(rules, 매체 spec.json)
  skip_layouts            제외할 layout_type (예: product_gallery)
  skip_disclaimer         디스클레이머 섹션 제외
  drop_text_only_sections 이미지 없는 텍스트-only 섹션 제외 (카드 행·스펙 표는 예외)
  max_card_columns        DOM 컬럼 수가 없을 때 카드 행 최대 열 수
  use_group_heading       true면 카드 묶음(item_group)의 대제목(group_heading)을 카드 행 제목으로 (F6)
  legacy_gallery_path_filter  true면 모든 섹션에 예전 규칙(주소에 /gallery/ 가 있으면 제외) — 되돌리기용.
                          기본(false): 컴포넌트 구조로 만든 섹션(component_id 있음)의 이미지는 LG.com 그 컴포넌트에
                          실제로 보이는 컨텐츠이므로 모두 쓴다 (독일 등은 기능 이미지도 DAM /gallery/ 폴더에 둠).
                          예전 Gemini 방식 섹션(component_id 없음)만 예전 규칙 유지 — 갤러리 썸네일 혼입 방지.
"""
import re

from make_mirror import _section_signature

_VID_EXT = (".mp4", ".webm", ".mov")
# 갤러리 썸네일 렌디션·탭 ON/OFF 상태 이미지 — 컨텐츠화 금지
_THUMB_RE = re.compile(r"thum-\d+x\d+", re.I)
_LEGACY_GALLERY_RE = re.compile(r"/gallery/", re.I)
_ONOFF_RE = re.compile(r"[_-](on|off)\.(png|jpe?g)$", re.I)


def best_image_url(media: dict) -> str:
    """미디어 객체에서 최적 이미지 URL."""
    return media.get("pc_url") or media.get("unified_url") or media.get("mobile_url") or ""


def usable_media(section: dict) -> list:
    """컨텐츠로 쓸 미디어만: 아이콘/갤러리/탭상태/비디오 제외."""
    out = []
    for m in section.get("media", []):
        u = best_image_url(m)
        low = u.lower().split("?")[0]
        if not u or m.get("role") == "icon" or low.endswith(_VID_EXT):
            continue
        if _THUMB_RE.search(u) or _ONOFF_RE.search(low):
            continue
        out.append(m)
    return out


def is_disclaimer(section: dict) -> bool:
    order = section.get("order")
    return isinstance(order, str) and "disclaimer" in order


def _cardish(section: dict) -> bool:
    # 카드 그리드형 컴포넌트: N열 그리드 + Key Benefit Summary(icon_grid, ST0027 등
    # column-N 클래스 없이 swiper로 N열 구현하는 컴포넌트)
    # + item_group: 파서가 항목(캐러셀 슬라이드/카드) 단위로 쪼갠 섹션 —
    #   닷컴에서 한 화면에 나란히 보이므로 한 행 카드로 되돌린다.
    lt = section.get("layout_type") or ""
    return lt.startswith("grid_") or lt == "icon_grid" or bool(section.get("item_group"))


def _dedupe(sections: list) -> list:
    """이미지·텍스트가 모두 같은 섹션은 한 번만 (캐러셀 루프 복제 슬라이드 등)."""
    seen, out = set(), []
    for s in sections:
        sig = _section_signature(s)
        if (sig[0] or sig[1] or sig[2]) and sig in seen:
            continue
        seen.add(sig)
        out.append(s)
    return out


def _merge_card_rows(sections: list, max_cols: int, use_group_heading: bool = False) -> list:
    """연속된 '단일 이미지 grid_N' 섹션 병합 → 한 행 카드(card_row).
    lg.com에선 한 행 비교 카드인데 크롤 구조상 섹션이 갈라지는 케이스 복원.
    DOM 선언 컬럼 수(column_count)가 있으면 그 수만큼씩 청크로 나눠 정확히 N열 카드 행을 만든다
    (없으면 max_cols 폴백)."""
    merged, i = [], 0
    while i < len(sections):
        s = sections[i]
        dom = s.get("component_dom_index")
        if _cardish(s) and not is_disclaimer(s) and dom is not None and dom >= 0:
            cc = s.get("column_count") or 0
            # 같은 컴포넌트(dom_index)의 연속 섹션을 모두 수집 —
            # 이미지 섹션은 카드로, 중간 텍스트-only 중복은 흡수(##는 행 대제목)
            cards, heading_text, j = [], "", i
            while j < len(sections):
                nx = sections[j]
                if nx.get("component_dom_index") != dom or is_disclaimer(nx):
                    break
                um = usable_media(nx)
                if um and use_group_heading and not heading_text and nx.get("group_heading"):
                    heading_text = "## " + nx["group_heading"]   # 컴포넌트 대제목 (F6)
                if um:
                    for mm in um:
                        cards.append({"img": best_image_url(mm), "text": nx.get("text", "")})
                elif nx.get("text", "").strip().startswith("##") and not heading_text:
                    heading_text = nx["text"]      # ## 대제목 → 카드 행 헤딩
                j += 1
            if len(cards) >= 2:
                # 직전 텍스트-only 섹션도 대제목 후보 (컴포넌트 밖 헤딩)
                if not heading_text and merged and merged[-1].get("layout_type") != "card_row" \
                        and not is_disclaimer(merged[-1]) and not usable_media(merged[-1]) \
                        and merged[-1].get("text"):
                    heading_text = merged.pop()["text"]
                per = cc if cc in range(2, max_cols + 1) else min(len(cards), max_cols)
                for k in range(0, len(cards), per):
                    merged.append({
                        "layout_type": "card_row",
                        "component_id": s.get("component_id", ""),
                        "order": s.get("order"),
                        "cols": per,
                        "heading": heading_text if k == 0 else "",
                        "cards": cards[k:k + per],
                        "media": [], "text": "",
                    })
                i = j
                continue
        merged.append(s)
        i += 1
    return merged


def _drop_gallery_media(sections: list, legacy: bool) -> list:
    """제품 갤러리 이미지 제외 (섹션은 복사본, mirror 원본은 그대로)."""
    def keep(m, s):
        if legacy or not s.get("component_id"):
            return not _LEGACY_GALLERY_RE.search(best_image_url(m))
        return True

    return [dict(s, media=[m for m in s.get("media", []) if keep(m, s)]) for s in sections]


def build_blocks(mirror: dict, rules: dict) -> list:
    """mirror → 블록 목록 (화면 순서)."""
    skip_layouts = set(rules.get("skip_layouts") or [])
    sections = [s for s in mirror.get("sections", []) if s.get("layout_type") not in skip_layouts]
    sections = _drop_gallery_media(sections, bool(rules.get("legacy_gallery_path_filter")))
    sections = _dedupe(sections)
    sections = _merge_card_rows(sections, int(rules.get("max_card_columns") or 4),
                                bool(rules.get("use_group_heading")))

    blocks, kv_seen = [], False
    for s in sections:
        if rules.get("skip_disclaimer", True) and is_disclaimer(s):
            continue
        # 스펙 짝(라벨/값)이 있으면 표 — 이미지가 없어도 완결된 정보이므로 텍스트-only 제외보다 먼저
        if s.get("specs"):
            blocks.append({"kind": "spec_table", "section": s})
            continue
        if s.get("layout_type") == "card_row":
            blocks.append({"kind": "card_row", "component_id": s.get("component_id", ""),
                           "cols": s.get("cols"), "heading": s.get("heading", ""),
                           "cards": s.get("cards", [])})
            continue
        has_media = bool(usable_media(s))
        if rules.get("drop_text_only_sections", True) and not has_media:
            continue
        # KV: 문서 최상단의 첫 히어로(이미지 보유)
        kv = False
        if not kv_seen and has_media and s.get("layout_type") in ("hero_full_width", "text_over_image"):
            kv = kv_seen = True
        blocks.append({"kind": "section", "section": s, "kv": kv})
    return blocks
