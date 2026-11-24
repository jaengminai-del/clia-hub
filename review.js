/**
 * review.js — Shopee/Lazada PDP 검토·승인 화면(/review/)의 데이터 (2026-11-24, 목업 v12 를 운영으로)
 *
 * 검토하는 것은 빌더·벌크 엑셀이 내려받는 것과 같은 이미지다:
 *   설명 HTML = 빌더 편집본(edits.js)이 있으면 그것, 없으면 /api/ebay-generate (벌크 엑셀 contentFor 와 같은 순서)
 *   → /api/v1/slice-html (같은 HTML 이면 같은 해시 → 같은 이미지·같은 주소)
 *   + 태국 제품은 /api/v1/pdp-summary (Lazada 는 HTML, Shopee 는 태그 없는 글 + 앞 12장 · 3,000자)
 *   + lg.com 전체 화면 캡처(/api/v1/fullshot — 없으면 캡처) → crawler-py/review_prep.py 로 PDP 시작·끝, 이미지마다 USP 이름
 * 결과는 crawler-py/out/<slug>/review-<channel>.json (버킷에도). 크롤·편집본·요약이 바뀌면 stale → 다시 준비.
 * lg.com 캡처의 PDP 시작·끝을 사람이 고친 값은 out/<slug>/review-crop.json (캡처 key 가 같을 때만 쓴다).
 *
 *   GET  /api/v1/review/list?country=th            → { countries, gate, products: [{ slug, model, title, dv, grp, thumb, approval, prep }] }
 *   GET  /api/v1/review/item/:slug?channel=shopee  → { product, approval, gate, state, job, data }
 *   POST /api/v1/review/item/:slug/prepare { channel, recapture? }  → 준비 시작 (이미 있으면 그대로)
 *   POST /api/v1/review/item/:slug/crop    { top, bottom, by? }      → lg.com 캡처 PDP 범위 고침 (top=null 이면 자동으로)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cr = require('./crawler-routes');
const store = require('./crawl-store');
const approvals = require('./approvals');

const router = express.Router();
const CHANNELS = new Set(['shopee', 'lazada']);
// 준비 결과 판: 2 = 같은 영역 기준점(align) 추가 (2026-11-24) — 낮은 판은 「내용 바뀜」으로 보고 다시 준비
const PREP_V = 2;
const SHOPEE_MAX_IMAGES = 12, SHOPEE_DESC_MAX = 3000;   // bulk-jobs.js 와 같은 규칙
const LOCAL = () => (process.env.BULK_API_BASE || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');
const PY_DIR = path.join(__dirname, 'crawler-py');
const python = () => process.env.CRAWLER_PYTHON || (fs.existsSync(path.join(PY_DIR, '.venv', 'bin', 'python')) ? path.join(PY_DIR, '.venv', 'bin', 'python') : 'python3');
const SLICE_CACHE = path.join(__dirname, 'media-cache', 'slices');
const FULLSHOT_DIR = path.join(__dirname, 'media-cache', 'fullshot');
const readJson = (fp) => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; } };
const cleanSlug = (s) => path.basename(String(s || ''));
const dirOf = (slug) => path.join(cr.OUT_DIR, cleanSlug(slug));
const fileOf = (slug, ch) => path.join(dirOf(slug), `review-${ch}.json`);
const cropFile = (slug) => path.join(dirOf(slug), 'review-crop.json');
const isTh = (url) => /lg\.com\/th\//i.test(url || '');

/** 지금 내용의 지문 — 준비한 뒤 크롤·편집본·요약이 바뀌었는지 */
function sigOf(slug, ch, sum = cr.productSummary(cleanSlug(slug))) {   // sum: { url, crawled_at } (목록은 제품 색인 값 — mirror.json 을 다시 읽지 않게)
  const d = dirOf(slug);
  const e = readJson(path.join(d, `edit-${ch}.json`));
  let sumAt = 0;
  try { sumAt = Math.round(fs.statSync(path.join(d, 'summary.json')).mtimeMs); } catch (_) {}
  return { crawled_at: sum ? Number(sum.crawled_at) || 0 : 0, edit_at: e && fs.existsSync(path.join(d, `edit-${ch}.html`)) ? Number(e.at) || 0 : 0,
           sum_at: sum && isTh(sum.url) ? sumAt : 0 };
}
const sameSig = (a, b) => !!a && !!b && Math.abs(a.crawled_at - b.crawled_at) <= 1 && a.edit_at === b.edit_at && a.sum_at === b.sum_at;

