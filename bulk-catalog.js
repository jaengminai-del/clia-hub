/**
 * bulk-catalog.js — 벌크 엑셀용 CLIA 제품 목록 · 분류 · SKU 매칭 (2026-11-19, bulk-routes.js 에서 분리)
 *   productIndex()   크롤된 제품 (60초 캐시, 크롤 직후 invalidate())
 *   classifyUrl(url) 아직 크롤하지 않은 LG.com 주소의 제품군·사업부 (주소 경로로 — 크롤 뒤와 같은 규칙)
 *   matchRow(row, idx) 엑셀 행 → 제품 후보
 */
const fs = require('fs');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── CLIA 제품 목록 (허브 목록과 같은 카테고리 규칙) ──
const CAT = [[/tvs?[-_/]|oled|qned|stanbyme|lifestyle-(tvs|screens|ekranlar)/i, 'TV'], [/soundbar|speaker|lautsprecher|audio/i, 'Audio'],
  [/fridge|refrigerator|kuehl/i, 'Fridge'], [/dishwasher/i, 'Dishwasher'], [/wash|laundry|dryer|waesche/i, 'Washer'], [/monitor/i, 'Monitor'],
  [/laptop|gram/i, 'Laptop'], [/microwave|cook|oven/i, 'Cooking'], [/air|puricare|dehumid|condicionado/i, 'Air']];
// 사업부 (허브 목록과 같은 규칙, clia/index.html divOf): 에어 솔루션 = ES, TV·오디오·모니터·노트북 = MS, 나머지 = HS
const DIV_ES = /(^|[^a-z])(aircon|air[-_ ]?condition\w*|air[-_ ]?purif\w*|puricare|dehumid\w*|air[-_ ]?solution\w*|air[-_ ]?care|klima\w*|luftreiniger|luftentfeuchter|condicionado|purificador)([^a-z]|$)/i;
const DIV_MS = /(^|[^a-z])(tvs?|oled|qned|nanocell|stanbyme|lifestyle[-_ ]?(tvs|screens|ekranlar)|audio|soundbars?|sound[-_ ]?suite|speakers?|lautsprecher|xboom|xboombuds|earbuds|kopfhoerer|headphones?|tone[-_ ]?free|monitors?|monitore|laptops?|gram|notebooks?|it[-_ ]?products?|projectors?|beamer|cinebeam)([^a-z]|$)/i;
function divOf(cat, sub, url) {
  const k = [cat, sub, String(url || '').replace(/^https?:\/\/[^/]+/, '')].join(' ');
  if (cat === 'Air' || DIV_ES.test(k)) return 'ES';
  return DIV_MS.test(k) ? 'MS' : 'HS';
}
// 제품군 (허브 목록 2단계 필터와 같은 규칙, clia/index.html grpOf)
function grpOf(p) {
  const k = [p.cat, p.sub, String(p.url || '').replace(/^https?:\/\/[^/]+/, '')].join(' ').toLowerCase();
  if (p.dv === 'ES') {
    if (/dehumid|entfeuchter/.test(k)) return 'Dehumidifier';
    if (/air[-_ ]?condition|aircon|klima|condicionado|split|heat[-_ ]?pump|waermepumpe|heizung/.test(k)) return 'AC';
    if (/purif|puricare|luftreiniger|purificador/.test(k)) return 'Purifier';
    return 'AC';
  }
  if (p.dv === 'MS') {
    if (/monitor/.test(k)) return 'Monitor';
    if (/laptop|gram|notebook/.test(k)) return 'Laptop';
    if (/projector|beamer|cinebeam/.test(k)) return 'Projector';
    if (/audio|soundbar|sound[-_ ]?suite|speaker|lautsprecher|xboom|earbuds|kopfhoerer|headphone|tone[-_ ]?free/.test(k) && !/tvs?[-_ ]?(und|and|&)?[-_ ]?soundbar|tvs?-soundbars/.test(k)) return 'Audio';
    return 'TV';
  }
  if (/styler/.test(k)) return 'Styler';
  if (/dishwasher|geschirr|\bdw\b/.test(k)) return 'Dishwasher';
  if (/vacuum|cordzero|staubsauger/.test(k)) return 'Vacuum';
  if (/micro|mikrowell|cook|oven|backofen|range|hob|kochfeld/.test(k)) return 'Cooking';
  if (/fridge|refrigerator|kuehl|kühl|freezer|kimchi/.test(k)) return 'Fridge';
  const pth = [p.sub, String(p.url || '').replace(/^https?:\/\/[^/]+/, '')].join(' ').toLowerCase();
  if (/dryer|trockner/.test(pth) && !/washtower|waschtrockner|washers?[-_ ]?dryers?|wash[-_ ]?combo|washcombo/.test(pth)) return 'Dryer';
  if (/wash|wasch|waesche|laundry/.test(k)) return 'Washer';
  return 'Other';
}
const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

