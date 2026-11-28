/**
 * bulk-jobs.js — 벌크 엑셀 작업 실행 (2026-11-19)
 *
 * 한 작업 = 고른 행들을 (필요하면 먼저 LG.com 에서 크롤해 CLIA 에 등록하고) 설명 칸 내용을 만들어 엑셀에 쓴다.
 *   크롤: 서버 전체에서 동시에 BULK_CRAWL_CONC(기본 2)개 — 200개를 한 번에 띄우면 서버가 버티지 못한다
 *   내용: 작업마다 동시에 2개 (/api/ebay-generate → /api/v1/slice-html, 태국 제품은 /api/v1/pdp-summary 도 — Lazada 는 HTML, Shopee 는 글)
 *   확인 필요(flags): 크롤·생성 실패, 원문 누락, 동영상 장면 자동 선택, Shopee 12장 초과, Lazada 요약 실패, 주소 추정
 *   보관: 작업·올린 파일·결과를 로컬 + 버킷(bulk/…)에 7일 — 재배포·재시작 뒤 진행 중이던 작업을 이어서 한다
 *   알림: 끝나면 메일 (RESEND_API_KEY + CLIA_MAIL_FROM 이 있을 때, lge-d2c.com 발신) · 화면은 브라우저 알림
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const xlsx = require('./bulk-xlsx');
const store = require('./crawl-store');
const catalog = require('./bulk-catalog');
const { productVideos } = require('./video-frames');   // 동영상 장면: 빌더와 같은 목록·저장 (video-frames.js)

const DIR = path.join(__dirname, 'media-cache', 'bulk');
const KEEP_MS = 7 * 24 * 3600 * 1000;
const SHOPEE_MAX_IMAGES = 12;
const SHOPEE_DESC_MAX = 3000;   // Shopee 설명 글자 수 한도 — 요약(최대 2,000자) + 이미지 주소가 넘으면 뒤 이미지부터 뺀다
const CELL_MAX = 32767;
const CRAWL_CONC = Math.max(1, Math.min(4, parseInt(process.env.BULK_CRAWL_CONC, 10) || 2));
const LOCAL = () => (process.env.BULK_API_BASE || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');
const idOk = (s) => /^[0-9a-f]{16}$/.test(String(s || ''));
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; } };
const OUT_DIR = () => require('./crawler-routes').OUT_DIR;

// ── 동시에 몇 개까지 (크롤은 서버 전체 공용) ──
function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const { fn, ok, no } = q.shift(); new Promise((r) => r(fn())).then(ok, no).finally(() => { active--; next(); }); };   // fn 이 바로 throw 해도(중단) 자리를 돌려준다
  return (fn) => new Promise((ok, no) => { q.push({ fn, ok, no }); next(); });
}
const crawlSlot = limiter(CRAWL_CONC);
// 내용 만들기(페이지 생성 · 슬라이스 · 요약)도 서버 전체 공용. 예전엔 작업마다 2개 — 운영 측정(2026-11-27, 100개 같은 호출):
//   동시 2 → 45s · 4 → 22s · 8 → 12s · 16 → 6s (거의 비례). 기본 16, BULK_CONTENT_CONC 로 1~24
const CONTENT_CONC = Math.max(1, Math.min(24, parseInt(process.env.BULK_CONTENT_CONC, 10) || 16));
const contentSlot = limiter(CONTENT_CONC);
// 슬라이스 그리기(파이썬 + 크로미움)는 따로 더 좁게 (2026-11-28): 캐시가 없는 제품을 한꺼번에 그리면 서버가 프로세스 한도에 걸린다 —
//   운영 11-27 실제 Check(72개)에서 spawn EAGAIN · 'Chromium을 실행할 수 없습니다' · 'browser has been closed', 11-28 엔 8개 동시에 2개 실패.
//   캐시가 있는 것은 바로 지나간다. 기본 4, BULK_SLICE_CONC 로 1~16
const SLICE_CONC = Math.max(1, Math.min(16, parseInt(process.env.BULK_SLICE_CONC, 10) || 4));
const sliceSlot = limiter(SLICE_CONC);

// ── 올린 파일 (로컬 + 버킷) ──
async function saveUpload(id, buf, meta) {
  fs.mkdirSync(path.join(DIR, id), { recursive: true });
  fs.writeFileSync(path.join(DIR, id, 'source.xlsx'), buf);
  fs.writeFileSync(path.join(DIR, id, 'meta.json'), JSON.stringify(meta));
  await store.putBuffer(`bulk/${id}/source.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').catch(() => {});
  await store.putBuffer(`bulk/${id}/meta.json`, Buffer.from(JSON.stringify(meta)), 'application/json').catch(() => {});
}
async function readUpload(id) {
  if (!idOk(id)) return null;
  const d = path.join(DIR, id);
  if (!fs.existsSync(path.join(d, 'source.xlsx'))) {   // 재배포 뒤: 버킷에서
    const [b, m] = await Promise.all([store.getBuffer(`bulk/${id}/source.xlsx`), store.getBuffer(`bulk/${id}/meta.json`)]);
    if (!b || !m) return null;
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'source.xlsx'), b);
    fs.writeFileSync(path.join(d, 'meta.json'), m);
  }
  const meta = readJson(path.join(d, 'meta.json'));
  return meta ? { meta, buf: fs.readFileSync(path.join(d, 'source.xlsx')) } : null;
}
function cleanup() {
  let ents = [];
  try { ents = fs.readdirSync(DIR); } catch (_) { return; }
  for (const n of ents) {
    try { if (Date.now() - fs.statSync(path.join(DIR, n)).mtimeMs > KEEP_MS) fs.rmSync(path.join(DIR, n), { recursive: true, force: true }); } catch (_) {}
  }
}

// ── 작업 보관 ──
const jobs = new Map();
const loadingJobs = new Map();
const jobFile = (id) => path.join(DIR, 'jobs', `${id}.json`);
let saveTimers = new Map();
function persist(j, now) {
  const write = async () => {
    saveTimers.delete(j.id);
    const buf = Buffer.from(JSON.stringify(j));
    fs.mkdirSync(path.dirname(jobFile(j.id)), { recursive: true });
    fs.writeFileSync(jobFile(j.id), buf);
    await store.putBuffer(`bulk/jobs/${j.id}.json`, buf, 'application/json').catch(() => {});
  };
  if (now) { clearTimeout(saveTimers.get(j.id)); return write(); }
  if (!saveTimers.has(j.id)) saveTimers.set(j.id, setTimeout(write, 4000));
  return Promise.resolve();
}
async function activeList(update) {
  const buf = await store.getBuffer('bulk/jobs/active.json').catch(() => null);
  let ids = [];
  try { ids = buf ? JSON.parse(buf.toString('utf8')) : readJson(path.join(DIR, 'jobs', 'active.json')) || []; } catch (_) {}
  if (!update) return ids;
  ids = update(ids);
  const out = Buffer.from(JSON.stringify(ids));
  fs.mkdirSync(path.join(DIR, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'jobs', 'active.json'), out);
  await store.putBuffer('bulk/jobs/active.json', out, 'application/json').catch(() => {});
  return ids;
}
async function getJob(id) {
  if (!idOk(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  if (!loadingJobs.has(id)) {
    loadingJobs.set(id, (async () => {
      let j = readJson(jobFile(id));
      if (!j) { const b = await store.getBuffer(`bulk/jobs/${id}.json`).catch(() => null); try { j = b && JSON.parse(b.toString('utf8')); } catch (_) {} }
      if (j) {
        jobs.set(id, j);
        if (j.status === 'ready') {
          for (const it of j.items) {
            if (j.check && it.status === 'working') {
              clearConfirmation(it);
              Object.assign(it, { status: 'failed', unified: false, error: 'Preparation interrupted' });
            }
          }
          kickRetries(j);
        }
      }
      return j || null;
    })().finally(() => loadingJobs.delete(id)));
  }
  return loadingJobs.get(id);
}

// 끝난 작업을 다시 열 때 '확인 필요'를 지금 규칙으로 다시 센다 (2026-11-23) — 작업 기록·결과 엑셀은 그대로, 화면에 보내는 값만.
// 작업이 끝난 뒤 그 제품을 다시 크롤했으면 지금 데이터는 엑셀에 들어간 내용과 다르므로 그때 저장한 것을 쓴다.
// 저장한 이유를 그대로 쓸 때도 제품 데이터 없이 알 수 있는 것은 지금 규칙으로 (화면 bulk.js normFlag 와 같은 규칙):
// 동영상 장면 자동 선택은 안내, 이미지 없이 글만 빠진 원문 누락도 안내
function normStored(flags) {
  if (!flags) return flags;
  const out = flags.map((f) => (f.code === 'frame' ? { ...f, sev: 'info' } : f.code === 'qa' && !f.images ? { ...f, code: 'qaTx', sev: 'info' } : f));
  return out.every((f, i) => f === flags[i]) ? flags : out;
}
function currentFlags(j, it) {
  if (it.status !== 'ok' || !it.slug || !j.finishedAt) return normStored(it.flags);
  const dir = path.join(OUT_DIR(), it.slug);
  const src = readJson(path.join(dir, 'source.json'));
  if (!src || !fs.existsSync(path.join(dir, 'mirror.json'))) return normStored(it.flags);
  if (!(src.crawled_at > 0) || src.crawled_at * 1000 > j.finishedAt) return normStored(it.flags);
  return flagsFor(j, it, { allImages: it.allImages, summaryErr: it.summaryErr });
}

// 작업의 나라 (2026-11-23): 벌크는 나라별로 완전히 나눈다 — 태국 작업이 싱가포르 화면에 보이지 않게.
// 이 기능 전에 만든 작업은 나라 기록이 없어 행의 LG.com 주소(lg.com/<cc>/…)에서 가장 많은 나라로 정한다
function countryOf(j) {
  if (j.country) return j.country;
  const n = {};
  for (const it of j.items || []) { const c = (/lg\.com\/([a-z]{2})(?:_[a-z]{2})?\//i.exec(it.url || '') || [])[1]; if (c) n[c.toLowerCase()] = (n[c.toLowerCase()] || 0) + 1; }
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || '';
}

const units = (its) => { const m = new Map(); for (const it of its) { const k = it.bundle ? 'b:' + it.row : it.slug || it.url || 'r:' + it.row; if (!m.has(k)) m.set(k, []); m.get(k).push(it); } return [...m.values()]; };
const reviewWrites = new WeakSet();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blocking = x => x.blocked && !x.ok && x.k !== 'n12';   // 예전 작업 기록의 'Shopee 12장 차단'은 이제 막지 않는다
const incompletePdp = it => it.unified !== true || !it.hash || !it.contentDigest ||
  (it.ai || []).some(blocking);
// lg.com 에 내용이 없는 제품(empty): 엑셀 행은 그대로 두고 받기를 막지 않는다 (2026-11-28 결정)
const exportBlocked = it => reviewWrites.has(it) || (it.check !== 'removed' && !it.empty &&
  (it.status !== 'ok' || it.retrying || incompletePdp(it)));
const skuConflict = ({ descCol, skuCol, skus }) => Number(descCol) === Number(skuCol) && !!skus?.length;
function assertSeparateColumns(job) {
  if (skuConflict(job)) throw new Error('SKU and PDP description must use different columns');
}
async function workbookMatches(j, bytes, proofs) {
  try {
    const sheet = (await xlsx.load(bytes)).sheets.find(s => s.path === j.sheet);
    return !!sheet && Object.entries(proofs).every(([row, proof]) => {
      const text = sheet.rows.get(Number(row))?.get(Number(j.descCol));
      return typeof text === 'string' && digest(text) === proof.contentDigest;
    });
  } catch (_) { return false; }
}
const included = it => it.status === 'ok' && it.check !== 'removed';
// lg.com 화면에 기능 섹션도 스펙도 없는 제품 (lg-visibility 가 페이지 데이터에만 있는 섹션을 다 숨김, 예: T2310NBTB): 만들 PDP 가 없다 —
//   실패가 아니라 'lg.com 에 내용 없음', 엑셀 행은 그대로 (2026-11-28 결정: lg.com 에 있는데 못 가져온 것만 오류)
function lgEmpty(slug) {
  const m = slug ? readJson(path.join(OUT_DIR(), slug, 'mirror.json')) : null;
  return !!(m && m._lg_hidden && !(m.sections || []).length);
}
const isCurrentRow = (j, it) => {
  const row = j.resultRows?.[it.row];
  return !!row && row.hash === it.hash && row.contentDigest === it.contentDigest;
};
function deliveryDenial(j) {
  if (j.status !== 'ready') return { status: 404, error: 'file not ready' };
  if (skuConflict(j)) return { status: 409, error: 'SKU and PDP description must use different columns', code: 'sku_description_conflict' };
  const rows = j.check ? j.items.filter(included) : [];
  if (j.check && (!j.resultDigest || !j.resultRows || Object.keys(j.resultRows).length !== rows.length ||
      j.items.some(exportBlocked) || rows.some(it => !isCurrentRow(j, it) || it.check !== 'ok' ||
        it.checkedHash !== it.hash || it.checkedChannel !== j.channel ||
        it.checkedContentDigest !== it.contentDigest))) {
    return { status: 409, error: 'Some PDPs are incomplete or need review again', code: 'pdp_export_blocked' };
  }
  const approvals = require('./approvals');
  if (approvals.gateOn()) {
    const pending = approvals.pendingOf(j.items, j.check ? j.channel : undefined);
    if (pending.length) return { status: 409, error: 'not approved', code: 'not_approved', pending: pending.length,
      models: pending.slice(0, 20).map(x => x.model || x.slug) };
  }
  return null;
}
async function resultBytes(j) {
  const fp = path.join(DIR, j.upload, `result-${j.id}.xlsx`);
  const buf = fs.existsSync(fp) ? fs.readFileSync(fp) : await store.getBuffer(`bulk/${j.upload}/result-${j.id}.xlsx`).catch(() => null);
  if (!j.check || !buf) return buf;
  if (skuConflict(j) || !j.resultRows || !j.resultDigest || digest(buf) !== j.resultDigest) return null;
  return await workbookMatches(j, buf, j.resultRows) ? buf : null;
}
const jobTransactions = new Map();
function transact(j, fn) {
  const run = (jobTransactions.get(j.id) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  jobTransactions.set(j.id, tail);
  tail.then(() => { if (jobTransactions.get(j.id) === tail) jobTransactions.delete(j.id); });
  return run;
}
function deliver(j, row) {
  return transact(j, async () => {
    const denial = deliveryDenial(j);
    if (denial) return denial;
    if (row !== undefined && !j.items.some(it => it.row === row && included(it))) {
      return { status: 404, error: 'row not filled by this job', code: 'not_filled' };
    }
    const bytes = await resultBytes(j);
    return deliveryDenial(j) || (bytes ? { bytes } : { status: j.check ? 409 : 404, error: 'file unavailable or needs preparation again' });
  });
}

function jobView(j) {
  const done = j.status !== 'running' && j.status !== 'queued';
  // 동영상 수(장면 바꾸기 버튼)는 이 기능 전에 끝난 작업 기록에 없어서 다시 열 때 센다
  const withVideos = (it) => (it.status === 'ok' && it.slug && it.videos == null
    ? { ...it, videos: productVideos(readJson(path.join(OUT_DIR(), it.slug, 'mirror.json'))).length } : it);
  const approvals = require('./approvals');
  const pending = done ? approvals.pendingOf(j.items, j.check ? j.channel : undefined) : [];
  const pendingSlugs = new Set(pending.map(x => x.slug).filter(Boolean));
  const its = (done ? j.items.map((it) => { const flags = currentFlags(j, it); return withVideos(flags === it.flags ? it : { ...it, flags }); }) : j.items)
    .map(it => (j.check && (it.ai || []).some(x => x.k === 'n12' && !x.ok)
      ? { ...it, ai: it.ai.map(x => (x.k === 'n12' ? { ...x, ok: true, blocked: false, cut: true } : x)) } : it))   // 예전 기록의 12장 차단은 정보로만
    .map(it => {
      if (!j.check || it.check === 'removed' || it.status !== 'ok') return it;
      if (!exportBlocked(it) && isCurrentRow(j, it)) {
        return it.check !== 'ok' || (it.checkedHash === it.hash && it.checkedChannel === j.channel &&
          it.checkedContentDigest === it.contentDigest && (!approvals.gateOn() || !pendingSlugs.has(it.slug))) ? it : { ...it, check: null };
      }
      if (it.unified && it.contentDigest && ((it.ai || []).some(blocking) || it.retrying)) return { ...it, check: null };
      return { ...it, check: null, imgs: [], ai: [{ k: 'preview', ok: false, blocked: true }] };
    });
  const fin = (x) => x.status === 'ok' || x.status === 'failed';
  return { id: j.id, upload: j.upload, status: j.status, error: j.error, channel: j.channel, country: countryOf(j), phase: j.phase,
    total: its.length, done: its.filter(fin).length,
    ok: its.filter((x) => x.status === 'ok').length, failed: its.filter((x) => x.status === 'failed').length,
    replaced: its.filter((x) => x.status === 'ok' && x.prevLen > 0).length,
    crawlTotal: its.filter((x) => x.register || x.force).length, crawlDone: its.filter((x) => (x.register || x.force) && (x.crawled || x.status === 'failed')).length,
    review: its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info')).length,
    notify: j.notify ? { email: !!j.notify.email, sent: !!j.notify.sent } : null,
    skus: j.skus || [], items: its, file: j.status === 'ready' && (!j.check || !deliveryDenial(j)) ? `/api/v1/bulk/jobs/${j.id}/file` : null, fileName: j.outName, at: j.at, finishedAt: j.finishedAt,
    // 벌크 Check (?check=1): 라이브 아닌 것 건너뜀 수 · 확인 · 뺀 수
    // 확인 · 뺀 수는 제품 기준 (같은 제품의 여러 행은 하나) — 진행 막대 · 건너뜀 수와 같은 단위
    check: j.check ? { ...j.check, confirmed: units(its).filter((u) => u.every((x) => x.check === 'ok')).length, removed: units(its).filter((u) => u.every((x) => x.check === 'removed')).length } : null,
    // 검토·승인 (approvals.js): 승인 안 된 제품 수. gate 가 켜져 있으면 엑셀 받기가 잠긴다
    approval: done ? { gate: approvals.gateOn(), pending: pending.length, models: pending.slice(0, 20).map(x => x.model || x.slug) } : null };
}

// ── 내용 만들기 (같은 서버의 기존 API) ──
async function post(p, body, timeoutMs) {
  const r = await fetch(LOCAL() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status} ${p}`);
  return j;
}
async function contentFor(channel, url, opt = {}) {   // opt.fresh: 슬라이스를 새로 그림(캐시 무시 — 자동 다시 하기)
  const listing = channel === 'lazada' && !opt.check;
  // PDP 요약(태국어)은 태국 제품만 — 싱가포르 등은 요약 없이 이미지만 (2026-11-23). Shopee 도 (2026-11-24, 글로 이미지 주소 위에)
  const summaryP = /lg\.com\/th\//i.test(url) ? post('/api/v1/pdp-summary', { url }, 7 * 60 * 1000).catch((e) => ({ error: e.message })) : null;
  // 빌더에서 저장한 편집본이 있으면 그것으로 (edits.js) — 없으면 크롤 데이터로 새로 만든다
  const slug = require('./crawler-routes').slugify(url);
  const ed = require('./edits').getEdit(slug, channel);
  const g = ed ? { html: ed.html } : await post('/api/ebay-generate', { url, medium: 'shopee_lazada', listing, ...(opt.check ? { reviewMap: true } : {}) }, 5 * 60 * 1000);
  if (!g.html) throw new Error('generate returned no HTML');
  const sliceOpts = { medium: 'shopee_lazada', ...(opt.fresh ? { rev: 'r' + Date.now().toString(36) } : {}) };
  const sl = await sliceContent(g.html, sliceOpts, opt.check, slug);
  const sm = await summaryP;
  if (channel === 'shopee') {
    // Shopee 설명은 HTML 을 받지 않는다 → Promotion(상품 설명 정보) · 요약(태국)은 태그 없는 글로 위, 그 아래 이미지 주소 (한 줄에 하나, 앞 12장),
    // 맨 아래 상품 설명 정보의 나머지 (2026-11-25 — 태국은 Product details 가 요약 자리)
    const LR = require('./listing-routes');
    const parts = opt.check ? {} : LR.shopeeParts(await LR.currentFor(url).catch(() => null), url);
    const head = (parts.top ? parts.top + '\n\n' : '') + (sm && sm.text ? sm.text.trim() + '\n\n' : '');
    const tail = parts.bottom ? '\n\n' + parts.bottom : '';
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    while (urls.length > 1 && (head + urls.join('\n') + tail).length > SHOPEE_DESC_MAX) urls.pop();
    if (!urls.length) throw new Error('no images');
    const text = head + urls.join('\n') + tail;
    return { text, images: urls.length, allImages: sl.count, summaryErr: sm && sm.error ? sm.error.slice(0, 200) : '', edited: !!ed,
             tooLong: text.length > SHOPEE_DESC_MAX ? text.length : 0, urls, hash: sl.hash, ...sliceEvidence(sl, opt.check) };
  }
  return { text: (sm && sm.html ? sm.html + '\n' : '') + sl.html, images: sl.count, allImages: sl.count, summaryErr: sm && sm.error ? sm.error.slice(0, 200) : '', edited: !!ed,
           urls: sl.urls || [], hash: sl.hash, ...sliceEvidence(sl, opt.check) };
}

// Check sends only the PDP render to XLSX and reviews the exact URLs retained in that cell.
async function sliceContent(html, sliceOpts, check, slug) {
  const mirror = check && slug && readJson(path.join(OUT_DIR(), slug, 'mirror.json'));
  const gallery = ((mirror && mirror._gallery) || []).flatMap(g => [g.pc_url, g.mobile_url, g.unified_url]).filter(Boolean).map(imgKey);
  return sliceSlot(() => post('/api/v1/slice-html', { html, ...sliceOpts, ...(check ? { review: true, reviewGallery: gallery } : {}) }, 12 * 60 * 1000));
}
const sliceEvidence = (sl, check) => ({
  loaded: sl.images_loaded, broken: sl.broken || null,
  ...(check ? { unified: true, sections: sl.sections, specTables: sl.specTables } : {}),
});

// 묶음 상품 ('A + B' 행, 2026-11-23): 구성품 크롤 결과를 빌더 번들과 같은 모양으로 합쳐(crawler-py/bundle_pto.py combine)
// 같은 렌더러(ebay_builder.py)로 그리고, 단품과 같은 슬라이스 이미지로 만든다. 묶음 결과는 media-cache/bulk/bundles/<키>/ (제품 목록엔 안 나옴)
const PY_DIR = path.join(__dirname, 'crawler-py');
const python = () => process.env.CRAWLER_PYTHON || (fs.existsSync(path.join(PY_DIR, '.venv', 'bin', 'python')) ? path.join(PY_DIR, '.venv', 'bin', 'python') : 'python3');
const runPy = (args, timeoutMs) => new Promise((resolve, reject) => require('child_process').execFile(python(), args, { cwd: PY_DIR, timeout: timeoutMs },
  (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop().slice(0, 300))) : resolve(String(out)))));
const bundleKey = (it) => crypto.createHash('sha1').update(it.bundle.map((x) => x.slug).join('+')).digest('hex').slice(0, 16);
async function contentForBundle(channel, it, title, opt = {}) {
  const dir = opt.check ? fs.mkdtempSync(path.join(os.tmpdir(), 'clia-check-bundle-')) : path.join(DIR, 'bundles', bundleKey(it));
  const spec = { title: title || it.model, components: it.bundle.map((x) => ({ model: x.model || '', url: x.url, slug: x.slug })) };
  const outputName = opt.check ? 'check-content.html' : 'content.html';
  let html;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
    await runPy(['bundle_pto.py', 'combine', dir, path.join(dir, 'spec.json')], 60 * 1000);
    await runPy(['ebay_builder.py', dir, '--fragment', '--medium', 'shopee_lazada', '-o', outputName, ...(opt.check ? ['--map-sections'] : [])], 3 * 60 * 1000);
    html = fs.readFileSync(path.join(dir, outputName), 'utf8');
  } finally {
    if (opt.check) fs.rmSync(dir, { recursive: true, force: true });
  }
  const sliceOpts = { medium: 'shopee_lazada', ...(opt.fresh ? { rev: 'r' + Date.now().toString(36) } : {}) };
  const sl = await sliceContent(html, sliceOpts, opt.check);
  if (channel === 'shopee') {
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    if (opt.check) while (urls.length > 1 && urls.join('\n').length > SHOPEE_DESC_MAX) urls.pop();
    if (!urls.length) throw new Error('no images');
    return { tooLong: opt.check && urls.join('\n').length > SHOPEE_DESC_MAX, text: urls.join('\n'), images: urls.length, allImages: sl.count, summaryErr: '', urls, hash: sl.hash, ...sliceEvidence(sl, opt.check) };
  }
  return { text: sl.html, images: sl.count, allImages: sl.count, summaryErr: '', urls: sl.urls || [], hash: sl.hash, ...sliceEvidence(sl, opt.check) };   // 묶음은 PDP 요약 없이 (요약은 제품 하나 기준)
}

// 크롤 검사 기록(qa_report)으로 센 원문 누락 — 확인 필요(flagsFor) · 벌크 Check 의 AI 체크(aiChecks)가 같이 쓴다
function qaOf(slug) {
  const dir = path.join(OUT_DIR(), slug || '');
  const mirror = readJson(path.join(dir, 'mirror.json'));
  const qa = readJson(path.join(dir, 'qa_report.json')) || (mirror && mirror._qa) || {};
  // 원문 누락: 일부러 빼는 것(바로가기 링크 영역 ST0018 · 탭 카드 안 글)은 세지 않는다 — 그대로 세면 거의 모든 제품이 걸린다.
  // 구매처 영역(PD0016 Where to buy)도 컨텐츠가 아니다 — 이 규칙 전에 크롤한 제품의 검사 기록에는 그 썸네일이 누락으로 들어 있다
  // 실제로 빠진 이미지가 있거나, 본문 글이 5개 이상 빠졌을 때만
  const cov = qa.coverage || {}, chk = qa.checks || {};
  const real = (x) => x && !NON_CONTENT.has(x.component_id);
  const tx = (cov.missing_texts || []).filter((x) => real(x) && !GALLERY.has(x.component_id) && !x.only_in_cards), texts = tx.length;
  // 예전에 크롤한 결과의 검사 기록에는 '크롤러가 일부러 뺀 이미지(LG 가 404·자리표시를 내줌)'가 누락으로 들어 있다 — 그것은 빼고 센다.
  // 새 크롤은 검사가 이미 제외한다. 주소가 겹쳐 있던 것은 실제로 이미지를 잃은 것이라 그대로 센다 (다시 가져오면 고쳐진다).
  const dead = new Set(((mirror && mirror._dead_media_dropped) || []).filter((d) => !DUP_DAM.test(d.url || '')).map((d) => imgKey(d.url)));
  // 갤러리는 우리가 만드는 것(엑셀 설명 칸)이 아니다 — 갤러리 컴포넌트(PD0012 · PD0033)나 갤러리 사진과 같은 그림은 세지 않는다.
  // 새 크롤은 검사(coverage_check.py)가 이미 빼지만, 예전 기록에 섞여 있어도 걸리지 않게 (2026-11-27)
  const gal = new Set(((mirror && mirror._gallery) || []).flatMap((g) => [g.pc_url, g.mobile_url]).filter(Boolean).map(imgKey));
  const gone = (cov.missing_images || []).filter(real).filter((x) => !GALLERY.has(x.component_id) && !gal.has(imgKey(x.image)) && !dead.has(imgKey(x.image)));
  const images = gone.length + (chk.images_missing_url || 0);
  const files = gone.slice(0, 3).map((x) => String(x.image || '').split('/').pop());   // 어떤 이미지가 빠졌는지 (화면에서 마우스를 올리면 보임)
  // Keep the original evidence and its source section together.
  const keyOf = x => cov.source_ownership === 2 ? x.source_key : undefined;
  const imageIssues = gone.map((x) => ({ src: fullImg(dir, x.image), source_key: keyOf(x) }));
  const textIssues = tx.map(x => ({ ...x, source_key: keyOf(x) }));
  // 스펙 원본: 검사 기록의 source_specs. 그 전 방식으로 크롤한 제품(기록에 source_specs 가 없음)은 크롤 결과(mirror)의 스펙 행으로 (2026-11-28).
  //   예전엔 그 기록의 '빠진 글' 중 스펙 영역 글자(표 제목 'สรุป' · 'ข้อมูลจำเพาะพื้นฐาน' 등)를 빠진 스펙으로 세서, 태국 Shopee Live 140개 중
  //   35개가 '빠진 스펙'이 되고 다시 크롤(제품마다 3번)이 한꺼번에 몰렸다. 스펙 행은 크롤 결과에 그대로 있으니 다시 크롤할 필요가 없다
  const mirrorSpecs = (mirror?.sections || []).filter(s => s.specs?.length).map(s => ({ component_id: s.component_id, section: s.component_id,
    source_key: (s.source_keys || [])[0], rows: s.specs.map(r => ({ label: r.label, value: r.value })), fromMirror: true }));
  const sourceSpecs = Array.isArray(cov.source_specs) ? cov.source_specs.map(x => ({ ...x, source_key: keyOf(x) }))
    : mirrorSpecs.length ? mirrorSpecs : null;
  const specIds = new Set(mirrorSpecs.map(x => x.component_id).filter(Boolean));
  const legacySpecs = sourceSpecs === null ? (cov.missing_texts || []).filter(x => x.component_id === 'PD0008') : [];
  // 스펙 영역 글자는 스펙 표로 확인하니 '빠진 글'로 따로 세지 않는다 (예전 기록만 — 새 기록은 이미 스펙 행으로 나뉜다)
  const textIssuesOut = sourceSpecs?.[0]?.fromMirror ? textIssues.filter(x => !specIds.has(x.component_id)) : textIssues;
  return { images, texts: textIssuesOut.length, files, mirror, imageIssues, textIssues: textIssuesOut, sourceSpecs, legacySpecs };
}

// 검사 기록의 이미지 주소는 끝 120자만 남아 있을 수 있다 → 크롤한 원문(pc.html)에서 그 끝으로 끝나는 전체 주소를 찾는다
function fullImg(dir, tail) {
  tail = String(tail || '');
  const abs = (u) => (/^https?:\/\//.test(u) ? u : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? 'https://www.lg.com' + u : null);
  if (/^(https?:)?\/\/|^\/content\//.test(tail)) return abs(tail);
  let html = ''; try { html = fs.readFileSync(path.join(dir, 'pc.html'), 'utf8'); } catch (_) { return null; }
  if (!tail) return null;
  const i = html.indexOf(tail); if (i < 0) return null;
  let s = i; while (s > 0 && !/["'\s(,=]/.test(html[s - 1])) s--;
  return abs(html.slice(s, i + tail.length));
}

// ── 벌크 Check (?check=1, 2026-11-26) ──
// AI 체크: 미리 계산해 두고 화면이 한 줄씩 보여 준다. 항목: 이미지 다 불러옴 · lg.com 문구와 같음 · (태국) 요약 · Shopee 12장 · 스펙표.
//   ok=false 인 항목이 있으면 사람이 '다시 준비' / '이번 엑셀에서 빼기'. Shopee 12장 넘는 것은 자동으로 앞 12장 — 통과 + 회색 안내.
function aiChecks(j, it, c) {
  const out = [];
  const q = it.bundle ? { images: 0, texts: 0, mirror: null } : qaOf(it.slug);
  const lgImg = q.images;
  const collect = (report, used) => {
    const m = /^(\d+)\/(\d+)$/.exec(String(report?.loaded || ''));
    if (!Array.isArray(report?.broken)) {
      return Array.from({ length: m ? Math.max(0, +m[2] - +m[1]) : 0 }, () => ({}));
    }
    return report.broken.flatMap(b => {
      if (!Array.isArray(b.regions)) return !used || b.slice <= used ? [{ ...b, regions: [b] }] : [];
      const regions = b.regions.filter(r => r.slice <= used);
      return regions.length || !b.regions.length ? [{ ...b, regions }] : [];
    });
  };
  const used = c?.urls?.length || 0;
  const at = collect(c, used);
  const bad = at.length;
  const regions = ({ source_key }) => {
    const map = c?.sections || {};
    return source_key && Object.hasOwn(map, source_key) ? map[source_key].filter(r => r.slice <= used) : [];
  };
  const imageIssues = (q.imageIssues || []).map((x) => ({ src: x.src, regions: regions(x) }));
  const specsInMirror = !!q.mirror?.sections?.some(s => s.specs?.length);
  // 스펙 표가 PDP 에 그려져 있으면 있는 것 — Shopee 한도로 앞 12장 밖에 있어도 '빠짐'이 아니다 (2026-11-28 결정)
  const completeInCell = regions => !!regions?.length && regions.every(r => Number.isInteger(r.slice) && r.slice > 0);
  const rowKey = pair => JSON.stringify(pair.map(v => String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ')));
  const specSources = it.bundle?.length
    ? it.bundle.map((component, i) => ({ qa: component.slug ? qaOf(component.slug) : null,
      part: i + 1, model: component.model || component.slug || String(i + 1) }))
    : [{ qa: q, part: 0, model: '' }];
  const expectedRows = (table, rows) => {
    if (!rows?.length) return false;
    const pairs = new Set((table.rows || []).map(rowKey));
    return rows.every(r => pairs.has(rowKey([r.label, r.value])));
  };
  const hasTable = ({ source_key, rows, part, fromMirror }) => {
    const tables = (c?.specTables || []).filter(t => (t.part || 0) === part);
    const keyed = source_key ? tables.filter(t => t.sourceKeys.includes(source_key)) : [];
    if (keyed.length) return keyed.some(t => completeInCell(t.regions) && expectedRows(t, rows));
    // 예전 방식 크롤(크롤 결과의 스펙 행으로 확인): 그 행이 전부 들어 있는 표가 PDP 에 다 그려져 있으면 있는 것
    if (fromMirror && !part) return tables.some(t => completeInCell(t.regions) && expectedRows(t, rows));
    // Older saved HTML has no section key. Only the exact expected pairs in a
    // single, complete, unkeyed table can corroborate the source.
    if (part || !c?.edited) return false;
    const matches = tables.filter(t => !t.sourceKeys.length && expectedRows(t, rows));
    return matches.length === 1 && completeInCell(matches[0].regions);
  };
  const missingTables = specSources.flatMap(({ qa, part, model }) =>
    (qa?.sourceSpecs || []).map(x => ({ ...x, part, model })).filter(x => !hasTable(x)));
  const specIssues = missingTables.map(x => ({
    ...(x.model ? { model: x.model } : {}), rows: x.rows,
    regions: x.source_key ? regions({ source_key: x.part ? `part:${x.part}:${x.source_key}` : x.source_key }) : [],
  }));
  const specComponents = new Set(missingTables.map(x => x.source_key || x.component_id));
  const crawlParts = specSources.filter(({ qa, part }) => part &&
    (!Array.isArray(qa?.sourceSpecs) || (missingTables.some(x => x.part === part) && !qa?.mirror?.sections?.some(s => s.specs?.length))))
    .map(x => x.part);
  let legacyUnknown = false;
  for (const { qa, model } of specSources) {
    if (Array.isArray(qa?.sourceSpecs)) continue;
    const lines = qa?.legacySpecs?.map(x => x.text).filter(Boolean) || [];
    if (lines.length) {
      specIssues.push({ ...(model ? { model } : {}), lines, regions: [] });
      specComponents.add('PD0008');
    } else {
      legacyUnknown = true;
      if (model) specIssues.push({ model, unknown: true, regions: [] });
    }
  }
  const textGroups = new Map();
  for (const x of q.textIssues || []) {
    if (specComponents.has(x.source_key || x.component_id)) continue;
    const key = x.source_key || x.section || x.component_id;
    if (!textGroups.has(key)) textGroups.set(key, { lines: [], regions: regions(x) });
    textGroups.get(key).lines.push(x.text);
  }
  const textIssues = [...textGroups.values()];
  const texts = textIssues.reduce((n, x) => n + x.lines.length, 0);
  out.push({ k: 'img', ok: !bad && !lgImg, n: bad + lgImg, bad, lg: lgImg,
    ...(at && at.length ? { at } : {}), issues: imageIssues });
  out.push({ k: 'txt', ok: texts < 5, n: texts, issues: textIssues });
  if (!it.bundle && /lg\.com\/th\//i.test(it.url || '')) out.push({ k: 'sum', ok: !(c && c.summaryErr) });
  if (j.channel === 'shopee') {
    // Shopee 한도(앞 12장 · 3,000자)로 뒤가 잘리는 것은 자동 — 앞 12장만 엑셀에 넣고 막지 않는다 (2026-11-28 결정)
    out.push({ k: 'n12', ok: true, cut: used < (c?.allImages ?? used) || !!c?.tooLong, used, all: c?.allImages ?? used });
  }
  out.push({ k: 'spec', ok: !specIssues.length && !legacyUnknown, unknown: legacyUnknown && specIssues.every(x => x.unknown), blocked: !!specIssues.length || legacyUnknown,
    crawl: it.bundle ? !!crawlParts.length : !specsInMirror || legacyUnknown || !!q.legacySpecs?.length, crawlParts, issues: specIssues });
  return out;
}
const aiFail = (ai) => (ai || []).some((x) => !x.ok);
// 고쳐질 수 있는 문제(이미지 · 글 누락)면 한 번 자동으로 다시 (retryLater — 작업이 끝난 뒤 뒤에서):
// 마지막 크롤이 하루보다 오래됐으면 다시 크롤, 아니면 다시 그리기만 (방금 크롤한 것은 다시 크롤해도 같다 — 크롤 비용만 든다)
// 자동으로 고칠 수 있는 것 (2026-11-27, PR #103 표 · 장혁 결정): 사람에게 묻기 전에 뒤에서 다시.
//   누락(lg.com 이미지 · 글 · 스펙 표, 준비 실패) → 크롤 시점과 상관없이 force 로 다시 크롤 — 누락이 없어질 때까지, 안전장치: 최대 3번 · 간격 0 / 30초 / 90초
//     (운영 로그 11-25~27 크롤 41건: 중앙값 31초 · 느린 것 ~2분. 하루 전 새로 크롤한 제품도 같은 글이 계속 빠져 있어 — 크롤러가 못 읽는 구조 —
//      더 돌려도 크롤 비용과 기다림만 늘어난다. 3번이면 일시적 실패(네트워크 · 차단)에 간격을 두고 두 번 더 기회)
//   슬라이스에서 못 가져온 이미지 · 요약 실패 → 다시 그리기(슬라이스 캐시 무시) 최대 2번
//   Shopee 12장은 자동(앞 12장만 엑셀에)이라 묻지도 막지도 않는다 (2026-11-28 결정).
const MAX_CRAWLS = 3, CRAWL_GAP = [0, 30 * 1000, 90 * 1000], MAX_DRAWS = 2;
// 자동 재시도는 서버 전체에서 동시에 BULK_RETRY_CONC(기본 2)개 제품만 (2026-11-28). 한 제품의 재시도 = 크롤 + 페이지 생성 + 슬라이스 + 요약이라
//   무겁다 — 운영에서 127개가 한꺼번에 재시도에 들어가자 'can't start new thread' · spawn EAGAIN · 'Chromium을 실행할 수 없습니다'로
//   재시도 자체가 실패했다. 사람이 연 작업(첫 결과)은 이 줄을 서지 않는다
const RETRY_CONC = Math.max(1, Math.min(8, parseInt(process.env.BULK_RETRY_CONC, 10) || 2));
const retrySlot = limiter(RETRY_CONC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fixPlan(it, ai) {
  if (it.empty) return null;   // lg.com 에 내용이 없음 — 다시 크롤해도 같다
  if (it.status === 'failed') return it.bundle ? { crawl: false, draw: true } : { crawl: true, draw: false };
  const bad = (k) => (ai || []).some((x) => x.k === k && !x.ok);
  const img = (ai || []).find((x) => x.k === 'img') || {};
  const spec = (ai || []).find((x) => x.k === 'spec');
  const crawl = (!it.bundle && ((!img.ok && img.lg > 0) || bad('txt'))) || (bad('spec') && spec.crawl !== false);
  const draw = (!img.ok && img.bad > 0) || bad('sum') || bad('preview') || (bad('spec') && spec.crawl === false);
  return crawl || draw ? { crawl, draw } : null;
}
// 다시 그리기 횟수: 빠진 이미지만이면 1번 (2026-11-28) — 같은 이미지가 또 빠지면 다시 그려도 그대로라 사람에게 바로 넘긴다.
//   운영 140개 Check: 처음 결과는 30초에 나왔는데 같은 4개를 2번씩 다시 그리느라(이미지마다 최대 90초 기다림) 4분 30초를 더 썼고 결과는 같았다
const drawsFor = (ai) => { const bad = (k) => (ai || []).some((x) => x.k === k && !x.ok); return bad('sum') || bad('preview') || bad('spec') ? MAX_DRAWS : 1; };
const retryable = (it, ai) => { const p = fixPlan(it, ai); return !!p && ((p.crawl && (it.crawls || 0) < MAX_CRAWLS) || (p.draw && (it.tries || 0) < drawsFor(ai))); };
// 다시 해도 못 가져온 이미지: lg.com 원본 주소를 직접 열어 본다 — lg.com 에서도 없으면(404 · 410) PDP 에 없는 게 맞다 → 문제 아님
async function settleImg(ai) {
  const img = (ai || []).find((x) => x.k === 'img'); if (!img || img.ok || !(img.at || []).length) return ai;
  await Promise.all(img.at.map(async (b) => {
    if (!/^https:\/\/www\.lg\.com\//.test(b.src || '')) return;
    try { const r = await fetch(b.src, { method: 'HEAD', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.lg.com/' } }); if (r.status === 404 || r.status === 410) b.lgGone = 1; } catch (_) {}
  }));
  const left = img.at.filter((b) => !b.lgGone).length;
  img.goneOnLg = img.at.length - left; img.bad = left; img.n = left + (img.lg || 0); img.ok = !img.n;
  return ai;
}
// 작업 결과 글(행 → 설명 칸)을 남겨 둔다 — Check 에서 뺀 행만 빼고 엑셀을 다시 만들 때 (로컬 + 버킷)
const textsFile = (j) => path.join(DIR, j.upload, `texts-${j.id}.json`);
async function saveTexts(j, texts, bucket) {
  fs.mkdirSync(path.join(DIR, j.upload), { recursive: true });
  const buf = Buffer.from(JSON.stringify(Object.fromEntries(texts)));
  fs.writeFileSync(textsFile(j), buf);
  if (bucket) await store.putBuffer(`bulk/${j.upload}/texts-${j.id}.json`, buf, 'application/json').catch(() => {});
}
async function loadTexts(j) {
  let d = readJson(textsFile(j));
  if (!d) { const b = await store.getBuffer(`bulk/${j.upload}/texts-${j.id}.json`).catch(() => null); try { d = b && JSON.parse(b.toString('utf8')); } catch (_) {} }
  return new Map(Object.entries(d || {}).map(([k, v]) => [+k, v]));
}
// 결과 엑셀 = 올린 파일 + (빼지 않은) 채운 행. 뺀 행은 원래 내용 그대로
async function writeResult(j, texts) {
  assertSeparateColumns(j);
  const up = await readUpload(j.upload);
  if (!up) throw new Error('uploaded file expired');
  const wb = await xlsx.load(up.buf);
  const sheet = wb.sheets.find((x) => x.path === j.sheet);
  if (!sheet) throw new Error('sheet not found');
  let n = 0;
  const resultRows = {};
  for (const it of j.items) {
    if (it.status !== 'ok' || it.check === 'removed' || (j.check && incompletePdp(it)) || !texts.has(it.row)) continue;
    if (j.check) {
      if (digest(texts.get(it.row)) !== it.contentDigest) continue;
      resultRows[it.row] = { hash: it.hash, contentDigest: it.contentDigest };
    }
    it.prevLen = String((sheet.rows.get(it.row) || new Map()).get(j.descCol) || '').trim().length;
    wb.setCell(j.sheet, it.row, j.descCol, texts.get(it.row));
    n++;
  }
  for (const x of j.skus || []) if (j.skuCol) wb.setCell(j.sheet, x.row, j.skuCol, x.sku);
  const buf = await wb.save();
  if (j.check && !(await workbookMatches(j, buf, resultRows))) throw new Error('Written PDP cells differ from review');
  fs.mkdirSync(path.join(DIR, j.upload), { recursive: true });
  fs.writeFileSync(path.join(DIR, j.upload, `result-${j.id}.xlsx`), buf);
  await store.putBuffer(`bulk/${j.upload}/result-${j.id}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').catch(() => {});
  if (j.check) { j.resultDigest = digest(buf); j.resultRows = resultRows; }
  return n;
}
// Check 화면의 버튼 — 한 제품(같은 제품의 여러 행)에 한 번: ok(확인하고 다음 → 승인 기록 via 'bulk' + 본 이미지 해시) ·
//   remove(이번 엑셀에서 빼기 — 그 행들은 원래 내용 그대로) · retry(다시 준비)
function clearConfirmation(it) {
  it.check = null;
  delete it.checkedHash;
  delete it.checkedChannel;
  delete it.checkedContentDigest;
  delete it.checkedBy;
  delete it.checkedAt;
}
function checkAction(j, rows, action, by, override, reviewed) {
  return transact(j, async () => {
    const its = j.items.filter(x => rows.includes(x.row));
    if (!j.check || !its.length) return { error: 'not found', status: 404 };
    if (j.status !== 'ready') return { error: 'job is not ready', status: 409 };
    if (its.some(it => reviewWrites.has(it) || it.status === 'working' || it.retrying)) {
      return { error: 'already preparing', status: 409 };
    }
    if (action === 'ok') {
      if (its.some(it => {
        const seen = reviewed?.[it.row];
        return !it.hash || !it.contentDigest || seen?.hash !== it.hash || seen?.contentDigest !== it.contentDigest;
      })) return { error: 'The PDP changed. Review it again before confirming.', status: 409, code: 'review_changed' };
      if (its.some(it => !included(it) || incompletePdp(it) || !isCurrentRow(j, it)) || !(await resultBytes(j))) {
        return { error: 'Review the actual Excel PDP before including this item', status: 409 };
      }
      const who = String(by || '').slice(0, 120), stamped = new Map(), approvals = require('./approvals');
      if (approvals.gateOn()) {
        const hashes = new Map();
        for (const it of j.items.filter(x => included(x) && !x.bundle && x.slug)) {
          if (hashes.has(it.slug) && hashes.get(it.slug) !== it.hash) hashes.set(it.slug, null);
          else hashes.set(it.slug, it.hash);
        }
        if (its.some(it => !it.bundle && hashes.get(it.slug) === null)) {
          return { error: 'Prepare the rows for this product together before confirming', status: 409 };
        }
      }
      for (const it of its) {
        if (!it.bundle && it.slug && stamped.get(it.slug) !== it.hash) {
          stamped.set(it.slug, it.hash);
          const prior = approvals.status(it.slug);
          const hashes = prior.status === 'approved' ? prior.hashes : null;
          approvals.write(it.slug, { state: 'approved', by: who, via: override ? 'bulk-override' : 'bulk',
            hashes: { ...hashes, [j.channel]: it.hash } });
        }
        Object.assign(it, { check: 'ok', checkedBy: who, checkedAt: Date.now(),
          checkedHash: it.hash, checkedChannel: j.channel, checkedContentDigest: it.contentDigest });
      }
    } else if (action === 'remove') {
      await commitRows(j, its.map(it => ({ it, apply: staged => { clearConfirmation(staged); staged.check = 'removed'; } })));
      return { ok: true };
    } else if (action === 'retry') {
      for (const it of its) { clearConfirmation(it); it.status = 'working'; reviewWrites.add(it); }
      await persist(j, true);
      redoAll(j, its).catch(e => console.warn('[bulk] check redo', j.id, rows.join(','), e.message));
      return { ok: true };
    } else return { error: 'unknown action', status: 400 };
    await persist(j, true);
    return { ok: true };
  });
}

// The caller holds the per-job transaction. Stage row changes while storage awaits,
// then publish the row state and the proof for the workbook in the same turn.
async function commitRows(j, updates) {
  const texts = await loadTexts(j);
  const staged = { ...j, items: j.items.map(it => ({ ...it })) };
  for (const { it, text, apply } of updates) {
    const other = staged.items.find(x => x.row === it.row);
    apply(other);
    if (text !== undefined) texts.set(it.row, text);
  }
  await saveTexts(staged, texts, true);
  await writeResult(staged, texts);
  await persist(staged, true);
  for (const { it: item } of updates) {
    const other = staged.items.find(x => x.row === item.row);
    for (const k of Object.keys(item)) if (!Object.hasOwn(other, k)) delete item[k];
    Object.assign(item, other);
  }
  j.resultDigest = staged.resultDigest;
  j.resultRows = staged.resultRows;
}
function commitRender(j, items, c, ai) {
  return transact(j, () => commitRows(j, items.map(it => ({
    it, text: c.text, apply: staged => {
      clearConfirmation(staged);
      Object.assign(staged, { status: 'ok', error: '', images: c.images, allImages: c.allImages,
        chars: c.text.length, summaryErr: c.summaryErr || '', imgs: c.urls || [], unified: c.unified === true,
        hash: c.hash || '', contentDigest: digest(c.text), ai: JSON.parse(JSON.stringify(ai)) });
      staged.flags = flagsFor(j, staged, c);
    },
  }))));
}
// 자동 재시도 (2026-11-27): 작업이 끝난 뒤 뒤에서 — 사람은 결과를 바로 보고, 고쳐지면 그 제품이 '준비됨'으로 옮겨 간다
const retryingJobs = new Set();
function kickRetries(j) {
  if (!j.check || retryingJobs.has(j.id)) return;
  const its = j.items.filter((x) => x.retrying && (x.status === 'ok' || x.status === 'failed'));
  if (!its.length) return;
  retryingJobs.add(j.id);
  return Promise.all(units(its).map(([it, ...same]) => retryLater(j, it, same)))
    .finally(() => retryingJobs.delete(j.id));
}
async function retryLater(j, it, same) {
  const cr = require('./crawler-routes'), all = [it, ...same];
  for (;;) {
    const plan = fixPlan(it, it.ai); if (!plan) break;
    const doCrawl = plan.crawl && (it.crawls || 0) < MAX_CRAWLS, doDraw = plan.draw && (it.tries || 0) < drawsFor(it.ai);
    if (!doCrawl && !doDraw) break;
    // 화면에 무엇을 다시 하는지 알린다 (2026-11-28): 'crawl' lg.com 에서 다시 크롤 · 'draw' PDP 를 다시 그림 — 문제는 it.ai 그대로
    await transact(j, async () => { for (const x of all) x.redo = doCrawl ? 'crawl' : 'draw'; await persist(j, true); });
    if (doCrawl && CRAWL_GAP[it.crawls || 0]) await sleep(CRAWL_GAP[it.crawls || 0]);   // 기다리는 동안은 자리를 잡지 않는다
    await retrySlot(async () => {
      try {
        if (doCrawl) {   // 누락이면 크롤 시점과 상관없이 force 로 — 간격을 두고 (화면은 기다리지 않는다, 뒤에서)
          const k = it.crawls || 0;
          await transact(j, async () => {
            for (const x of all) x.crawls = k + 1;
            await persist(j, true);
          });
          const targets = it.bundle ? (it.ai.find(x => x.k === 'spec')?.crawlParts || [])
            .map(part => it.bundle[part - 1]?.url).filter(Boolean) : [it.url];
          for (const url of new Set(targets)) {
            await crawlSlot(() => cr.crawl(url, { force: true, base: j.base })).catch((e) => console.warn('[bulk] check auto crawl', it.slug, e.message));
          }
          catalog.invalidate();
        }
        if (doDraw) await transact(j, () => { const tries = (it.tries || 0) + 1; for (const x of all) x.tries = tries; });
        const c = await contentSlot(() => (it.bundle ? contentForBundle(j.channel, it, it.bundleTitle, { fresh: true, check: j.check }) : contentFor(j.channel, it.url, { fresh: true, check: j.check })));
        if (c.text.length > CELL_MAX) throw new Error(`too long for one Excel cell (${c.text.length} chars)`);
        const ai = aiChecks(j, it, c);
        if (!retryable({ ...it, status: 'ok' }, ai)) await settleImg(ai);   // 마지막이면 lg.com 원본도 확인
        await commitRender(j, all, c, ai);
        for (const x of all) require('./slice-preview').ensure(x.imgs).catch(() => {});
      } catch (e) {
        console.warn('[bulk] check auto retry', j.id, it.slug, it.crawls || 0, it.tries || 0, e.message);
        if (it.status === 'failed') await transact(j, () => { for (const x of all) x.error = String(e.message || e).slice(0, 300); });
      }
    });
    await transact(j, () => persist(j, true));
  }
  await transact(j, async () => { for (const x of all) { delete x.retrying; delete x.redo; } await persist(j, true); });
}
async function redoAll(j, its) {
  await Promise.all(units(its).map(([first, ...rest]) => redo(j, first, rest)));
}
// 다시 준비 (사람이 누름): 다시 크롤 → 내용 → AI 체크(자동 재시도 없이) → 엑셀 다시
async function redo(j, it, same = []) {
  const cr = require('./crawler-routes');
  try {
    const targets = it.bundle ? it.bundle.map(x => x.url).filter(Boolean) : [it.url];
    for (const url of new Set(targets)) await crawlSlot(() => cr.crawl(url, { force: true, base: j.base }));
    catalog.invalidate();
    const c = it.bundle ? await contentForBundle(j.channel, it, it.bundleTitle, { check: j.check }) : await contentFor(j.channel, it.url, { check: j.check });
    if (c.text.length > CELL_MAX) throw new Error(`too long for one Excel cell (${c.text.length} chars)`);
    await commitRender(j, [it, ...same], c, aiChecks(j, it, c));
  } catch (e) {
    await transact(j, () => {
      for (const x of [it, ...same]) Object.assign(x, { status: x.error && !x.imgs ? 'failed' : 'ok',
        unified: false, ai: [...(x.ai || []).filter(y => y.k !== 'redo'), { k: 'redo', ok: false, msg: String(e.message || e).slice(0, 200) }] });
    });
  }
  await transact(j, async () => { for (const x of [it, ...same]) reviewWrites.delete(x); await persist(j, true); });
}

// ── 확인 필요 ──
function autoFrames(mirror) {
  const out = [];
  for (const s of (mirror && mirror.sections) || []) for (const m of s.media || []) if (m.auto_frame) out.push(m);
  return out;
}
// 이미지 파일 이름 비교용 (crawler-py/coverage_check.py 의 _img_key 와 같은 규칙)
const imgKey = (u) => {
  let k = String(u || '').split('?')[0].replace(/\/jcr:content\/.*$/, '');
  k = k.slice(k.lastIndexOf('/') + 1).toLowerCase().replace(/%20/g, ' ');
  try { k = decodeURIComponent(k); } catch (_) {}
  return k.replace(/[._-]\d{2,4}x\d{2,4}/g, '');
};
const GALLERY = new Set(['PD0012', 'PD0033']);   // 제품 갤러리 (큰 사진 + 썸네일) — 상세(PDP)가 아니다
const NON_CONTENT = new Set(['ST0018', 'PD0016']);   // 누락으로 세지 않는 영역: 바로가기 링크(ST0018) · 구매처(PD0016)
const DUP_DAM = /(?:\/content\/dam\/channel\/wcms){2,}/;   // LG 페이지가 경로를 두 번 붙인 주소 — 이미지가 실제로 있어서 크롤러가 바로잡는다
function flagsFor(j, it, c) {
  const f = [];
  if (it.bundle) f.push({ code: 'bundle', sev: 'info', n: it.bundle.length });   // 묶음 상품: 구성품 N개를 합친 내용 (안내)
  const { images, texts, files, mirror } = qaOf(it.slug);
  // 확인 필요(warn·error)는 '다른 제품일 수 있음' 또는 '다시 돌리면 고쳐질 수 있음'만. 그대로 써도 되는 것은 info(작은 안내)
  if (images) f.push({ code: 'qa', sev: 'warn', images, texts, files });                       // 이미지 누락: 다시 가져오기 · 확인
  if (texts >= 5) f.push({ code: 'qaTx', sev: 'info', texts });                         // 글 누락: 캐러셀 버튼 글자 같은 오탐이 많아 안내만
  const frames = autoFrames(mirror).filter((m) => !m.auto_frame.confirmed).length;
  if (frames) f.push({ code: 'frame', sev: 'info', n: frames });                        // 자동으로 고른 장면은 정상 동작 — 바꾸고 싶을 때만
  if (c && j.channel === 'shopee' && c.allImages > SHOPEE_MAX_IMAGES) f.push({ code: 'over12', sev: 'info', all: c.allImages });   // 앞 12장만 넣는 것은 정한 동작 — 안내만
  if (c && c.summaryErr) f.push({ code: 'summary', sev: 'warn' });
  if (c && c.tooLong) f.push({ code: 'long', sev: 'warn', n: c.tooLong });   // 상품 설명 정보까지 합쳐 Shopee 3,000자 넘음 — 문구를 줄여야
  if (it.fuzzy) f.push({ code: 'fuzzy', sev: 'warn' });
  if (it.alts) f.push({ code: 'alts', sev: 'info', n: it.alts });
  return f;
}

// ── 실행 ──
// 재배포로 끝나는 중 (drain.js): 다음 행은 시작하지 않고 돌고 있는 행만 마친다. 작업은 「진행 중」으로 남겨 새 서버가 이어 한다
let paused = false, runningJobs = 0;
require('./drain').register({ name: 'bulk', pause: () => { paused = true; }, busy: () => runningJobs });

async function run(j) {
  assertSeparateColumns(j);
  const cr = require('./crawler-routes');
  const wbUp = await readUpload(j.upload);
  if (!wbUp) throw new Error('uploaded file expired');
  const wb = await xlsx.load(wbUp.buf);
  const sheet = wb.sheets.find((s) => s.path === j.sheet);
  if (!sheet) throw new Error('sheet not found');
  const contentBy = new Map();     // slug → Promise<content>
  const texts = new Map();         // row → 설명 칸 내용 (작업 기록에는 넣지 않는다)
  // 같은 제품은 작업 안에서 한 번만 크롤 (단품 행과 여러 묶음의 구성품이 겹칠 수 있다 — 같은 폴더에 두 크롤이 동시에 쓰지 않게)
  const crawlBy = new Map();
  const crawlOnce = (url, force, onStart) => {   // onStart: 차례가 와서 실제로 크롤을 시작할 때 ('등록 대기' → '가져오는 중')
    if (!crawlBy.has(url)) crawlBy.set(url, crawlSlot(() => { stop(); if (onStart) onStart(); return cr.crawl(url, { force: !!force, base: j.base }); }).then(() => { catalog.invalidate(); }));
    return crawlBy.get(url);
  };
  j.phase = j.items.some((x) => (x.register || x.force) && !x.crawled) ? 'crawl' : 'content';
  persist(j);
  // 중단(cancel): 아직 시작 안 한 크롤·내용 만들기는 하지 않는다. 이미 돌고 있는 것은 끝나도 결과를 버린다
  const stop = () => {
    if (j.status === 'cancelled') throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (paused) throw Object.assign(new Error('paused for redeploy'), { paused: true });
  };
  await Promise.all(j.items.map(async (it) => {
    if (it.status === 'failed' && !it.retry) return;      // 이어서 할 때: 이미 실패한 것은 그대로
    try {
      stop();
      if (it.bundle) {   // 묶음 상품: 필요한 구성품만 크롤 → 합쳐서 내용 만들기
        if (!it.crawled) {
          const need = it.bundle.filter((x) => x.register || it.force);
          const started = () => { if (it.status !== 'crawling') { it.status = 'crawling'; persist(j); } };
          for (const x of need) { await crawlOnce(x.url, it.force, started); x.crawled = true; }
          it.crawled = true;
          await persist(j, true);
          stop();
        }
        if (!j.items.some((x) => (x.register || x.force) && !x.crawled && x.status !== 'failed')) j.phase = 'content';
        it.status = 'working'; persist(j);
        const key = 'bundle:' + (j.check ? it.row : bundleKey(it));
        if (!contentBy.has(key)) contentBy.set(key, contentSlot(() => { stop(); return contentForBundle(j.channel, it, it.bundleTitle, { check: j.check }); }));
        const c = await contentBy.get(key);
        stop();
        if (c.text.length > CELL_MAX) throw Object.assign(new Error(`too long for one Excel cell (${c.text.length} chars)`), { stage: 'content' });
        texts.set(it.row, c.text);
        if (j.check) {
          const ai = aiChecks(j, it, c);
          if (retryable({ ...it, status: 'ok' }, ai)) it.retrying = 1;
          Object.assign(it, { contentDigest: digest(c.text), ai, imgs: c.urls || [], unified: c.unified === true, hash: c.hash || '' });
          await saveTexts(j, texts, false);
          require('./slice-preview').ensure(it.imgs).catch(() => {});
        }
        Object.assign(it, { status: 'ok', error: '', images: c.images, allImages: c.allImages, chars: c.text.length, summaryErr: '' });
        it.flags = flagsFor(j, it, c);
        it.videos = 0;
        persist(j);
        return;
      }
      if ((it.register || it.force) && !it.crawled) {
        // 차례가 오면 '가져오는 중' (그 전에는 '등록 대기')
        await crawlOnce(it.url, it.force, () => { it.status = 'crawling'; persist(j); });
        it.crawled = true;
        it.slug = cr.slugify(it.url);
        catalog.invalidate();
        const sum = cr.productSummary(it.slug);   // 목록에 새로 등록한 제품 썸네일·제목
        if (sum) Object.assign(it, { thumb: sum.thumb || '', title: sum.title || '' });
        await persist(j, true);   // 크롤이 끝난 것은 바로 기록 — 재시작해도 다시 크롤하지 않게
        stop();
      }
      if (!it.slug) it.slug = cr.slugify(it.url);
      if (!j.items.some((x) => (x.register || x.force) && !x.crawled && x.status !== 'failed')) j.phase = 'content';
      if (lgEmpty(it.slug)) throw Object.assign(new Error('no content on lg.com'), { empty: true });
      it.status = 'working'; persist(j);
      if (!contentBy.has(it.slug)) contentBy.set(it.slug, contentSlot(() => { stop(); return contentFor(j.channel, it.url, { check: j.check }); }));
      let c = await contentBy.get(it.slug);
      stop();
      if (j.check) {   // 자동 재시도(다시 크롤)는 기다리지 않는다 — 작업이 끝난 뒤 뒤에서 (retryLater). 그동안 화면엔 '검토 필요 · 다시 시도 중'
        const ai = aiChecks(j, it, c);
        if (retryable(it, ai)) it.retrying = 1;
        Object.assign(it, { ai, contentDigest: digest(c.text), imgs: c.urls || [], unified: c.unified === true, hash: c.hash || '' }); stop();
        require('./slice-preview').ensure(it.imgs).catch(() => {}); }   // Check 화면용 작은 미리보기를 미리 (원본은 그대로)
      if (c.text.length > CELL_MAX) throw Object.assign(new Error(`too long for one Excel cell (${c.text.length} chars)`), { stage: 'content' });
      texts.set(it.row, c.text);
      if (j.check) await saveTexts(j, texts, false);
      Object.assign(it, { status: 'ok', error: '', images: c.images, allImages: c.allImages, chars: c.text.length, summaryErr: c.summaryErr, edited: !!c.edited });
      it.flags = flagsFor(j, it, c);
      it.videos = productVideos(readJson(path.join(OUT_DIR(), it.slug, 'mirror.json'))).length;   // 동영상 장면 바꾸기 버튼 (shared/clia-frame-picker.js)
    } catch (e) {
      if (e.cancelled || j.status === 'cancelled') { it.status = 'cancelled'; persist(j); return; }
      if (e.paused) { it.status = 'queued'; return; }   // 새 서버가 이어서 (크롤이 끝난 것은 crawled 로 남아 다시 크롤하지 않는다)
      const msg = String(e.message || e).slice(0, 300);
      if (e.empty) { Object.assign(it, { status: 'failed', empty: true, error: msg, flags: [{ code: 'empty', sev: 'info', msg }] }); persist(j); return; }
      const stage = (it.register || it.force) && !it.crawled ? 'crawl' : 'content';
      Object.assign(it, { status: 'failed', error: msg, flags: [{ code: stage, sev: 'error', msg }] });
      if (j.check && retryable(it, [])) it.retrying = 1;   // 벌크 Check: 준비 실패도 작업이 끝난 뒤 자동으로 다시 크롤
    }
    persist(j);
  }));
  if (j.status === 'cancelled') return;   // 중단했으면 엑셀을 만들지 않는다
  if (paused) return;                      // 재배포: 새 서버가 이어서 엑셀까지 만든다
  j.phase = 'write';
  if (j.check) {
    await transact(j, async () => { await saveTexts(j, texts, true); await writeResult(j, texts); });
    return;
  }
  for (const it of j.items) {
    if (it.status !== 'ok' || (j.check && incompletePdp(it))) continue;
    it.prevLen = String((sheet.rows.get(it.row) || new Map()).get(j.descCol) || '').trim().length;
    wb.setCell(j.sheet, it.row, j.descCol, texts.get(it.row));
  }
  // SKU 번호가 비어 있던 행에 사용자가 넣은 SKU
  for (const x of j.skus || []) if (j.skuCol) wb.setCell(j.sheet, x.row, j.skuCol, x.sku);
  if (!j.items.some((x) => x.status === 'ok')) throw new Error('no row could be filled');
  const buf = await wb.save();
  fs.mkdirSync(path.join(DIR, j.upload), { recursive: true });
  fs.writeFileSync(path.join(DIR, j.upload, `result-${j.id}.xlsx`), buf);
  await store.putBuffer(`bulk/${j.upload}/result-${j.id}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').catch(() => {});
}

function start(j) {
  jobs.set(j.id, j);
  j.status = 'running';
  activeList((ids) => [...new Set([...ids, j.id])]).catch(() => {});
  runningJobs++;
  run(j)
    .then(() => { if (j.status !== 'cancelled' && !paused) j.status = 'ready'; })
    .catch((e) => { if (j.status === 'cancelled') return; j.status = 'failed'; j.error = e.message; console.error('[bulk] failed', j.id, e.message); })
    .finally(async () => {
      if (paused && j.status === 'running') {   // 재배포로 멈춤 — 「진행 중」으로 남겨 두고 새 서버가 이어 한다
        await persist(j, true).catch(() => {});
        console.log(`[bulk] paused for redeploy ${j.id} (${j.items.filter((x) => x.status === 'ok').length} ok so far)`);
        runningJobs--;
        return;
      }
      runningJobs--;
      j.finishedAt = Date.now(); j.phase = 'done';
      console.log(`[bulk] ${j.status} ${j.outName}: ok ${j.items.filter((x) => x.status === 'ok').length}, failed ${j.items.filter((x) => x.status === 'failed').length}`);
      if (j.status !== 'cancelled') await notify(j).catch((e) => console.warn('[bulk] notify', e.message));   // 중단한 작업은 메일을 보내지 않는다
      if (j.status === 'failed') await alertAdmin(j).catch((e) => console.warn('[bulk] admin alert', e.message));
      await transact(j, () => persist(j, true));
      await activeList((ids) => ids.filter((x) => x !== j.id)).catch(() => {});
      if (j.status === 'ready') kickRetries(j);
    });
  return j;
}

function create({ upload, channel, country, sheet, descCol, items, outName, base, notify: nt, lang, skus, skuCol, check }) {
  const j = { id: crypto.randomBytes(8).toString('hex'), upload, channel, country: country || countryOf({ items }), sheet, descCol, items, outName, base, lang, check: check || null,
    skus: skus && skus.length && skuCol ? skus : [], skuCol: skuCol || null,
    notify: nt && nt.email ? { email: nt.email, lang } : null, status: 'running', phase: 'queued', error: '', at: Date.now() };
  for (const [k, x] of jobs) if (Date.now() - (x.at || 0) > KEEP_MS) jobs.delete(k);
  cleanup();
  return start(j);
}

// 중단: 실수로 내보내기를 눌렀을 때. 이미 CLIA 에 등록한 제품은 그대로 두고, 엑셀은 만들지 않는다
async function cancel(j) {
  if (j.status !== 'running') return false;
  j.status = 'cancelled'; j.cancelledAt = Date.now();
  for (const it of j.items) if (it.status === 'queued') it.status = 'cancelled';
  console.log(`[bulk] cancel ${j.id} (${j.outName})`);
  await persist(j, true);
  await activeList((ids) => ids.filter((x) => x !== j.id)).catch(() => {});   // 재시작해도 다시 돌리지 않게
  return true;
}

// 재배포·재시작 뒤: 진행 중이던 작업을 이어서 (크롤이 끝난 제품은 캐시라 바로 넘어간다)
async function resumeAll() {
  const ids = await activeList().catch(() => []);
  for (const id of ids) {
    const j = await getJob(id);
    if (!j || j.status !== 'running') { await activeList((xs) => xs.filter((x) => x !== id)).catch(() => {}); continue; }
    for (const it of j.items) if (it.status !== 'failed') it.status = 'queued';
    if (j.notify) j.notify.sending = false;   // 크롤이 끝난 것(crawled)은 내용만 다시
    console.log(`[bulk] resume ${id} (${j.items.length} rows)`);
    start(j);
  }
}

// ── 끝났을 때 메일 (lge-d2c.com Resend) — 내용은 bulk-mail.js ──
function notify(j) {
  return transact(j, async () => {
    const to = j.notify && j.notify.email;
    const key = process.env.RESEND_API_KEY, from = process.env.CLIA_MAIL_FROM;
    if (!to || !key || !from || j.notify.sent) return;
    await sendMail(j, to, key, from);
  });
}
async function sendMail(j, to, key, from) {
  const base = (process.env.PUBLIC_BASE_URL || j.base || '').replace(/\/$/, '');
  // 완성된 엑셀을 메일에 첨부 (너무 크면 받기 링크만)
  let attachments;
  const denied = deliveryDenial(j);
  const bytes = denied ? null : await resultBytes(j);
  const buf = bytes && !deliveryDenial(j) ? bytes : null;
  if (buf && buf.length <= MAIL_ATTACH_MAX) attachments = [{ filename: j.outName, content: buf.toString('base64') }];
  const m = require('./bulk-mail').build(j, { base, attached: !!attachments, reviewRequired: !!(j.check && !buf) });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: m.subject, html: m.html, text: m.text, ...(attachments ? { attachments } : {}) }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`mail HTTP ${r.status}`);
  j.notify.sent = true;
}
// 작업이 실패하면 담당자(BULK_ADMIN_EMAIL, 쉼표로 여러 명 — 첫 번째 To, 나머지 CC)에게 자동으로 — 사용자가 메일을 신청했든 안 했든
async function alertAdmin(j) {
  const mail = require('./bulk-mail');
  const to = mail.admins();
  const key = process.env.RESEND_API_KEY, from = process.env.CLIA_MAIL_FROM;
  if (!to.length || !key || !from || j.adminSent) return;
  j.adminSent = true;
  const m = mail.buildAdmin(j, { base: (process.env.PUBLIC_BASE_URL || j.base || '').replace(/\/$/, '') });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // 첫 번째 담당자는 받는 사람(To), 나머지는 참조(CC)
    body: JSON.stringify({ from, to: [to[0]], ...(to.length > 1 ? { cc: to.slice(1) } : {}), subject: m.subject, html: m.html, text: m.text, ...(j.notify && j.notify.email ? { reply_to: j.notify.email } : {}) }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) { j.adminSent = false; throw new Error(`mail HTTP ${r.status}`); }
}
const MAIL_ATTACH_MAX = 15 * 1024 * 1024;   // Resend 한도(40MB)보다 넉넉히 작게
// 내보내기 시작 뒤 팝업에서 받은 메일 주소 — 이미 끝났으면 바로 보낸다
async function setNotify(j, email, lang) {
  await transact(j, async () => {
    j.notify = { email, lang: lang || j.lang || 'en' };
    await persist(j, true);
  });
  if (j.status !== 'running') { await notify(j); await transact(j, () => persist(j, true)); }
  return j;
}
const mailReady = () => !!(process.env.RESEND_API_KEY && process.env.CLIA_MAIL_FROM);
function emailOk(e) {
  if (!/^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i.test(String(e || ''))) return false;
  const allow = String(process.env.BULK_NOTIFY_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !allow.length || allow.some((d) => String(e).toLowerCase().endsWith('@' + d) || String(e).toLowerCase().endsWith('.' + d));
}

module.exports = { countryOf, create, cancel, setNotify, getJob, jobView, resumeAll, saveUpload, readUpload, mailReady, emailOk, CRAWL_CONC, DIR, checkAction, exportBlocked, deliver, aiChecks, skuConflict, _kickRetries: kickRetries, RETRY_CONC, _commitRender: commitRender, _sendMail: sendMail, _contentFor: contentFor, _writeResult: writeResult, _fixPlan: fixPlan, _settleImg: settleImg, _retryable: retryable, _lgEmpty: lgEmpty };
