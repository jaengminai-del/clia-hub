# -*- coding: utf-8 -*-
"""
content_gen.amazon — Amazon A+ 1차 컨텐츠 생성 (브라우저 빌더 로직의 Python 이전, 2026-10-16)

  크롤 결과(mirror.json)
     → features.build_features   선택 화면의 카드 목록 (카드 1장 = 모듈 1개)
     → modules.build_modules     선택한 카드 → A+ 모듈 (Standard / Premium)
  규격 값: content_gen/media/amazon_aplus/spec.json
"""
import json
from functools import lru_cache
from pathlib import Path

from .features import build_features
from .modules import build_modules

_SPEC = Path(__file__).resolve().parent.parent / "media" / "amazon_aplus" / "spec.json"


@lru_cache(maxsize=None)
def load_spec() -> dict:
    return json.loads(_SPEC.read_text(encoding="utf-8"))


def features_for(mirror: dict) -> list:
    return build_features(mirror)


def modules_for(mirror: dict, selection: list, mode: str = "standard", start_id: int = 1) -> list:
    return build_modules(build_features(mirror), selection, load_spec(), mode, start_id)