// ── 준비 작업 (한 번에 2개) ──
const jobs = new Map();   // `${slug}|${ch}` → { state: 'pending'|'error', step, at, error, bg }
const queue = [];          // [{ slug, ch, opts, bg }] — 사람이 연 것(bg=false)이 늘 먼저
let running = 0, runningBg = 0;
// 미리 준비 (2026-11-24): 검토하는 사람이 기다리지 않게, 서버가 Shopee/Lazada 법인 제품을 차례로 미리 준비한다.
//   REVIEW_PREWARM=0 이면 끔 · REVIEW_PREWARM_COUNTRIES (기본 th,sg) · REVIEW_PREWARM_CONC (기본 1, 최대 4)
//   준비가 안 됐거나(none) 내용이 바뀐(stale) 채널만. 실패한 것은 6시간 뒤에 다시. 10분마다 다시 훑는다(새로 크롤한 제품 · 편집본 저장).
const PREWARM = process.env.REVIEW_PREWARM !== '0';
const PREWARM_COUNTRIES = new Set(String(process.env.REVIEW_PREWARM_COUNTRIES || 'th,sg').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
// 미리 준비 동시 수: 1~4 (운영 4 vCPU · 16GB — 4개면 CPU 한도 가까이, 그 이상은 사용자 작업이 느려지고 lg.com 차단 위험, 2026-11-24)
const BG_CONC = Math.max(1, Math.min(4, parseInt(process.env.REVIEW_PREWARM_CONC, 10) || 1));
// 전체 동시 수 = 미리 준비 + 1 — 미리 준비가 꽉 차 있어도 사람이 연 제품은 바로 시작한다
const CONC = Math.max(2, BG_CONC + 1);
// 기본은 전부 준비 — lg.com 캡처 · 상세 이미지 · PDP 요약까지 (검토 화면에서 누르면 바로 보이게, 2026-11-24 사용자 결정).
//   REVIEW_PREWARM_MODE=existing 이면 크롤 데이터와 이미 있는 요약·캡처만으로 (AI 요약 · Firecrawl 캡처를 새로 만들지 않음 — 빈 것은 사람이 열 때 채움)
const PREWARM_EXISTING_ONLY = process.env.REVIEW_PREWARM_MODE === 'existing';

async function post(p, body, timeoutMs) {
  const r = await fetch(LOCAL() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status} ${p}`);
  return j;
}
async function getJ(p, timeoutMs = 30000) {
  const r = await fetch(LOCAL() + p, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status} ${p}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sliceManifest(hash) {
  const fp = path.join(SLICE_CACHE, hash, 'manifest.json');
  const m = readJson(fp);
  if (m) return m;
  const buf = await store.getBuffer(`media-slices/${hash}/manifest.json`).catch(() => null);
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}

/** lg.com 전체 화면 캡처 — 있으면 그것, 없으면(또는 recapture) 캡처하고 기다린다 (최대 4분) */
async function fullshot(url, recapture, step, existingOnly = false, directOnly = false) {
  const q = '/api/v1/fullshot?url=' + encodeURIComponent(url);
  let st = await getJ(q);
  if (st.status === 'ready' && !recapture) return st;
  if (existingOnly && st.status !== 'pending') return st;   // 미리 준비: 있는 캡처만 (새로 찍지 않는다)
  if (st.status !== 'pending') {
    step('fullshot');
    // recapture: 있는 캡처도 다시 찍는다 (지연 로드가 덜 찍힌 캡처 — 새 캡처가 성공해야 바뀐다)
    st = await post('/api/v1/fullshot', { url, retry: true, force: !!recapture, ...(directOnly ? { via: 'direct' } : {}) }, 30000);
  }
  for (let i = 0; i < 120 && st.status === 'pending'; i++) { await sleep(2000); st = await getJ(q); }
  return st;
}

function runPrep(input) {
  return new Promise((resolve, reject) => {
    const p = require('child_process').execFile(python(), ['review_prep.py'], { cwd: PY_DIR, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out, stderr) => {
      let d = {};
      try { d = JSON.parse(String(out || '')); } catch (_) {}
      if (err || d.error) return reject(new Error(d.error || String(stderr || err.message).trim().split('\n').pop().slice(0, 300)));
      resolve(d);
    });
    p.stdin.end(JSON.stringify(input));
  });
}

// existingOnly (미리 준비): 크롤 데이터와 이미 있는 것만으로 — PDP 요약(AI)·lg.com 캡처(Firecrawl)를 새로 만들지 않는다.
//   빠진 것은 사람이 그 제품을 열 때 채운다 (화면이 force 로 다시 준비 → 아래 existingOnly=false)
// bg (미리 준비): lg.com 캡처는 직접(Playwright)만 — 막히면 Firecrawl 로 넘기지 않고 비워 두고, 사람이 열 때 채운다
async function prepare(slug, ch, { recapture = false, existingOnly = false, bg = false } = {}) {
  const key = `${slug}|${ch}`, job = jobs.get(key);
  const step = (s) => { job.step = s; };
  const sum = cr.productSummary(slug);
  if (!sum) throw new Error('product not found');
  const sig = sigOf(slug, ch);
  // 1) 설명 HTML — 벌크 엑셀과 같은 순서 (편집본 → 크롤 데이터로 새로)
  step('html');
  const ed = require('./edits').getEdit(slug, ch);
  const html = ed ? ed.html : (await post('/api/ebay-generate', { url: sum.url, medium: 'shopee_lazada', listing: ch === 'lazada' }, 5 * 60 * 1000)).html;
  if (!html) throw new Error('generate returned no HTML');
  // 2) 슬라이스 이미지 (빌더 이미지 ZIP·이미지형 HTML·벌크 엑셀과 같은 해시)
  step('slices');
  const sl = await post('/api/v1/slice-html', { html, medium: 'shopee_lazada' }, 12 * 60 * 1000);
  const man = await sliceManifest(sl.hash);
  if (!man || !(man.images || []).length) throw new Error('slice manifest missing');
  const slices = man.images.map((im) => ({ src: `/media/slices/${sl.hash}/${im.file}`, w: im.width, h: im.height, text: im.text || '' }));
  // 3) PDP 요약 (태국 제품만 — 벌크와 같다)
  let sm = null, summaryErr = '';
  if (isTh(sum.url)) {
    step('summary');
    sm = await post('/api/v1/pdp-summary', { url: sum.url, cachedOnly: existingOnly }, 7 * 60 * 1000).catch((e) => {
      if (!(existingOnly && /no summary yet/.test(e.message))) summaryErr = String(e.message).slice(0, 200);
      return null;
    });
  }
  let shopeeN = slices.length, shopeeChars = 0;
  if (ch === 'shopee') {   // bulk-jobs.contentFor 와 같은 자르기: 앞 12장, 요약 + 주소가 3,000자를 넘으면 뒤에서부터 뺀다
    const top = sm && sm.text ? sm.text.trim() + '\n\n' : '';
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    while (urls.length > 1 && (top + urls.join('\n')).length > SHOPEE_DESC_MAX) urls.pop();
    shopeeN = urls.length; shopeeChars = (top + urls.join('\n')).length;
  }
  // 지문의 요약 시각은 요약을 만든 뒤에 — 처음 만드는 요약 때문에 준비하자마자 「내용 바뀜」이 되지 않게 (2026-11-24 ISC10E)
  sig.sum_at = sigOf(slug, ch).sum_at;
  // 4) lg.com 전체 화면 캡처 → 5) PDP 시작·끝 · 이미지마다 USP 이름 · 같은 영역
  const sliceTotal = slices.reduce((n, x) => n + x.h, 0);
  // 덜 찍힌 캡처(lg.com 에 기능 섹션이 안 보임): PDP 범위가 상세 이미지 전체의 35% 도 안 되거나,
  // 상세 이미지의 그림을 lg.com 에서 25% 도 못 찾았는데 PDP 범위도 60% 가 안 될 때 (2026-11-24 TH ISC10E — 캡처에 요약·스펙만)
  const thin = (an) => {
    const shot = an && an.shot;
    if (!shot || sliceTotal <= 3000) return false;
    const pdp = (Math.min(shot.bottom, shot.h) - shot.top) * (1000 / (shot.w || 960));
    const al = an.align, few = al && al.images ? al.matched / al.images < 0.25 : false;
    return pdp < 0.35 * sliceTotal || (few && pdp < 0.6 * sliceTotal);
  };
  const analyze = async (st, allowReuse) => {
    const shotPath = st && st.status === 'ready' ? path.join(FULLSHOT_DIR, `${st.key}.jpg`) : null;
    step('analyze');
    // 다른 채널을 이미 같은 이미지 묶음 · 같은 캡처로 준비했으면 분석(USP · 같은 영역)을 그대로 쓴다 — 오래 걸리는 다시 그리기를 건너뜀
    const other = readJson(fileOf(slug, ch === 'shopee' ? 'lazada' : 'shopee'));
    if (allowReuse && other && (other.v || 1) >= PREP_V && other.hash === sl.hash && other.shot && shotPath && other.shot.key === st.key
        && fs.existsSync(shotPath) && other.shot.bytes === fs.statSync(shotPath).size) {
      const { top, bottom, topHow, bottomHow, auto, w, h } = other.shot;
      return { shotPath, a: { usps: other.usps, sliceUsps: other.sliceUsps, secs: other.secs, kind: other.kind, lead: other.lead,
        align: other.align, alignErr: other.alignErr, shot: { w, h, top, bottom, topHow, bottomHow, auto } } };
    }
    // 같은 영역 맞추기용: 상세 이미지를 만든 HTML 을 slices.py 와 같은 글꼴로 다시 그려 섹션 위치를 잰다 (review_align.py)
    const htmlTmp = path.join(require('os').tmpdir(), `review-${process.pid}-${Date.now()}-${ch}.html`);
    fs.writeFileSync(htmlTmp, html);
    try {
      return { shotPath, a: await runPrep({ fullshot: shotPath && fs.existsSync(shotPath) ? shotPath : null, mirror: path.join(dirOf(slug), 'mirror.json'),
        slices: slices.map((s) => ({ text: s.text })), html: htmlTmp, medium: 'shopee_lazada',
        fontsCss: `http://127.0.0.1:${process.env.PORT || 3001}/css/fonts.css`, sliceWidth: slices[0].w }) };
    } finally { fs.rmSync(htmlTmp, { force: true }); }
  };
  step('fullshot-check');
  let fsErr = '', st = null;
  const shoot = async (re) => {
    try { st = await fullshot(sum.url, re, step, existingOnly && !re, bg); fsErr = ''; } catch (e) { fsErr = String(e.message).slice(0, 200); }
    if (st && st.status === 'none') fsErr = existingOnly ? 'not captured yet' : 'no capture';
    if (st && st.status === 'error') fsErr = String(st.error || 'capture failed').slice(0, 200);
  };
  await shoot(recapture);
  let { shotPath, a } = await analyze(st, true);
  // 미리 준비는 최근(24시간 안) 찍은 캡처를 다시 찍지 않는다 — lg.com 페이지가 원래 짧은 제품(TH 일부, 기능 섹션 없음)을
  // 두 채널이 번갈아 계속 다시 찍던 것 (2026-11-24 운영: T2312VSPB · T2313VSPB · T2314VS2B · ISC10E)
  const shotAge = shotPath && fs.existsSync(shotPath) ? Date.now() - fs.statSync(shotPath).mtimeMs : Infinity;
  if (thin(a) && !recapture && !existingOnly && !(bg && shotAge < 24 * 3600 * 1000)) {   // 덜 찍혔으면 한 번 다시 캡처하고 다시 본다
    console.log(`[review] ${slug}: lg.com 캡처가 덜 찍힘 (PDP ${a.shot.bottom - a.shot.top}px / 상세 이미지 ${sliceTotal}px) → 다시 캡처`);
    await shoot(true);
    ({ shotPath, a } = await analyze(st, false));
  }
  if (a.shot && thin(a)) a.shot.incomplete = true;   // 다시 찍어도 덜 찍혔으면 화면에 알린다
  const rec = {
    v: PREP_V, slug, channel: ch, url: sum.url, prepared_at: Date.now(), sig, source: ed ? 'edit' : 'crawl', hash: sl.hash,
    slices: slices.map(({ src, w, h }) => ({ src, w, h })), images_loaded: man.images_loaded || sl.images_loaded || '',
    usps: a.usps, sliceUsps: a.sliceUsps, secs: a.secs, kind: a.kind, lead: a.lead, align: a.align || null, alignErr: a.alignErr || '',
    sum: ch === 'lazada' && sm && sm.html ? sm.html : '', sumText: ch === 'shopee' && sm && sm.text ? sm.text.trim() : '', summaryErr,
    // 미리 준비에서 빈 것 — 화면이 제품을 열 때 채운다
    missing: [...(isTh(sum.url) && !sm && !summaryErr ? ['summary'] : []), ...(!a.shot ? ['fullshot'] : [])],
    shopeeN, shopeeChars,
    shot: a.shot ? { key: st.key, src: `/media/fullshot/${st.key}.jpg`, bytes: fs.statSync(shotPath).size, ...a.shot } : null, shotErr: a.shot ? '' : (fsErr || 'no capture'),
  };
  const fp = fileOf(slug, ch);
  fs.writeFileSync(fp, JSON.stringify(rec));
  store.pushPaths([fp]).catch((e) => console.warn('[review] 버킷 업로드 실패', e.message));
  console.log(`[review] ${slug} ${ch}: 이미지 ${slices.length}장 (${rec.source}) · USP ${a.usps.length} · 캡처 ${a.shot ? `${a.shot.top}~${a.shot.bottom}` : fsErr || '없음'}`
    + ` · 같은 영역 ${a.align ? `${a.align.anchors.length}곳 (이미지 ${a.align.matched}/${a.align.images})` : a.alignErr || '없음'}`);
  return rec;
}

