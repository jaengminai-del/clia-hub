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
        import aem_model_sl as aem_model
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
    from .model import build_blocks, set_image_prefer
    rules = load_medium("shopee_lazada")["spec"].get("rules", {})
    set_image_prefer(rules.get("image_prefer", "mobile"))
    blocks = build_blocks(mirror, rules)
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


KF_DIRECT_USPS = 20   # USP 가 이보다 많으면 처음부터 Key features 로 (2,000자에 다 못 넣음)


def key_features(slug_dir: Path) -> list:
    """lg.com 제품 페이지 위쪽 「คุณลักษณะที่สำคัญ」(Key features, #keyFeatureList) — 크롤 때 받은 원본 HTML 에서. 보통 3~6개."""
    import html as H
    for name in ("pc_raw.html", "pc.html"):
        fp = slug_dir / name
        if not fp.exists():
            continue
        h = fp.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'id="keyFeatureList"[^>]*>(.*?)</ul>', h, re.S)
        if not m:
            continue
        out = []
        for x in re.findall(r"<li[^>]*>(.*?)</li>", m.group(1), re.S):
            t = re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", "", x))).strip()
            if t and t not in out:
                out.append(t)
        if out:
            return out
    return []


def kf_prompt(kf: list) -> str:
    rows = "\n".join(f"{i}. {t}" for i, t in enumerate(kf, 1))
    return (f"\n\nคุณลักษณะที่สำคัญ (Key features) ที่ LG.com กำหนดไว้สำหรับสินค้านี้มี {len(kf)} ข้อ:\n{rows}\n\n"
            f"ข้อกำหนดจุดเด่นสินค้า: highlights ต้องมี {len(kf)} ข้อพอดี — 1 ข้อต่อ 1 คุณลักษณะที่สำคัญ เรียงตามลำดับเลขด้านบน "
            "แต่ละข้อขึ้นต้นด้วยชื่อคุณลักษณะนั้น แล้วอธิบายประโยชน์สั้นๆ โดยใช้ข้อมูลจากหน้าสินค้า ไม่ต้องใส่ฟีเจอร์อื่นนอกรายการ")


def usp_prompt(usps: list) -> str:
    rows = "\n".join(f"{i}. {u['title']}" + (f" — {u['desc'][:400]}" if u["desc"] else "") for i, u in enumerate(usps, 1))
    return (f"\n\nจุดขาย (USP) ทั้งหมดบนหน้าสินค้านี้มี {len(usps)} ข้อ ตามรายการด้านล่าง:\n{rows}\n\n"
            f"ข้อกำหนดจุดเด่นสินค้า: highlights ต้องมี {len(usps)} ข้อพอดี — 1 ข้อต่อ 1 USP เรียงตามลำดับเลขด้านบน "
            "ห้ามตัด ห้ามรวม ห้ามเพิ่มข้ออื่น แต่ละข้อขึ้นต้นด้วยชื่อ USP นั้น แล้วตามด้วยคำอธิบายที่ย่อให้สั้นที่สุด "
            "(ย่อเฉพาะคำอธิบาย ไม่ตัด USP) ถ้าความยาวไม่พอ ให้เหลือเพียงชื่อ USP กับประโยชน์สั้นๆ "
            "และให้บทนำกับข้อมูลสินค้ากระชับ")


# ── 번들(세트 판매) 제품 (2026-11-24 사용자 결정) ──
#   lg.com 번들 페이지에는 본 제품 내용만 있고 사은품은 제품명에만 나온다 (예: 「ทีวี … 86QNED80TSA ฟรี ตู้เย็น … GC-F20FFBFB」).
#   · 사은품이 스피커(사운드바 · xboom 등): 본 제품만 — 사은품은 한 줄로만 언급
#   · 그 밖(냉장고 · 세탁기 · 전자레인지 · 청소기 등 두 제품): 반반 — 사은품 내용은 그 제품의 크롤(같은 out 폴더)에서.
#     두 제품 USP 를 2,000자 안에 다 넣을 수 없어, 제품마다 가장 중요한 USP 를 BUNDLE_SPLIT_USPS 개까지 고른다.
#   · 사은품 크롤이 없으면 본 제품만 (사은품 한 줄) — bundle.gift_missing 으로 알린다.
BUNDLE_SPLIT_USPS = 6
_BUNDLE_CONN = re.compile(r"\s(ฟรี|และ|ซื้อคู่)")
_SPEAKER = re.compile(r"soundbar|sound bar|ซาวด์บาร์|ลำโพง|xboom|\bgrab\b|\bbounce\b|speaker", re.I)
_CODE = re.compile(r"(?<![A-Za-z0-9])(?=[A-Za-z0-9.\-]*\d)(?=[A-Za-z0-9.\-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9.\-]{3,}[A-Za-z0-9](?![A-Za-z0-9])")


