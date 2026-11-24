# -*- coding: utf-8 -*-
"""
review_prep.py — 검토·승인 화면 재료 (2026-11-24, 목업 v10~v12 규칙을 운영으로)

    python review_prep.py < input.json   → stdout JSON

입력 (stdin JSON)
  { "fullshot": "<lg.com 전체 화면 캡처 JPEG 경로>" | null,
    "mirror":   "<크롤 결과 mirror.json 경로>",
    "slices":   [{"text": "<슬라이스에 든 글 (slice-html manifest.text, 자르지 않은 전문)>"}, ...],
    "html":     "<상세 이미지를 만든 HTML 파일 경로>", "fontsCss": "<slices.py 와 같은 글꼴 CSS 주소>", "sliceWidth": 1000 }
출력
  { "shot": {"w", "h", "top", "bottom", "topHow", "bottomHow", "auto": {"top": bool, "bottom": bool}} | null,
    "usps": [USP 이름...],                       # PDP 요약 「จุดเด่นสินค้า」와 같은 목록 (content_gen.pdp_summary.usp_list)
    "sliceUsps": [[{"t", "est"?, "range"?}], ...], # 상세 이미지마다 그 이미지에 든 USP (순서를 지키는 동적 계획법)
    "secs": [[섹션 제목...], ...],               # 상세 이미지마다 그 이미지에서 시작하는 lg.com 섹션 제목
    "kind": ["" | "spec" | "spec+", ...],         # USP 없는 스펙 표 이미지 (spec+ = 앞 장에서 이어지는 표)
    "lead": [이미지 글 첫머리, ...],
    "align": {"anchors": [{"label", "L" (캡처 px), "R" (슬라이스 출력 px), "score"}], ...} | null }   # review_align.py — 같은 영역 기준점

lg.com 캡처에서 PDP 부분 (폭 960px, fullshot.py)
  시작(top): 갤러리 아래 앵커 탭 바(흰 바탕 → 베이지 띠)를 찾고, 그 아래 빈 띠 뒤 처음 무늬가 생기는 줄 − 16px.
  끝(bottom): 리뷰 섹션 제목(태국어 「รีวิวจากผู้ใช้สินค้า」) 위치 − 16px — 견본(review_assets/review-heading-th.png)을
              정규화 상관으로 찾는다. 다른 언어 페이지나 못 찾으면 캡처 끝까지 (auto=false → 검토 화면에서 사람이 맞춘다).
  2026-11-24 TH 28개 확인: 시작 24/28 목업과 같음(나머지 4개는 탭 바 바로 아래가 검은 섹션·프로모션 띠 — 사람이 맞춤), 끝 28/28 (±1px).
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATES = [HERE / "review_assets" / "review-heading-th.png"]


def norm(s):
    return re.sub(r"[\s​]+", "", s or "")


# ── lg.com 캡처: PDP 시작·끝 ──
def _rows(g, x1=880, step=4):
    """행마다 (밝기 평균, 분산) — 오른쪽 채팅 아이콘 영역(x>880)은 뺀다."""
    import numpy as np
    a = g[:, 0:x1:step]
    return a.mean(axis=1), a.var(axis=1)


def pdp_top(g):
    """갤러리(흰 바탕) 끝 → 베이지 띠(탭 바) → 탭 글자 → 밑줄 → 빈 띠 → 첫 내용."""
    h = g.shape[0]
    mean, var = _rows(g)
    y = 300
    while y < min(h - 10, 2200):
        if mean[y - 1] >= 250 and all(mean[y + k] < 250 and var[y + k] < 5 for k in range(8)):
            break
        y += 1
    else:
        return None, "tab bar not found"
    band, beige, quiet = y, mean[y + 2], 0
    y = band + 40
    while y < min(h - 1, band + 1200):
        if var[y] < 5 and abs(mean[y] - beige) < 6:      # 빈 띠 = 탭 바와 같은 베이지 (검은 배경 섹션은 빈 줄로 치지 않음)
            quiet += 1
        elif quiet >= 12:                                  # 빈 띠 뒤 처음으로 무늬가 생기는 줄
            return max(0, y - 16), f"tab band {band}, first content {y}"
        else:
            quiet = 0
        y += 1
    return None, f"no content after tab band {band}"


def pdp_bottom(g, top, xs=range(96, 150, 2), ds=2):
    import numpy as np
    from numpy.lib.stride_tricks import sliding_window_view
    from PIL import Image
    gd = g[::ds, ::ds]
    best = (-1.0, None)
    for tp in TEMPLATES:
        if not tp.exists():
            continue
        t = np.asarray(Image.open(tp).convert("L"), dtype=np.float32)[::ds, ::ds]
        th, tw = t.shape
        t = (t - t.mean()) / (t.std() + 1e-6)
        y_from = (top or 0) + 300
        for x in xs:
            col = gd[y_from // ds:, x // ds:x // ds + tw]
            if col.shape[1] < tw or col.shape[0] < th:
                continue
            win = sliding_window_view(col, (th, tw))[:, 0]
            score = ((win - win.mean(axis=(1, 2))[:, None, None]) * t).mean(axis=(1, 2)) / (win.std(axis=(1, 2)) + 1e-6)
            i = int(score.argmax())
            if score[i] > best[0]:
                best = (float(score[i]), y_from + i * ds)
    if best[0] < 0.8:
        return None, f"review heading not found (best {best[0]:.2f})"
    return best[1] - 16, f"review heading at {best[1]} (corr {best[0]:.3f})"


def shot_info(path):
    import numpy as np
    from PIL import Image
    with Image.open(path) as im:
        g = np.asarray(im.convert("L"), dtype=np.float32)
    h, w = g.shape
    top, how = pdp_top(g)
    bottom, bhow = pdp_bottom(g, top)
    return {"w": w, "h": h, "top": top if top is not None else 0, "bottom": bottom if bottom is not None else h,
            "topHow": how, "bottomHow": bhow, "auto": {"top": top is not None, "bottom": bottom is not None}}


# ── 상세 이미지: USP · 섹션 제목 · 스펙 표 ──
def headings(sec):
    lines = [l.strip() for l in (sec.get("text") or "").split("\n") if l.strip()]
    hs = [l[3:] for l in lines if l.startswith("## ")]
    return hs or lines[:1]


def map_usps(usps, texts):
    """USP 순서를 지키면서(이미지 번호가 줄지 않게) 가장 많은 USP 가 이미지 글에 맞는 배치 (동적 계획법).
    못 찾은 USP 는 앞뒤로 찾은 USP 사이 이미지에 있다 — 한 장이면 확정, 여러 장이면 앞쪽 이미지에 두고 est."""
    nt = [norm(x) for x in texts]
    cands = [[i for i, x in enumerate(nt) if norm(u)[:40] and norm(u)[:40] in x] for u in usps]
    best = {-1: (0, [])}
    for cs in cands:
        nxt = {k: (n, path + [None]) for k, (n, path) in best.items()}
        for c in cs:
            prev = max(((n, path) for k, (n, path) in best.items() if k <= c), key=lambda x: x[0], default=None)
            if prev and (c not in nxt or prev[0] + 1 > nxt[c][0]):
                nxt[c] = (prev[0] + 1, prev[1] + [c])
        best = nxt
    found = max(best.values(), key=lambda x: x[0])[1] if usps else []
    out = [[] for _ in texts]
    for k, u in enumerate(usps):
        t = u[:80]
        if not texts:
            break
        if found[k] is not None:
            out[found[k]].append({"t": t})
            continue
        lo = next((found[j] for j in range(k - 1, -1, -1) if found[j] is not None), 0)
        hi = next((found[j] for j in range(k + 1, len(usps)) if found[j] is not None), len(texts))
        hi = max(lo, hi - 1) if hi > lo else lo
        out[lo].append({"t": t, "est": hi > lo, "range": [lo + 1, hi + 1]} if hi > lo else {"t": t})
    return out


SPEC_RE = re.compile(r"สเปค|ข้อมูลจำเพาะ|คุณลักษณะเด่น|specification|key spec", re.I)


def spec_kinds(texts, slice_usps):
    out = []
    for i, s in enumerate(texts):
        if slice_usps[i]:
            out.append("")
            continue
        kv = len(re.findall(r":\s*(มี|ไม่มี|ใช่|ไม่|yes|no|\d)", s, re.I))     # 「항목: 값」 줄 (스펙 표)
        if SPEC_RE.search(s) or kv >= 3:
            out.append("spec")
        elif out and out[-1] in ("spec", "spec+"):
            out.append("spec+")
        else:
            out.append("")
    return out


def lead(text):
    t = re.sub(r"\s+", " ", text or "").strip()
    return (t[:38] + "…") if len(t) > 40 else t


def main():
    a = json.load(sys.stdin)
    sys.path.insert(0, str(HERE))
    from content_gen.pdp_summary import usp_list
    mirror = json.loads(Path(a["mirror"]).read_text(encoding="utf-8"))
    texts = [s.get("text") or "" for s in a.get("slices") or []]
    usps = [u["title"][:80] for u in usp_list(mirror)]
    su = map_usps(usps, texts)
    nt = [norm(x) for x in texts]
    secs, last = [[] for _ in texts], 0
    for s in mirror.get("sections") or []:
        disc = str(s.get("order", "")).startswith("disclaimer")
        hs = headings(s)
        key = norm(hs[0])[:40] if hs else ""
        if not key or disc:
            continue
        idx = next((i for i in range(last, len(nt)) if key in nt[i]), None)
        if idx is None:
            idx = next((i for i in range(len(nt)) if key in nt[i]), None)
        if idx is None:
            continue
        last = idx
        if hs[0][:70] not in secs[idx]:
            secs[idx].append(hs[0][:70])
    shot = None
    if a.get("fullshot") and Path(a["fullshot"]).exists():
        shot = shot_info(a["fullshot"])
    # 같은 영역 맞추기 (review_align.py) — 실패해도 나머지는 그대로 (화면은 구간 하나로 움직인다)
    al, al_err = None, ""
    if shot and a.get("html") and Path(a["html"]).exists():
        try:
            from review_align import align
            al = align(a["fullshot"], shot["top"], shot["bottom"], Path(a["html"]).read_text(encoding="utf-8"),
                       a.get("medium") or "shopee_lazada", a.get("fontsCss") or "", int(a.get("sliceWidth") or 1000),
                       boxes=a.get("boxes"))
        except Exception as e:      # noqa: BLE001 — 맞추기 실패는 준비 실패가 아니다
            al_err = f"{type(e).__name__}: {e}"[:200]
    json.dump({"shot": shot, "usps": usps, "sliceUsps": su, "secs": secs, "kind": spec_kinds(texts, su),
               "lead": [lead(x) for x in texts], "align": al, "alignErr": al_err}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as e:
        sys.stdout.write(json.dumps({"error": f"{type(e).__name__}: {e}"[:300]}))
        sys.exit(1)
