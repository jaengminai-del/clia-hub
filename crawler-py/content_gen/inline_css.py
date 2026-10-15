# -*- coding: utf-8 -*-
"""
inline_css.py — <style> 규칙을 각 요소의 style 속성으로 옮긴다 (eBay·Lazada 설명란 대비)

마켓 편집기가 <style> 블록을 지워도 미리보기와 같게 보이도록, 스타일시트의 선언을 해당 요소의
인라인 style 앞쪽에 넣는다. 우선순위: 스타일시트(구체성·순서대로) < 원래 인라인 style.
@media 등 인라인으로 옮길 수 없는 규칙은 건너뛴다(<style> 블록에는 그대로 남는다).
"""
import re

from bs4 import BeautifulSoup


def _rules(css: str) -> list:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", "", css)   # @media·@font-face 블록 제외
    out = []
    for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        decls = "; ".join(d.strip() for d in body.split(";") if d.strip())
        for s in sel.split(","):
            s = s.strip()
            if s and decls:
                out.append((s, decls))
    return out


def _specificity(sel: str) -> tuple:
    ids = sel.count("#")
    classes = len(re.findall(r"\.[\w-]+", sel))
    tags = len([t for t in re.split(r"[\s>+~]+", sel) if t and not t.startswith((".", "#"))])
    return ids, classes, tags


def inline(html: str, css: str) -> str:
    """html 안의 요소에 css 규칙을 인라인으로 적용한 html (style 블록은 건드리지 않음)."""
    soup = BeautifulSoup(html, "html.parser")
    applied = {}                              # id(el) → [(spec, order, decls)]
    els = {}
    for order, (sel, decls) in enumerate(_rules(css)):
        try:
            matched = soup.select(sel)
        except Exception:
            continue
        for el in matched:
            applied.setdefault(id(el), []).append((_specificity(sel), order, decls))
            els[id(el)] = el
    for k, el in els.items():
        sheet = "; ".join(d for _, _, d in sorted(applied[k], key=lambda x: (x[0], x[1])))
        own = (el.get("style") or "").strip().rstrip(";")
        el["style"] = f"{sheet}; {own}" if own else sheet
    return str(soup)


def font_face_css(faces: list, base_url: str) -> str:
    """@font-face 블록 (woff2 우선, ttf 폴백). faces: [{family, weight, file}] — file 은 확장자 없는 이름."""
    base = base_url.rstrip("/") + "/"
    return "\n".join(
        f"@font-face {{ font-family: '{f['family']}'; font-weight: {f['weight']}; font-style: normal; font-display: swap; "
        f"src: url('{base}{f['file']}.woff2') format('woff2'), url('{base}{f['file']}.ttf') format('truetype'); }}"
        for f in faces)
