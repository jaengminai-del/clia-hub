# -*- coding: utf-8 -*-
"""
component_mirror.py — 컴포넌트-우선(component-first) 미러 빌더.

기존 파이프라인은 Gemini가 추정한 섹션(final.json)을 기준으로 삼고 CCG 컴포넌트를
문자열 매칭으로 끼워넣어(매칭률 ~56%) 고아 섹션과 오그룹핑이 계속 발생했다.
이 모듈은 순서를 뒤집는다:

    HTML → component_parser(c-wrapper div) → **컴포넌트 = 섹션**
    · 섹션 경계 = 컴포넌트 부모 div
    · 이미지 ↔ eyebrow/headline/body = 그 div의 자식들 (이미 한 몸, 매칭 불필요)
    · 순서 = dom_index (DOM = 화면 순서)
    · 컬럼 수 = column-N 클래스 → 없으면 DOM 자식 구조/미디어 수로 추론

3P(eBay·Amazon) 출력 규칙:
    · 텍스트와 이미지가 **둘 다** 있는 섹션만 콘텐츠로 노출 (renderable)
    · 이미지만/텍스트만 있는 섹션은 feature 카드 후보(card_candidate)로 분류
    · 노이즈 컴포넌트(GNB/푸터/쿠키/추천 등)는 제외
    · 모든 이미지는 누락 없이 수집 (assets_all에 보존)
"""
import json
import re
from collections import Counter
from pathlib import Path
from typing import List, Optional

try:
    from text_filters import strip_descriptions, clean_line, is_image_description
except Exception:                                     # 폴백 (필터 부재 시 파이프라인 중단 방지)
    def strip_descriptions(t): return t
    def clean_line(t): return (t or "").lstrip("#* ").strip()
    def is_image_description(t): return False


# ── 노이즈 컴포넌트: 페이지 크롬/추천/지원 영역 (콘텐츠 아님) ──────────────
NOISE_PREFIX = ("CM", "GN", "AL", "PN", "CS")
NOISE_IDS = {
    "PD0001",   # Product List (추천 상품)
    "PD0002",   # Our Picks for You
    "PD0004",   # Reviews
    "PD0006",   # Support / Manual
    "PD0044", "PD0056",
}
# 갤러리는 콘텐츠 섹션이 아니라 제품 대표 이미지 → 별도 취급
GALLERY_IDS = {"PD0012", "PD0033"}
SPEC_IDS = {"PD0008", "ST0035"}

_TEXT_ROLES_HEAD = ("headline", "subheadline")
_TEXT_ROLES_BODY = ("body_copy", "body", "description")


def _pick_texts(comp: dict) -> dict:
    """컴포넌트 자식 텍스트를 역할별로 정리 (중복·묘사문 제거, 순서 보존)."""
    return _pick_texts_list(comp.get("elements", {}).get("texts", []))


def _pick_texts_list(text_list: list) -> dict:
    """텍스트 요소 목록을 역할별로 정리. 항목(item) 단위에도 그대로 쓴다."""
    out = {"eyebrow": [], "headline": [], "body": [], "disclaimer": []}
    seen = set()
    for t in (text_list or []):
        raw = (t.get("text") or "").strip()
        if not raw:
            continue
        txt = strip_descriptions(raw).strip()
        if not txt or is_image_description(txt):
            continue
        key = re.sub(r"\s+", " ", txt.lower())[:120]
        if key in seen:
            continue
        seen.add(key)
        role = (t.get("role") or "").lower()
        if role == "eyebrow":
            out["eyebrow"].append(txt)
        elif role in _TEXT_ROLES_HEAD:
            out["headline"].append(txt)
        elif role == "disclaimer":
            out["disclaimer"].append(txt)
        elif role in _TEXT_ROLES_BODY:
            out["body"].append(txt)
        else:
            out["body"].append(txt)
    return out


