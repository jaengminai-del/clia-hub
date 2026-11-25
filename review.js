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
  const sumAt = summaryHash(path.join(d, 'summary.json'));
  return { crawled_at: sum ? Number(sum.crawled_at) || 0 : 0, edit_at: e && fs.existsSync(path.join(d, `edit-${ch}.html`)) ? Number(e.at) || 0 : 0,
           sum_at: sum && isTh(sum.url) ? sumAt : 0 };
}
// 요약 지문 = summary.json 내용의 해시 (2026-11-24). 예전에는 파일 시각이었는데, 재배포 뒤 버킷에서 다시 받으면 시각이 바뀌어
//   준비한 것이 모두 「내용 바뀜」이 됐다. 시각·크기가 같으면 다시 읽지 않는다. 요약이 없으면 0.
const sumHashes = new Map();   // 파일 → { m, z, h }
function summaryHash(fp) {
  let st;
  try { st = fs.statSync(fp); } catch (_) { return 0; }
  const c = sumHashes.get(fp);
  if (c && c.m === st.mtimeMs && c.z === st.size) return c.h;
  let h = 0;
  try { h = require('crypto').createHash('sha1').update(fs.readFileSync(fp)).digest('hex').slice(0, 16); } catch (_) {}
  sumHashes.set(fp, { m: st.mtimeMs, z: st.size, h });
  return h;
}
// 예전 준비 결과(요약 지문이 파일 시각 숫자)는 지금 요약이 있으면 같다고 본다 — 배포하자마자 전부 다시 준비하지 않게
const sameSum = (a, b) => a === b || (typeof a === 'number' && a > 0 && typeof b === 'string' && !!b);
const sameSig = (a, b) => !!a && !!b && Math.abs(a.crawled_at - b.crawled_at) <= 1 && a.edit_at === b.edit_at && sameSum(a.sum_at, b.sum_at);

