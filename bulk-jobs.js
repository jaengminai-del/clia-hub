/**
 * bulk-jobs.js — 벌크 엑셀 작업 실행 (2026-11-19)
 *
 * 한 작업 = 고른 행들을 (필요하면 먼저 LG.com 에서 크롤해 CLIA 에 등록하고) 설명 칸 내용을 만들어 엑셀에 쓴다.
 *   크롤: 서버 전체에서 동시에 BULK_CRAWL_CONC(기본 2)개 — 200개를 한 번에 띄우면 서버가 버티지 못한다
 *   내용: 작업마다 동시에 2개 (/api/ebay-generate → /api/v1/slice-html, Lazada 는 /api/v1/pdp-summary 도)
 *   확인 필요(flags): 크롤·생성 실패, 원문 누락, 동영상 장면 자동 선택, Shopee 12장 초과, Lazada 요약 실패, 주소 추정
 *   보관: 작업·올린 파일·결과를 로컬 + 버킷(bulk/…)에 7일 — 재배포·재시작 뒤 진행 중이던 작업을 이어서 한다
 *   알림: 끝나면 메일 (RESEND_API_KEY + CLIA_MAIL_FROM 이 있을 때, lge-d2c.com 발신) · 화면은 브라우저 알림
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('./bulk-xlsx');
const store = require('./crawl-store');
const catalog = require('./bulk-catalog');
const { productVideos } = require('./video-frames');   // 동영상 장면: 빌더와 같은 목록·저장 (video-frames.js)

const DIR = path.join(__dirname, 'media-cache', 'bulk');
const KEEP_MS = 7 * 24 * 3600 * 1000;
const SHOPEE_MAX_IMAGES = 12;
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
  let j = readJson(jobFile(id));
  if (!j) { const b = await store.getBuffer(`bulk/jobs/${id}.json`).catch(() => null); try { j = b && JSON.parse(b.toString('utf8')); } catch (_) {} }
  if (j) jobs.set(id, j);
  return j || null;
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

function jobView(j) {
  const done = j.status !== 'running' && j.status !== 'queued';
  // 동영상 수(장면 바꾸기 버튼)는 이 기능 전에 끝난 작업 기록에 없어서 다시 열 때 센다
  const withVideos = (it) => (it.status === 'ok' && it.slug && it.videos == null
    ? { ...it, videos: productVideos(readJson(path.join(OUT_DIR(), it.slug, 'mirror.json'))).length } : it);
  const its = done ? j.items.map((it) => { const flags = currentFlags(j, it); return withVideos(flags === it.flags ? it : { ...it, flags }); }) : j.items;
  const fin = (x) => x.status === 'ok' || x.status === 'failed';
  return { id: j.id, upload: j.upload, status: j.status, error: j.error, channel: j.channel, phase: j.phase,
    total: its.length, done: its.filter(fin).length,
    ok: its.filter((x) => x.status === 'ok').length, failed: its.filter((x) => x.status === 'failed').length,
    replaced: its.filter((x) => x.status === 'ok' && x.prevLen > 0).length,
    crawlTotal: its.filter((x) => x.register || x.force).length, crawlDone: its.filter((x) => (x.register || x.force) && (x.crawled || x.status === 'failed')).length,
    review: its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info')).length,
    notify: j.notify ? { email: !!j.notify.email, sent: !!j.notify.sent } : null,
    items: its, file: j.status === 'ready' ? `/api/v1/bulk/jobs/${j.id}/file` : null, fileName: j.outName, at: j.at, finishedAt: j.finishedAt };
}

// ── 내용 만들기 (같은 서버의 기존 API) ──
async function post(p, body, timeoutMs) {
  const r = await fetch(LOCAL() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status} ${p}`);
  return j;
}
async function contentFor(channel, url) {
  const listing = channel === 'lazada';
  // PDP 요약(태국어)은 태국 제품만 — 싱가포르 등은 요약 없이 이미지만 (2026-11-23)
  const summaryP = channel === 'lazada' && /lg\.com\/th\//i.test(url) ? post('/api/v1/pdp-summary', { url }, 7 * 60 * 1000).catch((e) => ({ error: e.message })) : null;
  const g = await post('/api/ebay-generate', { url, medium: 'shopee_lazada', listing }, 5 * 60 * 1000);
  if (!g.html) throw new Error('generate returned no HTML');
  const sl = await post('/api/v1/slice-html', { html: g.html, medium: 'shopee_lazada' }, 12 * 60 * 1000);
  if (channel === 'shopee') {
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    if (!urls.length) throw new Error('no images');
    return { text: urls.join('\n'), images: urls.length, allImages: sl.count, summaryErr: '' };
  }
  const sm = await summaryP;
  return { text: (sm && sm.html ? sm.html + '\n' : '') + sl.html, images: sl.count, allImages: sl.count, summaryErr: sm && sm.error ? sm.error.slice(0, 200) : '' };
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
const NON_CONTENT = new Set(['ST0018', 'PD0016']);   // 누락으로 세지 않는 영역: 바로가기 링크(ST0018) · 구매처(PD0016)
const DUP_DAM = /(?:\/content\/dam\/channel\/wcms){2,}/;   // LG 페이지가 경로를 두 번 붙인 주소 — 이미지가 실제로 있어서 크롤러가 바로잡는다
function flagsFor(j, it, c) {
  const f = [];
  const dir = path.join(OUT_DIR(), it.slug || '');
  const mirror = readJson(path.join(dir, 'mirror.json'));
  const qa = readJson(path.join(dir, 'qa_report.json')) || (mirror && mirror._qa) || {};
  // 원문 누락: 일부러 빼는 것(바로가기 링크 영역 ST0018 · 탭 카드 안 글)은 세지 않는다 — 그대로 세면 거의 모든 제품이 걸린다.
  // 구매처 영역(PD0016 Where to buy)도 컨텐츠가 아니다 — 이 규칙 전에 크롤한 제품의 검사 기록에는 그 썸네일이 누락으로 들어 있다
  // 실제로 빠진 이미지가 있거나, 본문 글이 5개 이상 빠졌을 때만
  const cov = qa.coverage || {}, chk = qa.checks || {};
  const real = (x) => x && !NON_CONTENT.has(x.component_id);
  const texts = (cov.missing_texts || []).filter((x) => real(x) && !x.only_in_cards).length;
  // 예전에 크롤한 결과의 검사 기록에는 '크롤러가 일부러 뺀 이미지(LG 가 404·자리표시를 내줌)'가 누락으로 들어 있다 — 그것은 빼고 센다.
  // 새 크롤은 검사가 이미 제외한다. 주소가 겹쳐 있던 것은 실제로 이미지를 잃은 것이라 그대로 센다 (다시 가져오면 고쳐진다).
  const dead = new Set(((mirror && mirror._dead_media_dropped) || []).filter((d) => !DUP_DAM.test(d.url || '')).map((d) => imgKey(d.url)));
  const gone = (cov.missing_images || []).filter(real).filter((x) => !dead.has(imgKey(x.image)));
  const images = gone.length + (chk.images_missing_url || 0);
  const files = gone.slice(0, 3).map((x) => String(x.image || '').split('/').pop());   // 어떤 이미지가 빠졌는지 (화면에서 마우스를 올리면 보임)
  // 확인 필요(warn·error)는 '다른 제품일 수 있음' 또는 '다시 돌리면 고쳐질 수 있음'만. 그대로 써도 되는 것은 info(작은 안내)
  if (images) f.push({ code: 'qa', sev: 'warn', images, texts, files });                       // 이미지 누락: 다시 가져오기 · 확인
  if (texts >= 5) f.push({ code: 'qaTx', sev: 'info', texts });                         // 글 누락: 캐러셀 버튼 글자 같은 오탐이 많아 안내만
  const frames = autoFrames(mirror).filter((m) => !m.auto_frame.confirmed).length;
  if (frames) f.push({ code: 'frame', sev: 'info', n: frames });                        // 자동으로 고른 장면은 정상 동작 — 바꾸고 싶을 때만
  if (c && j.channel === 'shopee' && c.allImages > SHOPEE_MAX_IMAGES) f.push({ code: 'over12', sev: 'info', all: c.allImages });   // 앞 12장만 넣는 것은 정한 동작 — 안내만
  if (c && c.summaryErr) f.push({ code: 'summary', sev: 'warn' });
  if (it.fuzzy) f.push({ code: 'fuzzy', sev: 'warn' });
  if (it.alts) f.push({ code: 'alts', sev: 'info', n: it.alts });
  return f;
}

// ── 실행 ──
async function run(j) {
  const cr = require('./crawler-routes');
  const wbUp = await readUpload(j.upload);
  if (!wbUp) throw new Error('uploaded file expired');
  const wb = await xlsx.load(wbUp.buf);
  const sheet = wb.sheets.find((s) => s.path === j.sheet);
  if (!sheet) throw new Error('sheet not found');
  const contentBy = new Map();     // slug → Promise<content>
  const texts = new Map();         // row → 설명 칸 내용 (작업 기록에는 넣지 않는다)
  const contentSlot = limiter(2);
  j.phase = j.items.some((x) => (x.register || x.force) && !x.crawled) ? 'crawl' : 'content';
  persist(j);
  // 중단(cancel): 아직 시작 안 한 크롤·내용 만들기는 하지 않는다. 이미 돌고 있는 것은 끝나도 결과를 버린다
  const stop = () => { if (j.status === 'cancelled') throw Object.assign(new Error('cancelled'), { cancelled: true }); };
  await Promise.all(j.items.map(async (it) => {
    if (it.status === 'failed' && !it.retry) return;      // 이어서 할 때: 이미 실패한 것은 그대로
    try {
      stop();
      if ((it.register || it.force) && !it.crawled) {
        // 차례가 오면 '가져오는 중' (그 전에는 '등록 대기')
        await crawlSlot(() => { stop(); it.status = 'crawling'; persist(j); return cr.crawl(it.url, { force: !!it.force, base: j.base }); });
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
      it.status = 'working'; persist(j);
      if (!contentBy.has(it.slug)) contentBy.set(it.slug, contentSlot(() => { stop(); return contentFor(j.channel, it.url); }));
      const c = await contentBy.get(it.slug);
      stop();
      if (c.text.length > CELL_MAX) throw Object.assign(new Error(`too long for one Excel cell (${c.text.length} chars)`), { stage: 'content' });
      texts.set(it.row, c.text);
      Object.assign(it, { status: 'ok', error: '', images: c.images, allImages: c.allImages, chars: c.text.length, summaryErr: c.summaryErr });
      it.flags = flagsFor(j, it, c);
      it.videos = productVideos(readJson(path.join(OUT_DIR(), it.slug, 'mirror.json'))).length;   // 동영상 장면 바꾸기 버튼 (shared/clia-frame-picker.js)
    } catch (e) {
      if (e.cancelled || j.status === 'cancelled') { it.status = 'cancelled'; persist(j); return; }
      const msg = String(e.message || e).slice(0, 300);
      const stage = (it.register || it.force) && !it.crawled ? 'crawl' : 'content';
      Object.assign(it, { status: 'failed', error: msg, flags: [{ code: stage, sev: 'error', msg }] });
    }
    persist(j);
  }));
  if (j.status === 'cancelled') return;   // 중단했으면 엑셀을 만들지 않는다
  j.phase = 'write';
  for (const it of j.items) {
    if (it.status !== 'ok') continue;
    it.prevLen = String((sheet.rows.get(it.row) || new Map()).get(j.descCol) || '').trim().length;
    wb.setCell(j.sheet, it.row, j.descCol, texts.get(it.row));
  }
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
  run(j)
    .then(() => { if (j.status !== 'cancelled') j.status = 'ready'; })
    .catch((e) => { if (j.status === 'cancelled') return; j.status = 'failed'; j.error = e.message; console.error('[bulk] failed', j.id, e.message); })
    .finally(async () => {
      j.finishedAt = Date.now(); j.phase = 'done';
      console.log(`[bulk] ${j.status} ${j.outName}: ok ${j.items.filter((x) => x.status === 'ok').length}, failed ${j.items.filter((x) => x.status === 'failed').length}`);
      if (j.status !== 'cancelled') await notify(j).catch((e) => console.warn('[bulk] notify', e.message));   // 중단한 작업은 메일을 보내지 않는다
      if (j.status === 'failed') await alertAdmin(j).catch((e) => console.warn('[bulk] admin alert', e.message));
      await persist(j, true);
      await activeList((ids) => ids.filter((x) => x !== j.id)).catch(() => {});
    });
  return j;
}

function create({ upload, channel, sheet, descCol, items, outName, base, notify: nt, lang }) {
  const j = { id: crypto.randomBytes(8).toString('hex'), upload, channel, sheet, descCol, items, outName, base, lang,
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
async function notify(j) {
  const to = j.notify && j.notify.email;
  const key = process.env.RESEND_API_KEY, from = process.env.CLIA_MAIL_FROM;
  if (!to || !key || !from || j.notify.sent || j.notify.sending) return;
  j.notify.sending = true;   // 끝날 때 · 주소를 받을 때 거의 동시에 불려도 한 번만
  try { await sendMail(j, to, key, from); } finally { j.notify.sending = false; }
}
async function sendMail(j, to, key, from) {
  const base = (process.env.PUBLIC_BASE_URL || j.base || '').replace(/\/$/, '');
  // 완성된 엑셀을 메일에 첨부 (너무 크면 받기 링크만)
  let attachments;
  if (j.status === 'ready') {
    const fp = path.join(DIR, j.upload, `result-${j.id}.xlsx`);
    const buf = fs.existsSync(fp) ? fs.readFileSync(fp) : await store.getBuffer(`bulk/${j.upload}/result-${j.id}.xlsx`).catch(() => null);
    if (buf && buf.length <= MAIL_ATTACH_MAX) attachments = [{ filename: j.outName, content: buf.toString('base64') }];
  }
  const m = require('./bulk-mail').build(j, { base, attached: !!attachments });
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
  j.notify = { email, lang: lang || j.lang || 'en' };
  await persist(j, true);
  if (j.status !== 'running') { await notify(j); await persist(j, true); }
  return j;
}
const mailReady = () => !!(process.env.RESEND_API_KEY && process.env.CLIA_MAIL_FROM);
function emailOk(e) {
  if (!/^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i.test(String(e || ''))) return false;
  const allow = String(process.env.BULK_NOTIFY_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !allow.length || allow.some((d) => String(e).toLowerCase().endsWith('@' + d) || String(e).toLowerCase().endsWith('.' + d));
}

module.exports = { create, cancel, setNotify, getJob, jobView, resumeAll, saveUpload, readUpload, mailReady, emailOk, CRAWL_CONC, DIR };