const runningSlugs = new Map();   // slug → 돌고 있는 채널 수
let paused = false;   // 재배포로 끝나는 중 (drain.js) — 새 준비는 시작하지 않고 돌고 있는 것만 마친다
function pump() {
  while (!paused && running < CONC && queue.length) {
    // 사람이 연 것 먼저 · 미리 준비는 BG_CONC 개까지만 동시에.
    // 미리 준비는 같은 제품의 다른 채널이 돌고 있으면 건너뛴다 — 끝난 뒤에 돌아야 그 분석(같은 이미지면 그대로)·요약·캡처를 다시 쓴다
    let i = queue.findIndex((q) => !q.bg);
    if (i < 0) {
      if (runningBg >= BG_CONC) break;
      i = queue.findIndex((q) => !runningSlugs.has(q.slug));
      if (i < 0) break;
    }
    const { slug, ch, opts, bg } = queue.splice(i, 1)[0];
    const key = `${slug}|${ch}`;
    running++; if (bg) runningBg++;
    runningSlugs.set(slug, (runningSlugs.get(slug) || 0) + 1);
    prepare(slug, ch, { ...opts, bg }).then(() => jobs.delete(key)).catch((e) => {
      console.warn('[review] 준비 실패', slug, ch, e.message);
      jobs.set(key, { state: 'error', error: String(e.message).slice(0, 300), at: Date.now(), bg });
    }).finally(() => {
      running--; if (bg) runningBg--;
      const n = (runningSlugs.get(slug) || 1) - 1; if (n) runningSlugs.set(slug, n); else runningSlugs.delete(slug);
      pump();
    });
  }
}
function enqueue(slug, ch, opts = {}, bg = false) {
  const key = `${slug}|${ch}`, j = jobs.get(key);
  if (j && j.state === 'pending') {
    // 미리 준비 차례를 기다리던 것을 사람이 열면 → 사람 차례로 (맨 앞)
    const q = queue.findIndex((x) => x.slug === slug && x.ch === ch);
    if (!bg && q >= 0 && queue[q].bg) { const [it] = queue.splice(q, 1); it.bg = false; it.opts = { ...it.opts, ...opts, existingOnly: false }; queue.unshift(it); j.bg = false; pump(); }
    return j;
  }
  const nj = { state: 'pending', step: 'queued', at: Date.now(), bg };
  jobs.set(key, nj);
  if (bg) queue.push({ slug, ch, opts, bg }); else queue.unshift({ slug, ch, opts, bg });
  pump();
  return nj;
}

