# -*- coding: utf-8 -*-
"""
make_mirror.py — final.json → lg.com 미러 데이터 (AI 서술 완전 제거)

layout_flow(나열형)를 "텍스트 + 해당 미디어" 섹션 묶음으로 변환.
남기는 것: lg.com 원문 텍스트, 실제 에셋 URL(PC/모바일 쌍)뿐.
제거하는 것: associated_context 등 AI가 생성한 모든 서술.

사용법: python make_mirror.py <out/slug 디렉토리>  (생략 시 out/ 전체 일괄)
출력:  <slug>/mirror.json
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


import re

# 3P 공통 텍스트 필터 — 이미지 alt 장면 묘사문을 소스(mirror) 단계에서 제거해
# eBay·Amazon 등 모든 소비처에서 묘사문이 카피로 새지 않게 한다.
try:
    from text_filters import strip_descriptions, clean_line, is_image_description
except Exception:   # 모듈 부재 시 무필터 폴백 (파이프라인 중단 방지)
    def strip_descriptions(t):
        return t

    def clean_line(t):
        return (t or "").lstrip("#* ").strip()

    def is_image_description(t):
        return False


def _tokens(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]{3,}", (text or "").lower())}


def _fname_tokens(m: dict) -> set:
    u = m.get("pc_url") or m.get("unified_url") or m.get("mobile_url") or ""
    stem = u.split("/")[-1]
    return {w for w in re.findall(r"[a-z0-9]{3,}", stem.lower())
            if w not in {"jpg", "jpeg", "png", "webp", "mp4", "webm", "gif",
                         "desktop", "mobile", "feature", "features", "key", "2025", "2026",
                         "side", "by", "vs6", "energy", "fridge", "freezers"}}


def to_mirror(final: dict, md: str = None) -> dict:
    # 1) 텍스트 블록 목록 구성 (연속 text는 하나로 묶고, 디스클레이머는 아래로 분리)
    # 블록 구조 확장: component_id, layout_type 등 CCG 정보 포함
    blocks, media_items = [], []          # blocks: {"text":[...], "media":[], "is_disclaimer": bool, "has_heading": bool, "component_id": str, "layout_type": str}
    flow = final.get("layout_flow", [])
    skip = set()                          # 카드 그리드 look-ahead로 이미 소비한 캡션 인덱스
    for idx, s in enumerate(flow):
        if idx in skip:
            continue
        if s["content_type"] == "text":
            t = strip_descriptions((s.get("text_content") or "").strip())  # alt 묘사문 제거
            if not t:
                continue
            
            # 텍스트 내에서 디스클레이머(*, ※, 넘버링)와 일반 마케팅 타이틀/본문 분리 가공
            lines = t.split("\n")
            disclaimer_lines = []
            normal_lines = []
            for line in lines:
                stripped = line.strip()
                if not stripped:
                    continue
                # 디스클레이머 조건: *, ※ 로 시작하거나, 1), 2), 1., 2. 등으로 시작하는 넘버링 문장
                if ((stripped.startswith("*") and not stripped.startswith("**")) or 
                    stripped.startswith("※") or 
                    re.match(r"^\d+\s*[\).]\s*", stripped)):
                    disclaimer_lines.append(stripped)
                else:
                    normal_lines.append(line)
            
            # CCG 컴포넌트 정보 추출
            comp_id = s.get("component_id")
            comp_dom = s.get("component_dom_index", -1)
            layout_type = s.get("layout_type")
            text_align = s.get("text_alignment")
            elem_roles = s.get("element_roles")

            # 디스클레이머만 있다면 -> 무조건 단독 디스클레이머 블록으로 지정 (미디어 바인딩 완전 금지)
            if disclaimer_lines and not normal_lines:
                blocks.append({"text": disclaimer_lines, "media": [], "is_disclaimer": True, "has_heading": False, "_closed": True,
                               "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
                continue

            # 만약 둘 다 있다면 분할배치
            if disclaimer_lines and normal_lines:
                # 1. 디스클레이머 블록 (is_disclaimer=True)
                blocks.append({"text": disclaimer_lines, "media": [], "is_disclaimer": True, "has_heading": False, "_closed": True,
                               "component_id": None, "component_dom_index": -1, "layout_type": None, "text_alignment": None, "element_roles": None})
                # 2. 일반 마케팅 본문 블록 (is_disclaimer=False)
                has_heading = any(line.strip().startswith("##") for line in normal_lines)
                blocks.append({"text": normal_lines, "media": [], "is_disclaimer": False, "has_heading": has_heading, "_closed": False,
                               "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
                continue
                
            # 디스클레이머 없이 일반 텍스트만 있는 경우
            # 개선: 일반 텍스트이더라도 새로운 ##, ### 헤더나 **볼드**로 시작하는 핵심 마케팅 타이틀이라면
            # 이전 텍스트 블록과 강제 격리(_closed = True)하여 개별 독자 섹션으로 분리합니다.
            is_new_section_trigger = (
                t.strip().startswith("##") or 
                t.strip().startswith("###") or 
                t.strip().startswith("**") or
                any(line.strip().startswith("##") or line.strip().startswith("###") for line in lines)
            )

            # ## 헤더로 시작하거나 **로 강조된 볼드 타이틀 모두를 "대표적인 정식 타이틀/헤더"로 판단하여 동등 가중치 보호망을 제공합니다!
            has_heading = (
                t.strip().startswith("##") or 
                t.strip().startswith("###") or 
                t.strip().startswith("**") or 
                any(line.strip().startswith("##") or line.strip().startswith("###") or line.strip().startswith("**") for line in lines)
            )

            if blocks and not blocks[-1]["_closed"] and not blocks[-1].get("is_disclaimer") and not is_new_section_trigger:
                blocks[-1]["text"].append(t)
                if has_heading:
                    blocks[-1]["has_heading"] = True
                # 컴포넌트 정보 병합 (기존에 없으면 새로 추가)
                if comp_id and not blocks[-1].get("component_id"):
                    blocks[-1]["component_id"] = comp_id
                    blocks[-1]["component_dom_index"] = comp_dom
                    blocks[-1]["layout_type"] = layout_type
                    blocks[-1]["text_alignment"] = text_align
                    blocks[-1]["element_roles"] = elem_roles
            else:
                blocks.append({"text": [t], "media": [], "is_disclaimer": False, "has_heading": has_heading, "_closed": False,
                               "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
        else:
            ma = s.get("media_assets") or {}
            m = {k: v for k, v in (("pc_url", ma.get("pc_url", "")),
                                   ("mobile_url", ma.get("mobile_url", "")),
                                   ("unified_url", ma.get("unified_url", ""))) if v}
            if not m:
                continue
            # 가로 병렬 배치 정보 전파 (PC 기준 행당 이미지 수 / 행 그룹)
            if s.get("layout_columns", 1) > 1:
                m["columns"] = s["layout_columns"]
                m["row_group"] = s.get("row_group", 0)
                
            # CCG 컴포넌트 정보 추출 (미디어 섹션용)
            comp_id = s.get("component_id")
            comp_dom = s.get("component_dom_index", -1)
            layout_type = s.get("layout_type")
            text_align = s.get("text_alignment")
            elem_roles = s.get("element_roles")

            # [최고 효율성 보완 - 하이브리드 카드 처리]:
            # 만약 미디어 구역임에도 내부에 텍스트 내용(text_content)이 심어져 전달되었다면,
            # 이는 '아이콘 + 설명 타이틀/본문'이 결합된 독자적인 1개의 하이브리드 가로행 카드/배지 컴포넌트입니다.
            # 이 경우 복잡한 파일명 대조 루프를 생략하고 즉시 해당 텍스트와 이 미디어를 1대1 무결 결합시킵니다.
            t_content = strip_descriptions((s.get("text_content") or "").strip())  # alt 묘사문 제거
            if t_content:
                lines = t_content.split("\n")
                has_heading = t_content.startswith("##") or any(line.strip().startswith("##") for line in lines)

                # 내부 디스클레이머 검수 분리
                disclaimer_lines = []
                normal_lines = []
                for line in lines:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    if ((stripped.startswith("*") and not stripped.startswith("**")) or
                        stripped.startswith("※") or
                        re.match(r"^\d+\s*[\).]\s*", stripped)):
                        disclaimer_lines.append(stripped)
                    else:
                        normal_lines.append(line)

                if disclaimer_lines and not normal_lines:
                    blocks.append({"text": disclaimer_lines, "media": [m], "is_disclaimer": True, "has_heading": False, "_closed": True,
                                   "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
                elif disclaimer_lines and normal_lines:
                    blocks.append({"text": disclaimer_lines, "media": [], "is_disclaimer": True, "has_heading": False, "_closed": True,
                                   "component_id": None, "component_dom_index": -1, "layout_type": None, "text_alignment": None, "element_roles": None})
                    blocks.append({"text": normal_lines, "media": [m], "is_disclaimer": False, "has_heading": has_heading, "_closed": True,
                                   "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
                else:
                    blocks.append({"text": [t_content], "media": [m], "is_disclaimer": False, "has_heading": has_heading, "_closed": True,
                                   "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})

                # 이전 진행 중이던 텍스트 구역의 수렴 종료
                if len(blocks) > 1:
                    blocks[-2]["_closed"] = True
                continue

            # ── 카드 그리드 페어링 (이미지-위 / 캡션-아래) ──────────────────
            # lg.com 수상 배지·특징 카드처럼 미디어 바로 다음 flow 항목이 같은
            # row_group·다열(columns>1) 캡션이면, 그 둘을 1개 카드로 즉시 결합한다.
            # 이 결합을 생략하면 아래 소유 판정의 '앞 블록 +5 가중치'가 캡션을
            # 한 칸씩 밀어 첫 카드는 빈칸, 마지막 캡션은 다음 그룹으로 흘러내린다.
            cols = s.get("layout_columns", 1) or 1
            prev_is_open_caption = (
                idx - 1 >= 0 and (idx - 1) not in skip
                and flow[idx - 1]["content_type"] == "text"
                and (flow[idx - 1].get("text_content") or "").strip()
                and (flow[idx - 1].get("layout_columns", 1) or 1) > 1
                and flow[idx - 1].get("row_group") == s.get("row_group")
            )
            if cols > 1 and not prev_is_open_caption and idx + 1 < len(flow):
                nxt = flow[idx + 1]
                nxt_txt = (nxt.get("text_content") or "").strip()
                if (nxt["content_type"] == "text" and nxt_txt
                        and (nxt.get("layout_columns", 1) or 1) > 1
                        and nxt.get("row_group") == s.get("row_group")):
                    nlines = [ln.strip() for ln in nxt_txt.split("\n") if ln.strip()]
                    is_disc = bool(nlines) and all(
                        (ln.startswith("*") and not ln.startswith("**"))
                        or ln.startswith("※")
                        or re.match(r"^\d+\s*[\).]\s*", ln)
                        for ln in nlines)
                    if not is_disc:
                        has_heading = nxt_txt.startswith("##") or any(
                            l.strip().startswith("##") for l in nxt_txt.split("\n"))
                        if blocks and not blocks[-1]["_closed"]:
                            blocks[-1]["_closed"] = True
                        blocks.append({"text": [nxt_txt], "media": [m],
                                       "is_disclaimer": False,
                                       "has_heading": has_heading, "_closed": True,
                                       "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type,
                                       "text_alignment": text_align, "element_roles": elem_roles})
                        skip.add(idx + 1)
                        continue
            # ── 캡션 없는 순수 미디어 (기존 소유 판정 경로) ───────────────
            if blocks:
                blocks[-1]["_closed"] = True   # 미디어가 끼면 다음 text는 새 블록
            media_items.append({"m": m, "prev_idx": len(blocks) - 1, "component_id": comp_id, "component_dom_index": comp_dom,
                               "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
            if not blocks:
                blocks.append({"text": [], "media": [], "is_disclaimer": False, "has_heading": False, "_closed": True,
                               "component_id": comp_id, "component_dom_index": comp_dom, "layout_type": layout_type, "text_alignment": text_align, "element_roles": elem_roles})
                media_items[-1]["prev_idx"] = 0

    # 2) 각 미디어의 소속 판정 — 'is_disclaimer'가 참인 구역은 무조건 우회하여, ## 타이틀이 있는 구역 우선으로 바인딩
    for it in media_items:
        pi = max(it["prev_idx"], 0)

        # 앞 영역(pi) 탐색: 디스클레이머 구역은 전부 건너뛰기
        while pi >= 0 and blocks[pi].get("is_disclaimer"):
            pi -= 1
        if pi < 0:
            pi = 0

        ni = pi + 1 if pi + 1 < len(blocks) else pi
        # 뒤 영역(ni) 탐색: 디스클레이머 구역은 전부 건너뛰기
        while ni < len(blocks) and blocks[ni].get("is_disclaimer"):
            ni += 1
        if ni >= len(blocks):
            ni = pi

        # 우선순위 부여: 만약 두 영역 중 한 곳만 ## 타이틀 헤더를 가지고 있다면 그곳으로 자동 매칭 자석화!
        pi_has = blocks[pi].get("has_heading", False)
        ni_has = blocks[ni].get("has_heading", False) if ni < len(blocks) else False

        if pi_has and not ni_has:
            owner = pi
        elif ni_has and not pi_has:
            owner = ni
        else:
            # 둘의 타이틀 우선순위 성격이 같으면 파일명 유사도 점수로 판정하되,
            # 상세페이지의 자연스러운 하향 시각 레이아웃 특성 상 바로 위의 앞 텍스트 블록(pi)에 강력한 우선 가중치(+5)를 보장합니다!
            ft = _fname_tokens(it["m"])
            prev_score = len(ft & _tokens(" ".join(blocks[pi]["text"]))) + 5 if not blocks[pi].get("is_disclaimer") else -1
            next_score = len(ft & _tokens(" ".join(blocks[ni]["text"]))) if ni != pi and not blocks[ni].get("is_disclaimer") else -1
            owner = ni if next_score > prev_score else pi
        
        # 최종 백업: 소유 영역이 혹시 디스클레이머라면 비디스클레이머 영역으로 강제 우회
        if blocks[owner].get("is_disclaimer"):
            best_idx, min_dist = owner, len(blocks)
            for i, b in enumerate(blocks):
                if not b.get("is_disclaimer") and abs(i - owner) < min_dist:
                    min_dist = abs(i - owner)
                    best_idx = i
            owner = best_idx
            
        blocks[owner]["media"].append(it["m"])

    # dom_index → DOM 선언 컬럼 수 매핑 (enrich가 flow에 심은 column_count)
    col_by_dom = {}
    for s in final.get("layout_flow", []):
        di, cc = s.get("component_dom_index"), s.get("column_count")
        if di is not None and di >= 0 and cc:
            col_by_dom[di] = cc

    sections = []
    disclaimer_count = 0
    feature_count = 0

    for b in blocks:
        if not (b["text"] or b["media"]):
            continue

        if b.get("is_disclaimer"):
            disclaimer_count += 1
            order_label = f"{disclaimer_count} - disclaimer"
        else:
            feature_count += 1
            order_label = feature_count

        section = {
            "order": order_label,
            "text": "\n".join(b["text"]),
            "media": b["media"]
        }

        # CCG 컴포넌트 정보 추가 (eBay 빌더용 레이아웃 힌트)
        if b.get("component_id"):
            section["component_id"] = b["component_id"]
            section["component_dom_index"] = b.get("component_dom_index", -1)
            section["layout_type"] = b.get("layout_type")
            section["text_alignment"] = b.get("text_alignment")
            section["element_roles"] = b.get("element_roles")
            # DOM 선언 컬럼 수 — 빌더가 이 수만큼 열/모듈을 구성
            cc = col_by_dom.get(b.get("component_dom_index"))
            if cc:
                section["column_count"] = cc

        sections.append(section)

    mirror = {
        "product_title": final.get("product_title", ""),
        "note": "lg.com 원문 미러 — 모든 텍스트/URL은 원본 그대로, AI 생성 서술 없음",
        "sections": sections,
    }

    # CCG 컴포넌트 요약 정보 추가 (eBay 빌더 참조용)
    if final.get("_component_summary"):
        mirror["_component_summary"] = final["_component_summary"]
    if md:
        recover_missing(mirror, md)   # 결정적 누락 복구 (커버리지 100%)
        pair_video_posters(mirror, md)  # 비디오 카드에 인접 jpg 포스터 짝짓기
        order_by_document(mirror, md) # 문서(=화면) 순서로 섹션·미디어 결정적 정렬
        prefer_pc_variant(mirror, md) # 모바일 변형만 있는 미디어 → PC로 승격
    strip_below_fold(mirror)          # 리뷰·추천·FAQ·서포트·푸터 등 하단 위젯 제거
    sanitize_section_text(mirror)     # 마크다운 표·sr-only 설명문·각주·CTA 제거
    dedupe_section_media(mirror)      # 섹션 내 PC/모바일 중복 이미지 → PC만
    dedupe_global_media(mirror)       # 섹션 경계 넘는 동일 이미지 중복 → 1곳만
    tag_media_roles(mirror)           # UI 아이콘/썸네일·svg 태깅 (어댑터 컨텐츠화 방지)
    return mirror


# ── Step 7.5: LLM이 빠뜨린 미디어를 md에서 결정적으로 복구 ──────────────
JUNK = re.compile(r"gnb|promo|deals|banner|membership|favicon|\.svg|[-_]icon[-_]|logo|thum-(165|350)x", re.I)
_norm = lambda u: re.sub(r"[?#].*$", "", u)


def _md_media(md: str) -> dict:
    urls = set(re.findall(r"!\[[^\]]*\]\(([^)\s]+)\)", md))
    urls |= set(re.findall(r"\[(?:PC|MOBILE)_(?:IMAGE|VIDEO): (\S+?)\]", md))
    out = {}
    for u in urls:
        u = _norm(u)
        if "/content/dam/" not in u or JUNK.search(u):
            continue
        # 스템 = 전체 URL에서 디바이스 폴더/변형 접미사만 제거 — 자산별 고유 보장
        # (파일명만 쓰면 렌디션 thum-1600x1062 등이 서로 충돌해 누락됨)
        stem = re.sub(r"/(desktop|mobile)/", "/", u)
        stem = re.sub(r"-(m|d|gb-d|gb-m|gb)(\.\w+)$", r"\2", stem)
        e = out.setdefault(stem, {})
        if re.search(r"-m\.\w+$", u) or "/mobile/" in u:
            e.setdefault("mobile_url", u)
        else:
            e.setdefault("pc_url", u)
    return out


def _best_url(m: dict) -> str:
    return m.get("pc_url") or m.get("unified_url") or m.get("mobile_url") or ""


# UI 보조 에셋(탭 아이콘·캐러셀 썸네일 등) — 닷컴에선 작은 셀렉터로만 쓰이므로
# 3P 매체 어댑터(eBay/Amazon 등)가 본문 컨텐츠로 확대 노출하면 안 됨.
# .svg는 닷컴에서 장식 아이콘(피처 배지 등)으로만 쓰여 컨텐츠 이미지가 아님.
ICON_ASSET = re.compile(r"icon-on|icon-off|[-_]icon[-_]|[-_]ico[-_]|[-_]thumbnail[-_]|[-_](on|off)\.(png|jpe?g)$|\.svg(\?|$)", re.I)


# ── 텍스트 정제: 접근성 이미지 설명문·마크다운 표 잔여 제거 ──────────────
# sr-only/alt 이미지 설명문 (실제 PDP 노출 텍스트 아님) — 시각 서술 시작어 + 서술 동사
_IMG_DESC_START = re.compile(
    r"^(the|this|an?|a)\s+(image|images|animation|animations|scene|photo|photograph|"
    r"graphic|illustration|screenshot|picture|visual|close[- ]?up|split[- ]?screen|"
    r"laptop|person|screen|background|diagram|infographic|render(?:ing)?)\b", re.I)
_IMG_DESC_VERB = re.compile(
    r"\b(show|shows|showing|feature|features|featuring|display|displays|displaying|"
    r"highlight|highlights|highlighting|illustrat\w+|depict\w+|emphasi[sz]\w+|"
    r"showcas\w+|represent\w+|symboli[sz]\w+|portray\w+)\b", re.I)


# 각주 참조 마커 — 본문/제목 끝에 붙는 'eyes7)', '14)', 'Copilot13)' 등
# (디스클레이머 정의문은 별도 제거됨. 여기선 본문 속 위첨자형 참조 기호만 제거)
# 문자/구두점 뒤 1~2자리 숫자+')' → 제거. '(1)' 괄호쌍·'11.1.2 Ch'(공백 앞)는 보존.
_FOOTNOTE_REF = re.compile(r"(?<=[A-Za-z가-힣.,])\d{1,2}\)")


# UI/CTA 노이즈 — 카피가 아닌 네비/버튼 텍스트 (단독 라인 정확일치 시 제거)
_CTA_NOISE = re.compile(
    r"^(learn more|see more|view more|read more|show (more|less)|discover( more)?|"
    r"find out more|explore( more)?|shop now|buy( now)?|order now|add to cart|"
    r"watch( now| the full movie| video)?|play( video)?|pause|previous|next|close|"
    r"tab \d+|slide \d+|더보기|자세히( 보기)?|구매(하기)?|장바구니)\.?$", re.I)


def _clean_text_lines(text: str) -> str:
    """섹션 텍스트 정제:
    (a) 마크다운 표 잔여  (b) sr-only 이미지 설명문  (c) UI/CTA 노이즈
    (d) 미짝 '**' 잔여(탭 라벨 'Time travel**' 등) 정리."""
    out = []
    for raw in (text or "").split("\n"):
        ln = raw.rstrip()
        s = ln.strip()
        if not s:
            out.append(ln)
            continue
        # (a) 마크다운 표: 구분행(|---|)·빈행(| |) 삭제, 단일셀(| 값 |)은 값만
        if re.fullmatch(r"\|?[\s:|-]*\|?", s):        # | | / | --- | / |---|
            continue
        mcell = re.fullmatch(r"\|(.+)\|", s)
        if mcell:
            cell = mcell.group(1).replace("|", " ").strip()
            if cell and not re.fullmatch(r"[\s:-]+", cell):
                out.append(cell)
            continue
        # (b) 접근성 이미지 설명문: 시각 서술 시작 + 서술 동사 + 충분히 긴 문장
        if len(s) >= 40 and _IMG_DESC_START.match(s) and _IMG_DESC_VERB.search(s):
            continue
        # (c) UI/CTA 노이즈 (Learn more, Watch, Next 등) — 단독 라인 제거
        if _CTA_NOISE.match(s):
            continue
        # (d) 미짝 '**'(홀수 개) 잔여 제거 — 'Time travel**' → 'Time travel'
        #     완전한 **bold** 쌍(짝수)은 보존
        if ln.count("**") % 2 == 1:
            ln = ln.replace("**", "")
        # (e) 각주 참조 마커 제거 — 'eyes7)' → 'eyes', '14)' → ''
        ln = _FOOTNOTE_REF.sub("", ln)
        if not ln.strip():
            continue
        out.append(ln)
    # 정제 후 연속 빈 줄 축약
    res = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", res).strip()


def sanitize_section_text(mirror: dict):
    """모든 섹션 텍스트를 정제 (마크다운 표·이미지 설명문·각주·CTA 제거)."""
    for s in mirror["sections"]:
        s["text"] = _clean_text_lines(s.get("text", ""))


def _dedup_stem(u: str) -> str:
    """PC/모바일 변형을 하나로 묶는 스템 — -d/-m 접미사, /desktop//mobile/ 폴더,
    _Desktop/_Mobile, 치수(342x340) 차이를 제거해 동일 이미지 식별."""
    u = re.sub(r"[?#].*$", "", u or "")
    u = re.sub(r"/(desktop|mobile|pc)/", "/", u, flags=re.I)
    fn = u.split("/")[-1]
    fn = re.sub(r"[-_](m|d|gb-d|gb-m|gb|mobile|desktop|mo|pc)(\.\w+)$", r"\2", fn, flags=re.I)
    fn = re.sub(r"[-_](desktop|mobile)", "", fn, flags=re.I)
    fn = re.sub(r"\d{2,4}x\d{2,4}", "", fn)          # 치수 표기 제거
    return fn.lower()


def _is_mobile_url(u: str) -> bool:
    return bool(re.search(r"-m(\.\w+)$|/mobile/|_mobile|318x300", u or "", re.I))


def prefer_pc_variant(mirror: dict, md: str) -> int:
    """모바일 변형만 실린 미디어를 PC(데스크톱) 변형으로 승격.
    (-m→-d, /mobile/→/desktop/ 스왑 후 그 URL이 원문 md에 실재할 때만 적용)"""
    fixed = 0
    for s in mirror["sections"]:
        for mm in s["media"]:
            u = _best_url(mm)
            if not _is_mobile_url(u):
                continue
            pc = re.sub(r"-m(\.\w+)$", r"-d\1", u)
            pc = re.sub(r"/mobile/", "/desktop/", pc, flags=re.I)
            if pc != u and _norm(pc).split("/")[-1] in md:
                mm.setdefault("mobile_url", u)
                mm["pc_url"] = pc
                fixed += 1
    return fixed


def dedupe_section_media(mirror: dict) -> int:
    """섹션 내 PC/모바일 동일 이미지 중복 제거 — PC(데스크톱) 변형만 남긴다.
    (-d.jpg + -m.jpg 가 별도 미디어 객체로 들어와 같은 이미지가 2번 노출되던 문제)"""
    removed = 0
    for s in mirror["sections"]:
        seen, kept = {}, []
        for mm in s["media"]:
            st = _dedup_stem(_best_url(mm))
            if st in seen:
                idx = seen[st]
                # 남아있는 게 모바일이고 새 것이 PC면 PC로 교체
                if _is_mobile_url(_best_url(kept[idx])) and not _is_mobile_url(_best_url(mm)):
                    kept[idx] = mm
                removed += 1
                continue
            seen[st] = len(kept)
            kept.append(mm)
        s["media"] = kept
    return removed


def rehome_by_md_anchor(mirror: dict, md: str) -> int:
    """커스텀 태그([PC_IMAGE: url]) 직전의 캡션 줄을 '정답 주소'로 삼아
    미디어를 캡션이 속한 섹션으로 결정적 재귀속.

    Step7.5 시각 QA(LLM)가 스크린샷에 안 보이는 숨은 캐러셀 카드를
    헤딩 섹션 등으로 잘못 옮기는 확률적 오류를 md 근거로 되돌린다.
    """
    lines = md.split("\n")
    tag_re = re.compile(r"\[(?:PC|MOBILE)_(?:IMAGE|VIDEO): (\S+?)\]")

    def _clean(ln):
        return ln.strip().lstrip("#").strip()

    def _is_break(ln):
        s = ln.strip()
        return (not s) or s.startswith("#") or s.startswith("![") or bool(tag_re.match(s))

    cap, block = {}, {}
    for i, ln in enumerate(lines):
        m = tag_re.match(ln.strip())
        if not m:
            continue
        # 캡션 = 태그 직전의 비어있지 않은 원문 줄
        j = i - 1
        while j >= 0 and (not lines[j].strip() or tag_re.match(lines[j].strip())):
            j -= 1
        if j < 0:
            continue
        c = _clean(lines[j]).lstrip("*").strip()
        if len(c) < 8 or c.startswith("!["):
            continue
        key = _norm(m.group(1))
        cap[key] = c[:60]
        # 캡션 블록(verbatim) = 위로 eyebrow 최대 2줄 + 캡션 + 아래 본문 최대 2줄
        blk, k, took = [], j - 1, 0
        while k >= 0 and took < 2:
            if not lines[k].strip():
                k -= 1
                continue
            # eyebrow/짧은 라벨만 위로 수집 — 긴 줄은 스크린리더용 이미지 설명문
            if _is_break(lines[k]) or len(_clean(lines[k])) > 90:
                break
            blk.insert(0, _clean(lines[k]))
            took += 1
            k -= 1
        blk.append(_clean(lines[j]))
        k, took = i + 1, 0
        while k < len(lines) and took < 2:
            if not lines[k].strip() or tag_re.match(lines[k].strip()):
                k += 1
                continue
            if _is_break(lines[k]):
                break
            blk.append(_clean(lines[k]))
            took += 1
            k += 1
        block[key] = "\n".join(blk)

    moved = created = 0
    for s in list(mirror["sections"]):
        for mm in list(s["media"]):
            key = _norm(_best_url(mm))
            c = cap.get(key)
            if not c or c in s.get("text", ""):
                continue          # 캡션 미상이거나 이미 제 섹션
            tgt = next((t for t in mirror["sections"]
                        if c in t.get("text", "") and not _is_disclaimer_section(t)), None)
            if tgt is None:
                # Gemini가 숨은 캐러셀 캡션 텍스트를 누락한 경우 —
                # md 원문(verbatim) 캡션 블록으로 섹션 신설 후 그 옆에 배치
                tgt = {"order": 0, "text": block.get(key, c), "media": []}
                mirror["sections"].insert(mirror["sections"].index(s) + 1, tgt)
                created += 1
            if tgt is not s:
                s["media"].remove(mm)
                tgt["media"].append(mm)
                moved += 1
    if moved or created:
        renumber(mirror)
        print(f"   ✓ md 앵커 재귀속: 이동 {moved}건 / 캡션 섹션 신설 {created}건 (원문 verbatim)")
    return moved


def pair_video_posters(mirror: dict, md: str) -> int:
    """비디오 미디어에 인접한 정지 이미지(jpg)를 같은 섹션에 짝지어 추가.

    lg.com 비디오 카드에서 Gemini가 mp4만 취하면, 이미지 전용 매체(Amazon A+
    이미지 모듈 등)는 비디오 필터링 후 해당 슬롯이 비게 된다. md에서 비디오
    태그 주변(위 3줄/아래 2줄)의 이미지 URL을 포스터로 결정적 짝짓기.
    """
    lines = md.split("\n")
    vid_re = re.compile(r"\[(?:PC|MOBILE)_VIDEO: (\S+?)\]")
    img_re = re.compile(r"!\[[^\]]*\]\((\S+?)\)|\[(?:PC|MOBILE)_IMAGE: (\S+?)\]")
    poster = {}
    for i, ln in enumerate(lines):
        v = vid_re.search(ln)
        if not v:
            continue
        for j in list(range(i - 1, max(-1, i - 4), -1)) + [i + 1, i + 2]:
            if 0 <= j < len(lines):
                m = img_re.search(lines[j])
                if m:
                    u = m.group(1) or m.group(2)
                    if u and not JUNK.search(u):
                        poster[_norm(v.group(1))] = _norm(u)
                        break
    added = 0
    for s in mirror["sections"]:
        urls_here = {_norm(_best_url(mm)) for mm in s["media"]}
        for mm in list(s["media"]):
            u = _norm(_best_url(mm))
            if not re.search(r"\.(mp4|webm|mov)$", u, re.I):
                continue
            p = poster.get(u)
            if p and p not in urls_here:
                s["media"].insert(s["media"].index(mm),
                                  {"pc_url": p, "poster_of": u})
                urls_here.add(p)
                added += 1
    if added:
        print(f"   ✓ 비디오 포스터 짝짓기: {added}건 (이미지 전용 매체 슬롯 보전)")
    return added


def renumber(mirror: dict):
    """order 라벨을 상단→하단 순으로 재매김 (정수 / 'N - disclaimer')."""
    fc = dc = 0
    for s in mirror["sections"]:
        if _is_disclaimer_section(s):
            dc += 1
            s["order"] = f"{dc} - disclaimer"
        else:
            fc += 1
            s["order"] = fc


def _asset_key(url: str) -> str:
    """LG DAM URL에서 렌디션/사이즈 접미어를 무시한 원본 에셋 파일명 키.
    같은 에셋의 서로 다른 사이즈 변형(180x180 / 1100x730 / 파일명 _180x180 등)이
    하나의 키로 묶이도록 파일명 끝의 크기 토큰(_WxH, -WxH)을 제거한다."""
    m = re.search(r'/([^/]+\.(?:jpg|jpeg|png|webp|gif))', url or "", re.I)
    if not m:
        return (url or "")
    name = m.group(1).lower()
    stem, dot, ext = name.rpartition(".")
    stem = re.sub(r'[._-]\d{2,4}x\d{2,4}$', "", stem)   # 끝의 _180x180 / -350x350 제거
    return f"{stem}.{ext}"


def _img_effective_width(url: str) -> int:
    """URL이 실제로 렌더되는 유효 가로폭 추정 — 큰 값일수록 고해상도.
    ?w=N 다운스케일 파라미터가 있으면 그 값, 없으면 경로/렌디션의 최대 WxH 폭,
    크기 정보가 전혀 없으면 원본으로 간주(매우 큰 값)."""
    if not url:
        return 0
    mw = re.search(r'[?&]w=(\d+)', url)
    if mw:
        return int(mw.group(1))
    widths = [int(w) for w, _ in re.findall(r'(\d{2,4})x(\d{2,4})', url)]
    if widths:
        return max(widths)
    return 100000   # 크기 토큰/쿼리 없음 = 원본 풀사이즈로 간주


def upgrade_media_resolution(mirror: dict, html: str) -> int:
    """mirror의 모든 미디어 URL을, HTML에 실재하는 같은 에셋 변형 중 최고 해상도로 교체.

    LG DAM은 동일 이미지를 180x180/350x350 썸네일과 1100x730/1600x1062 원본 등으로
    함께 노출하는데, 크롤러가 썸네일을 잡는 경우가 있어 갤러리/로고/아이콘이 흐리게 나온다.
    HTML에 이미 존재하는 URL만 사용하므로 업스케일·404 위험이 없다 (쿼리 없는 네이티브 우선)."""
    # HTML의 모든 이미지 URL(렌디션·쿼리 포함 전체) 수집 → 에셋별 최고 해상도 맵 구축
    best = {}
    for u in re.findall(r'https?://[^\s"\'<>)\]]+', html or ""):
        if not re.search(r'\.(?:jpe?g|png|webp|gif)(?:$|[/?])', u, re.I):
            continue
        k = _asset_key(u)
        if k not in best or _img_effective_width(u) > _img_effective_width(best[k]):
            best[k] = u

    upgraded = 0
    for s in mirror.get("sections", []):
        for m in s.get("media", []):
            for key in ("pc_url", "mobile_url", "unified_url"):
                cur = m.get(key)
                if not cur:
                    continue
                cand = best.get(_asset_key(cur))
                if cand and _img_effective_width(cand) > _img_effective_width(cur):
                    m[key] = cand
                    upgraded += 1
    return upgraded


def ensure_product_gallery(mirror: dict, component_data: list, product_title: str = None) -> bool:
    """제품 갤러리(PD0012)를 mirror 상단에 보장.

    LG.com PDP는 제품 갤러리/바이박스가 항상 최상단이다. 그러나 Gemini가 이를
    feature 섹션으로 내보내지 않는 경우가 있어, 그럴 때 HTML 파싱(component_parser)이
    찾은 PD0012 컴포넌트를 상단 섹션으로 강제 주입한다. 이미 PD0012 섹션이 있으면 skip.
    (실제 배치는 이후 order_by_document가 dom_index 기준으로 확정 — PD0012는 문서 최상단
     컴포넌트라 자연히 맨 앞에 온다.)
    """
    if any(s.get("component_id") == "PD0012" for s in mirror.get("sections", [])):
        return False
    pd = next((c for c in (component_data or []) if c.get("component_id") == "PD0012"), None)
    if not pd:
        return False

    seen, media = set(), []
    for m in pd.get("elements", {}).get("media", []):
        url = m.get("src_desktop") or m.get("src_mobile") or ""
        if not url:
            continue
        key = _asset_key(url)
        if key in seen:
            continue
        seen.add(key)
        media.append({"pc_url": url, "mobile_url": m.get("src_mobile", "") or "", "unified_url": ""})
        if len(media) >= 8:   # 대표 갤러리 이미지만 (렌디션 중복 제거 후)
            break

    title = product_title or mirror.get("product_title") or ""
    if not title:
        for t in pd.get("elements", {}).get("texts", []):
            if t.get("role") == "headline" and t.get("text"):
                title = t["text"]
                break

    if not media and not title:
        return False   # 주입할 내용이 없으면 skip

    mirror["sections"].insert(0, {
        "order": 0,
        "text": (f"## {title}".strip() if title else ""),
        "media": media,
        "component_id": "PD0012",
        "component_dom_index": pd.get("dom_index", -1),
        "layout_type": pd.get("layout_type", "product_gallery"),
        "text_alignment": pd.get("text_alignment", "left"),
        "element_roles": None,
    })
    return True


def order_by_document(mirror: dict, md: str):
    """mirror를 실제 문서(=화면) 순서로 결정적 정렬.

    ① 섹션 순서: 매칭된 CCG 컴포넌트의 HTML DOM 등장 순번(component_dom_index)이
       1순위 진실. 타이틀 없는 이미지 카드처럼 텍스트 앵커가 없는 섹션도 DOM 구조
       순서로 정확히 배치된다. DOM 순번이 없는 미매칭 섹션은 preprocessed.md 등장
       위치(md 앵커) 베이스라인에서 직전 매칭 섹션 바로 뒤에 접착한다.
    ② 섹션 내 미디어 순서: 원본(Gemini 배치) 미디어 우선, 복구(recovered)
       미디어는 뒤로 — 복구분이 대표 이미지(hero) 자리를 뺏는 것 방지.
    """
    def media_pos(m):
        fn = _best_url(m).split("/")[-1]
        i = md.find(fn) if fn else -1
        return i if i >= 0 else 10 ** 9

    def text_pos(s):
        # 짧은 eyebrow(예: 'RGB Primary Color Ultra')는 캐러셀 캡션 등으로
        # 문서 앞쪽에 중복 등장할 수 있으므로, 가장 긴(=가장 고유한) 줄로 탐색
        lines = [ln.strip().lstrip("#").strip().lstrip("*").strip()
                 for ln in (s.get("text") or "").split("\n")]
        for t in sorted((t for t in lines if len(t) >= 8), key=len, reverse=True):
            i = md.find(t[:60])
            if i >= 0:
                return i
        return None

    def anchor(g):
        # 섹션 순서 앵커 우선순위: ① 원본(Gemini 배치) 미디어 위치
        # ② 고유 텍스트 위치 ③ 복구 미디어 위치 — 복구분은 숨은 캐러셀 등
        # 문서 앞쪽 위치를 갖는 경우가 많아 최후순위
        orig = [media_pos(m) for s in g for m in s["media"]
                if not m.get("recovered") and media_pos(m) < 10 ** 9]
        if orig:
            return min(orig)
        t = text_pos(g[0])
        if t is not None:
            return t
        rec = [media_pos(m) for s in g for m in s["media"] if media_pos(m) < 10 ** 9]
        return min(rec) if rec else None

    for s in mirror["sections"]:
        s["media"].sort(key=lambda m: (bool(m.get("recovered")), media_pos(m)))

    # 그룹: 정수 섹션 + 바로 뒤따르는 디스클레이머(항상 함께 이동)
    groups, cur = [], None
    for s in mirror["sections"]:
        if _is_disclaimer_section(s) and cur is not None:
            cur.append(s)
        else:
            cur = [s]
            groups.append(cur)
    # 그룹 대표 DOM 순번 — 매칭된 CCG 컴포넌트가 있으면 그 HTML DOM 등장 순번이 진실
    def group_dom(g):
        for s in g:
            di = s.get("component_dom_index", -1)
            if isinstance(di, int) and di >= 0:
                return di
        return None

    # 베이스라인: 기존 md 앵커 순서 (DOM 순번이 없는 미매칭 그룹의 상대 위치 결정용)
    BIG = 10 ** 9
    base_rank = sorted(range(len(groups)),
                       key=lambda i: (anchor(groups[i]) if anchor(groups[i]) is not None else BIG, i))

    # 최종 정렬: ① HTML DOM 순번(component_dom_index) 1순위 — 타이틀 없는 이미지 카드도
    # DOM 구조 순서로 정확히 배치됨. ② 미매칭 그룹은 md 베이스라인상 직전 매칭 그룹
    # 바로 뒤에 접착(헤딩→내용/노이즈 관계 보존). ③ 동순위는 md 상대순서 유지.
    keyed, last_dom = [], -1.0
    for rank, i in enumerate(base_rank):
        dom = group_dom(groups[i])
        if dom is not None:
            key = (float(dom), 0, rank)
            last_dom = float(dom)
        else:
            key = (last_dom, 1, rank)
        keyed.append((key, groups[i]))
    keyed.sort(key=lambda t: t[0])
    mirror["sections"] = [s for _, g in keyed for s in g]
    renumber(mirror)


# 병합 허용 레이아웃 — '이미지+헤드+바디'가 한 컴포넌트 div의 단일 유닛인 타입만.
# grid/carousel/icon_grid/tab/accordion/gallery/spec 등 다-아이템 타입은 병합 금지.
_MERGE_LAYOUTS = {"hero_full_width", "text_over_image", "image_text_left",
                  "image_text_right", "image_text_side", "vertical_stack", "unknown", None}


def merge_same_component(mirror: dict):
    """같은 컴포넌트 div(component_dom_index 동일)에서 이미지/헤드/바디가 여러 섹션으로
    쪼개진 것을 하나로 병합해 섹션 묶음 정확도를 높인다.

    order_by_document 이후 호출 — 동일 dom_index 섹션은 이미 인접해 있다.
    단일-유닛 레이아웃(hero/side/text)만 병합하고, 다-아이템 레이아웃(grid/carousel/
    icon_grid/tab/accordion/gallery)은 개별 아이템을 보존한다. 디스클레이머는 병합 제외.
    """
    def _url(m):
        return m.get("pc_url") or m.get("unified_url") or m.get("mobile_url") or ""

    out = []
    for s in mirror.get("sections", []):
        di = s.get("component_dom_index", -1)
        lt = s.get("layout_type")
        mergeable = (isinstance(di, int) and di >= 0 and lt in _MERGE_LAYOUTS
                     and not _is_disclaimer_section(s))
        if (mergeable and out
                and out[-1].get("component_dom_index") == di
                and out[-1].get("layout_type") in _MERGE_LAYOUTS
                and not _is_disclaimer_section(out[-1])):
            prev = out[-1]
            t1 = (prev.get("text") or "").strip()
            t2 = (s.get("text") or "").strip()
            if not t1:
                prev["text"] = t2
            elif t2 and t2 not in t1:
                prev["text"] = t1 + "\n" + t2
            seen = {_url(m) for m in prev.get("media", [])}
            for m in s.get("media", []):
                if _url(m) not in seen:
                    prev.setdefault("media", []).append(m)
                    seen.add(_url(m))
            continue
        out.append(s)

    mirror["sections"] = out
    renumber(mirror)


def _has_md_heading(t: str) -> bool:
    return any(ln.strip().startswith("##") for ln in (t or "").split("\n"))


def _has_strong_text(t: str) -> bool:
    """실질 헤딩/문장(≥15자, 묘사문 아님)이 있는지 — 파편·라벨·빈칸이면 False."""
    for ln in (t or "").split("\n"):
        c = clean_line(ln)
        if len(c) >= 15 and not is_image_description(c):
            return True
    return False


def pair_title_image(mirror: dict) -> int:
    """LG.com '타이틀 컴포넌트(ST0003, 이미지 없음) + 이미지 컴포넌트(ST0001, 텍스트 없음)'
    형제 구조 복원 — 타이틀 전용 섹션의 실제 카피를 바로 다음 '약한-텍스트 이미지' 섹션에
    결합한다. 이미지에 잘못 붙은 파편('NVMe (Gen', 'N/A', '-')은 진짜 타이틀로 교체.

    order_by_document·merge_same_component 이후(인접 확정) 실행. 보수적 가드:
    타이틀은 heading 보유·이미지 없음, 대상은 이미지 보유·강한 텍스트 없음일 때만 결합.
    """
    secs = mirror.get("sections", [])
    used = [False] * len(secs)
    out = []
    paired = 0
    for i, s in enumerate(secs):
        if used[i]:
            continue
        title_only = (not s.get("media") and _has_md_heading(s.get("text", ""))
                      and _has_strong_text(s.get("text", "")) and not _is_disclaimer_section(s))
        if title_only:
            # 다음 비-디스클레이머 컨텐츠 섹션 탐색 (사이 디스클레이머는 건너뛰되 순서 보존)
            j = i + 1
            while j < len(secs) and _is_disclaimer_section(secs[j]):
                j += 1
            if j < len(secs) and not used[j]:
                nxt = secs[j]
                if nxt.get("media") and not _has_strong_text(nxt.get("text", "")):
                    merged = dict(nxt)
                    merged["text"] = s.get("text", "")            # 진짜 타이틀/본문으로 교체
                    merged["component_id"] = s.get("component_id") or nxt.get("component_id")
                    merged["component_dom_index"] = s.get("component_dom_index", -1) \
                        if s.get("component_dom_index", -1) >= 0 else nxt.get("component_dom_index", -1)
                    used[i] = used[j] = True
                    for k in range(i + 1, j):                     # 사이 디스클레이머 먼저 배치
                        if not used[k]:
                            out.append(secs[k]); used[k] = True
                    out.append(merged)
                    paired += 1
                    continue
        out.append(s); used[i] = True
    mirror["sections"] = out
    renumber(mirror)
    return paired


def sanitize_texts(mirror: dict) -> int:
    """최종 방어 패스 — 모든 섹션 text에서 이미지 alt 묘사문·마크다운 이미지를 제거.

    to_mirror 진입점(strip_descriptions)을 우회하는 경로(rehome_by_md_anchor의 md
    캡션 섹션 신설 등)로 뒤늦게 유입된 묘사문까지 일괄 제거한다. 모든 섹션 조립·병합·
    재귀속이 끝난 뒤(파이프라인 최후반) 1회 호출한다. 텍스트·미디어 모두 빈 섹션은 제거.
    """
    changed = 0
    for s in mirror.get("sections", []):
        t = s.get("text", "") or ""
        if not t:
            continue
        c = strip_descriptions(t)
        if c != t:
            s["text"] = c
            changed += 1
    mirror["sections"] = [s for s in mirror.get("sections", [])
                          if (s.get("text", "").strip() or s.get("media"))]
    renumber(mirror)
    return changed


def _asset_key(u: str) -> str:
    """같은 에셋 판정용 키 — 도메인·쿼리·렌디션 접미(/jcr:content/...)를 뗀 DAM 경로."""
    u = re.sub(r"^https?://[^/]+", "", (u or "").split("?")[0])
    return u.split("/jcr:content")[0].lower()


def ui_control_asset_keys(html: str) -> set:
    """탭 버튼·버튼·앵커(#) 링크 안에서'만' 쓰이는 이미지 에셋 키.

    ST0036 아이콘 탭의 off/on 아이콘, 탭 썸네일처럼 클릭해서 콘텐츠로 이동/전환시키는
    UI 요소다. 같은 에셋이 컨트롤 밖(본문·탭 패널)에도 쓰이면 콘텐츠이므로 제외하지 않는다.
    """
    from bs4 import BeautifulSoup
    from component_parser import ComponentParser
    soup = BeautifulSoup(html or "", "html.parser")
    inside, outside = set(), set()
    for el in soup.find_all(["img", "source"]):
        src = el.get("src") or el.get("data-src") or (el.get("srcset") or "").split(",")[0].strip().split(" ")[0]
        if not src or src.startswith("data:"):
            continue
        (inside if ComponentParser._is_ui_control_media(el) else outside).add(_asset_key(src))
    return inside - outside


def drop_ui_control_media(mirror: dict, html: str) -> int:
    """UI 컨트롤 전용 이미지를 모든 섹션·갤러리에서 제거 (미러 생성 경로와 무관한 최종 방어).
    미디어가 비고 텍스트도 없는 섹션은 함께 제거된다."""
    keys = ui_control_asset_keys(html)
    if not keys:
        return 0
    removed = 0
    for bucket in ("sections", "_feature_cards"):
        for s in mirror.get(bucket, []) or []:
            kept = [m for m in s.get("media", []) if _asset_key(_best_url(m)) not in keys]
            removed += len(s.get("media", [])) - len(kept)
            s["media"] = kept
    for bucket in ("_gallery", "unassigned_media"):
        if mirror.get(bucket):
            before = len(mirror[bucket])
            mirror[bucket] = [m for m in mirror[bucket] if _asset_key(_best_url(m)) not in keys]
            removed += before - len(mirror[bucket])
    mirror["sections"] = [s for s in mirror.get("sections", [])
                          if (s.get("text", "").strip() or s.get("media"))]
    renumber(mirror)
    return removed


def tag_media_roles(mirror: dict):
    """모든 미디어에 role 태그 부여 — 어댑터가 role=='icon'을 컨텐츠화 스킵."""
    for s in mirror["sections"]:
        for m in s["media"]:
            if ICON_ASSET.search(_best_url(m)):
                m["role"] = "icon"
    for m in mirror.get("unassigned_media", []):
        if ICON_ASSET.search(_best_url(m)):
            m["role"] = "icon"


def dedupe_global_media(mirror: dict) -> int:
    """섹션 경계를 넘는 동일 이미지 중복 제거 — 같은 이미지가 인접 두 섹션(제목/본문)에
    걸쳐 카드에 두 번 노출되던 문제. 이미지는 '가장 텍스트가 풍부한 섹션' 한 곳에만 남긴다.
    (같은 스템의 비디오가 있는 섹션이 있으면 그 섹션을 canonical home으로 우선)"""
    homes = {}   # stem(jpg/이미지) -> (우선순위점수, section)
    def _img_stem(u):
        return _dedup_stem(u) if u and not re.search(r"\.(mp4|webm|mov)$", u, re.I) else None
    # canonical home 선정: 같은 스템 비디오 보유 섹션 > 텍스트 긴 섹션
    for s in mirror["sections"]:
        has_vid = {re.sub(r"\.(mp4|webm|mov)$", "", _dedup_stem(_best_url(m)), flags=re.I)
                   for m in s["media"] if re.search(r"\.(mp4|webm|mov)$", _best_url(m), re.I)}
        for m in s["media"]:
            st = _img_stem(_best_url(m))
            if not st:
                continue
            base = re.sub(r"\.\w+$", "", st)
            score = (1 if base in has_vid else 0, len(s.get("text", "")))
            if st not in homes or score > homes[st][0]:
                homes[st] = (score, s)
    removed = 0
    for s in mirror["sections"]:
        kept = []
        for m in s["media"]:
            st = _img_stem(_best_url(m))
            if st and homes.get(st, (None, s))[1] is not s:
                removed += 1
                continue
            kept.append(m)
        s["media"] = kept
    return removed


# 마케팅 컨텐츠 컴포넌트 (제품 피처/스펙) — 이베이·아마존 컨텐츠에 반영 대상
MARKETING_COMPONENTS = {
    "ST0001", "ST0003", "ST0004", "ST0005", "ST0007", "ST0009", "ST0010",
    "ST0013", "ST0014", "ST0016", "ST0027", "ST0036", "ST0038", "ST0048",
    "ST0053", "PD0008",  # PD0008=Spec (노출 컨텐츠)
}
# 비-컨텐츠 위젯 — 리뷰/추천상품/서포트/FAQ/GNB/푸터/개인화 (PDP 하단, 컨텐츠 아님)
NON_CONTENT_COMPONENTS = {
    "PD0002",  # Selective Offering (추천상품)
    "PD0004",  # PDP Reviews (#pdp-review)
    "PD0006",  # Product Service & Support
    "PD0033",  # Functional Tab (스티키 앵커 네비)
    "PD0056",  # (하단 위젯)
    "PN0002",  # Personalization (추천)
    "ST0025",  # FAQ
    "CM0001", "CM0002", "CM0007",  # 공통 크롬 (GNB/푸터/소셜)
}


def strip_below_fold(mirror: dict) -> int:
    """PDP 하단 비-컨텐츠 영역(리뷰·추천상품·FAQ·서포트·푸터)을 제거.
    원칙: 문서 순서상 '마지막 마케팅 컴포넌트' 이후는 전부 하단 위젯으로 간주해 절단
    (추천상품 카드처럼 컴포넌트 매칭이 안 된 섹션도 위치로 함께 제거).
    + 상단/중간에 낀 비-컨텐츠 컴포넌트(GNB·개인화 등)도 개별 제거."""
    secs = mirror["sections"]
    n0 = len(secs)
    last = -1
    for i, s in enumerate(secs):
        if s.get("component_id") in MARKETING_COMPONENTS:
            last = i
    if last >= 0:
        secs = secs[:last + 1]              # 마지막 마케팅 섹션까지만 유지
    secs = [s for s in secs if s.get("component_id") not in NON_CONTENT_COMPONENTS]
    mirror["sections"] = secs
    return n0 - len(secs)


def _is_disclaimer_section(s: dict) -> bool:
    return "disclaimer" in str(s.get("order", "")).lower()


def recover_missing(mirror: dict, md: str):
    have = set()
    for s in mirror["sections"]:
        for m in s["media"]:
            for k in ("pc_url", "mobile_url", "unified_url"):
                if m.get(k):
                    u = _norm(m[k])
                    have |= {u, re.sub(r"-m(\.\w+)$", r"-d\1", u), re.sub(r"-d(\.\w+)$", r"-m\1", u)}
    added, unassigned = 0, []
    for stem, m in _md_media(md).items():
        if any(u in have for u in m.values()):
            continue
        ft = _fname_tokens(m)
        # 복구 이미지의 feature 번호 (같은 그룹 재결합용)
        fnum_match = re.search(r"feature-\d+", _best_url(m))
        fnum = fnum_match.group(0) if fnum_match else None
        best, bs = None, 0
        for s in mirror["sections"]:
            # ① 마케팅 이미지를 디스클레이머(법적 고지) 섹션에 절대 부착 금지
            if _is_disclaimer_section(s):
                continue
            sc = len(ft & _tokens(s["text"]))
            # ② 같은 feature 번호 미디어가 이미 있는 섹션이면 가산점 → 흩어진 카드 재결합
            if fnum and any(fnum in _best_url(mm) for mm in s["media"]):
                sc += 3
            if sc > bs:
                best, bs = s, sc
        m["recovered"] = True                     # 기계 복구분 표시 (검수 대상)
        if best and bs >= 2:                      # 토큰 2개 이상 겹칠 때만 부착 (정밀도 우선)
            best["media"].append(m)
            added += 1
        else:
            unassigned.append(m)
    mirror["recovered_count"] = added
    mirror["unassigned_media"] = unassigned


def run(d: Path):
    fp = d / "final.json"
    if not fp.exists():
        return
    mdfp = d / "preprocessed.md"
    md = mdfp.read_text(encoding="utf-8") if mdfp.exists() else None
    mirror = to_mirror(json.loads(fp.read_text(encoding="utf-8")), md)
    (d / "mirror.json").write_text(json.dumps(mirror, ensure_ascii=False, indent=2), encoding="utf-8")
    n_media = sum(len(s["media"]) for s in mirror["sections"])
    print(f"✓ {d.name[:52]} → mirror.json (섹션 {len(mirror['sections'])} / 미디어 {n_media})")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run(Path(sys.argv[1]))
    else:
        for d in sorted((ROOT / "out").iterdir()):
            if d.is_dir():
                run(d)