def _pick_specs(comp: dict) -> List[dict]:
    """컴포넌트의 스펙 라벨/값 짝을 정리 (빈 값·중복 제거, DOM 순서 보존).

    파서가 라벨과 값을 한 몸으로 뽑아주므로 여기서 매칭할 일이 없다.
    """
    out, seen = [], set()
    for sp in comp.get("elements", {}).get("specs", []) or []:
        label = re.sub(r"\s+", " ", (sp.get("label") or "").strip())
        value = re.sub(r"\s+", " ", (sp.get("value") or "").strip())
        if not label or not value:
            continue
        key = (label.lower(), value.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append({"label": label, "value": value,
                    "group": (sp.get("group") or "").strip() or None})
    return out


_LG_ORIGIN = "https://www.lg.com"


def _abs_url(u: str, origin: str = _LG_ORIGIN) -> str:
    """LG DAM 상대경로(/content/dam/...)를 절대 URL로 변환.

    component_parser는 HTML의 src/srcset을 원문 그대로 담기 때문에 상대경로가 섞인다.
    3P(eBay·Amazon) HTML은 외부에서 열리므로 절대 URL이 아니면 이미지가 전부 깨진다.
    """
    u = (u or "").strip()
    if not u:
        return ""
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("/"):
        return origin + u
    if u.startswith("http://"):
        return "https://" + u[len("http://"):]
    return u


def _pick_media(comp: dict, origin: str = _LG_ORIGIN) -> List[dict]:
    """컴포넌트 자식 미디어 수집 (PC 우선, 파일명 기준 중복 제거, 순서 보존, URL 절대화)."""
    return _pick_media_list(comp.get("elements", {}).get("media", []), origin)


def _pick_media_list(media_list: list, origin: str = _LG_ORIGIN) -> List[dict]:
    """미디어 요소 목록 수집. 항목(item) 단위에도 그대로 쓴다."""
    out, seen = [], set()
    for m in (media_list or []):
        pc = _abs_url(m.get("src_desktop"), origin)
        mo = _abs_url(m.get("src_mobile"), origin)
        url = pc or mo
        if not url:
            continue
        key = url.split("/")[-1].split("?")[0].lower()
        key = re.sub(r"[._-]\d{2,4}x\d{2,4}", "", key)     # 사이즈 변형 통합
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "pc_url": pc or url,
            "mobile_url": mo,
            "unified_url": "",
            "type": m.get("type") or "image",
            "role": "icon" if re.search(r"\.svg($|\?)|/icon", url, re.I) else "content",
        })
    return out


def _infer_columns(comp: dict, n_media: int, n_head: int) -> int:
    """컬럼 수: DOM 선언(column-N) 우선 → 없으면 레이아웃/자식 수로 추론."""
    declared = comp.get("column_count") or 0
    if declared >= 2:
        return min(declared, 4)
    lt = comp.get("layout_type") or ""
    m = re.match(r"grid_(\d)_column", lt)
    if m:
        return int(m.group(1))
    if lt == "icon_grid":
        return min(max(n_media, 2), 4) if n_media >= 2 else 1
    # 헤드라인 여러 개 + 미디어 여러 개가 같은 수 → 카드 N열로 간주
    if n_head >= 2 and n_media >= 2 and abs(n_head - n_media) <= 1:
        return min(max(n_head, n_media), 4)
    return 1


