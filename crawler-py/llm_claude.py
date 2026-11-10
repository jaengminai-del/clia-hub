# -*- coding: utf-8 -*-
"""
llm_claude.py — Claude(Anthropic API) 호출 공통 모듈.

pdp_pipeline.py 의 시각 분석 4단계(분석·QA·보정·mirror QA)와 geo_gen.py 가
Gemini 대신 Claude 를 쓰도록 한다. ANTHROPIC_API_KEY 가 있으면 Claude, 없으면 기존 Gemini 경로.

입력: 지시문/텍스트(str)와 스크린샷 타일(Path)을 순서대로 섞은 목록
출력: Pydantic 스키마로 검증된 dict (structured outputs — 응답이 스키마를 벗어날 수 없다)

환경 변수
  ANTHROPIC_API_KEY  필수 (없으면 available() == False)
  CLAUDE_MODEL       기본 claude-opus-5-5
  CLAUDE_EFFORT      기본 medium (low / medium / high / xhigh / max)
"""
import base64
import json
import os
import sys
from pathlib import Path
from typing import List, Optional, Type, Union

from pydantic import BaseModel

CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5"
CLAUDE_EFFORT = os.getenv("CLAUDE_EFFORT", "medium").strip() or "medium"
# 거절(refusal) 시 서버가 같은 요청을 다른 모델로 자동 재시도 — 이 기능을 받는 모델에만 보낸다
# (Haiku 5.5 등은 fallbacks 를 받지 않으므로 보내면 400)
_FALLBACK_BETA = "server-side-fallback-2026-07-01"
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}
# 스트리밍 + 큰 max_tokens: 긴 PDP 의 layout_flow 가 잘리지 않도록 (thinking 토큰 포함)
DEFAULT_MAX_TOKENS = 64000

Part = Union[str, Path]


def available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def _client():
    import anthropic
    # SDK 가 429 / 5xx / 연결 오류를 지수 백오프로 재시도한다
    return anthropic.Anthropic(max_retries=4, timeout=900)


def _image_block(fp: Path) -> dict:
    data = base64.standard_b64encode(Path(fp).read_bytes()).decode("utf-8")
    suffix = Path(fp).suffix.lower()
    media_type = "image/png" if suffix == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}


def _content(parts: List[Part]) -> list:
    blocks = []
    for p in parts:
        if isinstance(p, Path):
            blocks.append(_image_block(p))
        elif p:
            blocks.append({"type": "text", "text": str(p)})
    return blocks


def _log_usage(label: str, msg) -> None:
    u = getattr(msg, "usage", None)
    if not u:
        return
    rec = {
        "label": label,
        "model": getattr(msg, "model", CLAUDE_MODEL),
        "input_tokens": getattr(u, "input_tokens", 0) or 0,
        "output_tokens": getattr(u, "output_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
    }
    # pipeline.log 에 한 줄 — 제품당 비용 추정용
    print(f"   [claude-usage] {json.dumps(rec, ensure_ascii=False)}", flush=True)


def vision_json(parts: List[Part], schema: Type[BaseModel], *, label: str = "",
                system: Optional[str] = None, max_tokens: int = DEFAULT_MAX_TOKENS, model: Optional[str] = None) -> dict:
    """텍스트·이미지 parts → schema 로 검증된 dict. 실패 시 RuntimeError. model: 이 호출만 다른 모델 (기본 CLAUDE_MODEL)"""
    model = model or CLAUDE_MODEL
    kwargs = dict(
        model=model,
        max_tokens=max_tokens,
        output_config={"effort": CLAUDE_EFFORT},
        output_format=schema,
        messages=[{"role": "user", "content": _content(parts)}],
    )
    if system:
        kwargs["system"] = system
    if model in _FALLBACK_MODELS:
        kwargs.update(betas=[_FALLBACK_BETA], fallbacks="default")
    with _client().beta.messages.stream(**kwargs) as stream:
        msg = stream.get_final_message()
    _log_usage(label, msg)

    if msg.stop_reason == "refusal":
        cat = getattr(getattr(msg, "stop_details", None), "category", None)
        raise RuntimeError(f"Claude declined the request ({label}, category={cat})")
    if msg.stop_reason == "max_tokens":
        raise RuntimeError(f"Claude response hit max_tokens ({label}) — output incomplete")
    parsed = msg.parsed_output
    if parsed is None:
        text = next((b.text for b in msg.content if getattr(b, "type", "") == "text"), "")
        return schema.model_validate_json(text).model_dump()
    return parsed.model_dump()


if __name__ == "__main__":
    # 연결 점검: python llm_claude.py
    class _Ping(BaseModel):
        ok: bool
    print(vision_json(["Return ok=true."], _Ping, label="ping", max_tokens=2000), file=sys.stderr)
