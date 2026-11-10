# -*- coding: utf-8 -*-
"""
pdp_summary.py — Shopee/Lazada 상세 설명 요약(태국어): PDP 이미지 위에 붙는 글 (2026-11-10)

지시문: content_gen/prompts/pdp_summary_th.md (사용자가 준 프롬프트 원문 — [ใส่ชื่อรุ่น] 자리에 모델명)
근거:   그 제품의 크롤 결과(mirror.json) — LG.com/th 제품 페이지의 기능 글·각주·스펙 표 그대로.
        모델은 이 글만 근거로 쓴다 (다른 모델·추측 금지는 지시문에도 있음).
출력:   {product_name, intro, highlights[], product_info[{label, value}], conflicts[]}  (Claude structured output)
        + 메타: ref_url(LG Thailand 페이지), checked_at(크롤 시각 기준 확인 날짜), model
        conflicts·ref_url·checked_at 는 '복사용 글 밖' — HTML 블록에는 넣지 않는다.

  python -m content_gen.pdp_summary <제품 out 폴더> [--refresh]   → <폴더>/summary.json, stdout JSON
"""
import datetime as _dt
import html as _html
import json
import re
import sys
from pathlib import Path
from typing import List

from pydantic import BaseModel, Field

PROMPT_FILE = Path(__file__).parent / "prompts" / "pdp_summary_th.md"
MIN_CHARS = 600          # 지시문: 600자 초과
import os as _os
MAX_CHARS = int(_os.getenv("SUMMARY_MAX_CHARS", "2000"))   # 사용자 결정(2026-11-10): 복사용 글 전체 2,000자 이내 (Shopee 설명 3,000자 제한보다 여유)
# 사용자 결정(2026-11-10): 길이 한도는 모든 제품 2,000자로 통일. 대신 PDP 의 USP 는 하나도 빼지 않는다 —
# 줄이는 건 각 USP 의 설명 글뿐 (usp_list → 지시문에 번호 목록, 장점 bullet 수 = USP 수 검사).
NAME_MAX = 120           # Shopee 상품명 최대 120자
FONT_H = "'LGEIHeadline','LG EI Headline','LGEIText','LINESeedSansTH',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"
FONT_B = "'LGEIText','LG EI Text','LINESeedSansTH',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"


class InfoRow(BaseModel):
    label: str = Field(description="หัวข้อข้อมูลสินค้า เช่น รุ่น ประเภท ความจุ สี ขนาด น้ำหนัก")
    value: str = Field(description="ค่าที่ยืนยันได้จากหน้า LG.com Thailand")


class PdpSummary(BaseModel):
    product_name: str = Field(description="1. ชื่อสินค้า: LG + ประเภทสินค้า + รุ่น + ความจุหรือขนาด + จุดขายหลัก")
    intro: str = Field(description="2. บทนำ: สรุปความน่าสนใจและประโยชน์ของสินค้า")
    highlights: List[str] = Field(description="3. จุดเด่นสินค้า: แต่ละข้อเชื่อมฟีเจอร์กับประโยชน์ที่ได้รับ")
    product_info: List[InfoRow] = Field(description="4. ข้อมูลสินค้า: เฉพาะข้อมูลที่ตรวจสอบได้")
    conflicts: List[str] = Field(description="ข้อขัดแย้งของข้อมูลที่พบ (อยู่นอกเนื้อหาพร้อมคัดลอก) — ไม่มีให้เป็นรายการว่าง")


def model_code(url: str) -> str:
    seg = [x for x in url.split("/") if x][-1]
    return seg.upper()


def page_footnotes(slug_dir: Path, url: str, have: str) -> list:
    """제품 페이지의 각주(* 로 시작하는 조건·근거 글). 컴포넌트 경로 크롤에는 빠져 있어서, 받아 둔 페이지(pc.html)의
    컴포넌트 모델에서 읽는다 — 이미 원문에 있는 것은 빼고."""
    fp = slug_dir / "pc.html"
    if not fp.exists():
        return []
    try:
        import aem_model
        am = aem_model.extract(fp.read_text(encoding="utf-8", errors="replace"), url) or {}
    except Exception:
        return []
    out = []
    for s in am.get("sections") or []:
        t = (s.get("text") or "").replace(" ", " ").strip()
        if (str(s.get("order", "")).startswith("disclaimer") or t.startswith("*")) and t[:60] not in have and t not in out:
            out.append(t)
    return out