def build_component_sections(component_data: list, origin: str = _LG_ORIGIN) -> dict:
    """components.json(파싱된 c-wrapper 컴포넌트) → 컴포넌트-우선 섹션 목록.

    반환 dict:
      sections      : 콘텐츠 섹션 (dom 순서). 각 섹션은 아래 필드를 가진다.
                      component_id / component_dom_index / layout_type / columns /
                      text_alignment / eyebrow / headline / body / disclaimer /
                      media / kind(content|gallery|spec) / renderable(bool)
      gallery       : 제품 갤러리 이미지 (PD0012 등)
      assets_all    : 모든 이미지 URL (누락 방지용 전수 목록)
      stats         : 집계
    """
    sections, gallery, assets_all = [], [], []
    seen_assets = set()

    for comp in sorted(component_data, key=lambda c: c.get("dom_index", 0)):
        cid = (comp.get("component_id") or "").upper()
        media = _pick_media(comp, origin)
        texts = _pick_texts(comp)

        # 전수 이미지 목록 (노이즈 포함 — 누락 방지용)
        for m in media:
            k = (m["pc_url"] or m["mobile_url"]).split("/")[-1].split("?")[0].lower()
            if k not in seen_assets:
                seen_assets.add(k)
                assets_all.append({"url": m["pc_url"] or m["mobile_url"],
                                   "component_id": cid, "role": m["role"]})

        if cid[:2] in NOISE_PREFIX or cid in NOISE_IDS:
            continue                                    # 페이지 크롬/추천 → 콘텐츠 제외

        if cid in GALLERY_IDS:
            for m in media:
                if m["role"] == "content":
                    gallery.append(m)
            continue

        head = texts["headline"]
        body = texts["body"]
        specs = _pick_specs(comp)
        content_media = [m for m in media if m["role"] == "content"]
        cols = _infer_columns(comp, len(content_media), len(head))
        has_text = bool(head or body or specs)
        has_img = bool(content_media)

        # ── 항목 단위 그룹 (캐러셀 슬라이드/카드): 항목마다 별도 섹션으로 분리.
        #    한 컴포넌트를 통째로 합치면 '제목 N개 → 본문 N개 → 이미지 N개'로 갈라져
        #    어느 이미지가 어느 텍스트의 것인지 알 수 없다. 항목 경계를 그대로 섹션 경계로 쓴다.
        item_groups = comp.get("elements", {}).get("items") or []
        if len(item_groups) >= 2:
            group_head = head[:1]            # 컴포넌트 레벨 제목(항목 밖) = 행 대제목
            n_items = len(item_groups)
            made = 0
            for it in item_groups:
                it_texts = _pick_texts_list(it.get("texts"))
                it_media = [m for m in _pick_media_list(it.get("media"), origin)
                            if m["role"] == "content"]
                it_head = it_texts["headline"]
                it_body = it_texts["body"]
                if not (it_head or it_body) or not it_media:
                    continue
                sections.append({
                    "component_id": cid,
                    "component_dom_index": comp.get("dom_index", -1),
                    "layout_type": comp.get("layout_type") or "unknown",
                    "columns": comp.get("column_count") or n_items,
                    "text_alignment": comp.get("text_alignment") or "left",
                    "eyebrow": it_texts["eyebrow"][:1],
                    "headline": it_head,
                    "body": it_body,
                    "specs": [],
                    "disclaimer": it_texts["disclaimer"],
                    "media": it_media,
                    "kind": "content",
                    "renderable": True,
                    # 한 행에 나란히 놓이는 항목 묶음 — 빌더가 카드 행으로 렌더할 근거
                    "item_group": True,
                    "group_heading": group_head[0] if group_head and made == 0 else "",
                })
                made += 1
            if made >= 2:
                continue                     # 항목 섹션으로 대체했으므로 통합 섹션은 만들지 않는다
            # 항목이 2개 미만으로 살아남으면 통합 경로로 폴백 (부분 추가분 되돌리기)
            if made:
                del sections[-made:]

        if not has_text and not has_img:
            continue

        sections.append({
            "component_id": cid,
            "component_dom_index": comp.get("dom_index", -1),
            "layout_type": comp.get("layout_type") or "unknown",
            "columns": cols,
            "text_alignment": comp.get("text_alignment") or "left",
            "eyebrow": texts["eyebrow"][:1],
            "headline": head,
            "body": body,
            "specs": specs,
            "disclaimer": texts["disclaimer"],
            "media": content_media,
            "kind": "spec" if cid in SPEC_IDS else "content",
            "item_group": False,
            "group_heading": "",
            # 3P 노출 조건: 텍스트와 이미지가 둘 다 모여 그룹핑된 섹션만.
            # 단 스펙 표는 라벨/값 짝 자체가 완결된 정보라 이미지가 없어도 노출한다
            # (이미지 요건은 '텍스트 조각만 떠도는 섹션'을 걸러내기 위한 규칙).
            "renderable": (has_text and has_img) or bool(specs),
        })

    stats = {
        "components_in": len(component_data),
        "sections": len(sections),
        "renderable": sum(1 for s in sections if s["renderable"]),
        "text_only": sum(1 for s in sections if not s["media"]),
        "image_only": sum(1 for s in sections if s["media"] and not (s["headline"] or s["body"])),
        "gallery_images": len(gallery),
        "assets_all": len(assets_all),
        "layouts": dict(Counter(s["layout_type"] for s in sections)),
    }
    return {"sections": sections, "gallery": gallery, "assets_all": assets_all, "stats": stats}