def _codes(t: str) -> list:
    return [c.upper() for c in _CODE.findall(t or "") if not re.fullmatch(r"\d+(HZ|K|GB|TB|CH|L|KG|W|MM|CM)", c.upper())]


def bundle_info_title_only(title: str):
    return bundle_info(title, None)


def bundle_info(title: str, slug_dir: Path = None):
    """제품명이 「본 제품 ฟรี/และ/ซื้อคู่ 사은품」 꼴이고 두 쪽에 서로 다른 모델(또는 사은품이 스피커)이면 번들."""
    m = _BUNDLE_CONN.search(title or "")
    if not m:
        return None
    main, gift = title[:m.start()].strip(), title[m.end():].strip()
    mc, gc = _codes(main), _codes(gift)
    speaker = bool(_SPEAKER.search(gift))
    if not mc or not (gc or speaker) or (gc and gc[0].split(".")[0] == mc[0].split(".")[0]):
        return None
    info = {"kind": "speaker" if speaker else "split", "conn": m.group(1), "main_title": main, "gift_title": gift,
            "main_model": mc[0].split(".")[0], "gift_model": gc[0] if gc else ""}
    if info["kind"] == "split":
        gdir = None
        if slug_dir and gc:
            code = gc[0].lower()
            pat = re.compile(r"-" + re.escape(code) + r"[a-z0-9]{0,2}$")
            def single(d):   # 다른 번들 페이지(예: …-wtbg-r5-max)는 사은품 내용으로 쓰지 않는다
                try:
                    t = json.loads((d / "mirror.json").read_text(encoding="utf-8")).get("product_title") or ""
                except Exception:
                    return False
                return not _BUNDLE_CONN.search(t) or bundle_info_title_only(t) is None
            cands = sorted((d for d in slug_dir.parent.iterdir() if d.is_dir() and d != slug_dir and pat.search(d.name)
                            and (d / "mirror.json").exists() and single(d)), key=lambda d: (not d.name.endswith("-" + code), len(d.name)))
            gdir = cands[0] if cands else None
        if gdir:
            info["gift_dir"] = gdir
            try:
                info["gift_url"] = json.loads((gdir / "source.json").read_text(encoding="utf-8")).get("url", "")
            except Exception:
                info["gift_url"] = ""
        else:
            info["kind"], info["gift_missing"] = "main", True   # 사은품 크롤 없음 → 본 제품만
    return info


def bundle_prompt(info: dict, main_usps: list, gift_usps: list, k1: int, k2: int, ka: bool = False, kb: bool = False) -> str:
    rows = lambda us: "\n".join(f"{i}. {u['title']}" + (f" — {u['desc'][:300]}" if u["desc"] else "") for i, u in enumerate(us, 1))
    if info["kind"] != "split":
        return (f"\n\nสินค้านี้เป็นชุดโปรโมชัน: สินค้าหลักคือ {info['main_title']} และมีของแถม/สินค้าคู่คือ {info['gift_title']} "
                "ให้เขียนเนื้อหาเฉพาะสินค้าหลัก กล่าวถึงของแถมเพียงสั้นๆ ครั้งเดียว (ในบทนำ หรือ 1 แถวในข้อมูลสินค้า) "
                "ห้ามเขียนจุดเด่นหรือสเปคของของแถมที่ไม่มีในข้อมูล ชื่อสินค้าให้ระบุของแถมต่อท้ายได้")
    return (f"\n\nสินค้านี้เป็นชุดโปรโมชัน 2 รายการ: (1) สินค้าหลัก {info['main_title']} (2) {info['conn']} {info['gift_title']} "
            "ข้อมูลของสินค้าที่ 2 อยู่ในแท็ก <lg_product_page> ชุดที่สอง ให้ใช้ข้อมูลแต่ละสินค้าจากหน้าของสินค้านั้นเท่านั้น ห้ามสลับกัน\n"
            "ให้แบ่งเนื้อหาครึ่งต่อครึ่งระหว่างสองสินค้า: บทนำกล่าวถึงทั้งสองสินค้าอย่างสมดุล "
            "ความยาวรวมของจุดเด่นสินค้าหลักกับของสินค้าที่ 2 ต้องใกล้เคียงกัน (ถ้าสินค้าใดมี USP น้อยข้อ ให้อธิบายแต่ละข้อละเอียดขึ้น) "
            f"จุดเด่นสินค้า (highlights) ต้องมี {k1 + k2} ข้อพอดี — {k1} ข้อแรกเป็นของสินค้าหลัก {'ตามรายการ A (คุณลักษณะที่สำคัญของ LG.com) ข้อละ 1 ข้อ' if ka else f'เลือก USP ที่สำคัญที่สุด {k1} ข้อจากรายการ A'} "
            f"แล้วตามด้วย {k2} ข้อของสินค้าที่ 2 {'ตามรายการ B (คุณลักษณะที่สำคัญของ LG.com) ข้อละ 1 ข้อ' if kb else f'เลือก USP ที่สำคัญที่สุด {k2} ข้อจากรายการ B'} (เรียงตามลำดับในรายการ) "
            "แต่ละข้อขึ้นต้นด้วยชื่อ USP แล้วตามด้วยประโยชน์สั้นๆ "
            "ข้อมูลสินค้า (product_info) ให้มีของทั้งสองสินค้า โดยขึ้นต้นป้ายกำกับด้วยชื่อรุ่นของสินค้านั้น "
            f"ชื่อสินค้า: LG + สินค้าหลัก + รุ่น + {info['conn']} + สินค้าที่ 2 + รุ่น\n"
            f"รายการ A (USP ของสินค้าหลัก):\n{rows(main_usps)}\n\nรายการ B (USP ของสินค้าที่ 2):\n{rows(gift_usps)}")


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