def source_text(mirror: dict, url: str, slug_dir: Path = None) -> str:
    """크롤 결과 → 모델에 줄 원문 (LG 페이지 순서 그대로, 스펙 표 포함) + 페이지 각주."""
    body = _mirror_text(mirror, url)
    notes = page_footnotes(slug_dir, url, body) if slug_dir else []
    if notes:
        body += "\n\nหมายเหตุใต้หน้าสินค้า:\n" + "\n".join(notes)
    return body


def _mirror_text(mirror: dict, url: str) -> str:
    lines = [f"URL: {url}", f"ชื่อสินค้าบนหน้า LG.com: {mirror.get('product_title') or ''}", ""]
    for s in mirror.get("sections") or []:
        t = (s.get("text") or "").replace(" ", " ").strip()
        if t:
            lines.append(t)
            lines.append("")
    return "\n".join(lines).strip()


def _usp_key(t: str) -> str:
    return re.sub(r"[\s™®\-–—:]+", " ", t).strip().lower()


def usp_list(mirror: dict) -> list:
    """PDP 이미지와 같은 블록(content_gen.model.build_blocks)에서 USP 목록 [{title, desc}] — 페이지 순서.
    섹션 하나 = USP 하나 (제목: 눈썹 글이 있으면 그것, 없으면 첫 ## 제목), 카드 줄은 카드 하나 = USP 하나.
    스펙 표·각주(*) 제외. 같은 기능이 두 번 나오면(제목이 같거나 한쪽 제목이 다른 쪽에 통째로 들어 있으면) 하나로."""
    from . import load_medium
    from .model import build_blocks
    blocks = build_blocks(mirror, load_medium("shopee_lazada")["spec"].get("rules", {}))
    texts = []
    for bl in blocks:
        if bl["kind"] == "section":
            sec = bl["section"]
            if not str(sec.get("order", "")).startswith("disclaimer"):
                texts.append(sec.get("text") or "")
        elif bl["kind"] == "card_row":
            texts += [c.get("text") or "" for c in bl.get("cards") or []]
    out = []
    for t in texts:
        lines = [ln.replace("\u2028", " ").replace("\xa0", " ").strip() for ln in t.split("\n")]
        lines = [ln for ln in lines if ln and not ln.startswith("*")]
        if not lines:
            continue
        heads = [i for i, ln in enumerate(lines) if ln.startswith("#")]
        clean = lambda ln: re.sub(r"^[#>\-\s•]+", "", ln).strip()
        if heads and heads[0] > 0:                 # 눈썹 글(기능명) + ## 제목
            title, rest = clean(lines[0]), lines[1:]
        elif heads:
            title, rest = clean(lines[heads[0]]), lines[:heads[0]] + lines[heads[0] + 1:]
        elif out:                                  # 제목 없는 글만 있는 섹션 = 앞 USP 의 이어지는 설명
            out[-1]["desc"] = (out[-1]["desc"] + " " + " ".join(clean(ln) for ln in lines)).strip()
            continue
        else:
            title, rest = clean(lines[0])[:80], lines[1:]
        desc = " ".join(clean(ln) for ln in rest if clean(ln))
        k = _usp_key(title)
        if not k:
            continue
        dup = next((u for u in out if u["key"] == k or (min(len(k), len(u["key"])) >= 6 and (k in u["key"] or u["key"] in k))), None)
        if dup:
            if desc and desc not in dup["desc"]:
                dup["desc"] = (dup["desc"] + " " + desc).strip()
            continue
        out.append({"key": k, "title": title, "desc": desc})
    return [{"title": u["title"], "desc": u["desc"]} for u in out]


def usp_prompt(usps: list) -> str:
    rows = "\n".join(f"{i}. {u['title']}" + (f" — {u['desc'][:400]}" if u["desc"] else "") for i, u in enumerate(usps, 1))
    return (f"\n\nจุดขาย (USP) ทั้งหมดบนหน้าสินค้านี้มี {len(usps)} ข้อ ตามรายการด้านล่าง:\n{rows}\n\n"
            f"ข้อกำหนดจุดเด่นสินค้า: highlights ต้องมี {len(usps)} ข้อพอดี — 1 ข้อต่อ 1 USP เรียงตามลำดับเลขด้านบน "
            "ห้ามตัด ห้ามรวม ห้ามเพิ่มข้ออื่น แต่ละข้อขึ้นต้นด้วยชื่อ USP นั้น แล้วตามด้วยคำอธิบายที่ย่อให้สั้นที่สุด "
            "(ย่อเฉพาะคำอธิบาย ไม่ตัด USP) ถ้าความยาวไม่พอ ให้เหลือเพียงชื่อ USP กับประโยชน์สั้นๆ "
            "และให้บทนำกับข้อมูลสินค้ากระชับ")


