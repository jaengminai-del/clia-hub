/**
 * bulk-routes.js — Shopee / Lazada 벌크 엑셀 채우기 (2026-11-18)
 *
 * 마켓에서 내려받은 벌크 엑셀(Shopee mass update · Lazada export)을 올리면, 각 행의 SKU(없으면 상품명 안의 모델명)를
 * CLIA 에 크롤된 제품과 연결하고, 사용자가 고른 행의 상품 설명 칸만 CLIA 결과로 바꿔 같은 서식의 엑셀로 돌려준다.
 *   Shopee: 슬라이스 이미지 주소 앞 12장 (한 줄에 하나) — 빌더의 "Copy image URLs" 와 같다
 *   Lazada: PDP 요약 + 이미지 HTML — 빌더의 "Copy image HTML" 과 같다
 * 이미 설명이 있던 칸은 지우고 바꾼다 (화면에 "교체" 로 표시). 고르지 않은 행은 그대로 둔다.
 *
 *   POST /api/v1/bulk/upload?name=<파일명>&country=<cc> (본문 = .xlsx) → 분석 (CLIA 에 없는 행은 같은 나라 LG.com 주소 lg)
 *   POST /api/v1/bulk/analyze {id, sheet, cols, country}     → 열을 직접 고른 뒤 다시 분석
 *   POST /api/v1/bulk/jobs/:job/notify {email, lang} → 끝나면 메일 (완성된 엑셀 첨부)
 *   POST /api/v1/bulk/build {id, channel, sheet, descCol, country, lang, notify:{email},
 *                            items:[{row, slug} | {row, url, register:true, alts, fuzzy} | {row, slug, force:true}]} → 작업
 *   GET  /api/v1/bulk/jobs/:job · /api/v1/bulk/jobs/:job/file · /api/v1/bulk/config
 *   GET  /api/v1/bulk/frames?slug= · POST /api/v1/bulk/frame {slug, video, src}   (자동 동영상 장면 확인·바꾸기)
 * 실행·보관·알림: bulk-jobs.js / 제품 목록·매칭: bulk-catalog.js / LG.com 주소: bulk-sitemap.js
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('./bulk-xlsx');
const { productIndex, matchRow, skuKeys, classifyUrl, norm } = require('./bulk-catalog');
const sitemap = require('./bulk-sitemap');
const bulkJobs = require('./bulk-jobs');

const cleanName = (s) => String(s || 'bulk.xlsx').replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').slice(0, 150) || 'bulk.xlsx';

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
      // Shopee 내부 키(et_title_product_description 등)의 'title' 은 이름 칸 표시가 아니므로 빼고 본다
      const i = c.labels.findIndex((l) => test.test(l) && !(not && not.test(l.replace(/^et_title_/i, ''))));
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
    // 마켓 벌크 엑셀처럼 보이는지 (설명·상품 ID·SKU 열 가운데 하나라도 찾았는지) — 아니면 화면이 "마켓 파일이 아님" 안내
    looksLikeMarket: !!(f.desc || f.id || f.parentSku || f.sku),
    columns: d.cols.map((c) => ({ col: c.col, letter: c.letter, label: c.labels.join(' / ').slice(0, 120) })),
    cols: f, rows, products,
  };
}

// CLIA 에 없는 행(같은 나라 기준) → 같은 나라 LG.com 사이트맵에서 주소 찾기. 일괄 등록(크롤) 후보가 된다
async function addLgUrls(out, country) {
  const cc = String(country || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return out;
  // 사이트 경로: 이미 매칭된 같은 나라 제품의 주소에서 (sa → sa_en 같은 경우), 없으면 나라 코드
  let site = cc;
  for (const p of Object.values(out.products)) {
    if (p && p.country === cc) { try { site = new URL(p.url).pathname.split('/').filter(Boolean)[0] || cc; } catch (_) {} break; }
  }
  if (!sitemap.siteOk(site)) return out;
  out.site = site;
  const todo = out.rows.filter((r) => !r.bundle && !r.candidates.some((s) => out.products[s] && out.products[s].country === cc));
  if (!todo.length) return out;
  try { await sitemap.index(site); } catch (e) { out.siteError = e.message; return out; }
  for (const r of todo) {
    const keys = [...skuKeys(r.parentSku), ...skuKeys(r.sku)];
    // SKU 가 없으면 상품명 안의 모델명처럼 생긴 낱말 (글자+숫자 5자 이상)
    if (!keys.length) for (const tok of String(r.name).toUpperCase().split(/[^A-Z0-9.\-]+/)) { const k = norm(tok.split('.')[0]); if (k.length >= 5 && /\d/.test(k) && /[A-Z]/.test(k)) keys.push(k); }
    const hit = keys.length ? await sitemap.lookup(site, [...new Set(keys)]) : null;
    r.lg = hit ? { ...hit, ...classifyUrl(hit.url) } : null;
  }
  return out;
}

const router = express.Router();
const MAX_MB = 40;
const rawBody = express.raw({ type: () => true, limit: MAX_MB + 'mb' });
// 큰 파일은 express 기본 처리(HTML 오류) 대신 화면이 알아듣는 JSON 으로
const raw = (req, res, next) => rawBody(req, res, (err) => (err
  ? res.status(err.status === 413 ? 413 : 400).json({ error: err.message, code: err.status === 413 ? 'too_big' : 'bad_upload', maxMb: MAX_MB })
  : next()));
// .xlsx 로 못 읽은 이유 — 화면이 사용자 언어로 안내한다
function fileProblem(buf, fileName) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xD0CF11E0) return 'xls_or_locked';   // 예전 .xls 또는 비밀번호 건 엑셀 (OLE 파일)
  const head = buf.subarray(0, 4096);
  const isText = !head.some((b) => b < 9 || (b > 13 && b < 32));
  if (/\.(csv|tsv|txt)$/i.test(fileName) || (isText && /[,;\t]/.test(head.toString('latin1')) && head.includes(0x0A))) return 'csv';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B) return 'broken';
  return 'not_xlsx';
}

router.post('/api/v1/bulk/upload', raw, async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'file required (.xlsx body)' });
  const fileName = cleanName(req.query.name);
  let wb;
  try { wb = await xlsx.load(buf); }
  catch (e) { return res.status(400).json({ error: e.message, code: fileProblem(buf, fileName) }); }
  try {
    const out = await addLgUrls(analyze(wb, fileName), req.query.country);
    const id = crypto.randomBytes(8).toString('hex');
    await bulkJobs.saveUpload(id, buf, { fileName, at: Date.now() });
    console.log(`[bulk] upload ${fileName}: ${out.rows.length} rows, matched ${out.rows.filter((r) => r.candidates.length).length}, LG.com found ${out.rows.filter((r) => r.lg).length}`);
    res.json({ id, ...out });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/v1/bulk/analyze', async (req, res) => {
  const b = req.body || {};
  const up = await bulkJobs.readUpload(b.id);
  if (!up) return res.status(404).json({ error: 'upload not found — upload again' });
  try {
    const wb = await xlsx.load(up.buf);
    res.json({ id: b.id, ...(await addLgUrls(analyze(wb, up.meta.fileName, { sheet: b.sheet, cols: b.cols }), b.country)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 같은 나라 LG.com 제품 주소만 등록(크롤) 대상으로 받는다
function lgUrlOk(u, country) {
  try {
    const x = new URL(String(u));
    const site = x.pathname.split('/').filter(Boolean)[0] || '';
    return x.protocol === 'https:' && x.hostname === 'www.lg.com' && x.pathname.split('/').filter(Boolean).length >= 3
      && /^[a-z]{2}(_[a-z]{2})?$/.test(site) && (!country || site.slice(0, 2) === country);
  } catch (_) { return false; }
}

router.post('/api/v1/bulk/build', async (req, res) => {
  const b = req.body || {};
  const up = await bulkJobs.readUpload(b.id);
  if (!up) return res.status(404).json({ error: 'upload not found — upload again' });
  if (!['shopee', 'lazada'].includes(b.channel)) return res.status(400).json({ error: 'channel must be shopee or lazada' });
  const descCol = parseInt(b.descCol, 10);
  if (!(descCol >= 1 && descCol <= 16384)) return res.status(400).json({ error: 'description column required' });
  const country = /^[a-z]{2}$/.test(b.country || '') ? b.country : '';
  const idx = productIndex();
  const cr = require('./crawler-routes');
  const seen = new Set();
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const row = parseInt(it.row, 10);
    if (!(row >= 1) || seen.has(row)) continue;
    const p = idx.products[String(it.slug || '')];
    if (p && !it.register) {
      items.push({ row, slug: p.slug, url: p.url, model: p.model, force: !!it.force, status: 'queued' });
    } else if (it.register && lgUrlOk(it.url, country)) {
      const c = classifyUrl(it.url) || {};
      items.push({ row, url: it.url, slug: cr.slugify(it.url), model: c.model, register: true, force: !!it.force,
        alts: Math.max(0, parseInt(it.alts, 10) || 0), fuzzy: !!it.fuzzy, status: 'queued' });
    } else continue;
    seen.add(row);
  }
  if (!items.length) return res.status(400).json({ error: 'select at least one product' });
  if (items.length > 2000) return res.status(400).json({ error: 'too many rows (max 2000)' });
  // 크롤 비용·시간: 한 번에 새로 등록(크롤)하는 제품은 300개까지
  const MAX_REG = Math.max(1, parseInt(process.env.BULK_MAX_REGISTER, 10) || 300);
  if (items.filter((x) => x.register || x.force).length > MAX_REG) return res.status(400).json({ error: `too many products to register at once (max ${MAX_REG})`, code: 'too_many_register', max: MAX_REG });
  const wb = await xlsx.load(up.buf).catch(() => null);
  if (!wb || !wb.sheets.some((s) => s.path === b.sheet)) return res.status(400).json({ error: 'sheet not found' });
  const email = b.notify && b.notify.email ? String(b.notify.email).trim() : '';
  if (email && !bulkJobs.emailOk(email)) return res.status(400).json({ error: 'email address not allowed', code: 'bad_email' });
  const base = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  const j = bulkJobs.create({ upload: b.id, channel: b.channel, sheet: b.sheet, descCol, items, base,
    outName: `${up.meta.fileName.replace(/\.xlsx$/i, '')}-clia-${b.channel}.xlsx`,
    notify: email && bulkJobs.mailReady() ? { email } : null, lang: /^[a-z]{2}$/.test(b.lang || '') ? b.lang : 'en' });
  console.log(`[bulk] build ${j.outName}: ${items.length} rows, register ${items.filter((x) => x.register).length}`);
  res.json(bulkJobs.jobView(j));
});

// 직접 넣은 LG.com 주소 확인 (같은 나라 제품 주소만) → 목록에 보일 정보
router.get('/api/v1/bulk/classify', (req, res) => {
  const url = String(req.query.url || '').trim();
  const country = /^[a-z]{2}$/.test(req.query.country || '') ? req.query.country : '';
  if (!lgUrlOk(url, country)) return res.status(400).json({ error: 'LG.com product URL of the same country required', code: 'bad_url' });
  res.json(classifyUrl(url));
});

router.get('/api/v1/bulk/config', (req, res) => res.json({ mail: bulkJobs.mailReady(), crawlConc: bulkJobs.CRAWL_CONC, secPerCrawl: 55, secPerItem: 15 }));

router.get('/api/v1/bulk/jobs/:job', async (req, res) => {
  const j = await bulkJobs.getJob(req.params.job);
  if (!j) return res.status(404).json({ error: 'job not found' });
  // 재배포 직후 제품 데이터를 버킷에서 받는 동안(약 1분)은 끝난 작업의 '확인 필요'를 지금 규칙으로 셀 수 없다 — 받을 때까지 기다린다
  if (j.status !== 'running' && j.status !== 'queued') await require('./crawl-store').whenPulled(75 * 1000);
  res.json(bulkJobs.jobView(j));
});

// 중단 (실수로 내보내기를 눌렀을 때) — 진행 중일 때만
router.post('/api/v1/bulk/jobs/:job/cancel', async (req, res) => {
  const j = await bulkJobs.getJob(req.params.job);
  if (!j) return res.status(404).json({ error: 'job not found' });
  if (!(await bulkJobs.cancel(j))) return res.status(409).json({ error: 'job is not running', code: 'not_running', job: bulkJobs.jobView(j) });
  res.json(bulkJobs.jobView(j));
});

// 내보내기 팝업: "완료되면 메일로 알려 드릴까요?" → 메일 주소 저장 (완성된 엑셀을 첨부해 보낸다)
router.post('/api/v1/bulk/jobs/:job/notify', async (req, res) => {
  const j = await bulkJobs.getJob(req.params.job);
  if (!j) return res.status(404).json({ error: 'job not found' });
  if (!bulkJobs.mailReady()) return res.status(503).json({ error: 'mail is not set up', code: 'no_mail' });
  const email = String((req.body || {}).email || '').trim();
  if (!bulkJobs.emailOk(email)) return res.status(400).json({ error: 'email address not allowed', code: 'bad_email' });
  const lang = /^[a-z]{2}$/.test((req.body || {}).lang || '') ? req.body.lang : j.lang;
  try { await bulkJobs.setNotify(j, email, lang); } catch (e) { return res.status(502).json({ error: e.message, code: 'mail_failed' }); }
  console.log(`[bulk] notify set ${j.id} (${j.status})`);
  res.json(bulkJobs.jobView(j));
});

router.get('/api/v1/bulk/jobs/:job/file', async (req, res) => {
  const j = await bulkJobs.getJob(req.params.job);
  if (!j || j.status !== 'ready') return res.status(404).json({ error: 'file not ready' });
  const fp = path.join(bulkJobs.DIR, j.upload, `result-${j.id}.xlsx`);
  if (!fs.existsSync(fp)) {   // 재배포 뒤: 버킷에서
    const buf = await require('./crawl-store').getBuffer(`bulk/${j.upload}/result-${j.id}.xlsx`);
    if (!buf) return res.status(404).json({ error: 'file expired' });
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, buf);
  }
  res.set('Content-Disposition', `attachment; filename="clia-bulk.xlsx"; filename*=UTF-8''${encodeURIComponent(j.outName)}`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').sendFile(fp);
});

// 자동으로 고른 동영상 대표 장면: 후보 보기 · 고르기 (고른 장면은 제품 데이터에 저장 → 다음 내보내기부터 반영)
router.get('/api/v1/bulk/frames', (req, res) => {
  const slug = path.basename(String(req.query.slug || ''));
  if (!slug) return res.status(400).json({ error: 'slug required' });
  res.json({ slug, videos: bulkJobs.framesOf(slug) });
});
router.post('/api/v1/bulk/frame', async (req, res) => {
  const { slug, video, src } = req.body || {};
  try { res.json({ slug, videos: await bulkJobs.saveFrame(String(slug || ''), String(video || ''), String(src || '')) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = { router, analyze, matchRow, skuKeys, addLgUrls };