GEMINI_SUMMARY_MODEL = "gemini-2.5-pro"   # 요약은 길이·USP 수 조건이 까다로워 Pro 기본 (SUMMARY_GEMINI_MODEL 로 바꿈)


def _ask_gemini(ask: str, model: str, key: str) -> dict:
    """Gemini 로 요약 (geo_gen.py 와 같은 호출 방식: JSON 응답 + 스키마). 일시 오류는 3번까지 다시 시도."""
    import time
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=key)
    for attempt in range(1, 4):
        try:
            resp = client.models.generate_content(
                model=model, contents=ask,
                config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=PdpSummary,
                                                   temperature=0.2))
            return PdpSummary.model_validate(json.loads(resp.text)).model_dump()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def generate(slug_dir: Path, url: str, model: str = "") -> dict:
    import os
    import llm_claude
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    if gemini_key:      # Gemini 키가 있으면 Gemini (통합 서버). Claude 모델 이름(SUMMARY_MODEL 등)이 넘어오면 무시한다
        asked = model or os.getenv("SUMMARY_GEMINI_MODEL", "").strip()
        model = asked if asked.startswith("gemini") else GEMINI_SUMMARY_MODEL
        ask_llm = lambda ask, attempt: _ask_gemini(ask, model, gemini_key)
    else:
        model = model or os.getenv("SUMMARY_MODEL", "").strip() or llm_claude.CLAUDE_MODEL
        ask_llm = lambda ask, attempt: llm_claude.vision_json([ask], PdpSummary, label=f"pdp-summary-{attempt}",
                                                              max_tokens=32000, model=model)
    mp = slug_dir / "mirror.json"
    mirror = json.loads(mp.read_text(encoding="utf-8"))
    checked = checked_date(mp)
    usps = usp_list(mirror)
    limit = MAX_CHARS
    bundle = bundle_info(mirror.get("product_title") or "", slug_dir)
    src = source_text(mirror, url, slug_dir)
    kf = key_features(slug_dir)
    # 시도 계획: [(근거, 지시문, 장점 수, 시도 횟수, 앞 제품 장점 수(반반))]
    if bundle and bundle["kind"] == "split":   # 반반: 사은품 내용은 그 제품의 크롤에서 · 제품마다 lg.com Key features (없으면 핵심 USP 6개까지)
        gdir = bundle["gift_dir"]
        gmirror = json.loads((gdir / "mirror.json").read_text(encoding="utf-8"))
        gift_usps, gkf = usp_list(gmirror), key_features(gdir)
        la = [{"title": t, "desc": ""} for t in kf[:BUNDLE_SPLIT_USPS]] if kf else usps
        lb = [{"title": t, "desc": ""} for t in gkf[:BUNDLE_SPLIT_USPS]] if gkf else gift_usps
        k1, k2 = min(len(la), BUNDLE_SPLIT_USPS), min(len(lb), BUNDLE_SPLIT_USPS)
        prompt = (build_prompt(url, src, checked, limit)
                  + f"\n\n<lg_product_page url=\"{bundle['gift_url']}\">\n{source_text(gmirror, bundle['gift_url'], gdir)}\n</lg_product_page>"
                  + bundle_prompt(bundle, la, lb, k1, k2, ka=bool(kf), kb=bool(gkf)))
        plans = [("key_features" if kf or gkf else "usps", prompt, k1 + k2, 4, k1)]
        usp_titles = [u["title"] for u in la] + [u["title"] for u in lb]
    else:              # 단품 · 스피커 번들(본 제품만)
        base = build_prompt(url, src, checked, limit) + (bundle_prompt(bundle, usps, [], 0, 0) if bundle else "")
        # 사용자 결정(2026-11-24): USP 를 다 넣는 것이 좋지만 2,000자에 안 들어가면 lg.com 에 Key features 로 등록된 것만.
        #   USP 가 KF_DIRECT_USPS 개를 넘으면 처음부터 Key features (어차피 안 들어감 — 유료 호출을 아낀다), 아니면 USP 다 넣기 2번 → Key features 2번
        plans = []
        if usps and not (kf and len(usps) > KF_DIRECT_USPS):
            plans.append(("usps", base + usp_prompt(usps), len(usps), 2 if kf else 4, 0))
        if kf:
            plans.append(("key_features", base + kf_prompt(kf), len(kf), 4 if not plans else 2, 0))
        if not plans:
            plans.append(("usps", base, 0, 4, 0))
        usp_titles = None
    split = bool(bundle and bundle["kind"] == "split")
    d, basis, good, last = None, "", None, ""
    for basis, prompt, need_h, tries, k1 in plans:
        share = (lambda d, k1=k1: sum(len(h) for h in d["highlights"][:k1]) / max(1, sum(len(h) for h in d["highlights"]))) if split else (lambda d: 0.5)
        ask = prompt
        for attempt in range(tries):        # 조건: 600 초과 · 2,000 이하 · 상품명 120 이하 · 장점 수 맞음 (반반: 35~65%) — 벗어나면 다시 쓰게
            r = _fix(ask_llm(ask, attempt), url)
            n, nn, nh = len(plain_text(r)), len(r["product_name"]), len(r["highlights"])
            core = MIN_CHARS < n <= limit and nn <= NAME_MAX and (not need_h or nh == need_h)
            sh = share(r)
            if core and 0.35 <= sh <= 0.65:
                d = r
                break
            if core and good is None:
                good = (r, basis)        # 반반 비율만 못 맞춘 결과 — 끝까지 못 맞추면 이것을 쓴다
            last = f"{basis}: {n} chars, name {nn}, highlights {nh}/{need_h}"
            ask = (prompt + f"\n\nผลครั้งก่อน: เนื้อหาพร้อมคัดลอกยาว {n:,} ตัวอักษร ชื่อสินค้ายาว {nn} ตัวอักษร จุดเด่นสินค้า {nh} ข้อ "
                   f"— ต้องยาวมากกว่า {MIN_CHARS} และไม่เกิน {limit:,} ตัวอักษร ชื่อสินค้าไม่เกิน {NAME_MAX} ตัวอักษร "
                   + (f"และจุดเด่นสินค้าต้องมี {need_h} ข้อพอดี " if need_h else "")
                   + (f"และจุดเด่นของสินค้าหลักยาว {round(sh * 100)}% ของจุดเด่นทั้งหมด — ต้องแบ่งความยาวให้สองสินค้าใกล้เคียงกัน (ประมาณครึ่งต่อครึ่ง) " if split else "")
                   + "เขียนใหม่ให้อยู่ในเกณฑ์ โดยย่อเฉพาะคำอธิบาย และยังใช้เฉพาะข้อมูลที่ยืนยันได้")
        if d is not None:
            break
    if d is None and good is not None:
        d, basis = good
    if d is None:
        raise RuntimeError(f"rule not met after retries: {last}" + (f" (bundle {bundle['kind']})" if bundle else ""))
    if usp_titles is None:
        usp_titles = [u["title"] for u in usps] if basis == "usps" else kf
    d = _fix(d, url)
    meta_b = {**{k: v for k, v in bundle.items() if k != "gift_dir"}, **({"main_share": round(share(d), 2)} if split else {})} if bundle else None
    return {**d, "chars": len(plain_text(d)), "max_chars": limit, "usps": usp_titles, "basis": basis, "ref_url": url, "checked_at": checked,
            "model": model, "prompt_file": PROMPT_FILE.name, **({"bundle": meta_b} if meta_b else {})}


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