def checked_date(mirror_path: Path) -> str:
    return _dt.datetime.fromtimestamp(mirror_path.stat().st_mtime, _dt.timezone(_dt.timedelta(hours=7))).strftime("%Y-%m-%d")


def build_prompt(url: str, src: str, checked: str, max_chars: int = MAX_CHARS) -> str:
    base = PROMPT_FILE.read_text(encoding="utf-8").replace("[ใส่ชื่อรุ่น]", model_code(url))
    return (base.rstrip() + "\n\n"
            f"ข้อมูลล่าสุดจาก LG.com Thailand ของรุ่นนี้ (ดึงจากหน้าสินค้าโดยตรงเมื่อ {checked}) อยู่ระหว่างแท็กด้านล่าง "
            "ให้ใช้ข้อมูลนี้เป็นแหล่งข้อมูลเดียว รวมถึงหมายเหตุ (*) และตารางสเปค:\n"
            f"<lg_product_page url=\"{url}\">\n{src}\n</lg_product_page>\n\n"
            "ส่งผลลัพธ์ตามโครงสร้างที่กำหนด: product_name, intro, highlights, product_info, conflicts "
            "(conflicts คือข้อขัดแย้งที่ต้องแจ้งไว้นอกเนื้อหาพร้อมคัดลอก ถ้าไม่มีให้เป็นรายการว่าง) "
            "ไม่ต้องใส่ลิงก์อ้างอิงหรือวันที่ในเนื้อหา — ระบบจะวางไว้นอกกรอบเอง\n\n"
            f"ข้อกำหนดความยาว: เนื้อหาพร้อมคัดลอกทั้งหมด (ชื่อสินค้า บทนำ จุดเด่นสินค้า และข้อมูลสินค้า รวมหัวข้อ) "
            f"ต้องยาวมากกว่า {MIN_CHARS} แต่ไม่เกิน {max_chars:,} ตัวอักษร และชื่อสินค้าไม่เกิน {NAME_MAX} ตัวอักษร "
            "ให้เลือกเฉพาะจุดขายและข้อมูลที่สำคัญที่สุด")


def body_chars(d: dict) -> int:
    return len(d["product_name"]) + len(d["intro"]) + sum(len(h) for h in d["highlights"]) \
        + sum(len(r["label"]) + len(r["value"]) for r in d["product_info"])


_ABSENT = re.compile(r"^\s*(ไม่|ไม่มี|no|none|-)\s*$", re.I)


def _fix(d: dict, url: str) -> dict:
    if "/refrigerators/" in url:            # 지시문: 냉장고는 "คิว" 대신 Q
        d["product_name"] = re.sub(r"\s*คิว", " Q", d["product_name"]).replace("  ", " ")
    # 지시문: 없는 기능은 쓰지 않는다 — 값이 '없음'인 정보 행, '(ไม่มี…)' 같은 괄호 설명은 뺀다
    rows = []
    for r in d["product_info"]:
        v = re.sub(r"\s*\((?:ไม่มี|ไม่)[^)]*\)", "", r["value"]).strip()
        if v and not _ABSENT.match(v):
            rows.append({"label": r["label"], "value": v})
    d["product_info"] = rows
    return d


