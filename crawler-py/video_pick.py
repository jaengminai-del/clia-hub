# -*- coding: utf-8 -*-
"""
video_pick.py — 동영상 대표 장면 자동 선택 (2026-11-17, 텍스트 v2 크롤과 함께)

LG 포스터가 검은 화면이거나 없을 때만 쓴다 (서버 video-frames.js autoFrame 이 부른다).
동영상·포스터 파일은 서버(Node)가 받아 둔 로컬 파일 — 이 스크립트는 네트워크를 쓰지 않는다.

  python video_pick.py poster <이미지>          → {"black": bool, "mean": 평균 밝기, "black_ratio": 검정 픽셀 비율}
  python video_pick.py pick <동영상> <작업 폴더>  → {"frames": n, "top": [{"t": 초, "score": 점수}, …]}  (최대 3개, 서로 2초 이상 떨어짐)

검은 포스터: 검정(밝기 < 16) 픽셀이 차지한 영역(경계 상자)이 그림의 절반 이상이고, 그 영역 안이 평균 밝기 < 3 · 검정 99% 넘음.
  LG 포스터는 검은 화면 위에 배경 띠(베이지 등)가 붙어 있기도 해서 그림 전체가 아니라 검은 영역 안을 본다 (예: AI Chatbot).
  어두운 장면·검은 바탕의 로고(예: Gemini, 검정 97%)는 검은 화면이 아님.
장면 점수 (전체 프레임 중 '비주얼이 가장 많은' 장면, 초당 2장):
  채움 coverage 45% : 16x16 칸 중 밝기 표준편차 > 8 인 칸 비율 (빈 검정·단색 배경이 넓으면 낮다)
  디테일 detail 35% : 가장자리 세기 평균 (동영상 안 최대값으로 나눠 0~1)
  색감 color 20%    : Hasler–Süsstrunk 색감 지표 (동영상 안 최대값으로 나눠 0~1)
  거의 검정·흰 화면(평균 밝기 < 12 또는 > 240)은 제외
"""
import glob
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageFilter, ImageStat

FPS = 2
BLACK_MEAN, BLACK_RATIO, BLACK_LEVEL = 3.0, 0.99, 16
FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")


BLACK_AREA = 0.5


def poster(path: str) -> dict:
    g = Image.open(path).convert("L")
    g.thumbnail((640, 640))
    box = g.point(lambda v: 255 if v < BLACK_LEVEL else 0).getbbox()
    area = ((box[2] - box[0]) * (box[3] - box[1]) / (g.size[0] * g.size[1])) if box else 0
    inner = g.crop(box) if box else g
    hist = inner.histogram()
    mean = ImageStat.Stat(inner).mean[0]
    ratio = sum(hist[:BLACK_LEVEL]) / (sum(hist) or 1)
    return {"black": area >= BLACK_AREA and mean < BLACK_MEAN and ratio > BLACK_RATIO,
            "mean": round(mean, 2), "black_ratio": round(ratio, 4), "black_area": round(area, 3)}


def _features(path: str) -> dict:
    im = Image.open(path).convert("RGB")
    g = im.convert("L")
    w, h = g.size
    blocks = busy = 0
    for y in range(0, h - 15, 16):
        for x in range(0, w - 15, 16):
            blocks += 1
            busy += ImageStat.Stat(g.crop((x, y, x + 16, y + 16))).stddev[0] > 8
    small = im.resize((120, max(1, int(120 * h / w))))
    r, gg, b = (list(c.tobytes()) for c in small.split())
    rg = [a - c for a, c in zip(r, gg)]
    yb = [(a + c) / 2 - d for a, c, d in zip(r, gg, b)]

    def sd(v):
        m = sum(v) / len(v)
        return (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5
    color = math.hypot(sd(rg), sd(yb)) + 0.3 * math.hypot(sum(rg) / len(rg), sum(yb) / len(yb))
    return {"mean": ImageStat.Stat(g).mean[0], "cov": busy / max(blocks, 1),
            "edge": ImageStat.Stat(g.filter(ImageFilter.FIND_EDGES)).mean[0], "col": color}


def pick(video: str, work: str) -> dict:
    os.makedirs(work, exist_ok=True)
    for f in glob.glob(os.path.join(work, "f*.jpg")):
        os.remove(f)
    subprocess.run([FFMPEG, "-v", "error", "-i", video, "-vf", f"fps={FPS},scale=480:-2", "-q:v", "3",
                    os.path.join(work, "f%04d.jpg")], check=True, timeout=300)
    rows = [dict(t=i / FPS, **_features(f)) for i, f in enumerate(sorted(glob.glob(os.path.join(work, "f*.jpg"))))]
    if not rows:
        return {"frames": 0, "top": []}
    me = max(r["edge"] for r in rows) or 1
    mc = max(r["col"] for r in rows) or 1
    for r in rows:
        ok = 12 <= r["mean"] <= 240
        r["score"] = round(0.45 * r["cov"] + 0.35 * r["edge"] / me + 0.20 * r["col"] / mc, 4) if ok else 0
    top = []
    for r in sorted(rows, key=lambda r: -r["score"]):
        if r["score"] <= 0:
            break
        if all(abs(r["t"] - x["t"]) >= 2 for x in top):
            top.append({"t": r["t"], "score": r["score"]})
        if len(top) == 3:
            break
    return {"frames": len(rows), "top": top}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "poster" and len(sys.argv) == 3:
        print(json.dumps(poster(sys.argv[2])))
    elif cmd == "pick" and len(sys.argv) == 4:
        print(json.dumps(pick(sys.argv[2], sys.argv[3])))
    else:
        sys.exit("usage: video_pick.py poster <image> | pick <video> <workdir>")
