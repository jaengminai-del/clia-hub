/**
 * edits.js — 빌더 편집본 저장 (2026-11-23)
 *
 * 빌더(Shopee/Lazada)에서 고친 설명 HTML 을 제품(크롤 폴더) + 채널별로 저장한다.
 *   crawler-py/out/<slug>/edit-<channel>.html   편집본 (빌더 결과 HTML 그대로, 스크립트·이벤트 속성은 뺌)
 *   crawler-py/out/<slug>/edit-<channel>.json   { at: 저장 시각, crawledAt: 그때 크롤 시각, sig: 그때 LG.com 내용 지문 }
 * 버킷에도 올린다 (재배포 뒤에도 남게). 벌크 엑셀은 편집본이 있으면 그 HTML 로 채운다 (bulk-jobs.contentFor).
 *
 *   GET    /api/v1/edits?url=&channel=          → { html, at, crawledAt } | 404
 *   PUT    /api/v1/edits  { url, channel, html } → { at }
 *   DELETE /api/v1/edits?url=&channel=          → { ok }   (원본으로)
 *   GET    /api/v1/edits/list?channel=          → { edits: { <slug>: { at, changed } } }
 *   POST   /api/v1/edits/keep { url, channel }  → 편집본 그대로 쓰기 (바뀐 LG.com 내용을 확인함)
 *
 * LG.com 바뀜 (2026-11-23): 편집본은 다시 크롤해도 덮어쓰지 않고 계속 쓰인다 — 그래서 새 크롤 내용이 묻힐 수 있다.
 * 저장할 때 크롤 데이터의 '내용 지문'(제목 · 글 · 스펙 · 이미지 파일)을 함께 두고, 지금 지문과 다르면 changed.
 * 크롤 시각만 바뀌고 내용이 같으면 표시하지 않는다. 사용자가 '새 내용으로 다시 편집'(DELETE) 또는
 * '편집본 그대로 쓰기'(keep — 지문을 지금 것으로)를 고를 때까지 changed 로 남는다.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./crawl-store');

const router = express.Router();
const CHANNELS = new Set(['shopee', 'lazada']);
const MAX_HTML = 4 * 1024 * 1024;
const cr = () => require('./crawler-routes');
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; } };

// 크롤 데이터의 LG.com 내용 지문 — 제목 · 섹션 글 · 스펙 · 이미지 파일 이름 (주소의 크기·쿼리 차이, 사람이 고른 동영상 장면은 빼고)
const imgKey = (u) => String(u || '').split('?')[0].replace(/\/jcr:content\/.*$/, '').split('/').pop().toLowerCase().replace(/[._-]\d{2,4}x\d{2,4}/g, '');
const normTx = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function contentSig(dir) {
  const m = readJson(path.join(dir, 'mirror.json'));
  if (!m) return '';
  const media = (x) => imgKey(x.poster_original || x.pc_url || x.unified_url || x.mobile_url);
  const body = {
    t: normTx(m.product_title),
    s: (m.sections || []).map((s) => [s.component_id || '', normTx(s.text), normTx(s.group_heading),
      (s.specs || []).map((x) => [normTx(x.label), normTx(x.value)]), (s.media || []).map(media)]),
    g: (m._gallery || []).map(media),
  };
  return require('crypto').createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}
const changedOf = (dir, meta) => !!(meta && meta.sig && meta.sig !== contentSig(dir));

// LG.com 제품 주소 → 크롤 폴더 (크롤한 제품만)
function productDir(url) {
  if (!/^https:\/\/www\.lg\.com\/[a-z]{2}(?:_[a-z]{2})?\/\S+$/i.test(String(url || ''))) return null;
  const dir = path.join(cr().OUT_DIR, cr().slugify(url));
  return fs.existsSync(path.join(dir, 'mirror.json')) ? dir : null;
}
const files = (dir, ch) => ({ html: path.join(dir, `edit-${ch}.html`), meta: path.join(dir, `edit-${ch}.json`) });

// 빌더 미리보기에 다시 넣는 HTML 이라 실행되는 것은 뺀다 (스크립트 · iframe · on* 속성 · javascript: 주소)
function clean(html) {
  return String(html)
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+contenteditable(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

/** 벌크 · 빌더 공용: 그 제품·채널의 편집본 (없으면 null) */
function getEdit(slugOrDir, channel) {
  if (!CHANNELS.has(channel)) return null;
  const dir = path.isAbsolute(slugOrDir) ? slugOrDir : path.join(cr().OUT_DIR, path.basename(String(slugOrDir || '')));
  const f = files(dir, channel);
  if (!fs.existsSync(f.html)) return null;
  const meta = readJson(f.meta) || {};
  const src = readJson(path.join(dir, 'source.json')) || {};
  return { html: fs.readFileSync(f.html, 'utf8'), ...meta, changed: changedOf(dir, meta), crawledAtNow: src.crawled_at ? Math.round(src.crawled_at * 1000) : 0 };
}