/** 미리 준비: Shopee/Lazada 법인 제품 중 준비 안 됨 · 내용 바뀜인 채널을 미리 준비 차례에 넣는다 (최근 크롤 먼저) */
function prewarm() {
  if (!PREWARM || paused) return 0;
  let n = 0;
  try {
    const idx = require('./bulk-catalog').productIndex();
    const ps = Object.values(idx.products).filter((p) => PREWARM_COUNTRIES.has(p.country)).sort((a, b) => b.crawled_at - a.crawled_at);
    for (const p of ps) for (const ch of CHANNELS) {
      const j = jobs.get(`${p.slug}|${ch}`);
      if (j && (j.state === 'pending' || (j.state === 'error' && Date.now() - j.at < 6 * 3600 * 1000))) continue;
      const { state } = prepState(p.slug, ch, p);
      if (state === 'none' || state === 'stale' || state === 'error') { enqueue(p.slug, ch, { existingOnly: PREWARM_EXISTING_ONLY }, true); n++; }
    }
  } catch (e) { console.warn('[review] 미리 준비 목록 실패', e.message); }
  if (n) console.log(`[review] 미리 준비 ${n}개 차례에 넣음 (대기 ${queue.length} · 동시 ${BG_CONC})`);
  return n;
}
if (PREWARM) {
  // 시작 직후에는 버킷 → 로컬 동기화가 끝난 뒤에 (없는 제품을 비었다고 보지 않게).
  // whenPulled 는 동기화가 시작되기 전에 부르면 바로 끝나므로(2026-11-24 운영: 첫 훑기가 제품 0개) 30초 뒤에 묻고 최대 30분 기다린다
  setTimeout(async () => {
    await Promise.resolve(store.whenPulled ? store.whenPulled(30 * 60 * 1000) : null).catch(() => {});
    await require('./drain').gate();   // 재배포: 이전 서버가 마무리 중이면 끝난 뒤에 (그 서버가 마친 준비를 다시 하지 않게)
    try { require('./bulk-catalog').invalidate(); } catch (_) {}   // 동기화 중에 만든 빈 제품 색인을 버린다
    prewarm();
  }, 30 * 1000);
  setInterval(prewarm, 10 * 60 * 1000).unref();
}
require('./drain').register({ name: 'review', pause: () => { paused = true; }, busy: () => running });
function queueStats() {
  return { queued: queue.length, queuedBg: queue.filter((q) => q.bg).length, running, runningBg, prewarm: PREWARM ? [...PREWARM_COUNTRIES] : [],
    mode: PREWARM_EXISTING_ONLY ? 'existing' : 'full', conc: BG_CONC };
}

