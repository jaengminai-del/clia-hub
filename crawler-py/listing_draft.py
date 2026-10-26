# -*- coding: utf-8 -*-
"""listing_draft.py — 리스팅 문구 "제품 상세(Product Details)" 초안을 크롤한 LG.com 원문으로 (AI 생성 없음).

    python listing_draft.py <out/slug 디렉토리>   → stdout {"details": "● 제목\\n- 설명\\n..."}
기능 섹션의 제목·본문을 원문 그대로 '● 제목 / - 본문' 형식으로 (수상·디스클레이머·텍스트 없는 섹션 제외, 최대 8개).
"""
import json
import re
import sys
from pathlib import Path

from content_gen.amazon.features import mirror_to_features

# 판촉·가격 문구는 제품 상세가 아니라 ① 프로모션 칸의 몫 → 초안에서 제외 (영·독·태)
PROMO = re.compile(r"\bsave up to\b|\d+\s*%\s*(off|discount)|\bpurchase two\b|\bbuy (more|two|\d)|\bcashback\b|\bvoucher\b|"
                   r"\bsparen sie\b|\brabatt\b|\bgutschein\b|ส่วนลด|ลดสูงสุด", re.I)
sys.stdout.reconfigure(encoding="utf-8")
mirror = json.loads((Path(sys.argv[1]) / "mirror.json").read_text(encoding="utf-8"))
lines, seen = [], set()
for f in mirror_to_features(mirror):
    if f.get("award"):
        continue
    items = f.get("cardItems") or [{"title": f.get("headline"), "body": f.get("body")}]
    for it in items:
        t, b = (it.get("title") or "").strip(), " ".join((it.get("body") or "").split())
        if not t or t in seen or PROMO.search(t) or PROMO.search(b):
            continue
        if t[:1] in "-–" or len(re.findall(r" - [A-Z][A-Z .()/]+:", " " + b)) >= 3:   # 스펙 요약 블록 (스펙 표에 이미 있음)
            continue
        if len(t) > 80:                      # 긴 문장은 제목이 아니라 앞 항목의 설명
            if lines:
                lines.append(f"- {t[:400]}")
            continue
        if not b and t.endswith("?"):        # 설명 없는 묶음 제목 ("What's to Love …?")
            continue
        seen.add(t)
        lines.append(f"● {t}")
        if b:
            lines.append(f"- {b[:400]}")
        if len(seen) >= 8:
            break
    if len(seen) >= 8:
        break
sys.stdout.write(json.dumps({"details": "\n".join(lines)}, ensure_ascii=False))
