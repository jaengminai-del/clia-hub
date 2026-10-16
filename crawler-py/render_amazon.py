# -*- coding: utf-8 -*-
"""render_amazon.py — out/<slug>/mirror.json → Amazon A+ 카드·모듈 JSON (Node 라우터용, stdout).

    python render_amazon.py <out/slug 디렉토리> features
    python render_amazon.py <out/slug 디렉토리> modules   < {"selection":[0,3,...], "mode":"standard", "start_id":1}
"""
import json
import sys
from pathlib import Path

from content_gen.amazon import features_for, modules_for

sys.stdout.reconfigure(encoding="utf-8")
mirror = json.loads((Path(sys.argv[1]) / "mirror.json").read_text(encoding="utf-8"))
cmd = sys.argv[2] if len(sys.argv) > 2 else "features"
if cmd == "features":
    out = features_for(mirror)
elif cmd == "modules":
    req = json.loads(sys.stdin.read() or "{}")
    out = modules_for(mirror, [int(i) for i in req.get("selection", [])],
                      req.get("mode", "standard"), int(req.get("start_id", 1)))
else:
    raise SystemExit(f"unknown command: {cmd}")
sys.stdout.write(json.dumps(out, ensure_ascii=False))
