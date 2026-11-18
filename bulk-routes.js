/**
 * bulk-routes.js — Shopee / Lazada 벌크 엑셀 채우기 (2026-11-18)
 *
 * 마켓에서 내려받은 벌크 엑셀(Shopee mass update · Lazada export)을 올리면, 각 행의 SKU(없으면 상품명 안의 모델명)를
 * CLIA 에 크롤된 제품과 연결하고, 사용자가 고른 행의 상품 설명 칸만 CLIA 결과로 바꿔 같은 서식의 엑셀로 돌려준다.
 *   Shopee: 슬라이스 이미지 주소 앞 12장 (한 줄에 하나) — 빌더의 "Copy image URLs" 와 같다
 *   Lazada: PDP 요약 + 이미지 HTML — 빌더의 "Copy image HTML" 과 같다
 * 이미 설명이 있던 칸은 지우고 바꾼다 (화면에 "교체" 로 표시). 고르지 않은 행은 그대로 둔다.
 *
 *   POST /api/v1/bulk/upload?name=<파일명>   (본문 = .xlsx)    → 분석 결과 (아래)
 *   POST /api/v1/bulk/analyze {id, sheet, cols}              → 열을 직접 고른 뒤 다시 분석
 *   POST /api/v1/bulk/build {id, channel, sheet, descCol, items:[{row, slug}]} → {job}
 *   GET  /api/v1/bulk/jobs/:job                               → 진행 상태 · 행별 결과
 *   GET  /api/v1/bulk/jobs/:job/file                          → 채운 엑셀
 *
 * 결과물은 같은 서버의 기존 경로로 만든다 (/api/ebay-generate → /api/v1/slice-html, Lazada 는 /api/v1/pdp-summary 도).
 * 올린 파일·결과 파일은 media-cache/bulk/<id>/ 에 24시간 둔다 (버킷에 올리지 않음).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('./bulk-xlsx');

const DIR = path.join(__dirname, 'media-cache', 'bulk');
const KEEP_MS = 24 * 3600 * 1000;
const SHOPEE_MAX_IMAGES = 12;          // Shopee 상품 설명 이미지 최대 12장 (빌더와 같음)
const CELL_MAX = 32767;                // 엑셀 한 칸 글자 수 한도
// 결과물은 같은 서버에서 만든다. BULK_API_BASE 는 시험용 (다른 CLIA 서버의 생성 API 를 쓸 때)
const LOCAL = () => (process.env.BULK_API_BASE || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');

const idOk = (s) => /^[0-9a-f]{16}$/.test(String(s || ''));
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── 열 찾기: 머리글 몇 줄(내부 키 · 현지어 이름 · 설명)을 합쳐 본다 ──
const HEAD = {
  desc: /product[_\s-]*description|long[_\s-]*description|^\s*description\s*$|รายละเอียดสินค้า|deskripsi\s*produk|mô\s*tả\s*sản\s*phẩm|商品描述/i,
  descNot: /short|highlight|title|name|video|image|ชื่อ/i,
  parentSku: /parent[_\s-]*sku|sku\s*หลัก|sku\s*induk|sku\s*cha|主商品货号/i,
  sku: /seller[_\s-]*sku|sellersku|variation[_\s-]*sku|\bsku\b/i,
  id: /product[_\s-]*id|item[_\s-]*id|รหัสสินค้า|\bspu[_\s-]*id/i,
  idNot: /categor|cat[_\s-]*id|shop|brand|variation|model[_\s-]*id/i,
  name: /product[_\s-]*name|item[_\s-]*name|ชื่อสินค้า|nama\s*produk|tên\s*sản\s*phẩm|商品名称/i,
};
const HEAD_ROWS = 15;

function columnsOf(sheet) {
  const cols = new Map();
  let maxCol = 0;
  for (const [r, cells] of sheet.rows) {
    if (r > HEAD_ROWS) continue;
    for (const [c, v] of cells) {
      maxCol = Math.max(maxCol, c);
      const t = String(v).trim();
      if (!t || t.length > 120) continue;   // 긴 글은 설명 행
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push({ r, t });
    }
  }
  return [...cols.entries()].sort((a, b) => a[0] - b[0])
    .map(([col, hs]) => ({ col, letter: xlsx.colName(col), labels: hs.map((h) => h.t), rows: hs.map((h) => h.r) }));
}

function detect(sheet) {
  const cols = columnsOf(sheet);
  let headEnd = 0;   // 머리글이 끝나는 행 = 머리글 이름이 맞은 칸 가운데 가장 아래 행 (데이터 행은 세지 않는다)
  const pick = (test, not, skip) => {
    for (const c of cols) {
      if (skip && skip.includes(c.col)) continue;
      const i = c.labels.findIndex((l) => test.test(l) && !(not && not.test(l)));
      if (i >= 0) { headEnd = Math.max(headEnd, c.rows[i]); return c.col; }
    }
    return null;
  };
  const found = { desc: pick(HEAD.desc, HEAD.descNot), parentSku: pick(HEAD.parentSku), id: pick(HEAD.id, HEAD.idNot), name: pick(HEAD.name) };
  found.sku = pick(HEAD.sku, HEAD.parentSku, [found.parentSku]);
  // 같은 열의 아래 머리글 행(현지어 이름·필수 표시·설명)까지: 맞은 행 바로 아래의 짧은 글 행들도 머리글로 본다
  const dataStart = (() => {
    const idc = found.id;
    if (!idc) return null;
    const rows = [...sheet.rows.keys()].sort((a, b) => a - b);
    return rows.find((r) => r > headEnd && /^\d{3,}$/.test(String((sheet.rows.get(r) || new Map()).get(idc) || '').trim())) || null;
  })();
  if (dataStart) headEnd = dataStart - 1;
  return { cols, found, headEnd };
}

function channelGuess(fileName, cols) {
  const all = (fileName + ' ' + cols.map((c) => c.labels.join(' ')).join(' ')).toLowerCase();
  if (/shopee|et_title|mass_update|ps_product/.test(all)) return 'shopee';
  if (/lazada|sellersku|lorikeet|catid/.test(all)) return 'lazada';
  return '';
}

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

// ── 분석 ──
function analyze(wb, fileName, { sheet: wantSheet, cols: over } = {}) {
  const idx = productIndex();
  const scored = wb.sheets.map((s) => {
    const d = detect(s);
    const n = [...s.rows.keys()].filter((r) => r > d.headEnd).length;
    return { s, d, score: (d.found.desc ? 1000000 : 0) + (d.found.id || d.found.sku || d.found.parentSku ? 100000 : 0) + n - (s.hidden ? 50000 : 0) };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error('no sheets in the file');
  const chosen = scored.find((x) => x.s.path === wantSheet) || scored[0];
  const { s: sheet, d } = chosen;
  const f = { ...d.found };
  for (const k of ['desc', 'parentSku', 'sku', 'id', 'name']) {
    if (over && k in over) f[k] = over[k] ? +over[k] : null;
  }
  let headEnd = d.headEnd;
  if (over && over.headEnd != null) headEnd = +over.headEnd;

  const rows = [];
  for (const [r, cells] of [...sheet.rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (r <= headEnd) continue;
    const get = (c) => (c ? String(cells.get(c) || '').trim() : '');
    const id = get(f.id), sku = get(f.sku), parentSku = get(f.parentSku), name = get(f.name);
    // 데이터 행: 상품 ID 가 숫자 (ID 열이 없으면 SKU·상품명이 있는 행) — 설명·예시 행을 거른다
    if (f.id ? !/^\d{3,}$/.test(id) : !(sku || parentSku || name)) continue;
    const desc = get(f.desc);
    const m = matchRow({ sku, parentSku, name }, idx);
    rows.push({ row: r, id, sku, parentSku, name: name.slice(0, 200), descLen: desc.length, descHead: desc.slice(0, 160), ...m });
  }
  const used = new Set(rows.flatMap((x) => x.candidates));
  const products = Object.fromEntries([...used].map((k) => [k, idx.products[k]]));
  return {
    fileName, channel: channelGuess(fileName, d.cols),
    sheets: wb.sheets.map((s) => ({ path: s.path, name: s.name, hidden: s.hidden })),
    sheet: sheet.path, headEnd,
    columns: d.cols.map((c) => ({ col: c.col, letter: c.letter, label: c.labels.join(' / ').slice(0, 120) })),
    cols: f, rows, products,
  };
}

// ── 올린 파일 보관 ──
function cleanup() {
  let ents = [];
  try { ents = fs.readdirSync(DIR); } catch (_) { return; }
  for (const n of ents) {
    try { if (Date.now() - fs.statSync(path.join(DIR, n)).mtimeMs > KEEP_MS) fs.rmSync(path.join(DIR, n), { recursive: true, force: true }); } catch (_) {}
  }
}
const cleanName = (s) => String(s || 'bulk.xlsx').replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').slice(0, 150) || 'bulk.xlsx';
function readUpload(id) {
  if (!idOk(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, id, 'meta.json'), 'utf8'));
    return { meta, buf: fs.readFileSync(path.join(DIR, id, 'source.xlsx')) };
  } catch (_) { return null; }
}

// ── 결과물 만들기 (같은 서버의 기존 API) ──
async function post(p, body, timeoutMs) {
  const r = await fetch(LOCAL() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status} ${p}`);
  return j;
}
async function contentFor(channel, url) {
  const listing = channel === 'lazada';   // Lazada HTML 에는 리스팅 문구 카드 (Shopee 는 설명이 이미지 주소뿐)
  const summaryP = channel === 'lazada' ? post('/api/v1/pdp-summary', { url }, 7 * 60 * 1000).catch((e) => ({ error: e.message })) : null;
  const g = await post('/api/ebay-generate', { url, medium: 'shopee_lazada', listing }, 5 * 60 * 1000);
  if (!g.html) throw new Error('generate returned no HTML');
  const sl = await post('/api/v1/slice-html', { html: g.html, medium: 'shopee_lazada' }, 12 * 60 * 1000);
  if (channel === 'shopee') {
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    if (!urls.length) throw new Error('no images');
    return { text: urls.join('\n'), images: urls.length, allImages: sl.count, summaryErr: '' };
  }
  const sm = await summaryP;
  const text = (sm && sm.html ? sm.html + '\n' : '') + sl.html;
  // 요약을 못 만들면 이미지 HTML 만 넣고 행에 표시한다 (빌더의 "Copy image HTML" 과 같은 처리)
  return { text, images: sl.count, allImages: sl.count, summaryErr: sm && sm.error ? sm.error.slice(0, 200) : '' };
}

const jobs = new Map();
function jobView(j) {
  return { id: j.id, status: j.status, error: j.error, channel: j.channel, total: j.items.length,
    done: j.items.filter((x) => x.status === 'ok' || x.status === 'failed').length,
    ok: j.items.filter((x) => x.status === 'ok').length, failed: j.items.filter((x) => x.status === 'failed').length,
    replaced: j.items.filter((x) => x.status === 'ok' && x.prevLen > 0).length,
    items: j.items, file: j.status === 'ready' ? `/api/v1/bulk/jobs/${j.id}/file` : null, fileName: j.outName };
}

async function runJob(j, wb, sheetPath, descCol) {
  const bySlug = new Map();
  const todo = [...new Set(j.items.map((x) => x.slug))];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const slug = todo[next++];
      const its = j.items.filter((x) => x.slug === slug);
      its.forEach((x) => { x.status = 'working'; });
      try {
        const c = await contentFor(j.channel, its[0].url);
        if (c.text.length > CELL_MAX) throw new Error(`too long for one Excel cell (${c.text.length} chars)`);
        bySlug.set(slug, c);
        its.forEach((x) => Object.assign(x, { status: 'ok', images: c.images, allImages: c.allImages, chars: c.text.length, summaryErr: c.summaryErr }));
      } catch (e) {
        its.forEach((x) => Object.assign(x, { status: 'failed', error: String(e.message || e).slice(0, 300) }));
      }
    }
  };
  await Promise.all([worker(), worker()]);
  const sheet = wb.sheets.find((s) => s.path === sheetPath);
  for (const it of j.items) {
    if (it.status !== 'ok') continue;
    it.prevLen = String((sheet.rows.get(it.row) || new Map()).get(descCol) || '').trim().length;
    wb.setCell(sheetPath, it.row, descCol, bySlug.get(it.slug).text);
  }
  if (!j.items.some((x) => x.status === 'ok')) throw new Error('no row could be filled');
  fs.writeFileSync(path.join(DIR, j.upload, `result-${j.id}.xlsx`), await wb.save());
}

const router = express.Router();
const raw = express.raw({ type: () => true, limit: '40mb' });

router.post('/api/v1/bulk/upload', raw, async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'file required (.xlsx body)' });
  const fileName = cleanName(req.query.name);
  try {
    const wb = await xlsx.load(buf);
    const out = analyze(wb, fileName);
    cleanup();
    const id = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.join(DIR, id), { recursive: true });
    fs.writeFileSync(path.join(DIR, id, 'source.xlsx'), buf);
    fs.writeFileSync(path.join(DIR, id, 'meta.json'), JSON.stringify({ fileName, at: Date.now() }));
    console.log(`[bulk] upload ${fileName}: ${out.rows.length} rows, matched ${out.rows.filter((r) => r.candidates.length).length}`);
    res.json({ id, ...out });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/v1/bulk/analyze', async (req, res) => {
  const b = req.body || {};
  const up = readUpload(b.id);
  if (!up) return res.status(404).json({ error: 'upload not found (files are kept 24 hours) — upload again' });
  try {
    const wb = await xlsx.load(up.buf);
    res.json({ id: b.id, ...analyze(wb, up.meta.fileName, { sheet: b.sheet, cols: b.cols }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/v1/bulk/build', async (req, res) => {
  const b = req.body || {};
  const up = readUpload(b.id);
  if (!up) return res.status(404).json({ error: 'upload not found (files are kept 24 hours) — upload again' });
  if (!['shopee', 'lazada'].includes(b.channel)) return res.status(400).json({ error: 'channel must be shopee or lazada' });
  const descCol = parseInt(b.descCol, 10);
  if (!(descCol >= 1 && descCol <= 16384)) return res.status(400).json({ error: 'description column required' });
  const idx = productIndex();
  const seen = new Set();
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const row = parseInt(it.row, 10);
    const p = idx.products[String(it.slug || '')];
    if (!(row >= 1) || !p || seen.has(row)) continue;
    seen.add(row);
    items.push({ row, slug: p.slug, url: p.url, model: p.model, status: 'queued' });
  }
  if (!items.length) return res.status(400).json({ error: 'select at least one matched row' });
  if (items.length > 2000) return res.status(400).json({ error: 'too many rows (max 2000)' });
  let wb;
  try { wb = await xlsx.load(up.buf); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!wb.sheets.some((s) => s.path === b.sheet)) return res.status(400).json({ error: 'sheet not found' });
  const id = crypto.randomBytes(8).toString('hex');
  const base = up.meta.fileName.replace(/\.xlsx$/i, '');
  const j = { id, upload: b.id, channel: b.channel, status: 'running', error: '', items, outName: `${base}-clia-${b.channel}.xlsx`, at: Date.now() };
  jobs.set(id, j);
  for (const [k, x] of jobs) if (Date.now() - x.at > KEEP_MS) jobs.delete(k);
  console.log(`[bulk] build ${j.outName}: ${items.length} rows, ${new Set(items.map((x) => x.slug)).size} products`);
  runJob(j, wb, b.sheet, descCol)
    .then(() => { j.status = 'ready'; console.log(`[bulk] ready ${j.outName}`); })
    .catch((e) => { j.status = 'failed'; j.error = e.message; console.error('[bulk] failed', e.message); });
  res.json(jobView(j));
});

router.get('/api/v1/bulk/jobs/:job', (req, res) => {
  const j = jobs.get(req.params.job);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(jobView(j));
});

router.get('/api/v1/bulk/jobs/:job/file', (req, res) => {
  const j = jobs.get(req.params.job);
  if (!j || j.status !== 'ready') return res.status(404).json({ error: 'file not ready' });
  const fp = path.join(DIR, j.upload, `result-${j.id}.xlsx`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file expired' });
  res.set('Content-Disposition', `attachment; filename="clia-bulk.xlsx"; filename*=UTF-8''${encodeURIComponent(j.outName)}`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').sendFile(fp);
});

module.exports = { router, analyze, matchRow, skuKeys };