def _is_fragment_heading(text: str) -> bool:
    """CMS 입력 실수로 남은 잘린 제목 조각인가 (예: 'Hea' ← 'Heat Pump ...').

    라틴 문자 1~4자 한 단어이면서 대문자 약어(AI·OLED·4K)가 아닌 경우만 파편으로 본다.
    """
    t = (text or "").strip()
    return bool(re.fullmatch(r"[A-Za-z]{1,4}", t)) and not t.isupper()


def _is_image_with_fragment_text(s: dict) -> bool:
    """이미지 + 파편 제목뿐(본문 없음)인 섹션 — 결합 시 이미지 전용 섹션으로 취급."""
    return bool(s["media"]) and not s["body"] and bool(s["headline"]) \
        and all(_is_fragment_heading(h) for h in s["headline"])


def stitch_orphans(built: dict) -> int:
    """텍스트만/이미지만 있는 인접 섹션을 DOM 순서로 결합 — LG.com의
    '타이틀 컴포넌트(ST0003) + 이미지 컴포넌트(ST0001)' 형제 구조 복원.

    DOM 인접(dom_index 차이 ≤ 2)일 때만 결합하므로 엉뚱한 짝짓기가 없다.
    결합 결과는 renderable=True 가 되어 3P 콘텐츠로 노출된다.
    이미지 쪽에 잘린 제목 조각('Hea')만 있으면 그 조각은 버리고 이미지 전용으로 결합한다.
    """
    secs = built["sections"]
    out, used, merged = [], [False] * len(secs), 0
    for i, s in enumerate(secs):
        if used[i]:
            continue
        text_only = bool(s["headline"] or s["body"]) and not s["media"]
        if text_only:
            for j in range(i + 1, min(i + 3, len(secs))):
                if used[j]:
                    continue
                t = secs[j]
                img_only = (bool(t["media"]) and not (t["headline"] or t["body"])) \
                    or _is_image_with_fragment_text(t)
                if img_only and abs(t["component_dom_index"] - s["component_dom_index"]) <= 2:
                    s = dict(s)
                    s["media"] = t["media"]
                    s["columns"] = max(s["columns"], t["columns"])
                    if t["layout_type"] not in ("unknown", "vertical_stack"):
                        s["layout_type"] = t["layout_type"]
                    s["renderable"] = True
                    used[j] = True
                    merged += 1
                    break
        out.append(s)
        used[i] = True
    built["sections"] = out
    built["stats"]["stitched"] = merged
    built["stats"]["renderable"] = sum(1 for x in out if x["renderable"])
    built["stats"]["sections"] = len(out)
    return merged


