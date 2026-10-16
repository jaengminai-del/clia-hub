# -*- coding: utf-8 -*-
"""브라우저(JavaScript) 코드와 결과가 한 글자도 다르지 않게 옮기기 위한 도우미.

JS 문자열 길이·자르기는 UTF-16 코드 단위, trim()·\\s 는 JS 공백 정의를 따른다.
"""
import re

# JS String.prototype.trim / 정규식 \s 가 공백으로 보는 문자
WS = "\t\n\u000b\u000c\r    -     　﻿"
_WS_CLASS = f"[{WS}]"
_TRIM_RE = re.compile(f"^{_WS_CLASS}+|{_WS_CLASS}+$")


def trim(s: str) -> str:
    return _TRIM_RE.sub("", s)


def jlen(s: str) -> int:
    """JS s.length (UTF-16 코드 단위 수)."""
    return len(s.encode("utf-16-le")) // 2


def jslice(s: str, n: int) -> str:
    """JS s.slice(0, n)."""
    if len(s) <= n and jlen(s) <= n:
        return s
    b = s.encode("utf-16-le", "surrogatepass")[: n * 2]
    return b.decode("utf-16-le", "surrogatepass")


def truthy(v) -> bool:
    """JS 참/거짓 판정 ('' · 0 · None · False → 거짓, 빈 배열·객체는 참)."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        return v != ""
    return True


def js_or(*vals):
    """JS a || b || c."""
    for v in vals[:-1]:
        if truthy(v):
            return v
    return vals[-1]


def ws(pattern: str) -> str:
    """정규식 문자열의 \\s 를 JS 공백 정의로 바꾼다."""
    return pattern.replace(r"\s", _WS_CLASS)