/** 채널의 편집본이 있는 제품 목록 { slug: { at, changed } } */
function listEdits(channel) {
  const out = {};
  if (!CHANNELS.has(channel)) return out;
  let names = [];
  try { names = fs.readdirSync(cr().OUT_DIR); } catch (_) { return out; }
  for (const slug of names) {
    const dir = path.join(cr().OUT_DIR, slug), f = files(dir, channel);
    if (!fs.existsSync(f.html)) continue;
    const meta = readJson(f.meta) || {};
    out[slug] = { at: meta.at || 0, changed: changedOf(dir, meta) };
  }
  return out;
}

function args(req) {
  const q = { ...req.query, ...(req.body || {}) };
  const channel = String(q.channel || '');
  if (!CHANNELS.has(channel)) return { error: 'channel must be shopee or lazada', status: 400 };
  const dir = productDir(q.url);
  if (!dir) return { error: 'product not crawled (LG.com product URL required)', status: 404 };
  return { channel, dir, f: files(dir, channel) };
}

router.get('/api/v1/edits/list', (req, res) => res.json({ edits: listEdits(String(req.query.channel || '')) }));

router.get('/api/v1/edits', (req, res) => {
  const a = args(req);
  if (a.error) return res.status(a.status).json({ error: a.error });
  const e = getEdit(a.dir, a.channel);
  if (!e) return res.status(404).json({ error: 'no saved edit', code: 'none' });
  res.json(e);
});

router.put('/api/v1/edits', async (req, res) => {
  const a = args(req);
  if (a.error) return res.status(a.status).json({ error: a.error });
  const html = clean((req.body || {}).html || '');
  if (!html.trim()) return res.status(400).json({ error: 'html required' });
  if (html.length > MAX_HTML) return res.status(413).json({ error: 'edit too large' });
  const src = readJson(path.join(a.dir, 'source.json')) || {};
  const meta = { at: Date.now(), crawledAt: src.crawled_at ? Math.round(src.crawled_at * 1000) : 0, sig: contentSig(a.dir) };
  fs.writeFileSync(a.f.html, html);
  fs.writeFileSync(a.f.meta, JSON.stringify(meta));
  await store.pushPaths([a.f.html, a.f.meta]).catch(() => {});
  console.log(`[edits] saved ${path.basename(a.dir)} ${a.channel} (${html.length} chars)`);
  res.json({ ...meta, changed: false });
});

// 편집본 그대로 쓰기 — 바뀐 LG.com 내용을 확인했으니 지문을 지금 것으로 (다음에 또 바뀌면 다시 표시)
router.post('/api/v1/edits/keep', async (req, res) => {
  const a = args(req);
  if (a.error) return res.status(a.status).json({ error: a.error });
  const meta = readJson(a.f.meta);
  if (!meta || !fs.existsSync(a.f.html)) return res.status(404).json({ error: 'no saved edit', code: 'none' });
  Object.assign(meta, { sig: contentSig(a.dir), keptAt: Date.now() });
  fs.writeFileSync(a.f.meta, JSON.stringify(meta));
  await store.pushPaths([a.f.meta]).catch(() => {});
  res.json({ ...meta, changed: false });
});

router.delete('/api/v1/edits', async (req, res) => {
  const a = args(req);
  if (a.error) return res.status(a.status).json({ error: a.error });
  for (const fp of [a.f.html, a.f.meta]) fs.rmSync(fp, { force: true });
  await store.removePaths([a.f.html, a.f.meta]).catch(() => {});
  console.log(`[edits] removed ${path.basename(a.dir)} ${a.channel}`);
  res.json({ ok: true });
});

module.exports = { router, getEdit, listEdits, clean, contentSig };