def to_mirror_format(built: dict, product_title: str = "") -> dict:
    """컴포넌트-우선 섹션 → 기존 mirror.json 스키마로 직렬화 (하위 호환).

    eBay/Amazon 빌더가 그대로 소비할 수 있도록 text(마크다운)+media 형태로 변환한다.
    renderable=False(그룹핑 불가) 섹션은 콘텐츠에서 제외하되 feature 카드 후보로 남긴다.
    """
    out_secs, cards = [], []
    order = 0
    for s in built["sections"]:
        parts = []
        parts += s["eyebrow"]
        parts += [f"## {h}" for h in s["headline"]]
        parts += s["body"]
        # 스펙은 '라벨: 값' 한 줄로 붙여야 짝이 유지된다.
        # 라벨만 제목 스타일로 모으고 값을 아래에 몰아두면 어느 값이 어느 항목인지 알 수 없다.
        cur_group = None
        for sp in (s.get("specs") or []):
            if sp.get("group") and sp["group"] != cur_group:
                cur_group = sp["group"]
                parts.append(f"### {cur_group}")
            parts.append(f"- {sp['label']}: {sp['value']}")
        text = "\n".join(p for p in parts if p)
        entry = {
            "order": None,
            "text": text,
            "specs": s.get("specs") or [],
            # 한 행에 나란히 놓이는 항목 묶음 여부 — 빌더가 카드 행으로 렌더할 근거
            "item_group": bool(s.get("item_group")),
            "group_heading": s.get("group_heading") or "",
            "media": s["media"],
            "component_id": s["component_id"],
            "component_dom_index": s["component_dom_index"],
            "layout_type": s["layout_type"],
            "columns": s["columns"],
            "column_count": s["columns"],
            "text_alignment": s["text_alignment"],
        }
        if s["renderable"]:
            order += 1
            entry["order"] = order
            out_secs.append(entry)
            if s["disclaimer"]:
                out_secs.append({"order": f"{order} - disclaimer",
                                 "text": "\n".join(f"*{d.lstrip('*').strip()}" for d in s["disclaimer"]),
                                 "media": [], "component_id": None,
                                 "component_dom_index": -1, "layout_type": None})
        else:
            cards.append(entry)

    return {
        "product_title": product_title,
        "note": "lg.com 원문 미러 (component-first: div 구조 기반 그룹핑)",
        "sections": out_secs,
        "_feature_cards": cards,          # 텍스트/이미지 한쪽만 있는 섹션 (카드 후보)
        "_gallery": built["gallery"],
        "_assets_all": built["assets_all"],
        "_component_summary": dict(Counter(s["component_id"] for s in built["sections"])),
        "_cf_stats": built["stats"],
    }


def build_from_components(component_data: list, product_title: str = "", origin: str = _LG_ORIGIN) -> dict:
    """엔드투엔드: components.json → mirror 스키마 (그룹핑·컬럼·노출조건 적용)."""
    built = build_component_sections(component_data, origin)
    stitch_orphans(built)
    return to_mirror_format(built, product_title)


def _origin_from_slug(slug: str) -> str:
    """slug(www-lg-com-sg-...)에서 원본 도메인 복원. 실패 시 기본 lg.com."""
    m = re.match(r"^(www-lg-com|www-lg-co-[a-z]{2}|[a-z-]*lg-com)", slug or "")
    if m:
        host = m.group(1).replace("-", ".")
        return "https://" + host
    return _LG_ORIGIN


def main():
    import argparse
    ap = argparse.ArgumentParser(description="컴포넌트-우선 미러 빌더")
    ap.add_argument("slug_dir", help="out/<slug> 디렉토리")
    ap.add_argument("--write", action="store_true", help="mirror_cf.json 저장")
    args = ap.parse_args()
    d = Path(args.slug_dir)
    comps = json.loads((d / "components.json").read_text(encoding="utf-8"))
    title = ""
    fp = d / "final.json"
    if fp.exists():
        try:
            title = json.loads(fp.read_text(encoding="utf-8")).get("product_title", "")
        except Exception:
            pass
    mirror = build_from_components(comps, title, _origin_from_slug(d.name))
    st = mirror["_cf_stats"]
    print(f"컴포넌트 {st['components_in']} → 섹션 {st['sections']} "
          f"(노출가능 {st['renderable']} / 텍스트만 {st['text_only']} / 이미지만 {st['image_only']} "
          f"/ 결합 {st.get('stitched', 0)})")
    print(f"갤러리 {st['gallery_images']}장 · 전체 이미지 {st['assets_all']}장")
    print(f"레이아웃: {st['layouts']}")
    if args.write:
        (d / "mirror_cf.json").write_text(json.dumps(mirror, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✓ 저장: {d / 'mirror_cf.json'}")


if __name__ == "__main__":
    main()
