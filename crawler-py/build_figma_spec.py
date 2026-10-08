# -*- coding: utf-8 -*-
"""
build_figma_spec.py — figma-specs / figma-specs-pd 마크다운을 컴포넌트별
기계판독 스펙(figma_component_spec.json)으로 변환.

빌더(ebay_builder 등)가 컴포넌트 넘버별 레이아웃(텍스트 오버레이 여부)·
폰트·색상을 인지해 컨텐츠에 반영하도록 하기 위한 단일 소스.

사용법: python build_figma_spec.py   (결과: figma_component_spec.json)
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC_DIRS = [ROOT / "figma-specs", ROOT / "figma-specs-pd"]
OUT = Path(__file__).resolve().parent / "figma_component_spec.json"

# 텍스트가 이미지 위에 얹히는 오버레이 유형 (이름/파일명 신호)
OVERLAY_RE = re.compile(r"overlay|layered", re.I)
# LG EI Text Regular 24/28 → (size, line-height)
FONT_RE = re.compile(r"LG (?:EI Text|EI Headline|Smart UI)\s+\w+\s+(\d+)/(\d+)", re.I)
COLOR_RE = re.compile(r"=\s*(#[0-9a-fA-F]{6})")


def parse_one(fp: Path) -> dict:
    t = fp.read_text(encoding="utf-8")
    cid_m = re.match(r"([A-Z]{2}\d{4})", fp.name)
    if not cid_m:
        return None
    cid = cid_m.group(1)
    name = ""
    m = re.search(r"^# \S+ · (.+)$", t, re.M)
    if m:
        name = m.group(1).strip()

    # 스타일 섹션 한정 파싱
    style = ""
    sm = re.search(r"## 스타일.*?(?=\n## |\Z)", t, re.S)
    if sm:
        style = sm.group(0)
    fonts = sorted({f"{a}/{b}" for a, b in FONT_RE.findall(style)},
                   key=lambda s: int(s.split("/")[0]))
    colors = sorted({c.lower() for c in COLOR_RE.findall(style)
                     if c.lower() not in ("#ffffff",)})

    is_overlay = bool(OVERLAY_RE.search(fp.name + " " + name))
    return {
        "component_id": cid,
        "name": name,
        "is_overlay": is_overlay,
        "fonts": fonts,
        "colors": colors,
    }


def build() -> dict:
    spec = {}
    for d in SPEC_DIRS:
        if not d.exists():
            continue
        for fp in sorted(d.glob("*.md")):
            if fp.name.endswith("-ELEMENTS.md") or fp.name == "README.md":
                continue
            one = parse_one(fp)
            if one and one["component_id"] not in spec:
                spec[one["component_id"]] = one
    return spec


if __name__ == "__main__":
    spec = build()
    OUT.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    ov = [k for k, v in spec.items() if v["is_overlay"]]
    print(f"✓ {len(spec)}개 컴포넌트 → {OUT.name}")
    print(f"  오버레이 유형: {ov}")
