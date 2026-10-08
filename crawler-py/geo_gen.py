# -*- coding: utf-8 -*-
"""
geo_gen.py — 크롤 결과(out/<slug>/mirror.json)만 근거로 GEO 자산 생성 (Gemini)

AI 쇼핑 어시스턴트(ChatGPT·Perplexity·Google AI Overview·Bing Copilot)가 인용할 수 있는
Q&A 6~8개와 타겟 키워드 10~15개를, 제품 페이지와 같은 언어로 만든다.
결과 JSON을 stdout 으로 출력 (저장은 crawler-routes.js 가 out/<slug>/geo.json 으로).

사용법: python geo_gen.py <out/slug 디렉토리>
필요 환경변수(.env): GEMINI_API_KEY
"""
import json
import os
import sys
import time
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")   # 프로젝트 루트 .env 공유 (pdp_pipeline 과 동일)
GEMINI_MODEL = "gemini-2.5-flash"   # 과부하 시 gemini-2.5-pro 로 폴백 (pdp_pipeline 과 동일 정책)


class FAQ(BaseModel):
    q: str
    a: str
    source: str = Field(description="Heading of the product-page section that supports the answer")


class GeoAssets(BaseModel):
    faq: List[FAQ]
    keywords: List[str]


SYSTEM = (
    "You write GEO (Generative Engine Optimization) assets for LG Electronics product pages: "
    "question-and-answer pairs that AI shopping assistants (ChatGPT, Perplexity, Google AI Overviews, Bing Copilot) can quote, "
    "and the search keywords shoppers would use. Use only facts stated in the product page text you are given; "
    "if the page does not state something, do not ask or answer about it. Write in the same language as the product page text."
)


def source_text(mirror: dict) -> str:
    parts = [f"# {mirror.get('product_title', '')}"]
    for s in mirror.get("sections", []):
        if "disclaimer" in str(s.get("order", "")):
            continue
        text = (s.get("text") or "").strip()
        if text:
            parts.append(text)
        specs = [x for x in (s.get("specs") or []) if x and x.get("label")]
        if specs:
            parts.append("## Specifications\n" + "\n".join(f"- {x['label']}: {x.get('value', '')}" for x in specs))
    return "\n\n".join(parts)


def main():
    out = Path(sys.argv[1])
    mirror = json.loads((out / "mirror.json").read_text(encoding="utf-8"))
    src = {}
    if (out / "source.json").exists():
        src = json.loads((out / "source.json").read_text(encoding="utf-8"))
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        sys.exit("GEMINI_API_KEY is not set")

    from google import genai
    from google.genai import types

    prompt = (
        f"Product page text (crawled from {src.get('url', 'LG.com')}):\n\n"
        f"<product_page>\n{source_text(mirror)}\n</product_page>\n\n"
        "Return 6-8 FAQ entries that real shoppers ask (features, use, specs, compatibility), each answer 1-3 sentences "
        "grounded in the page, with the heading of the supporting section as `source`, "
        "and 10-15 target keywords (short phrases, most important first)."
    )
    client = genai.Client(api_key=key)
    model = GEMINI_MODEL
    for attempt in range(1, 4):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM,
                    response_mime_type="application/json",
                    response_schema=GeoAssets,
                    temperature=0.2,
                ),
            )
            data = json.loads(resp.text)
            data["model"] = model
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stdout.write(json.dumps(data, ensure_ascii=False))
            return
        except Exception as e:
            if attempt == 3:
                raise
            if model == "gemini-2.5-flash":
                model = "gemini-2.5-pro"
            time.sleep(2 ** attempt)
            print(f"retry {attempt}: {str(e)[:120]}", file=sys.stderr)


if __name__ == "__main__":
    main()