/** 준비 결과 + 사람이 고친 lg.com 범위 */
function readPrep(slug, ch) {
  const rec = readJson(fileOf(slug, ch));
  if (!rec) return null;
  const c = readJson(cropFile(slug));
  if (rec.shot && c && c.key === rec.shot.key && (!c.bytes || c.bytes === rec.shot.bytes)) {
    rec.shot = { ...rec.shot, top: c.top, bottom: c.bottom, manual: { by: c.by || '', at: c.at } };
  }
  return rec;
}
/** 준비한 뒤 lg.com 을 다시 캡처했는지 (같은 key 에 다른 파일 — 크기로 본다. 로컬에 없으면(재배포 직후) 모른다 → 그대로) */
function shotChanged(rec) {
  if (!rec.shot || !rec.shot.bytes) return false;
  try { return fs.statSync(path.join(FULLSHOT_DIR, `${rec.shot.key}.jpg`)).size !== rec.shot.bytes; } catch (_) { return false; }
}
function prepState(slug, ch, sum) {
  const j = jobs.get(`${slug}|${ch}`);
  const rec = readJson(fileOf(slug, ch));
  const state = j && j.state === 'pending' ? 'pending' : rec ? (sameSig(rec.sig, sigOf(slug, ch, sum)) && !shotChanged(rec) && (rec.v || 1) >= PREP_V ? 'ready' : 'stale') : j && j.state === 'error' ? 'error' : 'none';
  return { state, job: j || null, rec };
}

