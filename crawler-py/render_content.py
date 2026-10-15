# -*- coding: utf-8 -*-
"""render_content.py — out/<slug>/mirror.json 을 매체용 1차 컨텐츠 HTML fragment 로 렌더해 stdout 출력 (Node 라우터용).

    python render_content.py <out/slug 디렉토리> [medium]   # medium 기본 ebay (content_gen/media/<medium>/)
"""
import json
import sys
from pathlib import Path

from content_gen import generate

sys.stdout.reconfigure(encoding="utf-8")
mirror = json.loads((Path(sys.argv[1]) / "mirror.json").read_text(encoding="utf-8"))
sys.stdout.write(generate(mirror, medium=sys.argv[2] if len(sys.argv) > 2 else "ebay", fragment=True))
