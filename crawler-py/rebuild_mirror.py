# -*- coding: utf-8 -*-
"""
rebuild_mirror.py — 캐시된 out/<slug>/ 의 mirror.json 을 최신 규칙으로 재생성 (재크롤·AI 호출 없음)

크롤러 규칙(UI 컨트롤 이미지 제외, 파편 제목 결합 등)을 고친 뒤 기존 캐시에 반영할 때 쓴다.
  · 컴포넌트-우선(component-first) 미러 → pc.html 을 다시 파싱해 미러를 새로 조립
  · Gemini 기반 미러 → 기존 mirror.json 에 UI 컨트롤 이미지 필터만 적용 (텍스트 불변)
기존 파일은 mirror.json.pre-rebuild.bak 으로 백업한다.

사용법: python rebuild_mirror.py <out/slug 디렉토리> [...]   (생략 시 out/ 전체 일괄)
"""
import json
import shutil
import sys
from pathlib import Path

from component_parser import parse_html_components
from component_mirror import build_from_components, _origin_from_slug
from make_mirror import drop_duplicate_sections, drop_ui_control_media, extract_gallery, sanitize_texts, tag_media_roles, upgrade_media_resolution

ROOT = Path(__file__).resolve().parent


def rebuild(d: Path) -> str:
    mfp, hfp = d / "mirror.json", d / "pc.html"
    if not (mfp.exists() and hfp.exists()):
        return "skip (mirror.json/pc.html 없음)"
    old = json.loads(mfp.read_text(encoding="utf-8"))
    html = hfp.read_text(encoding="utf-8")

    mode = "filter"
    mirror = old
    if "component-first" in (old.get("note") or ""):
        comps = parse_html_components(html)
        cf = build_from_components(comps, old.get("product_title", ""), _origin_from_slug(d.name))
        if cf.get("_cf_stats", {}).get("renderable", 0) >= 3:   # 파이프라인과 같은 품질 게이트
            mirror, mode = cf, "rebuild"
            (d / "components.json").write_text(json.dumps(comps, ensure_ascii=False, indent=2), encoding="utf-8")

    dup = drop_duplicate_sections(mirror)
    gal = extract_gallery(html, _origin_from_slug(d.name))
    if gal:
        mirror["_gallery"] = gal
    ui = drop_ui_control_media(mirror, html)
    if mode == "rebuild":           # 파이프라인 Step7 후처리와 동일 (filter 모드는 텍스트·URL 불변)
        sanitize_texts(mirror)
        upgrade_media_resolution(mirror, html)
    tag_media_roles(mirror)

    shutil.copyfile(mfp, d / "mirror.json.pre-rebuild.bak")
    mfp.write_text(json.dumps(mirror, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"{mode}: 섹션 {len(old.get('sections', []))} → {len(mirror['sections'])}, 중복 {dup}, UI 이미지 제외 {ui}, 갤러리 {len(mirror.get('_gallery', []))}장"


def main():
    dirs = [Path(a) for a in sys.argv[1:]] or sorted(p for p in (ROOT / "out").iterdir() if p.is_dir())
    for d in dirs:
        print(f"{d.name[:60]:60s} {rebuild(d)}")


if __name__ == "__main__":
    main()
