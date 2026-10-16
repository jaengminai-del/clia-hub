# -*- coding: utf-8 -*-
"""
modules.py — 선택한 카드 → Amazon A+ 모듈 목록

브라우저 빌더의 pickBestModule · pickBestImage · buildModulesFromKeywords 를 그대로 옮겼다 (2026-10-16, 결과 동일 검증).
모듈 형식도 브라우저와 같다: {type, imageUrl, videoUrl, slotImages, featureCount, textData, fit?, id}
  · 규칙: 기본은 Image Header With Text(970×600). PDP에서 가로로 나란히 3/4장이 확인된 경우만 Three/Four.
  · 수상·인증 배지: 개수로 결정 (1·2개 → Single Left, 3개 → Three, 4개 이상 → Four)
  · 문구는 PDP 원문만 (없으면 빈 칸 — 문구를 만들어 내지 않는다)
"""
from .jsutil import js_or, jslice, jlen, trim, truthy


def pick_best_module(feature: dict, spec: dict) -> str:
    images = feature.get("images") or []
    card_items = feature.get("cardItems")
    if len(images) == 0 and not (card_items and len(card_items)):
        return "text"
    if feature.get("award"):
        n = len(feature.get("badges") or images)
        am = spec["award_modules"]
        return am["four_plus"] if n >= 4 else am["three"] if n == 3 else am["one_or_two"]
    if feature.get("stacked"):
        return spec["default_module"]          # 합친 한 장 → 단일 이미지 헤더 모듈
    per_row = js_or((feature.get("layout") or {}).get("imgsPerRow"), 0)
    if per_row >= 4:
        return spec["row_modules"]["four_plus"]
    if per_row == 3:
        return spec["row_modules"]["three"]
    return spec["default_module"]


def pick_best_image(images: list, module_type: str, spec: dict):
    """모듈 이미지 칸 비율에 가장 가까운 이미지 (비율 정보가 없으면 첫 이미지)."""
    if not images:
        return None
    target = spec["module_ar"].get(module_type) or 1
    cand = [i for i in images if truthy(i.get("url")) and (i.get("ar") or 0) > 0]
    cand.sort(key=lambda i: abs(i["ar"] - target))     # 안정 정렬 (JS Array.sort 와 같음)
    return cand[0] if cand else images[0]


def _empty_text():
    return {"bullets": [], "bulletTitle": "", "subheads": [], "bodies": [], "items": []}