let _index = null;
const invalidate = () => { _index = null; };
function productIndex() {
  if (_index && Date.now() - _index.at < 60 * 1000) return _index;
  const cr = require('./crawler-routes');
  let dirs = [];
  try { dirs = fs.readdirSync(cr.OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')); } catch (_) {}
  const products = {};
  const byModel = new Map();
  for (const d of dirs) {
    const s = cr.productSummary(d.name);
    if (!s) continue;
    let segs = [];
    try { segs = new URL(s.url).pathname.split('/').filter(Boolean); } catch (_) { continue; }
    const model = (segs[segs.length - 1] || '').replace(/\.html?$/i, '');
    const p = {
      slug: s.slug, url: s.url, country: s.country, title: s.title, thumb: s.thumb, crawled_at: s.crawled_at,
      model: model.toUpperCase(),
      cat: (CAT.find(([r]) => r.test(s.url)) || [0, titleCase(segs[1])])[1],
      sub: titleCase(segs[segs.length - 2] || segs[1]),
    };
    p.dv = divOf(p.cat, p.sub, p.url);
    p.grp = grpOf(p);
    products[p.slug] = p;
    const k = norm(model);
    if (k.length >= 4) { if (!byModel.has(k)) byModel.set(k, []); byModel.get(k).push(p.slug); }
  }
  _index = { at: Date.now(), products, byModel };
  return _index;
}

// SKU → 모델 키 후보: "OLED65G6PSA.ATM" → OLED65G6PSA, 묶음 "A+B" 는 각각
function skuKeys(sku) {
  const out = [];
  for (const part of String(sku || '').split(/\s*[+&,|/]\s*|\s+and\s+/i)) {
    const p = part.trim().toUpperCase();
    if (!p) continue;
    out.push(norm(p.split(/[.\s_]/)[0]), norm(p));
  }
  return [...new Set(out.filter((k) => k.length >= 4))];
}

function matchRow({ sku, parentSku, name }, idx) {
  const parts = [parentSku, sku].filter(Boolean);
  const bundle = parts.some((s) => /[+&]/.test(s));
  const hit = new Set();
  let by = '';
  for (const s of parts) {
    for (const k of skuKeys(s)) {
      if (idx.byModel.has(k)) { idx.byModel.get(k).forEach((x) => hit.add(x)); by = 'sku'; continue; }
      // 끝에 붙은 suffix 를 점 없이 쓴 경우 (OLED65G6PSAATM): 가장 긴 모델명이 앞에 오는 것
      let best = '';
      for (const m of idx.byModel.keys()) if (m.length >= 6 && k.startsWith(m) && k.length - m.length <= 4 && m.length > best.length) best = m;
      if (best) { idx.byModel.get(best).forEach((x) => hit.add(x)); by = 'sku'; }
    }
    if (hit.size) break;   // Parent SKU 로 찾았으면 SKU 는 보지 않는다
  }
  if (!hit.size && name) {
    // 상품명 안의 모델명 ("… รุ่น IAQ13G1")
    for (const tok of String(name).toUpperCase().split(/[^A-Z0-9.\-]+/)) {
      for (const k of [norm(tok.split('.')[0]), norm(tok)]) if (k.length >= 5 && idx.byModel.has(k)) idx.byModel.get(k).forEach((x) => hit.add(x));
    }
    if (hit.size) by = 'name';
  }
  return { candidates: [...hit], by, bundle };
}


// 아직 크롤하지 않은 주소 → 목록에 보일 정보 (모델명·제품군·사업부·나라)
function classifyUrl(url) {
  let segs = [];
  try { segs = new URL(url).pathname.split('/').filter(Boolean); } catch (_) { return null; }
  const model = (segs[segs.length - 1] || '').replace(/\.html?$/i, '');
  const p = { url, model: model.toUpperCase(), site: segs[0] || '', country: String(segs[0] || '').slice(0, 2).toLowerCase(),
    cat: (CAT.find(([r]) => r.test(url)) || [0, titleCase(segs[1])])[1], sub: titleCase(segs[segs.length - 2] || segs[1]) };
  p.dv = divOf(p.cat, p.sub, p.url);
  p.grp = grpOf(p);
  return p;
}

module.exports = { norm, productIndex, invalidate, skuKeys, matchRow, classifyUrl, divOf, grpOf };
