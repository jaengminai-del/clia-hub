# -*- coding: utf-8 -*-
"""
ebay_builder.py — eBay 1차 컨텐츠 생성 (CLI + 기존 호출부 호환)

실제 생성은 content_gen 엔진이 한다:
  [A] content_gen/model.py             mirror → 공통 블록
  [B] content_gen/media/ebay/spec.json eBay 규격 (글자 크기·색·카드 비율·레이아웃 패턴)
  [C] content_gen/render_html.py       HTML 렌더

사용법:
    python ebay_builder.py <out/slug 디렉토리>              # 미리보기 문서 → ebay_content.html
    python ebay_builder.py <out/slug 디렉토리> --fragment   # eBay 설명란 조각
    python ebay_builder.py <out/slug 디렉토리> --preview    # 브라우저에서 미리보기
"""
import argparse
import json
import webbrowser
from pathlib import Path

from content_gen import generate, assert_no_active_content  # noqa: F401  (assert_* 는 하위 호환용 재노출)


def build_ebay_html(mirror: dict, fragment: bool = False) -> str:
    """mirror.json → eBay용 HTML.
    fragment=True: eBay 설명란 삽입용 조각(<style>+컨테이너, 문서 래퍼 없음)
    fragment=False: 브라우저 미리보기용 완전한 HTML 문서"""
    return generate(mirror, medium="ebay", fragment=fragment)


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

    mirror = json.loads(mirror_file.read_text(encoding="utf-8"))
    output_file = slug_dir / (args.output or "ebay_content.html")
    output_file.write_text(build_ebay_html(mirror, fragment=args.fragment), encoding="utf-8")
    print(f"✓ eBay HTML 생성 완료: {output_file}")

    component_summary = mirror.get("_component_summary", {})
    if component_summary:
        print(f"   사용된 CCG 컴포넌트: {dict(sorted(component_summary.items()))}")
    layout_types = {}
    for s in mirror.get("sections", []):
        lt = s.get("layout_type", "unknown")
        layout_types[lt] = layout_types.get(lt, 0) + 1
    if any(lt != "unknown" for lt in layout_types):
        print(f"   레이아웃 타입 분포: {dict(sorted((k, v) for k, v in layout_types.items() if k))}")

    if args.preview:
        webbrowser.open(f"file://{output_file.absolute()}")
        print("   → 브라우저에서 미리보기 열림")
    return 0


if __name__ == "__main__":
    exit(main())
