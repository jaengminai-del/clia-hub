"""preview_worker.py — 상세 이미지(슬라이스) 작은 미리보기 만들기 (2026-11-26, 벌크 Check)

slice-preview.js 가 한 번 띄워 두고 계속 쓴다 (요청마다 파이썬을 새로 띄우지 않게).
stdin 한 줄 = {"id", "src", "dst", "w"} → src 를 폭 w(기본 400)로 줄여 dst(JPEG)에 저장 → stdout 한 줄 {"id", "ok"[, "error"]}
"""
import json
import os
import sys

from PIL import Image

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    job = {}
    try:
        job = json.loads(line)
        w = max(80, min(1000, int(job.get("w") or 400)))
        with Image.open(job["src"]) as im:
            im = im.convert("RGB")
            if im.width > w:
                im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
            tmp = job["dst"] + ".part"
            im.save(tmp, "JPEG", quality=80, optimize=True, progressive=True)
            os.replace(tmp, job["dst"])
        print(json.dumps({"id": job.get("id"), "ok": True}), flush=True)
    except Exception as e:  # noqa: BLE001 — 한 장 실패해도 일꾼은 계속
        print(json.dumps({"id": job.get("id"), "ok": False, "error": str(e)[:300]}), flush=True)
