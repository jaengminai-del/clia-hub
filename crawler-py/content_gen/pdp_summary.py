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


def source_text(mirror: dict, url: str) -> str:
    """크롤 결과 → 모델에 줄 원문 (LG 페이지 순서 그대로, 각주·스펙 포함)."""
    lines = [f"URL: {url}", f"ชื่อสินค้าบนหน้า LG.com: {mirror.get('product_title') or ''}", ""]
    for s in mirror.get("sections") or []:
        t = (s.get("text") or "").replace(" ", " ").strip()
        if t:
            lines.append(t)
            lines.append("")
    return "\n".join(lines).strip()


def checked_date(mirror_path: Path) -> str:
    return _dt.datetime.fromtimestamp(mirror_path.stat().st_mtime, _dt.timezone(_dt.timedelta(hours=7))).strftime("%Y-%m-%d")


def build_prompt(url: str, src: str, checked: str) -> str:
    base = PROMPT_FILE.read_text(encoding="utf-8").replace("[ใส่ชื่อรุ่น]", model_code(url))
    return (base.rstrip() + "\n\n"
            f"ข้อมูลล่าสุดจาก LG.com Thailand ของรุ่นนี้ (ดึงจากหน้าสินค้าโดยตรงเมื่อ {checked}) อยู่ระหว่างแท็กด้านล่าง "
            "ให้ใช้ข้อมูลนี้เป็นแหล่งข้อมูลเดียว รวมถึงหมายเหตุ (*) และตารางสเปค:\n"
            f"<lg_product_page url=\"{url}\">\n{src}\n</lg_product_page>\n\n"
            "ส่งผลลัพธ์ตามโครงสร้างที่กำหนด: product_name, intro, highlights, product_info, conflicts "
            "(conflicts คือข้อขัดแย้งที่ต้องแจ้งไว้นอกเนื้อหาพร้อมคัดลอก ถ้าไม่มีให้เป็นรายการว่าง) "
            "ไม่ต้องใส่ลิงก์อ้างอิงหรือวันที่ในเนื้อหา — ระบบจะวางไว้นอกกรอบเอง")


def body_chars(d: dict) -> int:
    return len(d["product_name"]) + len(d["intro"]) + sum(len(h) for h in d["highlights"]) \
        + sum(len(r["label"]) + len(r["value"]) for r in d["product_info"])


def _fix_name(d: dict, url: str) -> dict:
    if "/refrigerators/" in url:            # 지시문: 냉장고는 "คิว" 대신 Q
        d["product_name"] = re.sub(r"\s*คิว", " Q", d["product_name"]).replace("  ", " ")
    return d


def generate(slug_dir: Path, url: str) -> dict:
    import llm_claude
    mp = slug_dir / "mirror.json"
    mirror = json.loads(mp.read_text(encoding="utf-8"))
    checked = checked_date(mp)
    prompt = build_prompt(url, source_text(mirror, url), checked)
    d = llm_claude.vision_json([prompt], PdpSummary, label="pdp-summary", max_tokens=32000)
    if body_chars(d) <= MIN_CHARS:          # 지시문의 길이 조건 — 한 번만 다시 요청
        d = llm_claude.vision_json([prompt + f"\n\nเนื้อหาครั้งก่อนสั้นเกินไป ({body_chars(d)} ตัวอักษร) "
                                    f"ต้องยาวมากกว่า {MIN_CHARS} ตัวอักษร โดยยังใช้เฉพาะข้อมูลที่ยืนยันได้"],
                                   PdpSummary, label="pdp-summary-retry", max_tokens=32000)
    d = _fix_name(d, url)
    return {**d, "chars": body_chars(d), "ref_url": url, "checked_at": checked, "model": llm_claude.CLAUDE_MODEL,
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
                             f'line-height:1.3;color:#111111;margin:{mt}px 0 8px 0;">{e(t)}</h{2 if size > 20 else 3}>')
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
        url = next((a for a in sys.argv[2:] if a.startswith("http")), "")
        out = slug_dir / "summary.json"
        if out.exists() and not refresh:
            d = json.loads(out.read_text(encoding="utf-8"))
        else:
            if not url: raise ValueError("url required")
            d = generate(slug_dir, url)
            out.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
        sys.stdout.write(json.dumps({**d, "html": to_html(d), "text": plain_text(d)}, ensure_ascii=False))
    except Exception as ex:
        sys.stdout.write(json.dumps({"error": str(ex)[:500]}, ensure_ascii=False))
        sys.exit(1)