router.get('/api/v1/review/list', (req, res) => {
  const idx = require('./bulk-catalog').productIndex();
  const country = String(req.query.country || '').toLowerCase();
  const all = Object.values(idx.products);
  const countries = {};
  for (const p of all) countries[p.country] = (countries[p.country] || 0) + 1;
  const products = all.filter((p) => !country || p.country === country).map((p) => {
    const prep = {};
    for (const ch of CHANNELS) {
      const { state, job, rec } = prepState(p.slug, ch, p);
      prep[ch] = { state, step: job && job.step, error: job && job.error, bg: !!(job && job.bg),
        n: rec ? rec.slices.length : 0, shopeeN: rec ? rec.shopeeN : 0, first: rec && rec.slices[0] ? rec.slices[0].src : '', hash: rec ? rec.hash : '' };
    }
    const a = approvals.status(p.slug);
    return { slug: p.slug, url: p.url, country: p.country, model: p.model, title: p.title, thumb: p.thumb, dv: p.dv, grp: p.grp, crawled_at: p.crawled_at,
      approval: { status: a.status, via: a.via || '', by: a.by || '', at: a.at || 0, comment: a.comment || '' }, prep };
  }).sort((a, b) => b.crawled_at - a.crawled_at);
  res.json({ gate: approvals.gateOn(), countries, products, queue: queueStats() });
});

