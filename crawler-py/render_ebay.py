# -*- coding: utf-8 -*-
"""render_ebay.py — out/<slug>/mirror.json 을 eBay HTML fragment 로 렌더해 stdout 출력 (Node 라우터용)."""
import json
import sys
from pathlib import Path

from ebay_builder import build_ebay_html

sys.stdout.reconfigure(encoding="utf-8")
mirror = json.loads((Path(sys.argv[1]) / "mirror.json").read_text(encoding="utf-8"))
sys.stdout.write(build_ebay_html(mirror, fragment=True))
