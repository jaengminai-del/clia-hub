# -*- coding: utf-8 -*-
"""backfill_source.py — 기존 캐시(out/<slug>/)에 source.json(원본 URL·국가·크롤 시각) 생성.

예전 크롤 산출물엔 원본 URL이 저장되지 않았다. pc.md/pc.html 안의 lg.com URL 중
slug 규칙(crawler-routes.js slugify)과 일치하는 것을 원본 URL로 복원한다.
사용법: python backfill_source.py   (이미 source.json 있는 폴더는 건너뜀)
"""
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
URL_RE = re.compile(r"https?://www\.lg\.com/[^\s\"'<>()\]]+")


def slugify(url: str) -> str:
    s = re.sub(r"^https?://", "", url)
    s = re.sub(r"[^\w]+", "-", s)
    return s.rstrip("-")


def main():
    for d in sorted(p for p in OUT.iterdir() if p.is_dir()):
        if (d / "source.json").exists() or not (d / "mirror.json").exists():
            continue
        url = None
        for f in ("pc.md", "pc.html"):
            fp = d / f
            if not fp.exists():
                continue
            for u in URL_RE.findall(fp.read_text(encoding="utf-8", errors="ignore")):
                u = u.split("#")[0].split("?")[0]
                if slugify(u) == d.name:
                    url = u
                    break
            if url:
                break
        if not url:
            print(f"✗ {d.name[:70]} — URL 복원 실패")
            continue
        src = {"url": url, "crawled_at": (d / "mirror.json").stat().st_mtime, "backfilled": True}
        (d / "source.json").write_text(json.dumps(src, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✓ {d.name[:70]} → {url}")


if __name__ == "__main__":
    main()
