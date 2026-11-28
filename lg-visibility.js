/**
 * lg-visibility.js — lg.com 화면에 기능 섹션이 없는 제품 (2026-11-25 사용자 결정)
 *
 * 예전 형식 lg.com PDP 는 기능 섹션이 HTML 컴포넌트가 아니라 페이지 안 데이터(AEM · Next.js)에만 있고, 보통은 브라우저가 그 데이터로
 * 화면에 그린다 (크롤러 aem_model.py — 그 데이터를 읽어 CLIA 내용을 만든다). 그런데 TH 243개 제품은 데이터만 있고 lg.com 이 화면에
 * 그리지 않는다 → 고객은 lg.com 에서 기능 섹션을 볼 수 없는데 CLIA 만 상세 내용을 만들었다.
 *
 * 판단: 페이지 데이터(AEM:)에서 온 섹션의 이미지가 lg.com 캡처(이미지 위치 기록)에 거의(10% 미만) 보이지 않으면 「lg.com 에 없음」.
 * 처리: 그 섹션들을 mirror.json 의 _lg_hidden 으로 옮긴다 (지우지 않음 — restore 로 되돌릴 수 있음). 스펙 등 lg.com 이 보여 주는 것은 그대로.
 *       빌더 · 벌크 엑셀 · 검토 화면은 mirror.json 을 읽으므로 모두 lg.com 처럼 스펙만.
 */
const fs = require('fs');
const path = require('path');

const MIN_MEDIA = 3;          // 이보다 이미지가 적으면 판단하지 않는다
const VISIBLE_MAX = 0.1;      // 보이는 비율이 이보다 낮으면 「lg.com 에 없음」

const stem = (u) => String(u || '').split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop().toLowerCase()
  .replace(/[-_](d|m|pc|mo|mob|mobile|desktop)(?=\.[a-z0-9]+$)/, '');
const isAem = (s) => String((s && s.component_id) || '').startsWith('AEM:');
const mediaOf = (s) => (s.media || []).map((m) => stem(m.pc_url || m.unified_url || m.mobile_url)).filter(Boolean);

function visibleStems(boxes) {
  const out = new Set();
  for (const b of (boxes && boxes.items) || []) {
    if (!b.vis) continue;
    for (const u of String(b.srcs || '').match(/[^\s,]+?\.(?:jpe?g|png|webp|gif|avif|mp4|webm)/gi) || []) out.add(stem(u));
  }
  return out;
}

/** → null (판단할 것 없음) | { aem, media, visible, hide } */
function check(mirror, boxes) {
  const aem = ((mirror && mirror.sections) || []).filter(isAem);
  const media = [...new Set(aem.flatMap(mediaOf))];
  if (!aem.length || media.length < MIN_MEDIA || !boxes || !Array.isArray(boxes.items)) return null;
  const vis = visibleStems(boxes);
  const visible = media.filter((m) => vis.has(m)).length;
  return { aem: aem.length, media: media.length, visible, hide: visible / media.length < VISIBLE_MAX };
}

/** 판단해서 숨긴다 → 숨겼으면 결과, 아니면 null. dir = crawler-py/out/<slug> */
function applyTo(dir, boxes) {
  const fp = path.join(dir, 'mirror.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; }
  if (m._lg_hidden) return null;
  const c = check(m, boxes);
  if (!c || !c.hide) return null;
  // 숨기면 남는 섹션이 없으면 숨기지 않는다 (2026-11-28) — 빈 PDP 는 만들 수 없어서 벌크 Check 가 '준비 못 함'으로 실패하고
  //   다시 크롤로 살아나도 다음 검토 준비가 또 숨겼다 (운영 T2310NBTB: 기능 섹션 4개 숨김 · 남은 것 0개)
  if (!m.sections.some((s) => !isAem(s))) return null;
  const hidden = m.sections.filter(isAem);
  m.sections = m.sections.filter((s) => !isAem(s));
  m._lg_hidden = { at: Date.now(), reason: 'lg.com 화면에 기능 섹션이 없음 (페이지 데이터에만 있음) — lg.com 처럼 스펙만', visible: `${c.visible}/${c.media}`, sections: hidden };
  fs.writeFileSync(fp, JSON.stringify(m, null, 2));
  return { ...c, kept: m.sections.length };
}

/** 다 숨겨서 빈 PDP 가 된 제품을 되돌린다 (위 규칙 전에 숨긴 것) → 되돌렸으면 true */
function heal(dir) {
  const fp = path.join(dir, 'mirror.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return false; }
  return !!m._lg_hidden && !(m.sections || []).length && restore(dir);
}

/** 되돌리기 (lg.com 이 페이지를 고쳤거나 그래도 쓰기로 했을 때) */
function restore(dir) {
  const fp = path.join(dir, 'mirror.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return false; }
  if (!m._lg_hidden) return false;
  const back = m._lg_hidden.sections || [];
  m.sections = [...back, ...(m.sections || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  delete m._lg_hidden;
  fs.writeFileSync(fp, JSON.stringify(m, null, 2));
  return true;
}

module.exports = { check, applyTo, restore, heal, stem };