// ── 준비 작업 (한 번에 2개) ──
const jobs = new Map();   // `${slug}|${ch}` → { state: 'pending'|'error', step, at, error, bg }
const queue = [];          // [{ slug, ch, opts, bg }] — 사람이 연 것(bg=false)이 늘 먼저
let running = 0, runningBg = 0;
// 미리 준비 (2026-11-24): 검토하는 사람이 기다리지 않게, 서버가 Shopee/Lazada 법인 제품을 차례로 미리 준비한다.
//   REVIEW_PREWARM=0 이면 끔 · REVIEW_PREWARM_COUNTRIES (기본 th,sg) · REVIEW_PREWARM_CONC (캡처 차선 — 아래 단계별 차선)
//   준비가 안 됐거나(none) 내용이 바뀐(stale) 채널만. 실패한 것은 6시간 뒤에 다시. 10분마다 다시 훑는다(새로 크롤한 제품 · 편집본 저장).
const PREWARM = process.env.REVIEW_PREWARM !== '0';
const PREWARM_COUNTRIES = new Set(String(process.env.REVIEW_PREWARM_COUNTRIES || 'th,sg').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
// 미리 준비 동시 수: 1~4 (운영 4 vCPU · 16GB — 4개면 CPU 한도 가까이, 그 이상은 사용자 작업이 느려지고 lg.com 차단 위험, 2026-11-24)
// 단계별 차선 (2026-11-24): 한 제품의 단계(그리기 · 요약 · 캡처 · 분석)는 쓰는 자원이 달라 차선을 따로 둔다 —
//   요약(Gemini)·캡처(lg.com)는 기다리는 시간이 대부분이라 CPU 를 거의 안 쓰는데, 한 작업이 단계를 차례로 돌면 그동안 자리를 잡고 있었다
//   (운영 CPU 평균 1.1 / 4). 그래서 동시에 도는 제품(BG_CONC)은 늘리고, 단계마다 차선 수로 묶는다. 사람이 연 제품은 차선에서도 먼저.
//   REVIEW_PREWARM_CONC = 캡처 차선 수(기본 1, 최대 8) · 동시 제품 수 = 캡처 차선 × 3 (REVIEW_PREWARM_JOBS 로 바꿈, 최대 24)
//   REVIEW_LANE_RENDER(2) · REVIEW_LANE_SUMMARY(6) · REVIEW_LANE_ANALYZE(3)
const envInt = (k, d, lo, hi) => Math.max(lo, Math.min(hi, parseInt(process.env[k], 10) || d));
const CAPTURE_LANES = envInt('REVIEW_PREWARM_CONC', 1, 1, 8);
const BG_CONC = envInt('REVIEW_PREWARM_JOBS', CAPTURE_LANES * 3, 1, 24);
function lane(name, n) {
  let active = 0;
  const waiting = [];   // [{ hi, go }]
  const run = async (fn, hi = false) => {
    if (active >= n) await new Promise((go) => { const w = { hi, go }; if (hi) { const i = waiting.findIndex((x) => !x.hi); waiting.splice(i < 0 ? waiting.length : i, 0, w); } else waiting.push(w); });
    active++;
    try { return await fn(); } finally { active--; const w = waiting.shift(); if (w) w.go(); }
  };
  run.stats = () => ({ n, active, waiting: waiting.length });
  return run;
}
const LANES = { render: lane('render', envInt('REVIEW_LANE_RENDER', 2, 1, 8)), summary: lane('summary', envInt('REVIEW_LANE_SUMMARY', 6, 1, 16)),
  capture: lane('capture', CAPTURE_LANES), analyze: lane('analyze', envInt('REVIEW_LANE_ANALYZE', 3, 1, 8)) };
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
async function fullshot(url, recapture, step, existingOnly = false, via = '') {   // via: 'direct' (직접만) · 'firecrawl' · '' (직접 → 막히면 Firecrawl)
  const q = '/api/v1/fullshot?url=' + encodeURIComponent(url);
  let st = await getJ(q);
  // 기록 없는 예전 캡처 → 주소만 확인 (4초) — 없어진 제품 페이지(홈으로 넘어감)를 찍은 것이면 gone (2026-11-24)
  if (st.status === 'ready' && st.verified === false && !recapture) {
    step('fullshot-verify');
    st = await post('/api/v1/fullshot', { url, verify: true }, 30000);
    for (let i = 0; i < 60 && st.status === 'pending'; i++) { await sleep(2000); st = await getJ(q); }
  }
  if ((st.status === 'ready' || st.status === 'gone') && !recapture) return st;   // gone: lg.com 에 제품 페이지 없음 — 다시 찍지 않는다
  if (existingOnly && st.status !== 'pending') return st;   // 미리 준비: 있는 캡처만 (새로 찍지 않는다)
  if (st.status !== 'pending') {
    step('fullshot');
    // recapture: 있는 캡처도 다시 찍는다 (지연 로드가 덜 찍힌 캡처 — 새 캡처가 성공해야 바뀐다)
    st = await post('/api/v1/fullshot', { url, retry: true, force: !!recapture, ...(via ? { via } : {}) }, 30000);
  }
  for (let i = 0; i < 120 && st.status === 'pending'; i++) { await sleep(2000); st = await getJ(q); }
  return st;
}

// lg.com 차단 차단기 (2026-11-24): 미리 준비의 직접 캡처가 「lg.com 이 막음」(CSS 가 막힘 등)으로 실패하면 30분 동안
//   미리 준비는 캡처를 건너뛴다 — 이미지·요약·분석은 그대로 준비하고 캡처만 비워 둔다(missing: fullshot).
//   30분 뒤 한 건만 먼저 시험해 보고(probe), 풀렸으면 다시 찍고 비워 둔 캡처를 채운다 (prewarm 이 다시 차례에 넣음).
//   막힌 동안 4개가 동시에 계속 부딪히지 않게. 사람이 연 제품은 상관없이 찍는다 (Firecrawl 로 넘어감).
const BLOCK_MS = (parseInt(process.env.REVIEW_CAPTURE_BLOCK_MINUTES, 10) || 30) * 60 * 1000;
const FIRECRAWL_FALLBACK = process.env.REVIEW_FIRECRAWL_FALLBACK !== '0';
const breaker = { until: 0, probing: false, trips: 0, streak: 0 };   // streak: 서로 다른 제품에서 연달아 막힌 수 (2번이면 쉼)
const isTransientErr = (m) => /thread|crash|has been closed|Target |Timeout|timed out|ECONN|EAGAIN|ENOMEM|exit \d|SIGKILL|socket hang up|fetch failed|KeyboardInterrupt|Chromium|Command failed|worker exited|context was destroyed|exit null|Expecting value|Clipped area/i.test(String(m || ''));
const isBlockErr = (m) => /막음|막는 중|blocked|stylesheet|\b403\b|access denied/i.test(String(m || ''));
function captureGate() {   // 미리 준비만: false = 건너뜀, 'probe' = 풀렸는지 시험하는 한 건, true = 찍음
  if (Date.now() < breaker.until || breaker.probing) return false;
  if (breaker.until) { breaker.probing = true; return 'probe'; }
  return true;
}
function captureResult(gate, err) {
  if (gate === 'probe') breaker.probing = false;
  if (err && isBlockErr(err)) {
    breaker.streak++;
    if (gate !== 'probe' && breaker.streak < 2) return;   // 한 제품만 막힌 것은 그 제품 문제일 수 있다
    if (!breaker.until || gate === 'probe' || Date.now() >= breaker.until) {
      breaker.trips++;
      console.warn(`[review] lg.com 이 캡처를 막음 → 미리 준비 캡처 ${BLOCK_MS / 60000}분 쉼 (캡처만 비워 두고 나중에 채움): ${String(err).slice(0, 120)}`);
    }
    breaker.until = Date.now() + BLOCK_MS;
  } else if (!err) breaker.streak = 0;
  if (gate === 'probe' && !err) {
    console.log('[review] lg.com 캡처 다시 됨 → 미리 준비 캡처 다시 시작 (비워 둔 캡처 채우기)');
    breaker.until = 0;
  }
}
const captureBlocked = () => Date.now() < breaker.until || breaker.probing;

/** 캡처의 이미지 위치 기록 (fullshot.py) — 로컬에 없으면 버킷에서. 이 캡처 파일의 것(jpg_bytes)일 때만 경로를 돌려준다 */
async function boxesFor(key, shotPath) {
  const fp = path.join(FULLSHOT_DIR, `${key}.boxes.json`);
  if (!fs.existsSync(fp)) {
    const buf = await store.getBuffer(`media-fullshot/${key}.boxes.json`).catch(() => null);
    if (!buf) return null;
    fs.writeFileSync(fp, buf);
  }
  const b = readJson(fp);
  try { if (!b || !b.jpg_bytes || b.jpg_bytes !== fs.statSync(shotPath).size) return null; } catch (_) { return null; }
  return fp;
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
async function prepare(slug, ch, { recapture = false, existingOnly = false, bg = false, upgrade = false } = {}) {
  const key = `${slug}|${ch}`, job = jobs.get(key);
  // 단계별 시간 (속도 개선용 — 로그 한 줄에 함께)
  const T = {}, t0 = Date.now();
  let cur = '', curT = t0;
  const step = (s) => { const now = Date.now(); if (cur) T[cur] = (T[cur] || 0) + (now - curT); cur = s; curT = now; job.step = s; };
  const sum = cr.productSummary(slug);
  if (!sum) throw new Error('product not found');
  const sig = sigOf(slug, ch);
  // 1) 설명 HTML — 벌크 엑셀과 같은 순서 (편집본 → 크롤 데이터로 새로)
  step('html');
  const ed = require('./edits').getEdit(slug, ch);
  const html = ed ? ed.html : (await LANES.render(() => post('/api/ebay-generate', { url: sum.url, medium: 'shopee_lazada', listing: ch === 'lazada' }, 5 * 60 * 1000), !bg)).html;
  if (!html) throw new Error('generate returned no HTML');
  // 2) 슬라이스 이미지 (빌더 이미지 ZIP·이미지형 HTML·벌크 엑셀과 같은 해시)
  step('slices');
  const sl = await LANES.render(() => post('/api/v1/slice-html', { html, medium: 'shopee_lazada' }, 12 * 60 * 1000), !bg);
  const man = await sliceManifest(sl.hash);
  if (!man || !(man.images || []).length) throw new Error('slice manifest missing');
  const slices = man.images.map((im) => ({ src: `/media/slices/${sl.hash}/${im.file}`, w: im.width, h: im.height, text: im.text || '' }));
  // 3) PDP 요약 (태국 제품만 — 벌크와 같다)
  let sm = null, summaryErr = '';
  if (isTh(sum.url)) {
    step('summary');
    sm = await LANES.summary(() => post('/api/v1/pdp-summary', { url: sum.url, cachedOnly: existingOnly }, 7 * 60 * 1000), !bg).catch((e) => {
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
      const boxes = shotPath && fs.existsSync(shotPath) ? await boxesFor(st.key, shotPath) : null;
      // 상세 이미지 HTML 의 섹션 · 이미지 위치 (같은 해시면 같다) — 한 번 재면 다시 쓴다 (브라우저 없이 분석, 버킷에도)
      const layoutCache = path.join(SLICE_CACHE, sl.hash, 'align-layout.json');
      let hadLayout = fs.existsSync(layoutCache);
      if (!hadLayout && boxes) {
        const buf = await store.getBuffer(`media-slices/${sl.hash}/align-layout.json`).catch(() => null);
        if (buf) { fs.mkdirSync(path.dirname(layoutCache), { recursive: true }); fs.writeFileSync(layoutCache, buf); hadLayout = true; }
      }
      const pushLayout = () => { if (!hadLayout && fs.existsSync(layoutCache)) store.putBuffer(`media-slices/${sl.hash}/align-layout.json`, fs.readFileSync(layoutCache), 'application/json').catch(() => {}); };
      const res = { shotPath, a: await LANES.analyze(() => runPrep({ fullshot: shotPath && fs.existsSync(shotPath) ? shotPath : null, boxes, layoutCache, mirror: path.join(dirOf(slug), 'mirror.json'),
        slices: slices.map((s) => ({ text: s.text })), html: htmlTmp, medium: 'shopee_lazada',
        fontsCss: `http://127.0.0.1:${process.env.PORT || 3001}/css/fonts.css`, sliceWidth: slices[0].w }), !bg) };
      pushLayout();
      return res;
    } finally { fs.rmSync(htmlTmp, { force: true }); }
  };
  step('fullshot-check');
  let fsErr = '', st = null, skipped = false;
  const shoot = async (re) => {
    // upgrade (위치 기록 다시 찍기, 천천히): 차단기와 상관없이 직접 캡처 한 번 — 실패해도 예전 캡처는 그대로, 차단기 · Firecrawl 에 손대지 않음
    const gate = upgrade ? true : bg && !existingOnly ? captureGate() : true;   // 미리 준비: lg.com 이 막는 중이면 직접 캡처는 하지 않는다
    // 사용자 결정(2026-11-24): 직접 캡처가 막히면 Firecrawl 로 (유료). 막힌 동안(차단기)은 바로 Firecrawl — REVIEW_FIRECRAWL_FALLBACK=0 이면 예전처럼 비워 둠.
    //   Firecrawl 캡처는 이미지 위치 기록이 없어 그림으로 맞춘다 → 풀리면 위치 기록 캡처로 다시 찍는다 (prewarm 의 위치 기록 다시 찍기)
    const fc = !upgrade && bg && !existingOnly && !gate && FIRECRAWL_FALLBACK;
    skipped = !gate && !fc;
    let tried = false;   // 실제로 새로 찍었는지 (있는 캡처를 그대로 쓰면 풀렸는지 알 수 없다)
    const stp = (x) => { if (x === 'fullshot') tried = true; step(x); };
    const viaNow = fc ? 'firecrawl' : bg ? 'direct' : '';
    // 막힌 동안 「다시 찍기」(위치 기록 · 덜 찍힘)는 하지 않는다 — 직접 찍은 캡처를 위치 기록 없는 Firecrawl 캡처로 바꾸지 않게
    try { st = await LANES.capture(() => fullshot(sum.url, re && !skipped && !fc, stp, (existingOnly && !re) || skipped, viaNow), !bg); fsErr = ''; } catch (e) { fsErr = String(e.message).slice(0, 200); tried = true; }
    // 직접 캡처가 막혔으면 바로 Firecrawl 로 한 번 더 (차단기 기록은 직접 캡처 결과로)
    const directBlocked = !upgrade && viaNow === 'direct' && FIRECRAWL_FALLBACK && st && st.status === 'error' && isBlockErr(st.error);
    if (directBlocked) {
      if (gate) captureResult(gate, st.error);
      const blockedErr = st.error;
      try { st = await LANES.capture(() => fullshot(sum.url, false, stp, false, 'firecrawl'), !bg); } catch (e) { fsErr = String(e.message).slice(0, 200); }
      if (st && st.status === 'ready') console.log(`[review] ${slug}: lg.com 이 직접 캡처를 막음 → Firecrawl 로 찍음`);
      else if (st && st.status === 'error') st = { ...st, error: `${blockedErr} · Firecrawl: ${st.error}` };
    }
    if (fc && st && st.status === 'ready' && tried) console.log(`[review] ${slug}: lg.com 이 막는 중 → Firecrawl 로 찍음`);
    if (st && st.status === 'none') fsErr = skipped ? 'lg.com 이 막는 중 — 나중에 채움' : existingOnly ? 'not captured yet' : 'no capture';
    if (st && (st.status === 'error' || st.status === 'gone')) fsErr = String(st.error || 'capture failed').slice(0, 200);
    if (!upgrade && gate && bg && !existingOnly && !directBlocked) {
      // 다시 찍기가 막혀 예전 캡처가 남은 것(상태는 ready)도 막힘으로 센다 — 차단기가 열려야 막힌 동안 다시 찍기를 멈춘다
      if (tried) captureResult(gate, st && st.status === 'ready' ? (st.lastError || '') : fsErr);
      else if (gate === 'probe') breaker.probing = false;   // 시험할 기회를 다음 건에 넘긴다
    }
  };
  await shoot(recapture);
  let { shotPath, a } = await analyze(st, true);
  // 미리 준비는 최근(24시간 안) 찍은 캡처를 다시 찍지 않는다 — lg.com 페이지가 원래 짧은 제품(TH 일부, 기능 섹션 없음)을
  // 두 채널이 번갈아 계속 다시 찍던 것 (2026-11-24 운영: T2312VSPB · T2313VSPB · T2314VS2B · ISC10E)
  const shotAge = shotPath && fs.existsSync(shotPath) ? Date.now() - fs.statSync(shotPath).mtimeMs : Infinity;
  if (thin(a) && !recapture && !existingOnly && !(bg && (shotAge < 24 * 3600 * 1000 || captureBlocked()))) {   // 덜 찍혔으면 한 번 다시 캡처하고 다시 본다
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
  step('');
  const secs = Object.entries(T).filter(([, v]) => v >= 100).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(' ');
  console.log(`[review] ${slug} ${ch}: 이미지 ${slices.length}장 (${rec.source}) · USP ${a.usps.length} · 캡처 ${a.shot ? `${a.shot.top}~${a.shot.bottom}` : fsErr || '없음'}`
    + ` · 같은 영역 ${a.align ? `${a.align.anchors.length}곳 (이미지 ${a.align.matched}/${a.align.images})` : a.alignErr || '없음'}`
    + ` · ${((Date.now() - t0) / 1000).toFixed(1)}초 (${secs}${bg ? '' : ' · 사람'})`);
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
      const prevTries = (jobs.get(key) || {}).tries || 0;   // 같은 채널이 연달아 실패한 수 (일시 오류 빠른 재시도는 3번까지)
      jobs.set(key, { state: 'error', error: String(e.message).slice(0, 300), at: Date.now(), bg, tries: prevTries + 1 });
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
  const nj = { state: 'pending', step: 'queued', at: Date.now(), bg, tries: j && j.state === 'error' ? j.tries || 0 : 0 };
  jobs.set(key, nj);
  if (bg) queue.push({ slug, ch, opts, bg }); else queue.unshift({ slug, ch, opts, bg });
  pump();
  return nj;
}

// 위치 기록 다시 찍기 — 천천히 (2026-11-25 사용자 결정): 위치 기록 없이 찍은 캡처(Firecrawl · 예전 캡처, 그림 맞추기)를
//   REVIEW_UPGRADE_INTERVAL_SEC(기본 90초)마다 한 제품씩 직접 다시 찍어 주소 맞추기로 옮긴다. 다른 준비가 없을 때만, 한 번에 하나.
//   lg.com 이 여러 개를 한꺼번에 찍으면 막아서 한꺼번에 하던 것(한 번 훑을 때 60개)은 계속 막혀 진척이 없었다.
//   차단기가 열려 있어도 시도하고(실패해도 예전 캡처 그대로), 실패한 제품은 6시간 뒤 다시.
const UPGRADE_EVERY = envInt('REVIEW_UPGRADE_INTERVAL_SEC', 90, 20, 3600) * 1000;
const upgradeTried = new Map();   // slug → 시도한 시각
let upgradeKey = '';
function upgradeCandidates() {
  const idx = require('./bulk-catalog').productIndex();
  return Object.values(idx.products).filter((p) => PREWARM_COUNTRIES.has(p.country)).sort((a, b) => b.crawled_at - a.crawled_at)
    .filter((p) => {
      const { state, rec } = prepState(p.slug, 'shopee', p);
      return state === 'ready' && rec && rec.shot && rec.align && rec.align.mode !== 'url';
    });
}
function upgradeTick() {
  if (!PREWARM || paused || PREWARM_EXISTING_ONLY) return;
  if (upgradeKey) { const j = jobs.get(upgradeKey); if (j && j.state === 'pending') return; upgradeKey = ''; }
  if (queue.length || running) return;   // 다른 준비가 먼저
  try {
    const now = Date.now();
    const cands = upgradeCandidates();
    const p = cands.find((x) => now - (upgradeTried.get(x.slug) || 0) > 6 * 3600 * 1000);
    if (!p) return;
    upgradeTried.set(p.slug, now);
    upgradeKey = `${p.slug}|shopee`;
    console.log(`[review] 위치 기록 다시 찍기 (천천히, 남은 ${cands.length}개): ${p.slug}`);
    enqueue(p.slug, 'shopee', { recapture: true, upgrade: true }, true);
  } catch (e) { console.warn('[review] 위치 기록 다시 찍기 실패', e.message); }
}
if (PREWARM) setInterval(upgradeTick, UPGRADE_EVERY).unref();
/** 미리 준비: Shopee/Lazada 법인 제품 중 준비 안 됨 · 내용 바뀜인 채널을 미리 준비 차례에 넣는다 (최근 크롤 먼저) */
function prewarm() {
  if (!PREWARM || paused) return 0;
  let n = 0, refills = 0;
  try {
    const idx = require('./bulk-catalog').productIndex();
    const ps = Object.values(idx.products).filter((p) => PREWARM_COUNTRIES.has(p.country)).sort((a, b) => b.crawled_at - a.crawled_at);
    for (const p of ps) for (const ch of CHANNELS) {
      const j = jobs.get(`${p.slug}|${ch}`);
      // 실패한 준비는 6시간 뒤 다시 — 단, 일시 오류(프로세스 · 스레드 부족, 브라우저 충돌, 연결)는 5분 뒤 (2026-11-24 운영: EAGAIN · KeyboardInterrupt)
      const retryMs = j && j.state === 'error' && isTransientErr(j.error) && (j.tries || 0) <= 3 ? 5 * 60 * 1000 : 6 * 3600 * 1000;
      if (j && (j.state === 'pending' || (j.state === 'error' && Date.now() - j.at < retryMs))) continue;
      const { state, rec } = prepState(p.slug, ch, p);
      // 캡처를 비워 두고 준비한 것(lg.com 이 막던 때) — 차단이 풀렸으면 다시 (1시간 지난 것만, 한 번 훑을 때 최대 40개)
      // 일시 오류(브라우저 · 스레드 부족 · 시간 초과)로 캡처 없이 준비된 것은 5분 뒤에 (2026-11-24 운영: 동시 실행이 많아 「can't start new thread」 · 「Target crashed」)
      const transient = rec && ((!rec.shot && isTransientErr(rec.shotErr)) || (rec.shot && !rec.align && isTransientErr(rec.alignErr)));
      // 막힌 동안에도 채운다 — 차단기가 열려 있으면 준비가 바로 Firecrawl 로 찍는다 (REVIEW_FIRECRAWL_FALLBACK)
      // 요약이 예전 규칙으로 실패한 것도 다시 (규칙이 바뀌면 서버가 새로 만든다 — 같은 규칙으로 실패한 것은 서버가 24시간 기억해 바로 돌려줌)
      const sumRetry = rec && /rule not met/.test(rec.summaryErr || '');
      const refill = state === 'ready' && !PREWARM_EXISTING_ONLY && rec && (transient || sumRetry || (!rec.shot && (isBlockErr(rec.shotErr) || movedBack(rec) || /Firecrawl 캡처 실패/.test(rec.shotErr || ''))))
        && (FIRECRAWL_FALLBACK || !captureBlocked()) && refills < 40
        && Date.now() - (rec.prepared_at || 0) > (transient ? 5 : 60) * 60 * 1000;
      if (state === 'none' || state === 'stale' || state === 'error' || refill) {
        enqueue(p.slug, ch, { existingOnly: PREWARM_EXISTING_ONLY }, true); n++;
        if (refill) refills++;
        continue;
      }
    }
    verifySweep(ps);
  } catch (e) { console.warn('[review] 미리 준비 목록 실패', e.message); }
  if (n) console.log(`[review] 미리 준비 ${n}개 차례에 넣음 (대기 ${queue.length} · 동시 ${BG_CONC}${refills ? ` · 캡처 채우기 ${refills}` : ''})`);
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
// 예전 캡처 확인 (2026-11-24): 기록 없이 찍힌 캡처(이 변경 전)가 제품 페이지인지 한 번씩 주소만 확인한다 — 한 번에 하나, 4초쯤.
//   없어진 제품(단종 · 번들)은 lg.com 이 홈으로 보내 홈 화면이 「LG.com」으로 찍혀 있었다 → 그 제품을 다시 준비해 캡처를 뺀다.
const verifyQ = [], verifyDone = new Set();
let verifying = false;
async function verifyPump() {
  if (verifying) return;
  verifying = true;
  try {
    while (verifyQ.length && !paused) {
      const { url, key, slug } = verifyQ.shift();
      try {
        const q = '/api/v1/fullshot?url=' + encodeURIComponent(url);
        let st = await getJ(q);
        if (st.status === 'ready' && st.verified === false) {
          st = await post('/api/v1/fullshot', { url, verify: true }, 30000);
          for (let i = 0; i < 60 && st.status === 'pending'; i++) { await sleep(2000); st = await getJ(q); }
        }
        if (st.status === 'gone') {
          console.log(`[review] ${slug}: 예전 lg.com 캡처는 홈 화면 (제품 페이지 없음) → 캡처 빼고 다시 준비`);
          for (const ch of CHANNELS) enqueue(slug, ch, { existingOnly: PREWARM_EXISTING_ONLY }, true);
        }
      } catch (e) { console.warn('[review] 캡처 확인 실패', slug, e.message); }
      verifyDone.add(key);
    }
  } finally { verifying = false; }
}
function verifySweep(ps) {
  for (const p of ps) for (const ch of CHANNELS) {
    const rec = readJson(fileOf(p.slug, ch));
    const key = rec && rec.shot && rec.shot.key;
    if (!key || verifyDone.has(key) || verifyQ.some((x) => x.key === key) || fs.existsSync(path.join(FULLSHOT_DIR, `${key}.json`))) continue;
    verifyQ.push({ url: rec.url, key, slug: p.slug });
  }
  if (verifyQ.length) { console.log(`[review] 예전 lg.com 캡처 주소 확인 ${verifyQ.length}개 차례에 넣음`); verifyPump(); }
}
require('./drain').register({ name: 'review', pause: () => { paused = true; }, busy: () => running + (verifying ? 1 : 0) });
function queueStats() {
  return { queued: queue.length, queuedBg: queue.filter((q) => q.bg).length, running, runningBg, prewarm: PREWARM ? [...PREWARM_COUNTRIES] : [],
    mode: PREWARM_EXISTING_ONLY ? 'existing' : 'full', conc: BG_CONC,
    lanes: Object.fromEntries(Object.entries(LANES).map(([k, l]) => [k, l.stats()])),
    captureBlockedUntil: captureBlocked() ? breaker.until : 0, captureBlockTrips: breaker.trips };
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
// 「페이지가 없음」으로 캡처를 뺐는데, 다시 보니 카테고리만 옮긴 같은 제품(2026-11-24 GN-F392PXAK) → 다시 준비해 캡처를 채운다
function movedBack(rec) {
  if (!/페이지가 없음/.test(rec.shotErr || '')) return false;
  const key = require('crypto').createHash('sha1').update(String(rec.url).trim().replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 20);
  const m = readJson(path.join(FULLSHOT_DIR, `${key}.json`));
  return !!(m && m.gone && m.final && lastSeg(m.final) === lastSeg(rec.url));
}
const lastSeg = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase().split('/').pop();
function shotChanged(rec) {
  if (!rec.shot || !rec.shot.bytes) return false;
  const m = readJson(path.join(FULLSHOT_DIR, `${rec.shot.key}.json`));
  if (m && m.gone && !(m.final && m.url && lastSeg(m.final) === lastSeg(m.url))) return true;   // 확인해 보니 홈 화면을 찍은 것 (제품 페이지 없음) → 다시 준비해 캡처를 뺀다
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
