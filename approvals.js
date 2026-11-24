/**
 * approvals.js — Shopee/Lazada PDP 검토·승인 상태 (2026-11-24)
 *
 * 제품마다 crawler-py/out/<slug>/approval.json 에 마지막 결정을 둔다 (버킷에도 — crawl-store 가 out/ 전체를 동기화).
 *   { state: 'approved' | 'rejected', by, at, via: 'checklist' | 'bulk', comment, crawled_at }
 * 상태(status)
 *   pending   — 결정 없음 (승인 전)
 *   approved  — 승인됨
 *   rejected  — 반려
 *   stale     — 승인 뒤 다시 크롤했거나 빌더 편집본을 새로 저장해 내용이 바뀜 → 승인 전으로 본다
 *   승인 기록에는 그때 본 슬라이스 묶음 해시(hashes: { shopee, lazada })도 남긴다 (검토·승인 화면 /review/)
 *
 * 다운로드 잠금은 서버 설정 APPROVAL_GATE=1 일 때만 켜진다 (기본 꺼짐).
 *   검토·승인 화면이 운영에 생기기 전에 켜면 모든 다운로드가 막히기 때문 — 화면이 생긴 뒤 켠다.
 *   꺼져 있어도 빌더·벌크 화면은 상태 배지를 보여 준다.
 *
 *   GET  /api/v1/approvals?url=<LG.com 주소> | ?slugs=a,b   → { gate, items: { <slug>: { status, ... } } }
 *   POST /api/v1/approvals/:slug   { state: 'approved'|'rejected'|'pending', by?, via?, comment?, hashes?: { shopee, lazada } }
 *   POST /api/v1/approvals         { slugs: [...], state, by?, via?, comment?, hashes?: { <slug>: { shopee, lazada } } }   (목록 화면 「선택 승인」)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cr = require('./crawler-routes');

const router = express.Router();
const STATES = new Set(['approved', 'rejected']);
const gateOn = () => process.env.APPROVAL_GATE === '1';
const cleanSlug = (s) => path.basename(String(s || ''));
const fileOf = (slug) => path.join(cr.OUT_DIR, cleanSlug(slug), 'approval.json');

function read(slug) {
  try { return JSON.parse(fs.readFileSync(fileOf(slug), 'utf8')); } catch (_) { return null; }
}

/** 제품 하나의 승인 상태. 승인 뒤 다시 크롤했으면(crawled_at 이 늘었으면) stale. */
function status(slug) {
  const a = read(slug);
  if (!a || !STATES.has(a.state)) return { status: 'pending' };
  const sum = cr.productSummary(cleanSlug(slug));
  const now = sum && sum.crawled_at ? Number(sum.crawled_at) : 0;
  if (a.state === 'approved' && a.crawled_at && now > Number(a.crawled_at) + 1) return { ...a, status: 'stale', why: 'recrawled' };
  if (a.state === 'approved') {   // 승인 뒤 빌더에서 편집본을 새로 저장함 (edit-<채널>.json at 은 ms)
    for (const ch of ['shopee', 'lazada']) {
      let e = null;
      try { e = JSON.parse(fs.readFileSync(path.join(cr.OUT_DIR, cleanSlug(slug), `edit-${ch}.json`), 'utf8')); } catch (_) {}
      if (e && Number(e.at) / 1000 > Number(a.at) + 1) return { ...a, status: 'stale', why: 'edited' };
    }
  }
  return { ...a, status: a.state };
}
const isApproved = (slug) => status(slug).status === 'approved';

const cleanHashes = (h) => Object.fromEntries(['shopee', 'lazada'].filter((ch) => h && /^[0-9a-f]{20}$/.test(h[ch] || '')).map((ch) => [ch, h[ch]]));
function write(slug, { state, by = '', via = '', comment = '', hashes = null }) {
  const s = cleanSlug(slug);
  if (!s || s.startsWith('_') || !fs.existsSync(path.join(cr.OUT_DIR, s, 'mirror.json'))) return null;
  const fp = fileOf(s);
  if (state === 'pending') { try { fs.unlinkSync(fp); } catch (_) {} return { status: 'pending' }; }
  const sum = cr.productSummary(s);
  const rec = { state, by: String(by).slice(0, 120), at: Date.now() / 1000, via: String(via).slice(0, 20),
    comment: String(comment).slice(0, 2000), crawled_at: sum && sum.crawled_at ? Number(sum.crawled_at) : 0, hashes: cleanHashes(hashes) };
  fs.writeFileSync(fp, JSON.stringify(rec, null, 1));
  require('./crawl-store').pushPaths([fp]).catch((e) => console.warn('[approvals] 버킷 업로드 실패', e.message));
  return status(s);
}

/** 벌크 엑셀 작업의 행들 중 승인 안 된 제품 (묶음 상품은 구성품 모두) → [{ slug, model, status }] */
function pendingOf(items) {
  const out = new Map();
  for (const it of items || []) {
    if (it.status !== 'ok') continue;
    const slugs = it.bundle && it.bundle.length ? it.bundle.map((x) => x.slug) : [it.slug];
    for (const s of slugs) {
      if (!s || out.has(s)) continue;
      const st = status(s).status;
      if (st !== 'approved') out.set(s, { slug: s, model: it.model || '', status: st });
    }
  }
  return [...out.values()];
}

router.get('/api/v1/approvals', (req, res) => {
  let slugs = String(req.query.slugs || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2000);
  if (req.query.url) slugs = [cr.slugify(String(req.query.url))];
  const items = {};
  for (const s of slugs) items[cleanSlug(s)] = status(s);
  res.json({ gate: gateOn(), items });
});

function post(req, res, slugs) {
  const b = req.body || {};
  const state = b.state === 'pending' ? 'pending' : STATES.has(b.state) ? b.state : null;
  if (!state) return res.status(400).json({ error: "state must be 'approved', 'rejected' or 'pending'" });
  if (state === 'rejected' && !String(b.comment || '').trim()) return res.status(400).json({ error: 'comment required to reject' });
  const items = {}, missing = [];
  for (const s of slugs) {
    const r = write(s, { state, by: b.by, via: b.via, comment: b.comment, hashes: b.hashes && b.hashes[cleanSlug(s)] ? b.hashes[cleanSlug(s)] : b.hashes });
    if (r) items[cleanSlug(s)] = r; else missing.push(cleanSlug(s));
  }
  console.log(`[approvals] ${state} ${Object.keys(items).length}개${missing.length ? ` (없는 제품 ${missing.length})` : ''} via=${b.via || ''}`);
  res.json({ gate: gateOn(), items, missing });
}
router.post('/api/v1/approvals/:slug', cr.auth, (req, res) => post(req, res, [req.params.slug]));
router.post('/api/v1/approvals', cr.auth, (req, res) => {
  const slugs = Array.isArray((req.body || {}).slugs) ? req.body.slugs.slice(0, 2000) : [];
  if (!slugs.length) return res.status(400).json({ error: 'slugs required' });
  post(req, res, slugs);
});

module.exports = { router, status, isApproved, pendingOf, gateOn };