def build_modules(features: list, selection: list, spec: dict, mode: str = "standard", start_id: int = 1) -> list:
    """selection: 선택 순서대로의 카드 번호(features 인덱스). mode: standard | premium."""
    L = spec["text_limits"]
    mods, next_id = [], start_id
    for idx in selection:
        if not (0 <= idx < len(features)):
            continue
        feature = features[idx]
        card_items = feature.get("cardItems")
        fimgs = feature.get("images") or []
        bullets = feature.get("bullets")
        per_row = js_or((feature.get("layout") or {}).get("imgsPerRow"), 0)
        horizontal = per_row == 3 or per_row >= 4

        # 다중 이미지 분할 (가로 행이 아닌 경우 → 이미지별 image-header-text)
        if (not feature.get("award") and not feature.get("stacked") and not horizontal
                and len(fimgs) >= 2 and mode != "premium"):
            for i, img in enumerate(fimgs):
                near, alt = img.get("nearText"), img.get("alt")
                if truthy(near) and jlen(trim(near)) > 2:
                    t = trim(near)
                elif truthy(alt) and jlen(trim(alt)) > 2:
                    t = trim(alt)
                else:
                    t = js_or(feature.get("headline") if i == 0 else js_or(
                        bullets[i] if bullets and i < len(bullets) else None, feature.get("headline")),
                        f"Feature {i + 1}")
                title = jslice(t, L["single_title"])
                if truthy(near) and jlen(trim(near)) > 20 and trim(near) != title:
                    body = trim(near)
                else:
                    body = js_or(feature.get("body"), "") if i == 0 else js_or(
                        bullets[i] if bullets and i < len(bullets) else None, "")
                body = jslice(js_or(body, ""), L["single_body"])
                mods.append({"type": "image-header-text", "imageUrl": img.get("url"), "videoUrl": None,
                             "slotImages": None, "featureCount": 1,
                             "textData": {"headline": js_or(title, feature.get("headline"), "Feature"),
                                          "subheadline": js_or(feature.get("subheadline"), "") if i == 0 else "",
                                          "body": body, **_empty_text()},
                             "id": next_id})
                next_id += 1
            continue

        type_id = pick_best_module(feature, spec)
        best = pick_best_image(fimgs, type_id, spec)
        image_url = best.get("url") if best else None

        # 멀티 이미지 모듈 슬롯 배정 — 고유 이미지가 모자라면 단일 이미지 모듈로 (같은 이미지 반복 방지)
        slot_images = None
        if type_id in ("three-img", "four-text"):
            count = 3 if type_id == "three-img" else 4
            uniq, seen = [], set()
            for i in range(count):
                u = js_or((card_items[i] if card_items and i < len(card_items) else {}).get("imageUrl"),
                          fimgs[i].get("url") if i < len(fimgs) else None)
                if truthy(u) and u not in seen:
                    seen.add(u)
                    uniq.append(u)
            if len(uniq) < count:
                type_id = spec["default_module"]
            else:
                slot_images = {f"s{i + 1}": u for i, u in enumerate(uniq)}

        # Premium 모드: Standard 타입 → Premium 등가 타입
        if mode == "premium":
            ptype = spec["std_to_premium"].get(type_id)
            if ptype:
                type_id = ptype
                if type_id in spec["premium_slot_counts"] and not slot_images:
                    slot_images = {}
                    for i in range(spec["premium_slot_counts"][type_id]):
                        f_img = fimgs[i] if i < len(fimgs) else (fimgs[0] if fimgs else None)
                        slot_images[f"s{i + 1}"] = f_img.get("url") if f_img else image_url
            else:
                type_id, slot_images = "p-text", None

        # 본문: PDP 서브카피(body/bullets)만
        if truthy(feature.get("body")) and jlen(trim(feature["body"])) > 0:
            body_text = trim(feature["body"])
        elif bullets and len(bullets) > 0:
            body_text = " • ".join(bullets[:3])
        else:
            body_text = ""

        def item_title(img, i):
            near, alt = img.get("nearText"), img.get("alt")
            if truthy(near) and jlen(trim(near)) > 2:
                return jslice(trim(near), L["item_title"])
            if truthy(alt) and jlen(trim(alt)) > 2:
                return jslice(trim(alt), L["item_title"])
            if bullets and i < len(bullets) and truthy(bullets[i]):
                return jslice(bullets[i], L["item_title"])
            fb = [feature.get("headline"), js_or(feature.get("subheadline"), feature.get("headline")),
                  js_or(bullets[0] if bullets else None, feature.get("headline"))]
            return jslice(js_or(fb[i] if i < len(fb) else None, feature.get("headline"), f"Feature {i + 1}"),
                          L["item_title"])

        def item_body(img, i):
            near = trim(img.get("nearText") or "")
            if jlen(near) > L["item_body_min"] and near != item_title(img, i):
                return jslice(near, L["item_body"])
            return ""

        # highlights 모듈용 subheads/bodies (bullets → 3칸)
        buls = bullets or []
        subheads, bodies = [], []
        for i in range(3):
            b = buls[i] if i < len(buls) else ""
            b = js_or(b, "")
            dash = b.find(" — ")
            if dash > 0:
                subheads.append(jslice(b[:dash], L["subhead"]))
                bodies.append(jslice(b[dash + 3:], L["highlight_body"]))
            elif jlen(b) > 0 and jlen(b) <= L["highlight_subhead_max"]:
                subheads.append(jslice(b, L["subhead"]))
                bodies.append("")
            else:
                subheads.append("")
                bodies.append(jslice(b, L["highlight_body"]))

        # 카드별 이미지·제목·본문 (cardItems 우선)
        if card_items and len(card_items) >= 2:
            items = []
            for i, card in enumerate(card_items[:4]):
                fi = fimgs[i] if i < len(fimgs) else None
                url = card.get("imageUrl")
                if not truthy(url):
                    url = fi.get("url") if fi and fi.get("url") is not None else ""
                items.append({"imageUrl": url,
                              "title": js_or(card.get("title"), item_title(fi or {}, i)),
                              "body": js_or(card.get("body"), item_body(fi or {}, i))})
        else:
            items = [{"imageUrl": img.get("url"), "title": item_title(img, i), "body": item_body(img, i)}
                     for i, img in enumerate(fimgs[:4])]

        award = feature.get("award")
        text = {}
        if award:
            crops = {}
            for b in feature.get("badges") or []:
                if truthy(b.get("crop")):
                    crops[b["imageUrl"]] = b["crop"]
            text.update({"award": True, "crops": crops})
        text.update({
            "headline": js_or(feature.get("headline"), "") if award else js_or(
                feature.get("headline"), feature.get("subheadline"),
                jslice(js_or(feature.get("body"), ""), L["headline_from_body"]), "Feature Section"),
            "subheadline": js_or(feature.get("subheadline"), ""),
            "body": body_text,
            "bullets": buls,
            "bulletTitle": js_or(feature.get("subheadline"), feature.get("headline"), ""),
            "subheads": subheads, "bodies": bodies, "items": items,
        })
        mod = {"type": type_id, "imageUrl": image_url, "videoUrl": None, "slotImages": slot_images,
               "featureCount": min(js_or(len(bullets or []), 4), 8), "textData": text}
        if award:
            mod["fit"] = "contain"              # 배지: 칸을 채우지 않고 전체가 보이게 (흰 여백)
        mod["id"] = next_id
        next_id += 1
        mods.append(mod)
    return mods
