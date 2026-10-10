# -*- coding: utf-8 -*-
"""
pdp_pipeline.py — 반응형 PDP 무손실 미러링 파이프라인 (Python)

Step 1: Firecrawl 디바이스별(PC/모바일) 교차 수집 (markdown + html)
Step 2: Playwright PC/모바일 Full-Page 스크린샷 (+ Gemini 입력용 타일링)
Step 3: BeautifulSoup 전처리 — 동영상/반응형 에셋을 커스텀 태그로 markdown에 강제 주입
Step 4: Gemini 2.5 Pro 멀티모달 융합 분석 → Structured Outputs (Pydantic 스키마)
Step 5: 후단 기계 검증 — AI 출력의 URL/텍스트가 원본에 실존하는지 대조 (환각 차단)

사용법:
    python pdp_pipeline.py <PDP_URL> [--skip-ai] [--cache]
      --skip-ai : Step 1~3만 실행 (GEMINI_API_KEY 없이 크롤/전처리 검증)
      --cache   : out/<slug>/ 에 저장된 크롤/스크린샷 재사용 (API 비용 0)

필요 환경변수(.env): FIRECRAWL_API_KEY, GEMINI_API_KEY
"""
import argparse
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import List, Optional
from concurrent.futures import ThreadPoolExecutor

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from PIL import Image
from pydantic import BaseModel, Field

from make_mirror import to_mirror, order_by_document, tag_media_roles, ensure_product_gallery, upgrade_media_resolution, rehome_by_md_anchor, merge_same_component, pair_title_image, sanitize_texts, _best_url, _is_disclaimer_section, drop_ui_control_media, drop_duplicate_sections, extract_gallery
from component_parser import ComponentParser, parse_html_components, LayoutType
from text_filters import is_image_description
from component_mirror import build_from_components


class _CFSkip(Exception):
    """컴포넌트-우선 경로에서 배치 QA를 의도적으로 건너뛸 때 쓰는 내부 신호."""

# ── 인코딩 강제: 모든 stdout/파일 I/O utf-8 ─────────────────────────────
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")   # 프로젝트 루트 .env 공유

FIRECRAWL_KEY = os.getenv("FIRECRAWL_API_KEY", "")
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.5-flash"   # 기본 속도 향상을 위해 gemini-2.5-flash 기본 사용 (Pro는 --pro 플래그로 활성화)

TILE_HEIGHT = 2400                  # 풀페이지 스크린샷 세로 분할 높이(px) - 1600에서 2400으로 상향하여 이미지 수 및 지연 감소
MAX_TILES_PER_DEVICE = 14           # Gemini 입력 이미지 수 제한 (비용/한도 보호)

PROGRESS_FILE = None