router.get('/api/v1/review/item/:slug', (req, res) => {
  const slug = cleanSlug(req.params.slug), ch = CHANNELS.has(req.query.channel) ? req.query.channel : 'shopee';
  const p = require('./bulk-catalog').productIndex().products[slug] || cr.productSummary(slug);
  if (!p) return res.status(404).json({ error: 'product not found' });
  const { state, job } = prepState(slug, ch);
  res.json({ product: { slug, url: p.url, model: p.model || '', title: p.title, dv: p.dv || '', grp: p.grp || '' }, channel: ch,
    approval: approvals.status(slug), gate: approvals.gateOn(), state, job, data: state === 'ready' || state === 'stale' ? readPrep(slug, ch) : null });
});

router.post('/api/v1/review/item/:slug/prepare', cr.auth, (req, res) => {
  const slug = cleanSlug(req.params.slug), b = req.body || {};
  const ch = CHANNELS.has(b.channel) ? b.channel : 'shopee';
  if (!cr.productSummary(slug)) return res.status(404).json({ error: 'product not found' });
  const { state } = prepState(slug, ch);
  if (state === 'ready' && !b.recapture && !b.force) return res.json({ state });
  const j = enqueue(slug, ch, { recapture: !!b.recapture });
  res.json({ state: 'pending', job: j });
});

router.post('/api/v1/review/item/:slug/crop', cr.auth, (req, res) => {
  const slug = cleanSlug(req.params.slug), b = req.body || {};
  const recs = [...CHANNELS].map((ch) => readJson(fileOf(slug, ch))).filter((r) => r && r.shot).sort((a, b) => b.prepared_at - a.prepared_at);
  if (!recs.length) return res.status(404).json({ error: 'no capture prepared' });
  const shot = recs[0].shot, fp = cropFile(slug);
  if (b.top == null) {   // 자동 값으로 되돌림
    fs.rmSync(fp, { force: true });
    Promise.resolve(store.removePaths([fp])).catch(() => {});
    return res.json({ ok: true, auto: true });
  }
  const top = Math.round(Number(b.top)), bottom = Math.round(Number(b.bottom));
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom > shot.h || bottom - top < 200) return res.status(400).json({ error: `need 0 ≤ top < bottom ≤ ${shot.h} (at least 200px)` });
  fs.writeFileSync(fp, JSON.stringify({ key: shot.key, bytes: shot.bytes || 0, top, bottom, by: String(b.by || '').slice(0, 120), at: Date.now() / 1000 }));
  store.pushPaths([fp]).catch((e) => console.warn('[review] 버킷 업로드 실패', e.message));
  res.json({ ok: true, top, bottom });
});

module.exports = { router, prepState, enqueue };