def generate(slug_dir: Path, url: str, model: str = "") -> dict:
    import os
    import llm_claude
    model = model or os.getenv("SUMMARY_MODEL", "").strip() or llm_claude.CLAUDE_MODEL
    mp = slug_dir / "mirror.json"
    mirror = json.loads(mp.read_text(encoding="utf-8"))
    checked = checked_date(mp)
    usps = usp_list(mirror)
    limit = MAX_CHARS
    prompt = build_prompt(url, source_text(mirror, url, slug_dir), checked, limit) + (usp_prompt(usps) if usps else "")
    ask, d = prompt, None
    for attempt in range(4):                # 조건: 600 초과 · 2,000 이하 · 상품명 120 이하 · 장점 수 = USP 수 — 벗어나면 다시 쓰게
        d = _fix(llm_claude.vision_json([ask], PdpSummary, label=f"pdp-summary-{attempt}", max_tokens=32000, model=model), url)
        n, nn = len(plain_text(d)), len(d["product_name"])
        nh = len(d["highlights"])
        if MIN_CHARS < n <= limit and nn <= NAME_MAX and (not usps or nh == len(usps)):
            break
        ask = (prompt + f"\n\nผลครั้งก่อน: เนื้อหาพร้อมคัดลอกยาว {n:,} ตัวอักษร ชื่อสินค้ายาว {nn} ตัวอักษร จุดเด่นสินค้า {nh} ข้อ "
               f"— ต้องยาวมากกว่า {MIN_CHARS} และไม่เกิน {limit:,} ตัวอักษร ชื่อสินค้าไม่เกิน {NAME_MAX} ตัวอักษร "
               + (f"และจุดเด่นสินค้าต้องมี {len(usps)} ข้อพอดี (1 ข้อต่อ 1 USP) " if usps else "")
               + "เขียนใหม่ให้อยู่ในเกณฑ์ โดยย่อเฉพาะคำอธิบาย และยังใช้เฉพาะข้อมูลที่ยืนยันได้")
    else:
        raise RuntimeError(f"rule not met after retries: {n} chars, name {nn}, highlights {nh}/{len(usps)} USPs")
    d = _fix(d, url)
    return {**d, "chars": len(plain_text(d)), "max_chars": limit, "usps": [u["title"] for u in usps], "ref_url": url, "checked_at": checked, "model": model,
            "prompt_file": PROMPT_FILE.name}


def plain_text(d: dict) -> str:
    """복사용 글 (Airtable 등) — 형식 4부분."""
    out = [d["product_name"], "", d["intro"], "", "จุดเด่นสินค้า"]
    out += [f"• {h}" for h in d["highlights"]]
    out += ["", "ข้อมูลสินค้า"] + [f"• {r['label']}: {r['value']}" for r in d["product_info"]]
    return "\n".join(out)


def to_html(d: dict) -> str:
    """PDP 이미지 위에 붙는 글 블록 — 인라인 스타일만 (마켓 편집기가 <style> 을 지워도 유지)."""
    e = _html.escape
    h = lambda t, size, mt: (f'<h{2 if size > 20 else 3} style="font-family:{FONT_H};font-weight:600;font-size:{size}px;'
                             f'line-height:1.4;color:#111111;margin:{mt}px 0 8px 0;">{e(t)}</h{2 if size > 20 else 3}>')
    p = lambda t: f'<p style="font-family:{FONT_B};font-size:16px;line-height:1.6;color:#333333;margin:0 0 8px 0;">{e(t)}</p>'
    li = lambda t: f'<li style="font-family:{FONT_B};font-size:16px;line-height:1.6;color:#333333;margin:0 0 6px 0;">{t}</li>'
    parts = [h(d["product_name"], 24, 0), p(d["intro"]), h("จุดเด่นสินค้า", 18, 16),
             '<ul style="margin:0;padding:0 0 0 22px;">' + "".join(li(e(x)) for x in d["highlights"]) + "</ul>",
             h("ข้อมูลสินค้า", 18, 16),
             '<ul style="margin:0;padding:0 0 0 22px;">'
             + "".join(li(f"{e(r['label'])}: {e(r['value'])}") for r in d["product_info"]) + "</ul>"]
    return ('<div class="lg-pdp-summary" style="max-width:1000px;margin:0 auto;padding:24px 20px;box-sizing:border-box;">'
            + "".join(parts) + "</div>")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        slug_dir = Path(sys.argv[1]); refresh = "--refresh" in sys.argv[2:]
        model = next((a.split("=", 1)[1] for a in sys.argv[2:] if a.startswith("--model=")), "")
        url = next((a for a in sys.argv[2:] if a.startswith("http")), "")
        out = slug_dir / "summary.json"
        if out.exists() and not refresh:
            d = json.loads(out.read_text(encoding="utf-8"))
        else:
            if not url: raise ValueError("url required")
            d = generate(slug_dir, url, model)
            out.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
        sys.stdout.write(json.dumps({**d, "html": to_html(d), "text": plain_text(d)}, ensure_ascii=False))
    except Exception as ex:
        sys.stdout.write(json.dumps({"error": str(ex)[:500]}, ensure_ascii=False))
        sys.exit(1)
