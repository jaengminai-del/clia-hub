# -*- coding: utf-8 -*-
"""
refine_mirror.py — 캐시된 out/<slug>/mirror.json 에 Step7.5(시각 QA·배치 교정) 적용

전체 재크롤 없이, 이미 저장된 스크린샷 타일과 mirror.json 만으로
run_mirror_qa → apply_mirror_fixes 루프를 수행하고 결과를 덮어쓴다.
(pdp_pipeline 전체 실행 시에는 Step7.5가 자동 포함되므로 이 스크립트는
 Step7.5 도입 이전에 크롤된 캐시를 업그레이드할 때 사용)

사용법: python refine_mirror.py <out/slug 디렉토리>  (생략 시 out/ 전체 일괄)
"""
import json
import sys
from pathlib import Path

from pdp_pipeline import run_mirror_qa, apply_mirror_fixes, QA_PASS_SCORE, MAX_QA_LOOPS
from make_mirror import tag_media_roles, order_by_document, rehome_by_md_anchor, pair_video_posters, sanitize_section_text, dedupe_section_media, prefer_pc_variant

ROOT = Path(__file__).resolve().parent


def refine(d: Path):
    mfp = d / "mirror.json"
    tiles = sorted((d / "tiles").glob("pc-*.jpg"))
    if not mfp.exists() or not tiles:
        print(f"– {d.name[:52]} 스킵 (mirror 또는 tiles 없음)")
        return
    mirror = json.loads(mfp.read_text(encoding="utf-8"))
    history, mqa = [], {}
    for loop in range(1, MAX_QA_LOOPS + 1):
        mqa = run_mirror_qa(mirror, tiles)
        history.append({"loop": loop, "score": mqa.get("layout_match_score"),
                        "moves": len(mqa.get("moves", [])),
                        "reorder": bool(mqa.get("section_order"))})
        if mqa.get("layout_match_score", 0) >= QA_PASS_SCORE \
                and not mqa.get("moves") and not mqa.get("section_order"):
            break
        moved = apply_mirror_fixes(mirror, mqa)
        print(f"   ✓ 배치 교정 (loop {loop}): 미디어 {moved}건 이동"
              f"{' + 섹션 재정렬' if mqa.get('section_order') else ''}")
        if not moved and not mqa.get("section_order"):
            break
    mdfp = d / "preprocessed.md"
    if mdfp.exists():
        _md = mdfp.read_text(encoding="utf-8")
        rehome_by_md_anchor(mirror, _md)   # QA 오이동(숨은 캐러셀) 결정적 복원
        pair_video_posters(mirror, _md)    # 비디오 카드 포스터 jpg 보전
        order_by_document(mirror, _md)
        prefer_pc_variant(mirror, _md)
    from make_mirror import strip_below_fold
    strip_below_fold(mirror)
    sanitize_section_text(mirror)
    dedupe_section_media(mirror)
    from make_mirror import dedupe_global_media
    dedupe_global_media(mirror)
    tag_media_roles(mirror)
    mfp.write_text(json.dumps(mirror, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "mirror_qa_report.json").write_text(
        json.dumps({"_history": history, "last": mqa}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"✓ {d.name[:52]} → mirror.json 교정 완료")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        refine(Path(sys.argv[1]))
    else:
        for d in sorted((ROOT / "out").iterdir()):
            if d.is_dir():
                refine(d)
