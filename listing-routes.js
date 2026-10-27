/**
 * listing-routes.js — 제품별 "리스팅 문구" 저장·버전 관리 (2026-10-26)
 *
 * 문구 5종: promotion(맨 위) · details · delivery · aftercare · returns(맨 아래) — eBay·Lazada HTML 에 자동 부착,
 * Shopee 는 설명란 텍스트 복사. 제품당 1세트(세 마켓 공통), 템플릿은 법인 + 제품군 단위.
 * 저장: 버킷 listing-texts/ (+ 로컬 data/listing-texts 캐시). 버전은 쌓이고, 사용자가 직접 지울 때만 삭제.
 *
 *   GET  /api/v1/listing?url=                    → { record, current }         (제품 문구 · 현재 버전)
 *   POST /api/v1/listing {url, corp, category, title, fields, titles, note, by, from}  → 새 버전
 *   POST /api/v1/listing/pin {url, v|null}       → 특정 버전 고정 (null = 최신 버전 사용)
 *   POST /api/v1/listing/delete {url, v}         → 버전 삭제 (고정된 버전이면 최신 버전 사용으로 돌아감)
 *   GET  /api/v1/listing/draft?url=              → { details } 제품 상세 초안 (LG.com 원문)
 *   GET  /api/v1/listing/text?url=               → Shopee 설명란용 일반 텍스트
 *   GET  /api/v1/listing/index?corp=             → 문구가 저장된 제품 목록 (다른 제품에서 가져오기)
 *   GET  /api/v1/listing-templates?corp=         → 템플릿 목록
 *   GET  /api/v1/listing-template?corp=&category=  → 템플릿 (버전 포함)
 *   POST /api/v1/listing-template {corp, category, fields, titles, note, by, from} → 새 버전
 *
 * currentFor(url) — 1차 컨텐츠 생성이 붙일 현재 문구 {fields, titles} (없으면 null)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./crawl-store');

const DIR = path.join(__dirname, 'data', 'listing-texts');
const FIELDS = ['promotion', 'details', 'delivery', 'aftercare', 'returns'];
const CRAWLER_DIR = path.join(__dirname, 'crawler-py');
const slugify = (url) => String(url).trim().replace(/https?:\/\//, '').replace(/[^\p{L}\p{N}_]+/gu, '-').replace(/-+$/, '');
const catKey = (c) => String(c || 'general').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'general';
const corpOk = (c) => /^[a-z_]{2,8}$/.test(c || '');

async function readJson(key) {
  const abs = path.join(DIR, key);
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) {}
  const buf = await store.getBuffer(`listing-texts/${key}`);
  if (!buf) return null;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
}
async function writeJson(key, obj) {
  const abs = path.join(DIR, key);
  const buf = Buffer.from(JSON.stringify(obj, null, 1));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  await store.putBuffer(`listing-texts/${key}`, buf, 'application/json').catch((e) => console.warn('[listing] 버킷 저장 실패', key, e.message));
}

const clean = (fields) => Object.fromEntries(FIELDS.map((k) => [k, String((fields || {})[k] || '').slice(0, 20000)]));
const cleanTitles = (t) => Object.fromEntries(FIELDS.map((k) => [k, String((t || {})[k] || '').slice(0, 120)]).filter(([, v]) => v));
const current = (rec) => (rec && rec.versions && rec.versions.length)
  ? (rec.versions.find((v) => v.v === rec.pinned) || rec.versions[rec.versions.length - 1]) : null;

function addVersion(rec, body) {
  // 지운 번호는 다시 쓰지 않는다 (maxV = 지금까지 발급한 가장 큰 번호)
  const v = Math.max(rec.maxV || 0, rec.versions.length ? rec.versions[rec.versions.length - 1].v : 0) + 1;
  rec.maxV = v;
  rec.versions.push({ v, at: new Date().toISOString(), by: String(body.by || '').slice(0, 40), note: String(body.note || '').slice(0, 200),
                      from: body.from ? String(body.from).slice(0, 200) : undefined, fields: clean(body.fields), titles: cleanTitles(body.titles) });
  return v;
}

async function currentFor(url) {
  if (!url) return null;
  const rec = await readJson(`products/${slugify(url)}.json`);
  const cur = current(rec);
  if (!cur || !FIELDS.some((k) => (cur.fields[k] || '').trim())) return null;
  return { fields: cur.fields, titles: cur.titles || {}, v: cur.v };
}

function plainText(listing) {
  const T = { promotion: 'Promotion Details', details: 'Product Details', delivery: 'Delivery & Installation Notice',
              aftercare: 'After Care Service Information', returns: 'Terms & Conditions for Return Policy' };
  const titles = { ...T, ...Object.fromEntries(Object.entries((listing && listing.titles) || {}).filter(([, v]) => v)) };
  const parts = FIELDS.filter((k) => ((listing && listing.fields[k]) || '').trim()).map((k) => `${titles[k]}:\n\n${listing.fields[k].trim()}`);
  return parts.length ? parts.join('\n\n\n\n') + '\n' : '';
}

const router = express.Router();

router.get('/api/v1/listing', async (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ error: 'url required' });
  const rec = await readJson(`products/${slugify(req.query.url)}.json`);
  res.json({ record: rec, current: current(rec) });
});

router.post('/api/v1/listing', async (req, res) => {
  const b = req.body || {};
  if (typeof b.url !== 'string' || !b.url) return res.status(400).json({ error: 'url required' });
  const slug = slugify(b.url);
  const rec = (await readJson(`products/${slug}.json`)) || { kind: 'product', slug, url: b.url, versions: [], pinned: null };
  Object.assign(rec, { corp: b.corp || rec.corp || '', category: b.category || rec.category || '', title: b.title || rec.title || '' });
  const v = addVersion(rec, b);
  await writeJson(`products/${slug}.json`, rec);
  const idx = (await readJson(`index-${rec.corp || 'all'}.json`)) || {};
  idx[slug] = { url: rec.url, title: rec.title, category: rec.category, v, at: rec.versions[rec.versions.length - 1].at };
  await writeJson(`index-${rec.corp || 'all'}.json`, idx);
  res.json({ ok: true, v, record: rec, current: current(rec) });
});

router.post('/api/v1/listing/pin', async (req, res) => {
  const { url, v = null } = req.body || {};
  const slug = slugify(url || '');
  const rec = await readJson(`products/${slug}.json`);
  if (!rec) return res.status(404).json({ error: 'no listing' });
  rec.pinned = v == null ? null : Number(v);
  await writeJson(`products/${slug}.json`, rec);
  res.json({ ok: true, record: rec, current: current(rec) });
});

router.post('/api/v1/listing/delete', async (req, res) => {
  const { url, v } = req.body || {};
  const slug = slugify(url || '');
  const rec = await readJson(`products/${slug}.json`);
  if (!rec) return res.status(404).json({ error: 'no listing' });
  const i = rec.versions.findIndex((x) => x.v === Number(v));
  if (i < 0) return res.status(404).json({ error: 'no such version' });
  rec.maxV = Math.max(rec.maxV || 0, ...rec.versions.map((x) => x.v));
  rec.versions.splice(i, 1);
  if (rec.pinned === Number(v)) rec.pinned = null;
  await writeJson(`products/${slug}.json`, rec);
  // 다른 제품에서 가져오기 목록: 남은 최신 버전으로 갱신, 다 지웠으면 빼기
  const idxKey = `index-${rec.corp || 'all'}.json`;
  const idx = (await readJson(idxKey)) || {};
  const last = rec.versions[rec.versions.length - 1];
  if (last) idx[slug] = { url: rec.url, title: rec.title, category: rec.category, v: last.v, at: last.at };
  else delete idx[slug];
  await writeJson(idxKey, idx);
  res.json({ ok: true, record: rec, current: current(rec) });
});

router.get('/api/v1/listing/draft', (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ error: 'url required' });
  const out = path.join(CRAWLER_DIR, 'out', slugify(req.query.url));
  if (!fs.existsSync(path.join(out, 'mirror.json'))) return res.status(404).json({ error: 'mirror not ready — crawl first' });
  const venv = path.join(CRAWLER_DIR, '.venv', 'bin', 'python');
  const py = process.env.CRAWLER_PYTHON || (fs.existsSync(venv) ? venv : 'python3');
  execFile(py, ['listing_draft.py', out], { cwd: CRAWLER_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) return res.status(500).json({ error: String(stderr || err.message).slice(0, 300) });
      try { res.json(JSON.parse(stdout)); } catch (e) { res.status(500).json({ error: 'bad draft output' }); }
    });
});

router.get('/api/v1/listing/text', async (req, res) => {
  const cur = await currentFor(req.query.url);
  res.json({ text: cur ? plainText(cur) : '', v: cur ? cur.v : null });
});

router.get('/api/v1/listing/index', async (req, res) => {
  const corp = corpOk(req.query.corp) ? req.query.corp : 'all';
  res.json((await readJson(`index-${corp}.json`)) || {});
});

router.get('/api/v1/listing-templates', async (req, res) => {
  if (!corpOk(req.query.corp)) return res.status(400).json({ error: 'corp required' });
  res.json((await readJson(`templates/${req.query.corp}/index.json`)) || {});
});

router.get('/api/v1/listing-template', async (req, res) => {
  if (!corpOk(req.query.corp)) return res.status(400).json({ error: 'corp required' });
  const rec = await readJson(`templates/${req.query.corp}/${catKey(req.query.category)}.json`);
  res.json({ record: rec, current: current(rec) });
});

router.post('/api/v1/listing-template', async (req, res) => {
  const b = req.body || {};
  if (!corpOk(b.corp)) return res.status(400).json({ error: 'corp required' });
  const key = catKey(b.category);
  const rec = (await readJson(`templates/${b.corp}/${key}.json`)) || { kind: 'template', corp: b.corp, category: b.category || 'General', versions: [], pinned: null };
  const v = addVersion(rec, b);
  await writeJson(`templates/${b.corp}/${key}.json`, rec);
  const idx = (await readJson(`templates/${b.corp}/index.json`)) || {};
  idx[key] = { category: rec.category, v, at: rec.versions[rec.versions.length - 1].at };
  await writeJson(`templates/${b.corp}/index.json`, idx);
  res.json({ ok: true, v, record: rec, current: current(rec) });
});

module.exports = { router, currentFor, plainText, slugify };
