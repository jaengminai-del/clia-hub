#!/usr/bin/env python3
"""Bundle many slice images into one ZIP on disk (stdin JSON → stdout JSON). Used by POST /api/v1/bundle.

stdin: {"out": "/abs/x.zip", "cache": "/abs/media-cache/slices", "base": "http://127.0.0.1:PORT",
        "entries": [{"hash": "...", "file": "slice-01.jpg", "path": "Folder/Model/01.jpg"}, ...],
        "extra": {"index.csv": "text", ...}}
Each image is read from the local slice cache, else fetched from the server's own /media/slices URL
(which falls back to the bucket). Images are stored uncompressed (JPEGs), written one by one — memory stays small.
"""
import json, os, sys, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor


def main():
    job = json.load(sys.stdin)
    out, cache, base = job["out"], job["cache"], job["base"].rstrip("/")
    entries, extra = job.get("entries") or [], job.get("extra") or {}

    def read(e):
        p = os.path.join(cache, e["hash"], e["file"])
        if os.path.exists(p):
            return open(p, "rb").read()
        for attempt in range(3):
            try:
                with urllib.request.urlopen(f"{base}/media/slices/{e['hash']}/{e['file']}", timeout=120) as r:
                    return r.read()
            except Exception as ex:
                err = ex
        raise RuntimeError(f"image missing: {e['hash']}/{e['file']} ({err!r})"[:300])

    tmp = out + ".part"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    n = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as z, ThreadPoolExecutor(8) as ex:
        for name, text in extra.items():
            z.writestr(name, text.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
        for i in range(0, len(entries), 64):           # 64 at a time: fetch in parallel, write in order
            chunk = entries[i:i + 64]
            for e, data in zip(chunk, ex.map(read, chunk)):
                z.writestr(e["path"], data); n += 1
    os.replace(tmp, out)
    print(json.dumps({"images": n, "bytes": os.path.getsize(out)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)[:500]})); sys.exit(1)
