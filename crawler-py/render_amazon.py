# -*- coding: utf-8 -*-
"""render_amazon.py — Amazon A+ 1차 컨텐츠 생성 CLI (Node 라우터용, content_gen.amazon)

    python render_amazon.py features [out/slug]   (slug 없으면 stdin {"mirror": {...}})          → 카드 목록 JSON
    python render_amazon.py modules  [out/slug]   < {"selection":[0,3], "mode":"standard", "start_id":1,
                                                     "features":[...] (slug 없을 때)}           → 모듈 JSON
    python render_amazon.py images               < {"modules":[...+transforms], "pdpUrl":"", "date":""}  → ZIP (stdout)
    python render_amazon.py stack                < {"urls":[...]}  → {"url": data URL(JPEG), "bg": "rgb(r,g,b)"}
"""
import base64
import json
import sys
from pathlib import Path

from content_gen.amazon import build_modules, features_for, load_spec, modules_for

cmd = sys.argv[1] if len(sys.argv) > 1 else ""


def mirror(r=None):
    if len(sys.argv) > 2:
        return json.loads((Path(sys.argv[2]) / "mirror.json").read_text(encoding="utf-8"))
    return (r or {}).get("mirror") or {}


def req():
    return json.loads(sys.stdin.buffer.read().decode("utf-8") or "{}")


def out_json(v):
    sys.stdout.buffer.write(json.dumps(v, ensure_ascii=False).encode("utf-8"))


if cmd == "features":
    out_json(features_for(mirror(None if len(sys.argv) > 2 else req())))
elif cmd == "modules":
    r = req()
    sel, mode, start = [int(i) for i in r.get("selection", [])], r.get("mode", "standard"), int(r.get("start_id", 1))
    if len(sys.argv) > 2:
        out_json(modules_for(mirror(), sel, mode, start))
    else:   # 빌더가 들고 있는 카드 목록(features API 결과)으로 바로
        out_json(build_modules(r.get("features") or [], sel, load_spec(), mode, start))
elif cmd == "images":
    from content_gen.amazon.images import build_zip
    r = req()
    data, n, fails = build_zip(r.get("modules") or [], load_spec(), r.get("pdpUrl") or "", r.get("date") or "")
    sys.stderr.write(json.dumps({"count": n, "fails": fails}) + "\n")
    sys.stdout.buffer.write(data)
elif cmd == "stack":
    from content_gen.amazon.images import merge_stacked
    res = merge_stacked(req().get("urls") or [])
    out_json(None if not res else {"url": "data:image/jpeg;base64," + base64.b64encode(res[0]).decode(), "bg": res[1]})
else:
    raise SystemExit(f"unknown command: {cmd}")