def write_progress(percent: int, message: str):
    global PROGRESS_FILE
    if PROGRESS_FILE:
        try:
            PROGRESS_FILE.write_text(json.dumps({
                "percent": percent,
                "message": message,
                "updated_at": time.time()
            }, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    print(f"➜ [Progress {percent}%] {message}")


def slugify(url: str) -> str:
    return re.sub(r"-+$", "", re.sub(r"[^\w]+", "-", re.sub(r"https?://", "", url)))


# ═════════════════════════════════════════════════════════════════════
# Step 1. Firecrawl — PC / 모바일 교차 수집
# ═════════════════════════════════════════════════════════════════════
def firecrawl_scrape(url: str, mobile: bool) -> dict:
    device = "mobile" if mobile else "pc"
    print(f"→ [Step1] Firecrawl {device.upper()} scrape (최적화 모드)...")
    # 최적화: 스크롤 대기 및 고정 지연 시간 단축 (속도 향상)
    actions = [{"type": "wait", "milliseconds": 1500}]
    for _ in range(4):                              # lazy-load 전체 트리거 (10회 -> 4회)
        actions.append({"type": "scroll", "direction": "down"})
        actions.append({"type": "wait", "milliseconds": 400})
    actions.append({"type": "executeJavascript", "script": "window.scrollTo(0,0);"})
    actions.append({"type": "wait", "milliseconds": 1000})

    body = {
        "url": url,
        "formats": ["markdown", "html"],
        "onlyMainContent": False,
        "waitFor": 3000,                              # 대기 시간 최적화 (8000ms -> 3000ms)
        "timeout": 120000,
        "mobile": mobile,                             # 모바일 뷰포트/UA 에뮬레이션
        "actions": actions,
    }
    r = requests.post(
        "https://api.firecrawl.dev/v1/scrape",
        headers={"Authorization": f"Bearer {FIRECRAWL_KEY}"},
        json=body, timeout=180,
    )
    j = r.json()
    if not (r.ok and j.get("success")):
        raise RuntimeError(f"Firecrawl {device} 실패: {str(j)[:300]}")
    return j["data"]


# ═════════════════════════════════════════════════════════════════════
# Step 2. Playwright — PC/모바일 풀페이지 스크린샷 + 타일링
# ═════════════════════════════════════════════════════════════════════
def capture_screenshot(url: str, out_png: Path, mobile: bool):
    from playwright.sync_api import sync_playwright
    device = "mobile" if mobile else "pc"
    print(f"→ [Step2] Playwright {device.upper()} 풀페이지 스크린샷...")
    with sync_playwright() as p:
        # headless-shell은 Akamai 등 WAF에 차단됨 → 설치된 실제 Chrome 사용(신형 headless)
        try:
            browser = p.chromium.launch(
                channel="chrome", headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
        except Exception:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
        if mobile:
            ctx = browser.new_context(
                viewport={"width": 390, "height": 844}, device_scale_factor=2,
                is_mobile=True, has_touch=True,
                user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
            )
        else:
            # 기본 headless UA("HeadlessChrome")는 봇 차단됨 → 일반 Chrome UA 위장
            ctx = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
            )
        ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="networkidle", timeout=60000)
        except Exception:
            pass                                       # networkidle 실패 허용
        
        # 최적화: 푸터나 주요 콘텐츠 엘리먼트 감지 시 즉시 대기 종료 (4000ms 고정 대기 제거)
        try:
            page.wait_for_selector("footer", timeout=2000)
        except Exception:
            page.wait_for_timeout(1500)
            
        # 전체 스크롤 → lazy-load 트리거. (Pass 축소 및 step 크기 증가로 고속 스크롤)
        prev_h = 0
        for _ in range(2):                             # 5회 -> 2회 루프로 축소
            page.evaluate("""async () => {
                await new Promise(res => {
                    let y = window.scrollY, step = 1500; // 700에서 1500으로 스텝 상향
                    const t = setInterval(() => {
                        window.scrollBy(0, step); y += step;
                        if (y >= document.body.scrollHeight) { clearInterval(t); res(); }
                    }, 100); // 120ms에서 100ms로 감소
                    setTimeout(() => { clearInterval(t); res(); }, 12000);
                });
            }""")
            page.wait_for_timeout(800)                 # 2000ms -> 800ms
            h = page.evaluate("document.body.scrollHeight")
            if h == prev_h:
                break
            prev_h = h
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(1000)                    # 2500ms -> 1000ms

        # 하단 비-컨텐츠 위젯(리뷰·추천·서포트·FAQ·푸터) 경계 Y 측정 →
        # 이 위쪽만 타일링/마크다운에 사용해 Gemini 입력 토큰 절감.
        boundary = {"y": 0, "txt": "", "pageH": 0}
        try:
            boundary = page.evaluate("""() => {
                const H = document.body.scrollHeight;
                const sels = ['#pdp-review','[class*="PD0004"]','[class*="PD0002"]',
                              '[class*="PD0006"]','[class*="PD0056"]','[class*="ST0025"]','footer'];
                let minY = Infinity, txt = '';
                for (const sel of sels) {
                    document.querySelectorAll(sel).forEach(el => {
                        const r = el.getBoundingClientRect();
                        const y = Math.round(r.top + window.scrollY);
                        if (r.height > 40 && y > H*0.35 && y < minY) {
                            minY = y; txt = (el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50);
                        }
                    });
                }
                return {y: minY===Infinity ? 0 : minY, txt, pageH: H};
            }""")
        except Exception:
            pass

        page.screenshot(path=str(out_png), full_page=True)
        browser.close()
    (out_png.parent / "boundary.json").write_text(json.dumps(boundary), encoding="utf-8")
    cut = f" | 하단위젯 경계 y={boundary['y']}" if boundary.get("y") else ""
    print(f"   ✓ 저장: {out_png.name} ({out_png.stat().st_size // 1024}KB){cut}")
    return boundary


def read_json(fp: Path):
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except Exception:
        return None


def truncate_md_at_boundary(md: str, boundary_txt: str) -> str:
    """하단 위젯 경계 텍스트(리뷰/추천 섹션 헤딩)가 md에 있으면 그 지점부터 절단.
    best-effort — 매칭 실패 시 원본 유지(뒤단 strip_below_fold가 최종 보장)."""
    if not boundary_txt or len(boundary_txt) < 6:
        return md
    # 경계 텍스트의 앞부분(가장 고유한 조각)으로 탐색
    probe = boundary_txt.split("\n")[0][:40].strip()
    idx = md.find(probe)
    if idx > len(md) * 0.3:            # 문서 30% 이후에서만 절단 (마케팅 보호)
        return md[:idx].rstrip()
    return md


def tile_screenshot(png: Path, tiles_dir: Path, prefix: str, max_height: int = 0) -> List[Path]:
    """풀페이지 스크린샷(세로 수만 px)을 Gemini 입력용 타일로 분할.
    max_height>0 이면 그 높이까지만(하단 비-컨텐츠 위젯 제외) 타일링해 토큰 절감."""
    tiles_dir.mkdir(parents=True, exist_ok=True)
    for old in tiles_dir.glob(f"{prefix}-*.jpg"):   # 이전 타일 제거 (크롭 높이 변경 시 잔여 방지)
        old.unlink()
    img = Image.open(png)
    w, h = img.size
    # 하단 위젯 경계까지만 (경계가 페이지의 35% 이상일 때만 신뢰)
    if max_height and h * 0.35 <= max_height < h:
        h = int(max_height)
        img = img.crop((0, 0, w, h))
    n = min((h + TILE_HEIGHT - 1) // TILE_HEIGHT, MAX_TILES_PER_DEVICE)
    step = h / n
    out = []
    for i in range(n):
        top, bottom = int(i * step), min(int((i + 1) * step), h)
        tile = img.crop((0, top, w, bottom)).convert("RGB")
        if w > 1280:                                   # 토큰 절약: 폭 1280 제한
            tile = tile.resize((1280, int(tile.height * 1280 / w)))
        fp = tiles_dir / f"{prefix}-{i+1:02d}.jpg"
        tile.save(fp, "JPEG", quality=70)              # 최적화: 85 -> 70 화질 압축률 상향으로 페이로드 경량화
        out.append(fp)
    print(f"   ✓ {prefix} 타일 {len(out)}장 (원본 {w}x{h})")
    return out


# ═════════════════════════════════════════════════════════════════════
# Step 3. 전처리 — 동영상/반응형 에셋 커스텀 태그 주입 (무손실)
# ═════════════════════════════════════════════════════════════════════
JUNK = re.compile(r"gnb|promotion|promo|deals|banner|membership|favicon|\.svg|[-_]icon[-_]|logo", re.I)


def _abs(u: str, base: str) -> str:
    if not u or u.startswith("data:"):
        return ""
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("/"):
        m = re.match(r"https?://[^/]+", base)
        return (m.group(0) + u) if m else u
    return u


def extract_media(html: str, base_url: str, device: str) -> List[dict]:
    """<video>/<iframe>/<picture>/srcset/display:none 미디어 전수 추출 + 디바이스 판별."""
    soup = BeautifulSoup(html, "html.parser")
    found, seen = [], set()

    def add(kind, url, anchor, dev=device):
        url = _abs(url, base_url)
        if not url or JUNK.search(url):
            return
        key = re.sub(r"[?#].*$", "", url)
        if key in seen:
            return
        seen.add(key)
        found.append({"kind": kind, "url": url, "device": dev, "anchor": (anchor or "")[:80]})

    def near_heading(el):
        h = el.find_previous(["h1", "h2", "h3"])
        return h.get_text(strip=True) if h else ""

    for v in soup.find_all("video"):
        anchor = v.get("aria-label") or near_heading(v)
        if v.get("src"):
            add("VIDEO", v["src"], anchor)
        for s in v.find_all("source"):
            if s.get("src"):
                add("VIDEO", s["src"], anchor)
    for f in soup.find_all("iframe"):
        src = f.get("src") or f.get("data-src") or ""
        if re.search(r"youtube|vimeo|\.mp4", src, re.I):
            add("VIDEO", src, near_heading(f))
    # <picture>: media 쿼리로 PC/모바일 명시 구분
    for pic in soup.find_all("picture"):
        anchor = ""
        img = pic.find("img")
        if img:
            anchor = (img.get("alt") or "").strip() or near_heading(pic)
        for s in pic.find_all("source"):
            ss = s.get("srcset") or ""
            u = ss.split(",")[0].strip().split(" ")[0]
            media = s.get("media") or ""
            dev = "mobile" if "max-width" in media else ("pc" if "min-width" in media else device)
            add("IMAGE", u, anchor, dev)
    # 숨김(display:none) 블록 내 이미지 — 반응형 듀얼 은닉분
    for el in soup.select('[style*="display:none"], [style*="display: none"]'):
        for img in el.find_all("img"):
            u = img.get("src") or img.get("data-src") or ""
            add("IMAGE", u, (img.get("alt") or "").strip(), device)
    # 지연 로딩 이미지 — src가 없거나 더미(data:)이고 data-src/data-desktop-src에
    # 실제 URL이 있는 경우 (Firecrawl md에는 더미만 실리거나 아예 누락됨)
    for img in soup.find_all("img"):
        src = (img.get("src") or "").strip()
        if src and not src.startswith("data:"):
            continue                      # 정상 src는 md가 커버
        lazy = img.get("data-src") or img.get("data-desktop-src") or ""
        if lazy and not lazy.startswith("data:"):
            anchor = (img.get("alt") or "").strip() or near_heading(img)
            add("IMAGE", lazy, anchor, device)

    # 인라인 CSS background-image — PD0041 카드 캐러셀 등은 <img> 없이 배경으로만
    # 이미지를 싣는다. URL이 CSS 이스케이프(\2f → /, \3a → :)로 인코딩된 경우 복원.
    # 앵커는 페이지 헤딩이 아니라 "같은 카드 컨테이너 안의 headline"을 우선 사용 —
    # 섹션 헤딩을 쓰면 N개 카드 태그가 헤딩 밑에 뭉쳐 캡션과 1:1 매칭이 깨진다.
    def card_anchor(el):
        node = el
        for _ in range(5):                      # 카드 컨테이너까지 상향 탐색
            node = getattr(node, "parent", None)
            if node is None or not getattr(node, "select_one", None):
                break
            t = node.select_one(".cmp-title, .c-text-contents__headline, h2, h3, h4")
            if t:
                txt = t.get_text(strip=True)
                if 4 <= len(txt) <= 100:
                    return txt
        return ""

    for el in soup.select('[style*="background-image"]'):
        style = el.get("style") or ""
        for raw in re.findall(r"background-image\s*:\s*url\(\s*(?:&quot;|['\"])?([^)'\"]+?)(?:&quot;|['\"])?\s*\)", style):
            u = re.sub(r"\\([0-9a-fA-F]{2,6})\s?", lambda m: chr(int(m.group(1), 16)), raw).strip()
            anchor = card_anchor(el) or (el.get("aria-label") or "").strip() or near_heading(el)
            add("IMAGE", u, anchor, device)
    return found


def inject_custom_tags(md: str, media: List[dict]) -> str:
    """markdown 원문은 보존하면서, 누락 미디어를 앵커 텍스트 근처에 커스텀 태그로 주입."""
    lines = md.split("\n")
    tagged, unanchored = 0, []
    for m in media:
        tag = f"[{m['device'].upper()}_{m['kind']}: {m['url']}]"
        if m["url"] in md:                              # 이미 markdown에 존재 → 태그 불필요
            continue
        placed = False
        if m["anchor"]:
            a = m["anchor"][:40]
            for i, ln in enumerate(lines):
                if a and a in ln:
                    lines.insert(i + 1, tag)
                    placed, tagged = True, tagged + 1
                    break
        if not placed:
            unanchored.append(tag)
    if unanchored:
        lines += ["", "## [UNANCHORED_MEDIA] (앵커 미상 — AI가 스크린샷으로 위치 판단)"] + unanchored
    print(f"→ [Step3] 커스텀 태그 주입: 앵커 {tagged}개 / 미앵커 {len(unanchored)}개")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════
# Step 4. Gemini 멀티모달 융합 분석 (Structured Outputs)
# ═════════════════════════════════════════════════════════════════════
class MediaAsset(BaseModel):
    pc_url: str = Field(description="PC 화면에서 노출되는 이미지 또는 동영상 URL. 없거나 공통이면 빈 문자열")
    mobile_url: str = Field(description="모바일 화면에서 노출되는 이미지 또는 동영상 URL. 없거나 공통이면 빈 문자열")
    unified_url: str = Field(description="PC/모바일 구분 없이 공통으로 사용되는 단일 에셋인 경우의 URL")


class PDPSection(BaseModel):
    sequence: int = Field(description="상세페이지 상단부터 하단까지의 시각적 흐름 순서 (1부터 시작)")
    content_type: str = Field(description="'text' 또는 'media' 중 하나")
    text_content: str = Field(description="content_type이 'text'일 때의 텍스트 원본 내용. 미디어 섹션이면 빈 문자열")
    media_assets: Optional[MediaAsset] = Field(default=None, description="content_type이 'media'일 때 해당 구역의 PC/모바일 반응형 에셋 정보")
    layout_columns: int = Field(default=1, description="PC 화면 기준 이 미디어가 속한 가로 행의 이미지 개수. 단독/풀폭=1, 2개 병렬=2, 3개 병렬=3, 4개 병렬=4. 텍스트 섹션은 1")
    row_group: int = Field(default=0, description="같은 가로 행에 나란히 배치된 미디어들은 동일한 행 그룹 번호(1부터). 단독 미디어는 0")
    associated_context: str = Field(description="미디어 섹션일 경우, 이 미디어가 설명하는 원문 PDP와 100% 동일한 언어 기반의 핵심 대표 키워드 1개 (예: 영어 PDP면 'Fresh', 한국어 PDP면 '신선', 독일어 PDP면 'Frische') (반드시 5자 이내의 극히 가볍고 간결한 단어로 작성하십시오. PDP 페이지에 실제 존재하지 않거나 사용되지 않은 다른 제3의 외국어를 임의로 주입하여 작성하는 행위를 완전히 금지합니다.). 텍스트 섹션이면 빈 문자열")
    # NOTE: CCG 컴포넌트 정보(component_id/layout_type/text_alignment/element_roles)는
    #       Gemini가 채우는 값이 아니라 HTML 파싱(Step 3.5)→매칭(enrich_with_component_data)으로
    #       사후 주입한다. dict 필드를 응답 스키마에 넣으면 Gemini Developer API가
    #       'additionalProperties' 미지원으로 거부하므로 스키마에서 제외한다.


class FinalPDPData(BaseModel):
    product_title: str = Field(description="추출된 상품명")
    layout_flow: List[PDPSection] = Field(description="상세페이지 전체 레이아웃 흐름 데이터 배열")


ANALYSIS_PROMPT = """당신은 이커머스 PDP 구조 분석 전문가입니다.

절대적 규칙: 원본 PDP 노출 언어 100% 일치 원칙 (Source Language Consistency Rule)
- 결과 JSON에 사용되는 모든 텍스트, 타이틀, 레이블, 대표 키워드(`associated_context` 포함)는 반드시 **원본 PDP 웹페이지에 실제로 노출되어 있는 원문 언어와 100% 일치**하게 작성하십시오.
- **예시**: 
  - 영국 PDP(English) 분석 중에는 키워드를 한글('인증', '디자인')로 임의 번역하거나 적어서는 절대 안 되며 원어 그대로('Awards', 'Design') 작성되어야 합니다.
  - 반대로 한국 PDP(Korean) 분석 중에는 원어 그대로 한글 키워드('인증', '색상')를 사용해야 합니다.
  - 독일 PDP(German) 분석 중에는 독일어 키워드('Energie', 'Farben')를 그대로 사용해야 합니다.
- PDP 페이지 원본의 그 어디에서도 찾아볼 수 없는 이질적인 외국어 단어(예: 영국/독일 페이지 결과물 내에 혼입되는 한글 단어 등)를 결과 데이터 내부의 단 한 필드에도 절대 주입하거나 번역하여 기재하지 마십시오.

입력:
1) [PC 스크린샷 타일들] — 상세페이지 PC 화면을 상단→하단 순서로 분할한 이미지
2) [모바일 스크린샷 타일들] — 동일 페이지의 모바일 화면 분할 이미지
3) [전처리된 마크다운] — 페이지 원문 텍스트 + 미디어 URL. [PC_VIDEO: url], [MOBILE_IMAGE: url]
   형태의 커스텀 태그는 마크다운 변환에서 누락된 미디어를 강제 보존한 것입니다.

작업:
- 스크린샷을 인간의 눈처럼 보며 어떤 텍스트(헤드라인/바디카피)와 어떤 미디어가
  하나의 시각적 세트인지, 상단→하단 흐름 순서를 1차 판단하십시오.
- 그 시각적 판단을 근거로, 마크다운 속 실제 텍스트 원문과 미디어 URL을 매칭하십시오.
- 같은 컨텐츠의 PC용/모바일용 에셋(파일명 -d/-m, desktop/mobile 경로 등)은 쌍으로 묶어
  pc_url/mobile_url에 넣고, 단일 공통 에셋은 unified_url에 넣으십시오.

LG PDP 구조 및 그룹핑 규칙 (필수 준수):
1. **정확한 시각적 흐름 순서 (Sequence)**:
   - 전체 `layout_flow` 섹션들은 실제 PDP의 최상단에서 최하단까지 시각적 흐름을 그대로 일치시켜야 합니다. 순서가 밀리거나 뒤죽박죽되지 않도록 스크린샷의 랜드마크 요소를 기반으로 정밀 배치하십시오.
2. **최상단 갤러리 캐러셀 이미지 중복 수집 배제**:
   - 제품 상세페이지 최상단 메인 갤러리 영역(제품 본체 외형 회전 컷, 360뷰 썸네일, 캐러셀 컷 등)에 노출되는 미디어들은 하단 마케팅 특징(Feature) 섹션에 삽입되면 안 됩니다.
   - `/gallery/`가 포함된 이미지나 제품의 단순 외관 썸네일컷은 본체 메인 갤러리 자산으로만 분류하고, 일반 Feature 섹션의 이미지로 중복 배정하지 마십시오.
3. **디스클레이머(Disclaimer, 법적 고지) 그룹 매칭**:
   - 디스클레이머(예: *Images have been simulated..., *To download... 등 별표로 시작하는 모든 법적 고지 텍스트)는 주로 **해당 이미지/미디어의 "바로 아래"**에 소속되어야 합니다.
   - **절대적이고 강제적인 규칙**: 새로운 헤드라인 타이틀(## Title)이나 본문 문단 위쪽(첫머리)으로 `*`로 시작하는 디스클레이머가 먼저 올 수 없습니다. 독립된 특징(Feature) 설명 섹션의 가장 첫 줄이 `*`로 시작하는 고지문이 되는 구조는 물리적으로 완전 금지합니다.
   - 이 디스클레이머들은 반드시 **"해당 고지문이 설명하는 짝 이미지/비디오 구역의 직후 하단"**으로 완벽하게 이동 수렴시키거나, 아예 독립된 별도의 `text` 면책 구역으로 최하단에 분리하십시오. 새로운 특징 설명 텍스트 영역의 시작부(## 타이틀 위쪽)에 섞여서 들어가는 형태를 절대 허용하지 않습니다.
4. **그리드 컴포넌트(1행 N개 카드/아이콘) 및 상위 타이틀 그룹핑**:
   - 한 가로행에 2~4개의 이미지 카드, 뱃지, 혹은 썬더볼트5 기술 아이콘들(예: 3개 연속 아이콘인 2x Faster, 96W, 5K2K Display)과 그 아래 각각의 부연 문장들이 배치된 경우, 이들 n개 전체를 총괄하는 상위의 메인 헤드라인(예: "World's first Thunderbolt™5 5K2K Display**")이 **통합 대타이틀(Header Title)**이 됩니다.
   - **강제 그룹핑 지침**: 
     - 이 통합 대타이틀 문단과 그 아래에 줄지어 배치되는 n개의 아이콘 이미지들, 그리고 각 아이콘의 세부 설명 텍스트들은 절대 각각의 별개 섹션으로 어설프게 분리되어 뒤죽박죽 밀려 나열되어서는 안 됩니다.
     - 또한, 이 그리드 구역의 가장 하단부에 배치되어 기술 구조를 한눈에 증명해 주는 대형 스크린샷 이미지(예: Thunderbolt 5 PC 연결 구도 상세 실사 컷, 텍스트가 부재한 단독 미디어) 역시 텍스트가 없다고 해서 혼자 공중에 뜨거나 분리되지 않고, 반드시 **"이 모든 것을 총괄하는 메인 대타이틀('World's first Thunderbolt...')이 포함된 텍스트 묶음 섹션"과 동일한 하나의 한 세트(Same Order)로 밀착 흡착**되도록 융합 구조를 설계하십시오.
     - 메인 대타이틀을 하나의 대표 `text` 구역으로 두고, 산하의 아이콘 에셋들과 매칭 실사 컷들을 모두 동일한 행 그룹(`row_group`)과 레이아웃 컬럼(`layout_columns=n`) 규격 하위에 질서정연하게 종속 배정하십시오.
   - **카드=이미지+캡션 쌍 유지 (가장 중요, 절대 준수)**:
     - 한 가로행에 N개의 카드(수상 뱃지, 아이콘, 썸네일 등)가 나열된 경우, **각 카드는 "그 카드의 이미지 1개 + 그 카드 바로 아래의 캡션 텍스트"를 반드시 한 쌍으로 유지**해야 합니다.
     - 출력 구조: N개 카드는 **N개의 개별 media 섹션**으로 만들고, 각 media 섹션 바로 앞(또는 바로 뒤)에 **그 카드만의 캡션 text 섹션**을 인접 배치하며, 이들 N쌍 전체에 **동일한 `row_group`과 `layout_columns=N`**을 부여하십시오. (예: 4개 수상 뱃지 → [캡션1][이미지1][캡션2][이미지2][캡션3][이미지3][캡션4][이미지4], 모두 row_group 동일)
     - **절대 금지 1**: N개 카드의 이미지들을 하나의 섹션에 몰아넣지 마십시오 (예: media 4개를 한 섹션에 전부 넣는 것 금지). 카드가 4개면 media 섹션도 4개입니다.
     - **절대 금지 2**: N개 카드의 캡션들을 이미지와 분리된 하나의 텍스트 덩어리로 뭉치지 마십시오 (예: "캡션1 캡션2 캡션3 캡션4"를 한 text 섹션에 합치는 것 금지). 각 캡션은 자기 짝 이미지에 붙어 있어야 합니다.
     - 요약하면: "이미지는 이미지끼리, 텍스트는 텍스트끼리" 갈라놓는 구조는 완전히 금지이며, 반드시 **카드 단위(이미지+캡션)로 쌍을 이루어** 화면 배치 그대로 출력하십시오.
   - **상단 오버뷰/요약 그리드**: 페이지 상단의 "왜 이 제품인가?(Why ...?)" 같은 요약 영역에 제품 핵심 특징 미리보기 썸네일이 한 가로행에 여러 개 나열되어 있다면, 이 역시 그리드로 인식하여 각 썸네일에 `row_group`·`layout_columns`를 부여하십시오. 여러 썸네일을 row_group 없이 한 섹션에 세로로 쌓아 넣지 마십시오.

규칙 (절대 준수):
- [PC_VIDEO: url], [PC_IMAGE: url], [MOBILE_*: url] 커스텀 태그의 미디어는 탭/캐러셀에
  숨겨져 스크린샷에 안 보이더라도 절대 누락 금지 — 마크다운 내 인접 텍스트(탭 제목·헤드라인)와
  매칭하여 해당 텍스트 섹션 직후의 media 섹션으로 반드시 포함하십시오.
  (탭 UI는 패널 수만큼 텍스트+media 세트를 연속 배치)
- layout_flow는 페이지 최상단부터 최하단까지 전체를 빠짐없이 포함. 섹션 병합·생략·요약으로
  개수를 줄이지 말 것. 미디어 하나 = media 섹션 하나.
- text_content는 마크다운에 실존하는 원문을 글자 그대로(verbatim) 복사하되, 반드시 원본 줄바꿈(\n)을 온전히 보존하십시오. 재작성·요약·번역 금지.
- **줄바꿈(\n) 및 마크다운 헤더 기호(##) 보존 규칙**: Eyebrow(예: `Hygiene care`)와 타이틀(예: `## Goodbye bacteria`)과 하위 본문은 대충 띄어쓰기로 한 줄로 묶지 말고, 원래 마크다운 그대로 개별 줄에 줄바꿈(\n)으로 명확히 나뉘어 보존되어 있어야 합니다. (절대로 이들을 `Hygiene care ## Goodbye bacteria ...`와 같이 공백으로 한 줄에 합쳐 기재하지 마십시오).
- URL은 입력에 실존하는 것만 사용. 존재하지 않는 URL 생성 절대 금지.
- 면책문구(*로 시작)는 흐름에 포함하되 별도 text 섹션으로 분리.
- 사이트 공통 UI(내비게이션/추천상품/리뷰/푸터)는 제외, 제품 마케팅 콘텐츠만 포함.
- **출력 토큰 최적화**: associated_context 필드는 반드시 5자 이내의 아주 짧은 대표 키워드로만 작성하십시오. 이를 준수하지 않으면 출력 길이 한도로 인해 분석 결과가 중간에 잘려서 끊기는 치명적인 오류가 발생합니다.
"""


def _html_product_title(html: str) -> str:
    """Gemini 없이 HTML에서 제품명 추출 (og:title → h1 → <title>)."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        return og["content"].split("|")[0].strip()
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return h1.get_text(" ", strip=True)
    return (soup.title.get_text(strip=True).split("|")[0].strip() if soup.title else "")


def run_gemini(md: str, pc_tiles: List[Path]) -> dict:
    from google import genai
    from google.genai import types
    import time
    print(f"→ [Step4] Gemini({GEMINI_MODEL}) 멀티모달 분석... (PC 타일 {len(pc_tiles)}장)")
    client = genai.Client(api_key=GEMINI_KEY)

    contents = [ANALYSIS_PROMPT, "\n\n=== [PC 스크린샷 타일] (상단→하단) ==="]
    for fp in pc_tiles:
        contents.append(types.Part.from_bytes(data=fp.read_bytes(), mime_type="image/jpeg"))
    contents.append("\n\n=== [전처리된 마크다운] ===\n" + md)

    # 503/429 등 일시적 구글 API 과부하 시 지수 백오프 재시도 및 모델 폴백 (최대 3회)
    current_model = GEMINI_MODEL
    for attempt in range(1, 4):
        try:
            resp = client.models.generate_content(
                model=current_model,
                contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=FinalPDPData,
                    temperature=0,
                    max_output_tokens=65536,
                ),
            )
            return json.loads(resp.text)
        except Exception as e:
            if attempt == 3:
                raise e
            if "503" in str(e) or "UNAVAILABLE" in str(e):
                if current_model == "gemini-2.5-flash":
                    current_model = "gemini-2.5-pro"
                    print("   ⚠️ gemini-2.5-flash 과부하로 인해 gemini-2.5-pro 모델로 즉시 폴백합니다.")
            elif isinstance(e, json.JSONDecodeError) and current_model == "gemini-2.5-flash":
                # 긴 PDP에서 flash 응답 JSON이 잘리거나 깨지는 경우 → pro 로 재시도
                current_model = "gemini-2.5-pro"
                print("   ⚠️ Gemini 응답 JSON 손상 → gemini-2.5-pro 모델로 재시도합니다.")
            wait_sec = attempt * 5
            print(f"   ⚠️ 구글 API 분석 오류 발생 (시도 {attempt}/3): {str(e)[:150]}")
            print(f"   ➜ {wait_sec}초 동안 대기 후 다시 시도합니다...")
            time.sleep(wait_sec)


# ═════════════════════════════════════════════════════════════════════
# Step 6. LLM 시각 QA — 사용자가 화면을 보고 인지하는 방식 그대로
#         스크린샷(시각적 진실) vs 크롤 결과(layout_flow)의 매칭을 재검수
# ═════════════════════════════════════════════════════════════════════
class QAIssue(BaseModel):
    sequence: int = Field(description="문제가 있는 섹션의 sequence 번호")
    issue_type: str = Field(description="'wrong_media'(다른 텍스트의 미디어가 매칭) | 'wrong_order'(순서 어긋남) | 'missing_media'(화면에 있는데 누락) | 'wrong_text'")
    description: str = Field(description="화면에서 실제로 보이는 것과 크롤 결과의 차이를 구체적으로 서술")
    suggested_fix: str = Field(description="올바른 매칭 제안 (올바른 미디어 파일명 또는 올바른 순서)")


class QAReport(BaseModel):
    total_media_checked: int = Field(description="검수한 media 섹션 수")
    match_score: int = Field(description="시각적 매칭 정확도 0~100 (사용자가 화면에서 인지하는 것과 일치하는 비율)")
    issues: List[QAIssue] = Field(description="발견된 매칭 오류 목록. 없으면 빈 배열")


QA_PROMPT = """당신은 PDP 크롤 결과의 QA 검수자입니다. 실제 사용자가 웹페이지를 눈으로 보며
"이 헤드라인 옆/아래의 이미지는 이 기능을 보여주는 것"이라고 인지하는 방식 그대로,
[스크린샷 타일들](시각적 진실)과 [크롤 결과 flow](추출물)를 상단→하단 순서로 대조하십시오.

각 MEDIA 항목에 대해: 바로 앞/뒤 TEXT 항목과 그 미디어가 화면에서 실제로 한 세트로
배치되어 있는지 확인. 다른 섹션의 미디어가 매칭됐거나(wrong_media), 순서가 밀렸거나
(wrong_order), 화면에 보이는 미디어가 누락됐으면(missing_media) issues에 보고하십시오.
탭/캐러셀에 숨겨진 미디어는 스크린샷에 안 보여도 오류가 아닙니다 (파일명의 번호 스템이
인접 텍스트와 일치하면 정상으로 간주).

**카드 그리드 특별 검수 (한 가로행에 N개 카드가 나열된 경우)**:
- 화면에서 각 카드는 "이미지 + 그 아래 캡션"이 한 쌍입니다. 크롤 결과에서 이 쌍이 풀려
  있으면(예: N개 이미지가 한 섹션에 몰려 있고 캡션들은 이미지와 분리된 별도 텍스트로 뭉쳐
  있는 경우) 반드시 wrong_media 로 보고하고, suggested_fix 에 "각 카드의 이미지와 캡션을
  쌍으로 재분리하고 동일 row_group 부여"라고 명시하십시오.
- 상단 요약(Why ...?) 영역에 썸네일이 한 행에 여러 개인데 row_group 없이 세로로 쌓여
  있으면 wrong_order 로 보고하십시오.

문제없으면 issues를 비우고 match_score만 주십시오."""


def run_qa(result: dict, pc_tiles: List[Path]) -> dict:
    from google import genai
    from google.genai import types
    import time
    print(f"→ [Step6] LLM 시각 QA... (PC 타일 {len(pc_tiles)}장 대조)")
    # 크롤 결과를 압축 flow 텍스트로 (토큰 절약)
    lines = []
    for s in result.get("layout_flow", []):
        if s["content_type"] == "media":
            ma = s.get("media_assets") or {}
            u = ma.get("unified_url") or ma.get("pc_url") or ma.get("mobile_url") or ""
            lines.append(f"[{s['sequence']}] MEDIA {u.split('/')[-1][:80]}")
        else:
            lines.append(f"[{s['sequence']}] TEXT {(s.get('text_content') or '')[:80]!r}")
    client = genai.Client(api_key=GEMINI_KEY)
    contents = [QA_PROMPT, "\n=== [PC 스크린샷 타일] (상단→하단) ==="]
    for fp in pc_tiles:
        contents.append(types.Part.from_bytes(data=fp.read_bytes(), mime_type="image/jpeg"))
    contents.append("\n=== [크롤 결과 flow] ===\n" + "\n".join(lines))

    # 503/429 등 일시적 구글 API 과부하 시 지수 백오프 재시도 및 모델 폴백 (최대 3회)
    current_model = GEMINI_MODEL
    for attempt in range(1, 4):
        try:
            resp = client.models.generate_content(
                model=current_model, contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json", response_schema=QAReport,
                    temperature=0, max_output_tokens=32768,
                ),
            )
            qa = json.loads(resp.text)
            print(f"   ✓ QA 점수 {qa.get('match_score')}점 | 이슈 {len(qa.get('issues', []))}건")
            return qa
        except Exception as e:
            if attempt == 3:
                raise e
            if "503" in str(e) or "UNAVAILABLE" in str(e):
                if current_model == "gemini-2.5-flash":
                    current_model = "gemini-2.5-pro"
                    print("   ⚠️ gemini-2.5-flash 과부하로 인해 gemini-2.5-pro 모델로 즉시 폴백합니다.")
            elif isinstance(e, json.JSONDecodeError) and current_model == "gemini-2.5-flash":
                current_model = "gemini-2.5-pro"
                print("   ⚠️ Gemini 응답 JSON 손상 → gemini-2.5-pro 모델로 재시도합니다.")
            wait_sec = attempt * 5
            print(f"   ⚠️ 구글 API QA 오류 발생 (시도 {attempt}/3): {str(e)[:150]}")
            print(f"   ➜ {wait_sec}초 동안 대기 후 다시 시도합니다...")
            time.sleep(wait_sec)


# ═════════════════════════════════════════════════════════════════════
# Step 6.5. QA 자동 보정 루프 — QA 이슈를 Gemini가 스크린샷을 다시 보며 교정
#           보정 → 재검증(Step5) → 재QA(Step6) 를 수렴할 때까지 반복
# ═════════════════════════════════════════════════════════════════════
QA_PASS_SCORE = 95      # 이 점수 이상 & 이슈 0건이면 수렴
MAX_QA_LOOPS = 2        # 무한 루프/비용 보호

CORRECTION_PROMPT = """당신은 PDP 크롤 결과 교정자입니다.
[기존 layout_flow]와 [QA 이슈 목록]이 주어집니다. 스크린샷을 다시 보고
이슈로 지적된 부분만 수정한 "전체" layout_flow를 다시 출력하십시오.

교정 규칙 (절대 준수):
- 이슈가 없는 섹션은 그대로 유지 — 텍스트/URL을 임의로 바꾸지 말 것.
- wrong_order: 섹션 순서를 화면 흐름대로 재배치 (타이틀은 자신의 이미지보다 위).
- wrong_media: 해당 텍스트와 같은 세트의 올바른 미디어로 교체
  (파일명 토큰과 타이틀 단어 일치로 검증, 입력에 실존하는 URL만 사용).
- wrong_text: 텍스트를 올바른 섹션 위치로 이동/분리 (원문 그대로).
- missing_media: 마크다운/커스텀 태그에 실존하는 URL로 추가.
- **카드 그리드 재쌍짓기**: 한 가로행 N개 카드에서 이미지들이 한 섹션에 몰려 있고
  캡션들이 별도 텍스트로 뭉쳐 있으면, 각 이미지를 자기 캡션과 다시 쌍으로 분리하여
  N개의 (이미지+캡션) 카드 단위로 만들고 모두 동일 row_group·layout_columns=N 부여.
  (이미지끼리/텍스트끼리 뭉치는 구조를 카드 쌍 구조로 교정)
- 전체 섹션을 최상단부터 최하단까지 빠짐없이 출력 — 생략·병합·요약 금지.
- 새 URL 생성 금지, 텍스트 재작성 금지 (verbatim 유지).
"""


def run_correction(result: dict, qa: dict, md: str, pc_tiles: List[Path]) -> dict:
    from google import genai
    from google.genai import types
    import time
    n_issues = len(qa.get("issues", []))
    print(f"→ [Step6.5] QA 자동 보정... (이슈 {n_issues}건 교정 요청)")
    client = genai.Client(api_key=GEMINI_KEY)
    contents = [CORRECTION_PROMPT, "\n=== [PC 스크린샷 타일] (상단→하단) ==="]
    for fp in pc_tiles:
        contents.append(types.Part.from_bytes(data=fp.read_bytes(), mime_type="image/jpeg"))
    contents.append("\n=== [기존 layout_flow] ===\n" + json.dumps(result, ensure_ascii=False))
    contents.append("\n=== [QA 이슈 목록] ===\n" + json.dumps(qa.get("issues", []), ensure_ascii=False))
    contents.append("\n=== [참고: 전처리 마크다운 (URL/원문 소스)] ===\n" + md)

    # 503/429 등 일시적 구글 API 과부하 시 지수 백오프 재시도 및 모델 폴백 (최대 3회)
    current_model = GEMINI_MODEL
    for attempt in range(1, 4):
        try:
            resp = client.models.generate_content(
                model=current_model, contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json", response_schema=FinalPDPData,
                    temperature=0, max_output_tokens=65536,
                ),
            )
            return json.loads(resp.text)
        except Exception as e:
            if attempt == 3:
                raise e
            if "503" in str(e) or "UNAVAILABLE" in str(e):
                if current_model == "gemini-2.5-flash":
                    current_model = "gemini-2.5-pro"
                    print("   ⚠️ gemini-2.5-flash 과부하로 인해 gemini-2.5-pro 모델로 즉시 폴백합니다.")
            elif isinstance(e, json.JSONDecodeError) and current_model == "gemini-2.5-flash":
                current_model = "gemini-2.5-pro"
                print("   ⚠️ Gemini 응답 JSON 손상 → gemini-2.5-pro 모델로 재시도합니다.")
            wait_sec = attempt * 5
            print(f"   ⚠️ 구글 API 보정 오류 발생 (시도 {attempt}/3): {str(e)[:150]}")
            print(f"   ➜ {wait_sec}초 동안 대기 후 다시 시도합니다...")
            time.sleep(wait_sec)


# ═════════════════════════════════════════════════════════════════════
# Step 7.5. mirror 시각 QA — 최종 산출물(mirror.json) 레이아웃을 PC 스크린샷과
#           직접 대조. final.json이 아니라 "실제 활용 레이아웃"을 눈으로 검수한다.
#           보정은 배치(미디어 이동·섹션 순서)만 — 텍스트/URL은 verbatim 불변.
# ═════════════════════════════════════════════════════════════════════
class MirrorMove(BaseModel):
    image: str = Field(description="잘못 배치된 미디어의 파일명 끝부분 (예: feature-31-lg-gaming-portal-d.jpg)")
    to_section: int = Field(description="화면상 실제로 이 미디어가 속해야 할 섹션의 order 정수 번호")


class MirrorQAReport(BaseModel):
    layout_match_score: int = Field(description="mirror 레이아웃이 PC 화면과 일치하는 정도 0~100")
    moves: List[MirrorMove] = Field(description="다른 섹션으로 옮겨야 할 미디어 목록. 정상이면 빈 배열")
    section_order: List[int] = Field(description="정수 섹션들의 올바른 상단→하단 순서(order 번호 나열). 순서가 정상이면 빈 배열")
    notes: List[str] = Field(description="화면과 다른 점 요약. 없으면 빈 배열")


MIRROR_QA_PROMPT = """당신은 PDP '최종 레이아웃'의 시각 QA 검수자입니다.
[PC 스크린샷 타일](시각적 진실)과 [mirror 섹션 레이아웃](최종 산출물)을 상단→하단으로 대조하여,
mirror가 실제 PC 화면과 "동일한 구조"로 배치됐는지 검수하십시오.

각 섹션은 {order, 텍스트 헤드, 미디어 파일명 목록}으로 제시됩니다. 확인 사항:
1. misplaced_media: 어떤 미디어가 화면상 다른 섹션(다른 헤드라인/기능)에 속하는데 엉뚱한
   섹션에 들어가 있으면, moves에 {그 파일명, 올바른 섹션 order}를 추가하십시오.
   특히 한 섹션에 서로 다른 기능의 이미지가 무더기로 몰려 있으면(예: 'Why ...?' 요약
   섹션에 gallery/gaming/sports 이미지가 뒤섞임) 각각 제 기능 섹션으로 재배치하십시오.
2. wrong_order: 섹션 순서가 화면 흐름과 다르면 section_order에 올바른 order 나열을 주십시오.
3. 카드 그리드(한 행 N개 카드)는 각 '이미지+그 아래 캡션'이 1:1로 같은 섹션에 있어야 합니다.

중요 제약:
- 텍스트나 URL을 새로 만들지 마십시오. 오직 "이미 존재하는 미디어를 어느 섹션으로 옮길지",
  "섹션 순서를 어떻게 바꿀지"만 판단합니다.
- 탭/캐러셀에 숨겨져 스크린샷에 안 보이는 미디어는, 파일명의 feature 번호가 어느 섹션과
  같은지로만 판단하고, 확신이 없으면 건드리지 마십시오(moves에 넣지 마십시오).
- 완벽히 일치하면 moves·section_order를 비우고 layout_match_score만 주십시오."""


def _mirror_qa_view(mirror: dict) -> str:
    lines = []
    for s in mirror["sections"]:
        head = re.sub(r"\s+", " ", (s.get("text") or "")).strip()[:70]
        imgs = [_best_url(m).split("/")[-1] for m in s["media"]]
        lines.append(f"[order {s['order']}] TEXT={head!r}")
        for im in imgs:
            lines.append(f"    IMG {im}")
    return "\n".join(lines)


def run_mirror_qa(mirror: dict, pc_tiles: List[Path]) -> dict:
    from google import genai
    from google.genai import types
    import time
    print(f"→ [Step7.5] mirror 시각 QA... (PC 타일 {len(pc_tiles)}장 대조)")
    client = genai.Client(api_key=GEMINI_KEY)
    contents = [MIRROR_QA_PROMPT, "\n=== [PC 스크린샷 타일] (상단→하단) ==="]
    for fp in pc_tiles:
        contents.append(types.Part.from_bytes(data=fp.read_bytes(), mime_type="image/jpeg"))
    contents.append("\n=== [mirror 섹션 레이아웃] ===\n" + _mirror_qa_view(mirror))
    current_model = GEMINI_MODEL
    for attempt in range(1, 4):
        try:
            resp = client.models.generate_content(
                model=current_model, contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json", response_schema=MirrorQAReport,
                    temperature=0, max_output_tokens=32768,
                ),
            )
            qa = json.loads(resp.text)
            print(f"   ✓ mirror QA 점수 {qa.get('layout_match_score')}점 | 이동 {len(qa.get('moves', []))}건"
                  f" | 순서교정 {'Y' if qa.get('section_order') else 'N'}")
            return qa
        except Exception as e:
            if attempt == 3:
                raise e
            if "503" in str(e) or "UNAVAILABLE" in str(e):
                if current_model == "gemini-2.5-flash":
                    current_model = "gemini-2.5-pro"
                    print("   ⚠️ flash 과부하 → pro 폴백")
            time.sleep(attempt * 5)


def _renumber_mirror(mirror: dict):
    """재배치/재정렬 후 order 라벨을 상단→하단 순으로 다시 매김 (make_mirror 규칙과 동일)."""
    fc = dc = 0
    for s in mirror["sections"]:
        if _is_disclaimer_section(s):
            dc += 1
            s["order"] = f"{dc} - disclaimer"
        else:
            fc += 1
            s["order"] = fc


def apply_mirror_fixes(mirror: dict, qa: dict) -> int:
    """mirror QA 결과를 결정적으로 적용 — 미디어 이동·섹션 순서만, 텍스트/URL 불변."""
    secs = mirror["sections"]
    by_order = {str(s["order"]): s for s in secs}
    moved = 0
    # 1) 미디어 재배치 (verbatim 안전: 기존 미디어 객체를 옮기기만)
    for mv in qa.get("moves", []):
        img = (mv.get("image") or "").strip()
        tgt = by_order.get(str(mv.get("to_section")))
        if not img or tgt is None or _is_disclaimer_section(tgt):
            continue
        for s in secs:
            if s is tgt:
                continue
            for m in [m for m in s["media"] if img in _best_url(m)]:
                s["media"].remove(m)
                if not any(_best_url(x) == _best_url(m) for x in tgt["media"]):
                    tgt["media"].append(m)
                    moved += 1
    # 2) 섹션 재정렬 (정수 섹션이 완전 일치할 때만; 디스클레이머는 선행 섹션에 고정 유지)
    want = [str(o) for o in (qa.get("section_order") or [])]
    int_orders = [str(s["order"]) for s in secs if not _is_disclaimer_section(s)]
    if want and set(want) == set(int_orders) and len(want) == len(int_orders):
        trailing, cur = {}, None
        for s in secs:
            if _is_disclaimer_section(s):
                if cur is not None:
                    trailing.setdefault(id(cur), []).append(s)
            else:
                cur = s
        leading = [s for s in secs if _is_disclaimer_section(s)
                   and all(s not in v for v in trailing.values())]
        new = list(leading)
        for o in want:
            s = by_order[o]
            new.append(s)
            new.extend(trailing.get(id(s), []))
        mirror["sections"] = new
    _renumber_mirror(mirror)
    return moved


# ═════════════════════════════════════════════════════════════════════
# Step 5. 후단 기계 검증 — AI 환각 차단 (URL/원문 실존 대조)
# ═════════════════════════════════════════════════════════════════════
def verify(result: dict, corpus: str) -> dict:
    norm = re.sub(r"\s+", " ", corpus)
    bad_urls, bad_texts = [], []
    for sec in result.get("layout_flow", []):
        ma = sec.get("media_assets") or {}
        for k in ("pc_url", "mobile_url", "unified_url"):
            u = (ma.get(k) or "").strip()
            if u and re.sub(r"[?#].*$", "", u) not in corpus:
                bad_urls.append({"sequence": sec.get("sequence"), "field": k, "url": u[-90:]})
        # Gemini가 eyebrow/헤드라인/본문을 \n으로 결합하므로 줄 단위로 원문 대조
        for line in (sec.get("text_content") or "").split("\n"):
            t = re.sub(r"\s+", " ", line).strip()
            if t and len(t) > 12 and t[:80] not in norm:
                bad_texts.append({"sequence": sec.get("sequence"), "text": t[:60]})
    report = {
        "sections": len(result.get("layout_flow", [])),
        "hallucinated_urls": bad_urls,       # 비어있어야 정상
        "unverbatim_texts": bad_texts,       # 비어있어야 정상
        "pass": not bad_urls and not bad_texts,
    }
    print(f"→ [Step5] 검증: 섹션 {report['sections']} | URL 환각 {len(bad_urls)} | 원문 불일치 {len(bad_texts)}"
          f" → {'✅ PASS' if report['pass'] else '⚠️ 검수 필요'}")
    return report


def post_process_split_disclaimers(layout_flow: list) -> list:
    """
    LLM이 미처 분리하지 못하고 한 섹션에 묶어버린 디스클레이머(*로 시작)와 
    일반 텍스트/헤드라인을 프로그램적으로 강제 분리합니다.
    """
    new_flow = []
    seq_counter = 1
    
    for sec in layout_flow:
        if sec.get("content_type") != "text":
            sec["sequence"] = seq_counter
            seq_counter += 1
            new_flow.append(sec)
            continue
            
        text = sec.get("text_content") or ""
        lines = text.split("\n")
        
        # 디스클레이머 행들과 일반 행들을 분리
        disclaimer_lines = []
        normal_lines = []
        
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if (stripped.startswith("*") and not stripped.startswith("**")) or stripped.startswith("※"):
                disclaimer_lines.append(line)
            else:
                normal_lines.append(line)
                
        # 만약 한 섹션에 디스클레이머와 일반 카피가 섞여있다면 분리
        if disclaimer_lines and normal_lines:
            # 1) 디스클레이머들로 이루어진 별도 text 섹션 추가 (이전 이미지 아래에 묶이도록)
            disclaimer_text = "\n".join(disclaimer_lines)
            new_flow.append({
                "sequence": seq_counter,
                "content_type": "text",
                "text_content": disclaimer_text,
                "media_assets": None,
                "layout_columns": 1,
                "row_group": 0,
                "associated_context": ""
            })
            seq_counter += 1
            
            # 2) 일반 본문으로 이루어진 text 섹션 추가
            normal_text = "\n".join(normal_lines)
            new_flow.append({
                "sequence": seq_counter,
                "content_type": "text",
                "text_content": normal_text,
                "media_assets": None,
                "layout_columns": 1,
                "row_group": 0,
                "associated_context": ""
            })
            seq_counter += 1
        else:
            sec["sequence"] = seq_counter
            seq_counter += 1
            new_flow.append(sec)
            
    return new_flow


def enrich_with_component_data(layout_flow: list, component_data: list) -> list:
    """
    AI 분석 결과(layout_flow)에 CCG 컴포넌트 정보를 매칭하여 추가합니다.
    미디어 URL 또는 텍스트 내용을 기준으로 컴포넌트를 매칭합니다.
    """
    # 컴포넌트에서 미디어 URL -> 컴포넌트 정보 매핑 구축
    url_to_component = {}
    text_to_component = {}

    for comp in component_data:
        comp_info = {
            "component_id": comp.get("component_id"),
            "component_dom_index": comp.get("dom_index", -1),  # DOM 순번 (섹션 정렬 기준)
            "layout_type": comp.get("layout_type"),
            "column_count": comp.get("column_count", 0),       # DOM 선언 컬럼 수
            "text_alignment": comp.get("text_alignment"),
            "background_type": comp.get("background_type"),
            "element_roles": comp.get("elements", {})
        }

        # 미디어 URL 매핑
        for media in comp.get("elements", {}).get("media", []):
            for url_key in ["src_desktop", "src_mobile"]:
                url = media.get(url_key)
                if url:
                    # URL의 마지막 경로 부분을 키로 사용 (파일명)
                    url_key_part = url.split("/")[-1].split("?")[0]
                    url_to_component[url_key_part] = comp_info
                    url_to_component[url] = comp_info

        # 텍스트 매핑 (헤드라인 기준)
        for text_el in comp.get("elements", {}).get("texts", []):
            if text_el.get("role") == "headline":
                text_key = text_el.get("text", "")[:50]  # 처음 50자로 매칭
                if text_key:
                    text_to_component[text_key] = comp_info

    # layout_flow 섹션에 컴포넌트 정보 매칭
    enriched_flow = []
    for sec in layout_flow:
        sec = dict(sec)  # 복사

        matched_comp = None

        # 1. 미디어 URL로 매칭 시도
        if sec.get("content_type") == "media" and sec.get("media_assets"):
            ma = sec["media_assets"]
            for url_key in ["pc_url", "mobile_url", "unified_url"]:
                url = ma.get(url_key, "")
                if url:
                    url_part = url.split("/")[-1].split("?")[0]
                    if url_part in url_to_component:
                        matched_comp = url_to_component[url_part]
                        break
                    if url in url_to_component:
                        matched_comp = url_to_component[url]
                        break

        # 2. 텍스트 헤드라인으로 매칭 시도
        if not matched_comp and sec.get("content_type") == "text":
            text = sec.get("text_content", "")
            # ## 헤드라인 추출
            lines = text.split("\n")
            for line in lines:
                clean_line = line.strip().lstrip("#").strip()[:50]
                if clean_line in text_to_component:
                    matched_comp = text_to_component[clean_line]
                    break

        # 컴포넌트 정보 추가
        if matched_comp:
            sec["component_id"] = matched_comp.get("component_id")
            sec["component_dom_index"] = matched_comp.get("component_dom_index", -1)
            sec["layout_type"] = matched_comp.get("layout_type")
            sec["column_count"] = matched_comp.get("column_count", 0)
            sec["text_alignment"] = matched_comp.get("text_alignment")
            sec["element_roles"] = {
                "texts": [t.get("role") for t in matched_comp.get("element_roles", {}).get("texts", [])],
                "has_cta": len(matched_comp.get("element_roles", {}).get("ctas", [])) > 0,
                "media_count": len(matched_comp.get("element_roles", {}).get("media", []))
            }
            # ── 컴포넌트 div 구조 기반 텍스트 백필 ──────────────────────────
            # 섹션 텍스트가 이미지 alt 묘사문이면, 컴포넌트가 실제 보유한
            # eyebrow/headline/body 역할 텍스트로 교체해 섹션 정확도를 높인다.
            # (Gemini가 이미지 설명을 잘못 카피로 잡은 경우를 컴포넌트 진실로 정정)
            _cur = (sec.get("text_content") or "").strip()
            if _cur and is_image_description(_cur):
                _roles = matched_comp.get("element_roles", {}).get("texts", [])
                def _pick(rs):
                    for t in _roles:
                        if t.get("role") in rs:
                            txt = (t.get("text") or "").strip()
                            if txt and not is_image_description(txt):
                                return txt
                    return ""
                _eb, _hl, _bd = _pick(("eyebrow",)), _pick(("headline", "subheadline")), _pick(("body_copy", "body"))
                _parts = [p for p in (_eb, (f"## {_hl}" if _hl else ""), _bd) if p]
                sec["text_content"] = "\n".join(_parts)  # 실컴포넌트 카피 없으면 "" → 이미지만 남음
        else:
            # 기본값 설정
            sec["component_id"] = None
            sec["component_dom_index"] = -1
            sec["layout_type"] = None
            sec["text_alignment"] = None
            sec["element_roles"] = None

        enriched_flow.append(sec)

    # 통계 출력
    matched_count = sum(1 for s in enriched_flow if s.get("component_id"))
    print(f"   컴포넌트 매칭: {matched_count}/{len(enriched_flow)} 섹션")

    return enriched_flow


def _attach_gallery(mirror: dict, html: str, origin: str):
    """제품 갤러리: LG.com 상단 갤러리(.c-gallery)를 화면 순서 그대로 (못 찾으면 기존 값 유지)."""
    gal = extract_gallery(html, origin)
    if gal:
        mirror["_gallery"] = gal
        print(f"   ✓ 제품 갤러리 {len(gal)}장 (LG.com 갤러리 영역 순서)")


def _polish_mirror(mirror: dict, html: str):
    """미러 최종 정리 — 빠른 경로·기존 경로 공통."""
    # 이미지·텍스트가 모두 같은 섹션 제거 (캐러셀 루프 복제 슬라이드 등)
    _dup = drop_duplicate_sections(mirror)
    if _dup:
        print(f"   ✓ 중복 섹션 제거: {_dup}건 (이미지·텍스트 동일)")
    # UI 컨트롤(탭 버튼 아이콘·썸네일, 버튼, # 앵커) 전용 이미지 제거 — 클릭해서 콘텐츠로
    # 이동/전환시키는 UI라 콘텐츠가 아니다. Gemini 경로로 유입된 경우까지 여기서 일괄 차단.
    _ui = drop_ui_control_media(mirror, html)
    if _ui:
        print(f"   ✓ UI 컨트롤 이미지 제외: {_ui}건 (탭 아이콘·썸네일 등)")
    _san = sanitize_texts(mirror)   # 최종 방어: 캡션 신설 등으로 뒤늦게 유입된 alt 묘사문 제거
    if _san:
        print(f"   ✓ 텍스트 최종 정제: {_san}개 섹션에서 alt 묘사문 제거")
    tag_media_roles(mirror)

    # 이미지 해상도 업그레이드 — 썸네일(180x180 등)로 잡힌 미디어를 HTML에 실재하는
    # 같은 에셋의 최고 해상도(원본)로 교체. 갤러리·로고·아이콘이 흐리게 나오는 문제 해결.
    up = upgrade_media_resolution(mirror, html)
    if up:
        print(f"   ✓ 이미지 해상도 업그레이드: {up}건 (썸네일→원본)")


def content_checks(mirror: dict) -> dict:
    """빠른 경로의 qa_report — AI 시각 QA 대신 결과 데이터를 코드로 점검한 수치.
    match_score 는 없음(null). 빌더는 checks 를 표시한다."""
    sections = mirror.get("sections", [])
    media = [m for s in sections for m in s.get("media", [])]
    no_url = sum(1 for m in media if not (m.get("pc_url") or m.get("unified_url") or m.get("mobile_url")))
    checks = {
        "sections": len(sections),
        "sections_with_image_and_text": sum(1 for s in sections if s.get("media") and (s.get("text") or "").strip()),
        "images": len(media) - no_url,
        "images_missing_url": no_url,
        "gallery_images": len(mirror.get("_gallery") or []),
        "feature_cards": len(mirror.get("_feature_cards") or []),
        "has_title": bool((mirror.get("product_title") or "").strip()),
    }
    issues = []
    if not checks["has_title"]:
        issues.append("제품명을 찾지 못했습니다")
    if checks["gallery_images"] == 0:
        issues.append("제품 갤러리 이미지가 없습니다")
    if checks["sections_with_image_and_text"] < 3:
        issues.append(f"이미지와 텍스트가 함께 있는 섹션이 {checks['sections_with_image_and_text']}개뿐입니다")
    if no_url:
        issues.append(f"주소가 없는 이미지 {no_url}개")
    return {"mode": "component", "match_score": None, "checks": checks, "issues": issues}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--skip-ai", action="store_true", help="Step 1~3만 실행")
    ap.add_argument("--cache", action="store_true", help="저장된 크롤/스크린샷 재사용")
    ap.add_argument("--pro", action="store_true", help="Gemini 2.5 Pro 사용 (기본값: Gemini 2.5 Flash)")
    ap.add_argument("--full-ai", action="store_true",
                    help="빠른 컴포넌트 경로를 쓰지 않고 기존 방식(스크린샷 + Gemini 분석·시각 QA)으로 실행. "
                         "환경 변수 CRAWLER_FULL_AI=1 로 전체 적용")
    args = ap.parse_args()
    full_ai = args.full_ai or os.getenv("CRAWLER_FULL_AI", "").strip() == "1"

    if not FIRECRAWL_KEY:
        sys.exit("✗ FIRECRAWL_API_KEY 없음 (.env)")
    out = ROOT / "out" / slugify(args.url)
    out.mkdir(parents=True, exist_ok=True)
    
    global PROGRESS_FILE
    PROGRESS_FILE = out / "progress.json"
    write_progress(5, "크롤 및 분석 인프라 초기화 완료")

    # CLI 인자에 따른 모델 다이내믹 라우팅 최적화 (Dual-Model Routing)
    global GEMINI_MODEL
    GEMINI_MODEL = "gemini-2.5-pro" if args.pro else "gemini-2.5-flash"
    print(f"→ [Setup] 분석용 AI 모델: {GEMINI_MODEL}")

    def cached(name: str) -> Optional[str]:
        fp = out / name
        return fp.read_text(encoding="utf-8") if (args.cache and fp.exists()) else None

    # Step 1 — PC 단일 기기 수집 (시간 단축 극대화)
    datasets = {}
    md_cached, html_cached = cached("pc.md"), cached("pc.html")
    if md_cached is None or html_cached is None:
        write_progress(15, "1단계: Firecrawl 웹 스크래핑 및 HTML/DOM 트리 분석 중...")
        print("→ [Step1] PC 크롤링 시작 (모바일 스킵으로 극단적 최적화)...")
        d = firecrawl_scrape(args.url, mobile=False)
        md, html = d.get("markdown", ""), d.get("html", "")
        (out / "pc.md").write_text(md, encoding="utf-8")
        (out / "pc.html").write_text(html, encoding="utf-8")
        write_progress(35, "1단계 완료: 원본 웹페이지 마크다운 수집 성공")
    else:
        print("✓ [Step1] PC 크롤 캐시 사용")
        write_progress(35, "1단계 (캐시): 웹 텍스트 수집 완료")
        md, html = md_cached, html_cached
        
    datasets["pc"] = {"md": md, "html": html}
    _cf_origin = "https://" + (args.url.split("//", 1)[-1].split("/", 1)[0] or "www.lg.com")

    # ★ 빠른 경로 (2026-10-10~): 최종 미러는 컴포넌트-우선(Step7-CF)으로 만들어지고 Gemini 결과는
    #   제품명만 쓰였다. 컴포넌트 근거가 충분하면 스크린샷·Gemini 분석·시각 QA(기존 10분+)를 건너뛰고
    #   HTML 컴포넌트만으로 바로 완성한다. 품질이 떨어지면 --full-ai / CRAWLER_FULL_AI=1 로 기존 방식 복귀.
    if not full_ai and not args.skip_ai:
        write_progress(60, "2단계: CCG 컴포넌트 ID 및 레이아웃 구조 파싱 중...")
        component_data = parse_html_components(html)
        _cf = build_from_components(component_data, _html_product_title(html), _cf_origin)
        _st = _cf.get("_cf_stats", {})
        if _st.get("renderable", 0) >= 3:          # Step7-CF 와 같은 최소 품질 게이트
            (out / "components.json").write_text(
                json.dumps(component_data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"→ [Fast] 컴포넌트 {len(component_data)}개 → 노출섹션 {_st['renderable']} "
                  f"(결합 {_st.get('stitched', 0)} / 카드후보 {len(_cf.get('_feature_cards', []))} "
                  f"/ 전체이미지 {_st.get('assets_all', 0)}장) — 스크린샷·Gemini 분석 생략")
            write_progress(90, "3단계: 리테일용 컨텐츠 데이터 생성 중...")
            mirror = _cf
            _attach_gallery(mirror, html, _cf_origin)
            _polish_mirror(mirror, html)
            # 예전 실행의 Gemini 산출물은 이번 결과와 무관하므로 정리
            for f in ("final.json", "verify_report.json", "mirror_qa_report.json"):
                (out / f).unlink(missing_ok=True)
            (out / "qa_report.json").write_text(
                json.dumps(content_checks(mirror), ensure_ascii=False, indent=2), encoding="utf-8")
            (out / "mirror.json").write_text(json.dumps(mirror, ensure_ascii=False, indent=2), encoding="utf-8")
            write_progress(100, "분석 완료!")
            print(f"\n✓ 완료 (빠른 컴포넌트 경로). 산출물: {out}/mirror.json")
            return
        print(f"→ [Fast] 컴포넌트 근거 부족(노출 {_st.get('renderable', 0)}) → 기존 방식(스크린샷 + Gemini 분석)으로 진행")

    # Step 2 — PC 단일 스크린샷 + 타일 (시간 단축 극대화)
    tiles = {}
    png = out / "pc_full.png"
    if not (args.cache and png.exists() and (out / "tiles").exists()):
        write_progress(40, "2단계: Playwright 헤드리스 브라우저 실행 및 스캔 중...")
        print("→ [Step2] PC 풀페이지 스크린샷 캡처 (모바일 스킵으로 극단적 최적화)...")
        capture_screenshot(args.url, png, mobile=False)
        write_progress(50, "2단계: 고화질 타일링(Tiling) 및 PIL 분할 가공 중...")
    else:
        print("✓ [Step2] PC 스크린샷 캐시 사용")
        write_progress(50, "2단계 (캐시): 고화질 스크린샷 로드 완료")
        
    # 하단 위젯 경계 로드 (신규 캡처는 반환값, 캐시는 boundary.json)
    boundary = read_json(out / "boundary.json") or {"y": 0, "txt": "", "pageH": 0}
    tiles["pc"] = tile_screenshot(png, out / "tiles", "pc", max_height=boundary.get("y", 0))
    write_progress(55, "2단계 완료: 비주얼 분석용 스크린샷 세트 가공 성공")

    # Step 3 — 전처리 (PC md 기준 + PC html의 미디어 주입)
    write_progress(58, "3단계: 원문 텍스트 내 비주얼 앵커 태그 매칭 및 주입 중...")
    media = extract_media(datasets["pc"]["html"], args.url, "pc")
    pre_md = inject_custom_tags(datasets["pc"]["md"], media)
    # 마크다운도 하단 위젯 경계 텍스트에서 절단 → Gemini 텍스트 토큰 절감 (best-effort)
    pre_md = truncate_md_at_boundary(pre_md, boundary.get("txt", ""))
    (out / "preprocessed.md").write_text(pre_md, encoding="utf-8")
    write_progress(60, "3단계 완료: 전처리 마크다운 빌드 완료 (AI 준비)")

    # Step 3.5 — CCG 컴포넌트 파싱 (HTML에서 컴포넌트 ID 및 레이아웃 구조 추출)
    write_progress(62, "3.5단계: CCG 컴포넌트 ID 및 레이아웃 구조 파싱 중...")
    component_data = parse_html_components(datasets["pc"]["html"])
    (out / "components.json").write_text(
        json.dumps(component_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"→ [Step3.5] CCG 컴포넌트 {len(component_data)}개 파싱 완료")

    # 컴포넌트 ID 요약 출력
    component_summary = {}
    for comp in component_data:
        cid = comp.get("component_id", "UNKNOWN")
        component_summary[cid] = component_summary.get(cid, 0) + 1
    print(f"   컴포넌트 분포: {dict(sorted(component_summary.items()))}")
    write_progress(64, f"3.5단계 완료: CCG 컴포넌트 {len(component_data)}개 인식")

    if args.skip_ai:
        write_progress(100, "분석 완료 (AI 분석 스킵)")
        print(f"\n✓ Step1~3 완료 (--skip-ai). 산출물: {out}")
        return
    if not GEMINI_KEY:
        sys.exit("✗ GEMINI_API_KEY 없음 (.env) — --skip-ai 로 1~3단계만 실행 가능")

    # Step 4 — Gemini 융합 분석 (PC 단일 뷰포트 분석)
    write_progress(65, f"4단계: Gemini {GEMINI_MODEL} 멀티모달 시각 구조 대조 분석 중 (20~40초 소요)...")
    gemini_ok = True
    try:
        result = run_gemini(pre_md, tiles["pc"])
    except Exception as _ge:
        # 최종 미러는 컴포넌트-우선(Step7-CF)으로 만들어지므로, HTML 컴포넌트 근거가 충분하면
        # Gemini 분석 없이도 완료할 수 있다 (Gemini 결과는 제품명 정도만 쓰임).
        _probe = build_from_components(component_data, "", _cf_origin).get("_cf_stats", {})
        if _probe.get("renderable", 0) < 3:
            raise
        gemini_ok = False
        print(f"   ⚠️ Gemini 분석 실패 → 컴포넌트-우선 미러로 계속 진행 (노출 섹션 {_probe['renderable']}): {str(_ge)[:120]}")
        write_progress(80, "4단계: AI 분석 응답 오류 — HTML 컴포넌트 구조로 계속 진행합니다")
        result = {"product_title": _html_product_title(datasets["pc"]["html"]), "layout_flow": []}
    # [프로그램적 강제 분리 보완] 디스클레이머와 타이틀이 합쳐진 경우 강제 분리
    result["layout_flow"] = post_process_split_disclaimers(result["layout_flow"])

    # NOTE: CCG 컴포넌트 매칭(enrich)은 여기서 하지 않는다. Step 6.5 QA 보정 루프가
    #       run_correction으로 result를 Gemini 스키마(FinalPDPData)에 맞춰 재직렬화하면서
    #       사후 주입한 컴포넌트 필드를 벗겨내기 때문. 매칭은 QA 루프 종료 후(Step 6.9)에 수행한다.
    (out / "final.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_progress(80, "4단계 완료: 멀티모달 레이아웃 흐름 데이터 추출 성공")

    # Step 5 — 후단 검증
    write_progress(82, "5단계: 수집 본문 실존 여부 및 원문 훼손율 검증 중...")
    corpus = pre_md + "\n" + datasets["pc"]["html"]
    report = verify(result, corpus) if gemini_ok else {"pass": True, "_note": "gemini skipped"}
    (out / "verify_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Step 6 — LLM 시각 QA (화면 인지 기준 매칭 재검수)
    write_progress(85, "6단계: LLM 자기치유형 시각 매칭 검수(Visual QA) 수행 중...")
    qa = {"match_score": None, "issues": [], "_note": "gemini skipped — component-first mirror"}
    if gemini_ok:
        try:
            qa = run_qa(result, tiles["pc"])
        except Exception as _qe:   # QA는 결과를 다듬는 선택 단계 — 실패해도 계속
            print(f"   ⚠️ 시각 QA 실패 → 건너뜀: {str(_qe)[:120]}")
            qa = {"match_score": None, "issues": [], "_note": "qa failed: " + str(_qe)[:200]}

    # Step 6.5 — QA 자동 보정 루프: 발견 → 교정 → 재검증 → 재QA (수렴까지)
    qa_history = [{"loop": 0, "score": qa.get("match_score"), "issues": len(qa.get("issues", []))}]
    for loop in range(1, MAX_QA_LOOPS + 1):
        if not gemini_ok or qa.get("match_score") is None or (qa.get("match_score", 0) >= QA_PASS_SCORE and not qa.get("issues")):
            break
        write_progress(88 + loop * 2, f"6.{loop}단계: 시각 정렬 불일치 보정 루프 기동 중 (루프 {loop}/{MAX_QA_LOOPS})...")
        try:
            corrected = run_correction(result, qa, pre_md, tiles["pc"])
        except Exception as _ce:   # 보정 실패 시 기존 결과 유지
            print(f"   ⚠️ 보정 실패 → 기존 결과 유지 (loop {loop}): {str(_ce)[:120]}")
            qa_history.append({"loop": loop, "failed": str(_ce)[:200]})
            break
        # 보정본 기계 검증 — 환각/원문훼손 있으면 보정 폐기(기존 유지)
        c_report = verify(corrected, corpus)
        if not c_report["pass"]:
            print(f"   ⚠️ 보정본이 기계 검증 실패 → 폐기, 기존 결과 유지 (loop {loop})")
            qa_history.append({"loop": loop, "rejected": True})
            break
        try:
            c_qa = run_qa(corrected, tiles["pc"])
        except Exception as _qe2:
            print(f"   ⚠️ 보정본 QA 실패 → 기존 결과 유지 (loop {loop}): {str(_qe2)[:120]}")
            qa_history.append({"loop": loop, "failed": str(_qe2)[:200]})
            break
        qa_history.append({"loop": loop, "score": c_qa.get("match_score"), "issues": len(c_qa.get("issues", []))})
        # 개선됐을 때만 채택 (점수 하락 시 기존 유지 후 종료)
        if c_qa.get("match_score", 0) >= qa.get("match_score", 0):
            result, qa, report = corrected, c_qa, c_report
            (out / "final.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            (out / "verify_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"   ✓ 보정 채택 (loop {loop}): {qa_history[-2].get('score')}점 → {c_qa.get('match_score')}점")
        else:
            print(f"   ⚠️ 보정 후 점수 하락({c_qa.get('match_score')}점) → 기존 유지")
            break

    qa["_history"] = qa_history
    (out / "qa_report.json").write_text(json.dumps(qa, ensure_ascii=False, indent=2), encoding="utf-8")
    write_progress(94, "6단계 완료: 최종 시각 정렬성 매칭 완료")

    # Step 6.9 — CCG 컴포넌트 매칭 (QA 보정 루프 종료 후 최종 result 기준으로 사후 주입)
    #            보정 루프가 Gemini 스키마로 재직렬화하므로 매칭은 반드시 루프 이후에 수행해야
    #            컴포넌트 정보가 유실되지 않고 to_mirror(Step 7)까지 전파된다.
    result["layout_flow"] = enrich_with_component_data(result["layout_flow"], component_data)
    result["_component_summary"] = component_summary
    (out / "final.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # Step 7 — 원문 미러 자동 생성 (AI 서술 제거, 최종 활용 데이터)
    # ★ 컴포넌트-우선(component-first): HTML c-wrapper div 구조를 섹션의 1차 진실로 사용.
    #   이미지↔헤드↔바디가 컴포넌트 div 안에서 이미 한 몸이라 문자열 매칭이 불필요하고,
    #   컬럼 수·정렬·순서(dom_index)도 DOM에서 그대로 온다. 텍스트+이미지가 모두 모인
    #   섹션만 3P 콘텐츠로 노출하고, 한쪽만 있는 섹션은 feature 카드 후보로 분리한다.
    #   컴포넌트 파싱이 빈약한 구형 PDP는 기존 Gemini 기반 to_mirror로 자동 폴백.
    write_progress(96, "7단계: 최종 리테일용 mirror.json 인덱스 및 자석형 레이아웃 바인딩 중...")
    mirror, _cf_used = None, False
    try:
        _cf = build_from_components(component_data, result.get("product_title", ""), _cf_origin)
        _st = _cf.get("_cf_stats", {})
        if _st.get("renderable", 0) >= 3:          # 최소 품질 게이트
            mirror, _cf_used = _cf, True
            print(f"→ [Step7-CF] 컴포넌트-우선 미러: 노출섹션 {_st['renderable']} "
                  f"(결합 {_st.get('stitched', 0)} / 카드후보 {len(_cf.get('_feature_cards', []))} "
                  f"/ 갤러리 {_st.get('gallery_images', 0)}장 / 전체이미지 {_st.get('assets_all', 0)}장)")
        else:
            print(f"→ [Step7-CF] 컴포넌트 근거 부족(노출 {_st.get('renderable', 0)}) → 기존 방식 사용")
    except Exception as _e:
        print(f"→ [Step7-CF] 실패 → 기존 방식 폴백: {str(_e)[:120]}")
    if mirror is None:
        mirror = to_mirror(result, pre_md)
    print(f"→ [Step7] mirror.json 생성 (섹션 {len(mirror['sections'])})")
    _attach_gallery(mirror, datasets["pc"]["html"], _cf_origin)

    # Step 7.5 — mirror 시각 QA: 최종 레이아웃을 PC 스크린샷과 직접 대조하여
    #            화면과 동일해지도록 배치(미디어 이동·섹션 순서)만 교정. 텍스트/URL 불변.
    #            단, 컴포넌트-우선 미러는 DOM 구조가 진실이라 이동 교정이 오히려
    #            정확한 그룹핑을 훼손하므로 스킵한다 (AI 호출도 절감).
    write_progress(98, "7.5단계: 최종 레이아웃을 PC 화면과 대조하는 시각 QA·배치 교정 중...")
    mqa_history = []
    if _cf_used:
        print("   ✓ [Step7.5] 컴포넌트-우선 미러 — DOM 구조가 진실이므로 배치 QA 스킵")
    try:
        if _cf_used:
            raise _CFSkip()
        for loop in range(1, MAX_QA_LOOPS + 1):
            mqa = run_mirror_qa(mirror, tiles["pc"])
            mqa_history.append({"loop": loop, "score": mqa.get("layout_match_score"),
                                "moves": len(mqa.get("moves", [])),
                                "reorder": bool(mqa.get("section_order"))})
            if mqa.get("layout_match_score", 0) >= QA_PASS_SCORE \
                    and not mqa.get("moves") and not mqa.get("section_order"):
                break
            moved = apply_mirror_fixes(mirror, mqa)
            print(f"   ✓ mirror 배치 교정 (loop {loop}): 미디어 {moved}건 이동"
                  f"{' + 섹션 재정렬' if mqa.get('section_order') else ''}")
            if not moved and not mqa.get("section_order"):
                break  # 적용할 게 없으면 종료
        (out / "mirror_qa_report.json").write_text(
            json.dumps({"_history": mqa_history, "last": mqa}, ensure_ascii=False, indent=2),
            encoding="utf-8")
    except _CFSkip:
        pass                      # 컴포넌트-우선 경로 — 의도된 스킵
    except Exception as e:
        print(f"   ⚠️ mirror 시각 QA 건너뜀(오류): {str(e)[:150]}")

    # 컴포넌트-우선 미러는 DOM 구조가 이미 진실이라 아래 재정렬·페어링 보정이 불필요하다
    # (오히려 정확한 그룹핑을 흐트러뜨림). 기존 Gemini 기반 미러일 때만 보정 파이프를 태운다.
    if not _cf_used:
        # 제품 갤러리(PD0012) 상단 보장 — Gemini가 놓쳤으면 HTML 파싱분에서 강제 주입
        if ensure_product_gallery(mirror, component_data, result.get("product_title")):
            print("   ✓ 제품 갤러리(PD0012) 상단 강제 주입 (Gemini 누락 보완)")

        # 교정 후 최종 정렬: md 앵커 재귀속(QA 오이동 복원) → 문서(=화면) 순서 →
        # 같은 컴포넌트 div 이미지+헤드+바디 병합(단일-유닛 한정) → 아이콘 재태깅
        rehome_by_md_anchor(mirror, pre_md)
        order_by_document(mirror, pre_md)
        merge_same_component(mirror)
        _pt = pair_title_image(mirror)  # 타이틀 전용 컴포넌트 ↔ 다음 이미지 섹션 형제 페어링
        if _pt:
            print(f"   ✓ 타이틀-이미지 페어링: {_pt}건 (파편 텍스트 → 진짜 타이틀)")
    _polish_mirror(mirror, datasets["pc"]["html"])

    (out / "mirror.json").write_text(json.dumps(mirror, ensure_ascii=False, indent=2), encoding="utf-8")

    write_progress(100, "분석 완료! 검수용 플레이 패널을 출력합니다.")
    print(f"\n✓ 완료. 산출물: {out}/mirror.json (활용) + final.json / verify_report.json / qa_report.json")


if __name__ == "__main__":
    main()
