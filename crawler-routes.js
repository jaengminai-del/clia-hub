/**
 * crawler-routes.js — LG.com PDP 크롤러 (Python 파이프라인) 내장 라우터
 *
 * 예전 crawler-py/api.py (FastAPI) 와 동일한 /api/v1/* 계약을 제공하되,
 * 별도 서버(8080)·터널 없이 메인 Node 서버가 crawler-py/pdp_pipeline.py 를 자식 프로세스로 실행한다.
 * server.js 의 /api/pcg-vision 도 crawl() 을 직접 호출한다.
 *   POST /api/v1/crawl                  → 202 { job_id }  (full_ai:true → 기존 Gemini 분석 방식 강제)
 *   GET  /api/v1/jobs/:id               → 상태/결과
 *   GET  /api/v1/jobs/:id/stream        → SSE 진행률
 *   GET  /api/v1/jobs/:id/ebay-html     → eBay HTML fragment
 *   GET  /api/v1/ebay-html?url=         → URL 직접 지정 렌더
 *   GET  /api/v1/content-html?url=&medium= → 매체별 1차 컨텐츠 HTML (content_gen/media/<medium>, 기본 ebay)
 *   GET  /api/v1/amazon-features?url=    → Amazon A+ 선택 화면 카드 목록 (content_gen/amazon)
 *   POST /api/v1/amazon-features {mirror} → 같은 결과 (빌더가 받은 크롤 결과로 바로)
 *   POST /api/v1/amazon-modules {url | features, selection, mode, start_id} → 선택 카드 → A+ 모듈 목록
 *   POST /api/v1/amazon-images {modules(+transforms), pdpUrl, date} → A+ 규격 이미지 ZIP (Pillow)
 *   POST /api/v1/amazon-stack {urls}   → 이어 붙은 히어로 한 장 {url: data URL, bg}
 *   GET  /api/v1/image-crop?url=&box=x,y,w,h → 원본의 일부를 잘라 JPEG (Amazon 이미지 자동 선택 결과)
 *   GET  /api/v1/products?country=uk    → 크롤 완료 제품 목록 (허브 Product List 검색용, 크롤러에 계속 누적)
 *   GET  /api/v1/products/:slug         → 제품 1건 (원본 URL + mirror + geo)
 *   POST /api/v1/products/:slug/geo     → GEO Q&A·키워드 생성 (Gemini, out/<slug>/geo.json 캐시, force:true 재생성)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const store = require('./crawl-store'); // 버킷 동기화 (설정 없으면 no-op)
const { autoFrame } = require('./video-frames'); // 크롤 직후 동영상 자동 장면 (검은·없는 포스터만)

const CRAWLER_DIR = path.join(__dirname, 'crawler-py');
const OUT_DIR = path.join(CRAWLER_DIR, 'out');
const PIPELINE = path.join(CRAWLER_DIR, 'pdp_pipeline.py');
const RENDER_CONTENT = path.join(CRAWLER_DIR, 'render_content.py');
const RENDER_AMAZON = path.join(CRAWLER_DIR, 'render_amazon.py');

// 로컬은 crawler-py/.venv, 배포(Docker)는 시스템 python3. CRAWLER_PYTHON 으로 강제 지정 가능.
function resolvePython() {
  if (process.env.CRAWLER_PYTHON) return process.env.CRAWLER_PYTHON;
  const venv = path.join(CRAWLER_DIR, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

const API_TOKEN = (process.env.CLIA_API_TOKEN || '').trim();
const jobs = new Map(); // job_id → { url, slug, out, startedAt, proc, exited }

// 광고 · 검색이 주소 뒤에 붙이는 추적값(?srsltid= · utm_* · gclid …)과 #뒤는 뗀다 (2026-11-24).
//   붙은 채로 크롤하면 같은 제품이 다른 제품으로 따로 저장된다 (예: GT-B2655PY ?srsltid=…). 다른 값은 그대로
const TRACKING = /^(utm_[a-z_]+|srsltid|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi)$/i;
function cleanUrl(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\?$/, '');
  } catch (_) { return String(url || '').trim(); }
}

// 크롤 실패 이유 (2026-11-24): 화면에는 쉬운 말(code → 화면 문구) + 문의 번호(ref), 기술 내용(detail)은 서버 로그에만.
//   전에는 pipeline.log 의 마지막 오류 줄(Firecrawl · RuntimeError …)을 그대로 사용자에게 보였다
const CRAWL_FAIL = {
  not_product: "This isn't an LG.com product page.",
  unreachable: "LG.com isn't responding. Try again later.",
  busy: "The server is busy. Try again in a few minutes.",
  incomplete: "The page is too long. Try again.",
  declined: "This page can't be crawled.",
  stopped: "The crawl stopped. Try again.",
  setup: "Crawling is unavailable. Contact the admin.",
  unknown: "Something went wrong. Try again.",
};
function failureOf(job) {
  let detail = job.spawnError || '';
  if (!detail) {
    try {
      const lines = fs.readFileSync(path.join(job.out, 'pipeline.log'), 'utf-8')
        .replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
      detail = (lines.slice().reverse().find((l) => /error|exception|✗|failed|실패/i.test(l)) || lines[lines.length - 1] || '').slice(0, 400);
    } catch {}
  }
  const d = detail;
  const code = job.signal ? 'stopped'   // 프로세스가 강제로 끝남 (메모리 부족 · 재시작 등)
    : /different page|canonical|errors\/404|not a product|no product|404/i.test(d) ? 'not_product'
    : /GEMINI_API_KEY|ANTHROPIC_API_KEY|FIRECRAWL_API_KEY|api key|402|payment required|credits/i.test(d) ? 'setup'   // 키 · 크레딧: 다시 해도 안 됨 → 관리자
    : /429|RESOURCE_EXHAUSTED|quota|overloaded|529|rate.?limit/i.test(d) ? 'busy'
    : /JSONDecodeError|incomplete|truncated/i.test(d) ? 'incomplete'
    : /declined|refusal/i.test(d) ? 'declined'
    : /firecrawl|402|payment required|timeout|timed out|net::|ERR_|403|502|503|connection/i.test(d) ? 'unreachable'
    : 'unknown';
  return { code, message: CRAWL_FAIL[code], detail: (job.signal ? `killed by ${job.signal}. ` : '') + d };
}
const refOf = (jobId) => String(jobId || '').replace(/^job_/, '').slice(0, 6).toUpperCase();

const slugify = (url) =>
  url.replace(/https?:\/\//, '').replace(/[^\p{L}\p{N}_]+/gu, '-').replace(/-+$/, '');

const readJson = (fp) => {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
};

function auth(req, res, next) {
  if (API_TOKEN && req.get('authorization') !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ detail: 'invalid or missing api token' });
  }
  next();
}

// 크롤이 같은 Firecrawl 요청에서 받은 lg.com 전체 화면 캡처(out/lgcom_full.jpg, 2026-11-24) → 캡처 저장소에 올린다.
//   server.js /api/v1/fullshot 과 같은 주소 키 · 같은 자리(media-cache/fullshot/<key>.jpg, 버킷 media-fullshot/<key>.jpg)
//   → 검토·승인 화면 왼쪽과 빌더 「전체 lg.com 페이지」가 따로 캡처(Firecrawl 한 번 더)하지 않고 바로 쓴다.
function publishPageShot(url, out) {
  const src = path.join(out, 'lgcom_full.jpg');
  try {
    if (!fs.existsSync(src) || fs.statSync(src).mtimeMs < Date.now() - 6 * 3600 * 1000) return;   // 이번 크롤에서 받은 것만
    const key = crypto.createHash('sha1').update(String(url).trim().replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 20);
    const dst = path.join(__dirname, 'media-cache', 'fullshot', `${key}.jpg`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    // 캡처 기록 (server.js fullshotMeta) — 크롤이 제품 페이지인지 확인한 뒤 받은 캡처라 확인된 것으로
    const meta = JSON.stringify({ url, final: url, at: Date.now(), via: 'crawl' });
    fs.writeFileSync(dst.replace(/\.jpg$/, '.json'), meta);
    store.putBuffer(`media-fullshot/${key}.json`, Buffer.from(meta), 'application/json').catch(() => {});
    store.putBuffer(`media-fullshot/${key}.jpg`, fs.readFileSync(dst), 'image/jpeg')
      .then(() => console.log(`[crawl] lg.com 전체 화면 캡처 → 캡처 저장소 ${key} (${Math.round(fs.statSync(dst).size / 1024)}KB)`))
      .catch((e) => console.warn('[crawl] 캡처 버킷 업로드 실패', e.message));
  } catch (e) { console.warn('[crawl] 캡처 올리기 실패', e.message); }
}

// 크롤 단계 캡처 (2026-11-24): Shopee/Lazada 법인(th · sg) 제품은 크롤이 끝나면 바로 lg.com 을 직접 캡처(이미지 위치 기록 포함)하고
//   검토 화면 준비를 차례에 넣는다 → 검토 준비는 이 캡처를 그대로 써서 몇 초 만에 끝난다 (따로 캡처하지 않음).
//   캡처는 서버의 캡처 작업자로 (/api/v1/fullshot force · via direct — Firecrawl 유료 호출 없음). 막히면 크롤 때 받은 Firecrawl 캡처가 남는다.
//   CRAWL_CAPTURE=0 이면 끔. 대상 법인은 REVIEW_PREWARM_COUNTRIES (기본 th,sg)
const CRAWL_CAPTURE_COUNTRIES = new Set(String(process.env.REVIEW_PREWARM_COUNTRIES || 'th,sg').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
function willCrawlCapture(url) {
  if (process.env.CRAWL_CAPTURE === '0') return false;
  const m = /lg\.com\/([a-z]{2})\//i.exec(url || '');
  return !!(m && CRAWL_CAPTURE_COUNTRIES.has(m[1].toLowerCase()));
}
function crawlCapture(url, slug) {
  if (!willCrawlCapture(url)) return;
  fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/v1/fullshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, force: true, via: 'direct' }) })
    .then((r) => r.json())
    .then((j) => {
      console.log(`[crawl] lg.com 캡처 시작 (크롤 단계) ${slug} — ${j.status}`);
      try {   // 검토 준비 — 캡처가 끝나기를 기다렸다가 그 캡처로 (미리 준비 차례, 사람이 연 것보다 뒤)
        const review = require('./review');
        for (const ch of ['shopee', 'lazada']) review.enqueue(slug, ch, {}, true);
      } catch (e) { console.warn('[crawl] 검토 준비 차례 넣기 실패', e.message); }
    })
    .catch((e) => console.warn('[crawl] lg.com 캡처 시작 실패', slug, e.message));
}

function launchPipeline(jobId, url, usePro, geminiKey, fullAi, html = null, base = '') {
  const slug = slugify(url);
  const out = path.join(OUT_DIR, slug);
  fs.mkdirSync(out, { recursive: true });
  // 원본 URL·크롤 시각 기록 — 제품 목록(/api/v1/products)이 slug만으로는 URL을 복원할 수 없어서
  fs.writeFileSync(path.join(out, 'source.json'),
    JSON.stringify({ url, crawled_at: Date.now() / 1000 }, null, 2));
  fs.writeFileSync(path.join(out, 'progress.json'),
    JSON.stringify({ percent: 0, message: '작업 대기열 등록됨', step: 'queued', updated_at: Date.now() / 1000 }));

  const args = [PIPELINE, url, '--cache'];
  if (html) {   // 미리 받은 제품 페이지 HTML (Firecrawl 생략 — 파이프라인이 요청 페이지인지 다시 확인)
    const hf = path.join(out, '_input.html');
    fs.writeFileSync(hf, html);
    args.push('--html-file', hf);
  }
  if (usePro) args.push('--pro');
  if (fullAi) args.push('--full-ai'); // 기존 방식(스크린샷 + Gemini 분석·시각 QA) 강제
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (geminiKey) env.GEMINI_API_KEY = geminiKey; // BYOK
  // 검토 화면 법인(th · sg)은 크롤이 끝나면 뒤에서 lg.com 을 직접 캡처(컴포넌트 기록 포함)하므로, 크롤의 Firecrawl 요청에서는 캡처를 받지 않는다
  //   → 빌더에 필요한 HTML 만 빨리 받고(스크롤 23번 · 전체 화면 캡처 생략) 바로 빌더로 (2026-11-25 사용자 결정)
  if (willCrawlCapture(url) && process.env.CRAWL_FIRECRAWL_SHOT !== '1') env.CRAWL_FIRECRAWL_SHOT = '0';

  const logFd = fs.openSync(path.join(out, 'pipeline.log'), 'w');
  const proc = spawn(resolvePython(), args, { cwd: CRAWLER_DIR, env, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  const job = jobs.get(jobId);
  Object.assign(job, { slug, out, proc, exited: false });
  proc.on('exit', (code, signal) => {
    const ok = code === 0 && fs.existsSync(path.join(out, 'mirror.json'));
    if (!ok) {
      job.signal = signal || null;
      const f = failureOf(job);
      console.error(`[crawl] 실패 #${refOf(jobId)} ${url} — ${f.code} · exit ${code}${signal ? ' ' + signal : ''} · ${f.detail}`);
    }
    // 텍스트 v2 크롤 결과: 검은·없는 동영상 포스터에 자동 장면 (video-frames.js) — 끝날 때까지 작업은 '처리 중'
    if (ok) job.post = true;
    job.exited = true;
    if (!ok) return;
    publishPageShot(url, out);
    crawlCapture(url, slug);   // 검토용 캡처 · 검토 준비는 뒤에서 (빌더를 기다리게 하지 않음)
    const tCrawl = Date.now() / 1000 - job.startedAt;
    autoFrame(out, { base })
      .catch((e) => console.warn('[auto-frame]', slug, e.message))
      .finally(() => {
        job.post = false;
        const tAll = Date.now() / 1000 - job.startedAt;
        console.log(`[crawl] 완료 ${slug} — 크롤 ${tCrawl.toFixed(1)}초 · 동영상 장면 ${(tAll - tCrawl).toFixed(1)}초 → 빌더 열림 (총 ${tAll.toFixed(1)}초)${willCrawlCapture(url) ? ' · 검토 캡처 · 준비는 뒤에서' : ''}`);
        // 크롤 결과를 버킷에 보관 (재배포해도 유지)
        store.pushProduct(slug).then((n) => n && console.log(`[crawl-store] ${slug}: ${n}개 파일 업로드`));
      });
  });
  proc.on('error', (e) => { job.exited = true; job.spawnError = e.message; console.error(`[crawl] 실패 #${refOf(jobId)} ${url} — 시작 못 함 · ${e.message}`); });
}

// 컨텐츠가 아닌 컴포넌트를 캐시된 mirror.json 에서도 뺀다 (crawler-py/component_mirror.py NON_CONTENT_COMPONENTS 와 같은 목록)
//   ST0018 = 링크가 걸리는 앵커 컴포넌트(사용 설명서·색상 바로가기 등) — feature 카드 아님. 재크롤 없이 기존 캐시에 적용.
const NON_CONTENT_COMPONENTS = new Set(['ST0018']);
//   PD0022 = 페이지 맨 위 추천 상품·액세서리 제목 (2026-11-26, component_mirror.py ACCESSORY_COMPONENTS 와 같은 규칙):
//   제목은 빼고, 이미지가 붙어 있으면(다음 히어로 이미지가 잘못 붙은 경우) 이미지만 남긴다. 이미지가 없으면 섹션째 뺀다.
const ACCESSORY_COMPONENTS = new Set(['PD0022']);
function cleanSections(sections) {
  const out = [];
  let changed = false;
  for (const s of sections) {
    if (NON_CONTENT_COMPONENTS.has(s.component_id)) { changed = true; continue; }
    if (ACCESSORY_COMPONENTS.has(s.component_id)) {
      if (!(s.media || []).length) { changed = true; continue; }
      if (s.text || (s.text_roles || []).length || s.group_heading) { changed = true; out.push({ ...s, text: '', text_roles: [], group_heading: '' }); continue; }
    }
    out.push(s);
  }
  return { out, changed };
}
function stripNonContent() {
  let n = 0;
  for (const slug of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []) {
    const fp = path.join(OUT_DIR, slug, 'mirror.json');
    const m = fs.existsSync(fp) ? readJson(fp) : null;
    if (!m || !Array.isArray(m.sections)) continue;
    const { out, changed } = cleanSections(m.sections);
    if (!changed) continue;
    m.sections = out;
    fs.writeFileSync(fp, JSON.stringify(m, null, 2));
    n++;
  }
  if (n) console.log(`[crawl] 컨텐츠 아닌 컴포넌트(${[...NON_CONTENT_COMPONENTS, ...ACCESSORY_COMPONENTS]}) 정리: ${n}개 제품`);
  return n;
}

function snapshot(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const mirrorFp = path.join(job.out, 'mirror.json');
  const prog = readJson(path.join(job.out, 'progress.json')) || { percent: 0, message: '' };

  if (job.post) {   // 파이프라인은 끝났고 동영상 자동 장면을 고르는 중
    return { job_id: jobId, status: 'processing', progress_percent: 98,
      log_message: '동영상 대표 장면 확인 중...', step: 'video', updated_at: Date.now() / 1000 };
  }
  if (fs.existsSync(mirrorFp) && fs.statSync(mirrorFp).mtimeMs / 1000 >= job.startedAt - 1) {
    return {
      job_id: jobId, status: 'completed', progress_percent: 100,
      completed_at: fs.statSync(mirrorFp).mtimeMs / 1000,
      result: { ...(readJson(mirrorFp) || {}), _qa: readJson(path.join(job.out, 'qa_report.json')) },
    };
  }
  if (job.exited) {
    // 사용자에게는 쉬운 말과 문의 번호만 — 기술 내용은 실패할 때 서버 로그에 남겼다 ([crawl] 실패 #번호)
    const f = failureOf(job);
    return { job_id: jobId, status: 'failed', progress_percent: prog.percent || 0, code: f.code, ref: refOf(jobId), error: f.message };
  }
  return { job_id: jobId, status: 'processing', progress_percent: prog.percent || 0,
    log_message: prog.message || '', step: prog.step || '', updated_at: prog.updated_at };
}

const mediumOf = (m) => (/^[a-z_]{2,32}$/.test(m || '') ? m : 'ebay');

// listingUrl 이 있으면 그 제품의 리스팅 문구(현재 버전)를 맨 위·맨 아래 카드로 붙인다 (listing-routes.js)
async function renderEbayHtml(out, medium = 'ebay', listingUrl = null) {
  if (!fs.existsSync(path.join(out, 'mirror.json'))) {
    throw Object.assign(new Error('mirror not ready — crawl first'), { status: 404 });
  }
  const args = [RENDER_CONTENT, out, mediumOf(medium)];
  const listing = listingUrl ? await require('./listing-routes').currentFor(listingUrl) : null;
  if (listing) {
    const lf = path.join(out, 'listing.json');
    fs.writeFileSync(lf, JSON.stringify(listing));
    args.push(lf);
  }
  return new Promise((resolve, reject) => {
    execFile(resolvePython(), args, { cwd: CRAWLER_DIR, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// Amazon A+ (Python content_gen.amazon) — cmd: features | modules (slug 폴더 필요) · images | stack
//   input → stdin JSON. raw=true 면 stdout 을 Buffer 로 (ZIP), 아니면 JSON.
function runAmazon(cmd, { out = null, input = null, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    if (out && !fs.existsSync(path.join(out, 'mirror.json'))) {
      return reject(Object.assign(new Error('mirror not ready — crawl first'), { status: 404 }));
    }
    const child = execFile(resolvePython(), [RENDER_AMAZON, cmd, ...(out ? [out] : [])],
      { cwd: CRAWLER_DIR, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer', timeout: 10 * 60 * 1000,
        // 이미지는 같은 서버의 /api/proxy-image 중계로 받는다 (배포 서버에서 Python 직접 요청은 LG.com 이 403)
        env: { ...process.env, PYTHONIOENCODING: 'utf-8',
               CLIA_IMAGE_PROXY: `http://127.0.0.1:${process.env.PORT || 3001}/api/proxy-image?url=` } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || '') || err.message));
        if (raw) return resolve({ data: stdout, info: String(stderr || '').trim().split('\n').pop() });
        try { resolve(JSON.parse(stdout.toString('utf-8'))); } catch (e) { reject(new Error('bad amazon output: ' + e.message)); }
      });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

const router = express.Router();

router.get('/healthz', (req, res) => res.json({
  ok: true,
  master_key: !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY),
  ai: process.env.GEMINI_API_KEY ? 'gemini' : (process.env.ANTHROPIC_API_KEY ? 'claude' : null),   // Gemini 키가 있으면 Gemini
  firecrawl: !!process.env.FIRECRAWL_API_KEY,
}));

// 크롤 작업 등록 → { jobId, cached }. 캐시(mirror.json)가 있으면 파이프라인 없이 즉시 완료.
function startCrawl(url, { force = false, pro = false, geminiKey = null, fullAi = false, html = null, base = '' } = {}) {
  url = cleanUrl(url);
  const slug = slugify(url);
  const out = path.join(OUT_DIR, slug);
  // 같은 제품을 이미 크롤 중이면 새로 띄우지 않고 그 크롤에 합류한다 (2026-11-24).
  //   두 크롤이 같은 폴더에 동시에 쓰면 결과가 섞이고, '다시 크롤'(force)은 진행 중인 크롤의 결과 파일을 지운다.
  //   허브 · 빌더 · 벌크 엑셀 모두 이 함수를 거치므로 여러 사람이 같은 제품을 눌러도 크롤은 하나
  for (const [id, j] of jobs) {
    if (j.slug === slug && j.proc && (!j.exited || j.post)) {
      console.log(`[crawl] ${slug}: 이미 크롤 중 → 같은 작업(${id})에 합류`);
      return { jobId: id, cached: false, joined: true };
    }
  }
  if (html) force = true;
  if (fs.existsSync(path.join(out, 'mirror.json')) && !force) {
    const jobId = 'cached_' + crypto.randomBytes(6).toString('hex');
    jobs.set(jobId, { url, slug, out, startedAt: 0, proc: null, exited: true });
    return { jobId, cached: true };
  }
  if (force && fs.existsSync(out)) {
    for (const f of ['mirror.json', 'final.json', 'pc.md', 'pc.html', 'pc_raw.html', 'pc_full.png', 'lgcom_full.jpg', 'progress.json']) {
      try { fs.unlinkSync(path.join(out, f)); } catch {}
    }
  }
  const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
  jobs.set(jobId, { url, slug, startedAt: Date.now() / 1000 });
  launchPipeline(jobId, url, pro, geminiKey, fullAi, html, base);
  return { jobId, cached: false };
}

// 크롤 후 완료까지 대기해 mirror(+_qa) 반환 — /api/pcg-vision 등 서버 내부용
async function crawl(url, opts = {}) {
  const { jobId } = startCrawl(url, opts);
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const snap = snapshot(jobId);
    if (snap.status === 'completed') return snap.result;
    if (snap.status === 'failed') throw Object.assign(new Error(snap.error || CRAWL_FAIL.unknown), { code: snap.code, ref: snap.ref });
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`[crawl] 실패 #${refOf(jobId)} ${url} — 20분 안에 끝나지 않음`);
  throw Object.assign(new Error(CRAWL_FAIL.stopped), { code: 'stopped', ref: refOf(jobId) });
}

// lg.com/<국가>/... → 국가 코드 (sa_en·sa_ar → sa). 법인별 제품 목록 필터에 사용.
function countryOf(url) {
  const m = /lg\.com\/([a-z]{2})(?:_[a-z]{2})?\//i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}

const firstImage = (mirror) => {
  const g = (mirror._gallery || [])[0];
  if (g) return g.pc_url || g.unified_url || g.mobile_url || '';
  for (const s of mirror.sections || []) {
    const m = (s.media || []).find((x) => x.role !== 'icon' && (x.pc_url || x.unified_url));
    if (m) return m.pc_url || m.unified_url;
  }
  return '';
};

function productSummary(slug) {
  const dir = path.join(OUT_DIR, slug);
  const src = readJson(path.join(dir, 'source.json'));
  const mirrorFp = path.join(dir, 'mirror.json');
  if (!src || !src.url || !fs.existsSync(mirrorFp)) return null;
  const mirror = readJson(mirrorFp) || {};
  return {
    slug, url: src.url, country: countryOf(src.url),
    title: mirror.product_title || slug,
    thumb: firstImage(mirror),
    crawled_at: src.crawled_at || fs.statSync(mirrorFp).mtimeMs / 1000,
    sections: (mirror.sections || []).length,
    gallery: (mirror._gallery || []).length,
  };
}

router.get('/api/v1/products', auth, (req, res) => {
  const country = String(req.query.country || '').toLowerCase();
  let dirs = [];
  try { dirs = fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  const list = dirs.map((d) => productSummary(d.name)).filter(Boolean)
    .filter((p) => !country || p.country === country)
    .sort((a, b) => b.crawled_at - a.crawled_at);
  res.json({ count: list.length, products: list });
});

// 크롤 제품 삭제 → 다시 크롤할 수 있게 (허브 목록의 삭제 버튼, 2026-11-05)
//   로컬 crawler-py/out/<slug>/ 는 out/_trash/<slug>-<stamp>/ 로 옮기고, 버킷은 trash/<stamp>/ 에 복사 후 삭제 (되돌리기 가능).
//   제품별 리스팅 문구(listing-texts/)는 URL 기준이라 지우지 않는다 → 다시 크롤하면 그대로 이어진다.
router.delete('/api/v1/products/:slug', auth, async (req, res) => {
  const slug = path.basename(req.params.slug);
  const dir = path.join(OUT_DIR, slug);
  if (!slug || slug.startsWith('_') || !fs.existsSync(path.join(dir, 'mirror.json'))) return res.status(404).json({ detail: 'product not found' });
  for (const [id, j] of jobs) {
    if (j.slug === slug && j.proc && !j.exited) return res.status(409).json({ detail: 'crawl in progress' });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trash = path.join(OUT_DIR, '_trash', `${slug}-${stamp}`);
  const meta = trashMeta(productSummary(slug), slug, Date.now() / 1000);   // 복구 목록에 보일 정보 — 폴더를 옮기기 전에
  const label = String(req.query.label || '').trim();   // 허브 목록에 보이던 이름 (같은 모델이 둘이면 GN-D382PQMB-TH 처럼 꼬리)
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(label)) meta.label = label;
  try {
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(dir, trash);
    const aux = path.join(__dirname, 'crawler', 'out');
    for (const f of fs.existsSync(aux) ? fs.readdirSync(aux).filter((n) => n.startsWith(`${slug}.`)) : []) {
      fs.renameSync(path.join(aux, f), path.join(trash, `crawler-out.${f}`));
    }
    for (const [id, j] of jobs) if (j.slug === slug) jobs.delete(id);   // 캐시된 작업이 지운 결과를 돌려주지 않게
    let remote = 0;
    try { remote = await store.deleteProduct(slug, stamp, meta); }
    catch (e) { console.warn('[crawl] 버킷 삭제 실패', slug, e.message); return res.status(502).json({ detail: 'local removed, bucket delete failed: ' + e.message }); }
    console.log(`[crawl] 제품 삭제: ${slug} (로컬 → ${path.relative(OUT_DIR, trash)}, 버킷 ${remote}개 → trash/${stamp}/)`);
    res.json({ ok: true, slug, stamp, trash: path.relative(OUT_DIR, trash), remote });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

// ── 최근 삭제한 제품 · 복구 (2026-11-26) ──
//   삭제는 버킷 trash/<stamp>/ 에 사본(편집본 · 승인 기록 등 제품 폴더 전부)을 남기고, 서버 로컬은 out/_trash/<slug>-<stamp>/ 로 옮긴다.
//   목록은 버킷 기준(재배포돼도 남는다) + 로컬 _trash. 복구는 원래 키로 다시 복사하고 로컬도 되돌린다.
//   그새 같은 제품을 다시 크롤했으면 덮어쓰지 않고 409 { code: 'recrawled' }.
const TRASH_DIR = path.join(OUT_DIR, '_trash');
const modelOf = (url, slug) => {
  try { const segs = new URL(url).pathname.split('/').filter(Boolean); return (segs[segs.length - 1] || slug).toUpperCase(); }
  catch { return String(slug || '').split('-').pop().toUpperCase(); }
};
function trashMeta(sum, slug, deletedAt) {
  const url = (sum && sum.url) || '';
  return { slug, url, country: countryOf(url) || (/^www-lg-com-([a-z]{2})-/.exec(slug) || [])[1] || '',
    model: modelOf(url, slug), title: (sum && sum.title) || '', thumb: (sum && sum.thumb) || '',
    crawled_at: (sum && sum.crawled_at) || 0, deleted_at: deletedAt || 0 };
}
const stampTime = (st) => { const t = Date.parse(st.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')); return Number.isFinite(t) ? t / 1000 : 0; };
// 로컬 휴지통 폴더 → { stamp, slug, dir }  (이름: <slug>-<stamp>)
function localTrash() {
  let names = [];
  try { names = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  return names.map((n) => {
    const m = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.exec(n);
    return m ? { slug: m[1], stamp: m[2], dir: path.join(TRASH_DIR, n) } : null;
  }).filter(Boolean);
}
// 로컬 휴지통 폴더의 정보 (source.json · mirror.json 이 폴더째 옮겨져 있다)
function localMeta(e) {
  const src = readJson(path.join(e.dir, 'source.json')) || {};
  const mirror = readJson(path.join(e.dir, 'mirror.json')) || {};
  return trashMeta({ url: src.url, title: mirror.product_title, thumb: firstImage(mirror), crawled_at: src.crawled_at }, e.slug, stampTime(e.stamp));
}
const trashMetaCache = new Map();   // stamp|slug → meta (사본은 바뀌지 않는다)
async function bucketMeta(e) {
  const k = `${e.stamp}|${e.slug}`;
  if (trashMetaCache.has(k)) return trashMetaCache.get(k);
  let meta = null;
  if (e.meta) { try { meta = JSON.parse(String(await store.getBuffer(`trash/${e.stamp}/${store.TRASH_META}`))); } catch {} }
  if (!meta || meta.slug !== e.slug) {   // 메모를 남기기 전(11/26 이전)에 지운 것 — 사본의 source.json 으로
    let src = {};
    try { src = JSON.parse(String(await store.getBuffer(`trash/${e.stamp}/crawler-py-out/${e.slug}/source.json`))); } catch {}
    meta = trashMeta({ url: src.url, crawled_at: src.crawled_at }, e.slug, stampTime(e.stamp));
  }
  trashMetaCache.set(k, meta);
  return meta;
}
const crawlingNow = (slug) => [...jobs.values()].some((j) => j.slug === slug && j.proc && !j.exited);

router.get('/api/v1/products-trash', auth, async (req, res) => {
  const country = String(req.query.country || '').toLowerCase();
  const items = new Map();
  try {
    for (const e of await store.listTrash()) {
      if (e.restored) continue;
      items.set(`${e.stamp}|${e.slug}`, { ...(await bucketMeta(e)), stamp: e.stamp, bucket: true, local: false, files: e.keys.length });
    }
  } catch (e) { return res.status(502).json({ detail: 'bucket list failed: ' + e.message }); }
  for (const e of localTrash()) {
    const k = `${e.stamp}|${e.slug}`;
    if (items.has(k)) items.get(k).local = true;
    else if (!store.enabled()) items.set(k, { ...localMeta(e), stamp: e.stamp, bucket: false, local: true });
    // 버킷이 있는데 버킷 사본이 없는 로컬 폴더 = 이미 복구했거나 버킷 삭제가 실패한 것 → 목록에 넣지 않는다
  }
  const list = [...items.values()]
    .filter((x) => !country || x.country === country)
    .map((x) => ({ ...x, recrawled: !!productSummary(x.slug) }))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  res.json({ count: list.length, items: list });
});

router.post('/api/v1/products-trash/restore', auth, express.json(), async (req, res) => {
  const slug = path.basename(String((req.body || {}).slug || ''));
  const stamp = String((req.body || {}).stamp || '');
  if (!slug || slug.startsWith('_') || !store.STAMP_RE.test(stamp)) return res.status(400).json({ detail: 'slug and stamp required' });
  const recrawled = () => { const s = productSummary(slug); return res.status(409).json({ code: 'recrawled', detail: 'this product was crawled again after it was deleted', crawled_at: s ? s.crawled_at : 0 }); };
  if (crawlingNow(slug)) return res.status(409).json({ code: 'crawling', detail: 'crawl in progress' });
  if (fs.existsSync(path.join(OUT_DIR, slug, 'mirror.json'))) return recrawled();
  const local = localTrash().find((e) => e.slug === slug && e.stamp === stamp);
  let keys = [];
  try {
    if (store.enabled()) {
      const r = await store.restoreProduct(stamp, slug);
      if (r.conflict) return recrawled();
      if (r.missing && !local) return res.status(404).json({ detail: 'not in trash' });
      keys = r.keys;
    } else if (!local) return res.status(404).json({ detail: 'not in trash' });
    if (local) try {
      const dir = path.join(OUT_DIR, slug);
      if (fs.existsSync(dir)) fs.renameSync(dir, path.join(TRASH_DIR, `${slug}-leftover-${Date.now()}`));   // mirror 없는 실패 크롤 찌꺼기
      fs.renameSync(local.dir, dir);
      const aux = path.join(__dirname, 'crawler', 'out');
      for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('crawler-out.'))) {
        fs.mkdirSync(aux, { recursive: true });
        fs.renameSync(path.join(dir, f), path.join(aux, f.slice('crawler-out.'.length)));
      }
    } catch (e) {   // 버킷은 이미 되돌렸으면 아래에서 버킷 사본을 내려받는다
      if (!keys.length) throw e;
      console.warn('[crawl] 복구: 로컬 폴더 되돌리기 실패, 버킷에서 받음', slug, e.message);
    }
    const pulled = await store.pullKeys(keys);   // 로컬 사본이 없으면(재배포 뒤) 버킷에서 내려받는다
    for (const [id, j] of jobs) if (j.slug === slug) jobs.delete(id);
    if (!fs.existsSync(path.join(OUT_DIR, slug, 'mirror.json'))) return res.status(500).json({ detail: 'restored files have no mirror.json' });
    trashMetaCache.delete(`${stamp}|${slug}`);
    console.log(`[crawl] 제품 복구: ${slug} (trash/${stamp}/ → 버킷 ${keys.length}개${local ? ' · 로컬 폴더' : ''} · 내려받음 ${pulled}개)`);
    res.json({ ok: true, slug, stamp, remote: keys.length, local: !!local, pulled, product: productSummary(slug) });
  } catch (e) {
    console.warn('[crawl] 복구 실패', slug, stamp, e.message);
    res.status(500).json({ detail: e.message });
  }
});

router.get('/api/v1/products/:slug', auth, (req, res) => {
  const slug = path.basename(req.params.slug); // 경로 탈출 방지
  const sum = productSummary(slug);
  if (!sum) return res.status(404).json({ detail: 'product not found' });
  const mirror = readJson(path.join(OUT_DIR, slug, 'mirror.json')) || {};
  res.json({ ...sum, geo: readJson(path.join(OUT_DIR, slug, 'geo.json')),
    mirror: { ...mirror, _qa: readJson(path.join(OUT_DIR, slug, 'qa_report.json')) } });
});

// ── GEO: 크롤 원문만 근거로 AI 검색 인용용 Q&A + 타겟 키워드 생성 (Gemini, crawler-py/geo_gen.py)
//    제품당 1회 생성 후 out/<slug>/geo.json 에 저장해 재사용한다.
const GEO_GEN = path.join(CRAWLER_DIR, 'geo_gen.py');
function generateGeo(slug) {
  const dir = path.join(OUT_DIR, slug);
  if (!fs.existsSync(path.join(dir, 'mirror.json'))) {
    return Promise.reject(Object.assign(new Error('mirror not found'), { status: 404 }));
  }
  return new Promise((resolve, reject) => {
    execFile(resolvePython(), [GEO_GEN, dir], {
      cwd: CRAWLER_DIR, timeout: 3 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      try {
        const geo = { ...JSON.parse(stdout), generated_at: Date.now() / 1000 };
        fs.writeFileSync(path.join(dir, 'geo.json'), JSON.stringify(geo, null, 2));
        store.pushPaths([path.join(dir, 'geo.json')]);
        resolve(geo);
      } catch (e) { reject(new Error('invalid GEO output: ' + e.message)); }
    });
  });
}

router.post('/api/v1/products/:slug/geo', auth, async (req, res) => {
  const slug = path.basename(req.params.slug);
  const cached = readJson(path.join(OUT_DIR, slug, 'geo.json'));
  if (cached && !(req.body || {}).force) return res.json(cached);
  try { res.json(await generateGeo(slug)); }
  catch (e) { console.error('[geo]', slug, e.message); res.status(e.status || 500).json({ detail: e.message.slice(0, 300) }); }
});

router.post('/api/v1/crawl', auth, (req, res) => {
  const { url, force_refresh = false, use_pro_model = false, full_ai = false, html = null } = req.body || {};
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ detail: 'valid url required' });
  }
  // html(미리 받은 제품 페이지)은 저장 컨텐츠를 정하므로 EXPORT_TOKEN 이 있어야 받는다
  if (html != null) {
    const tok = (process.env.EXPORT_TOKEN || '').trim();
    if (!tok || req.get('x-export-token') !== tok) return res.status(401).json({ detail: 'html requires x-export-token' });
    if (typeof html !== 'string' || html.length < 5000) return res.status(400).json({ detail: 'html too short' });
  }
  const { jobId, cached } = startCrawl(cleanUrl(url), {
    force: !!force_refresh, pro: !!use_pro_model, fullAi: !!full_ai, geminiKey: req.get('x-gemini-api-key') || null,
    html: html || null,
    base: `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`,   // 자동 장면 이미지 주소 (PUBLIC_BASE_URL 우선)
  });
  if (cached) {
    return res.status(202).json({ job_id: jobId, status: 'completed', cached: true, url: cleanUrl(url),
      message: '기분석 캐시 존재 — /api/v1/jobs/{job_id} 로 결과 조회', estimated_duration_seconds: 0 });
  }
  res.status(202).json({ job_id: jobId, status: 'queued', url: cleanUrl(url),
    message: '크롤링 분석 작업이 대기열에 등록되었습니다. 실시간 상태 조회를 활용하십시오.',
    estimated_duration_seconds: 45 });
});

router.get('/api/v1/jobs/:id', auth, (req, res) => {
  const snap = snapshot(req.params.id);
  if (!snap) return res.status(404).json({ detail: 'job not found' });
  res.json(snap);
});

router.get('/api/v1/jobs/:id/ebay-html', auth, async (req, res) => {
  const snap = snapshot(req.params.id);
  if (!snap) return res.status(404).json({ detail: 'job not found' });
  if (snap.status !== 'completed') {
    return res.status(409).json({ detail: `job status=${snap.status} — 완료 후 호출하세요` });
  }
  const job = jobs.get(req.params.id);
  try { res.type('html').send(await renderEbayHtml(job.out, 'ebay', req.query.listing === '0' ? null : job.url)); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message }); }
});

router.get('/api/v1/ebay-html', auth, async (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ detail: 'url required' });
  try { res.type('html').send(await renderEbayHtml(path.join(OUT_DIR, slugify(req.query.url)), 'ebay', req.query.listing === '0' ? null : req.query.url)); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message }); }
});

router.get('/api/v1/content-html', auth, async (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ detail: 'url required' });
  try { res.type('html').send(await renderEbayHtml(path.join(OUT_DIR, slugify(req.query.url)), req.query.medium, req.query.listing === '0' ? null : req.query.url)); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message }); }
});

router.get('/api/v1/amazon-features', auth, async (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ detail: 'url required' });
  try { res.json(await runAmazon('features', { out: path.join(OUT_DIR, slugify(req.query.url)) })); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message.slice(0, 300) }); }
});
// 빌더가 이미 받은 크롤 결과(mirror)로 바로 카드 목록 — URL 표기 차이로 캐시를 못 찾는 일이 없게
router.post('/api/v1/amazon-features', auth, async (req, res) => {
  const { mirror } = req.body || {};
  if (!mirror || !Array.isArray(mirror.sections)) return res.status(400).json({ detail: 'mirror required' });
  try { res.json(await runAmazon('features', { input: { mirror } })); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message.slice(0, 300) }); }
});

// 선택 카드 → 모듈. features(카드 목록)를 주면 그것으로, 아니면 url 의 크롤 캐시로
router.post('/api/v1/amazon-modules', auth, async (req, res) => {
  const { url, features, selection = [], mode = 'standard', start_id = 1 } = req.body || {};
  if (typeof url !== 'string' && !Array.isArray(features)) return res.status(400).json({ detail: 'url or features required' });
  if (!Array.isArray(selection)) return res.status(400).json({ detail: 'selection must be an array' });
  const input = { selection, mode: mode === 'premium' ? 'premium' : 'standard', start_id };
  try {
    res.json(Array.isArray(features)
      ? await runAmazon('modules', { input: { ...input, features } })
      : await runAmazon('modules', { out: path.join(OUT_DIR, slugify(url)), input }));
  } catch (e) { res.status(e.status || 500).json({ detail: e.message.slice(0, 300) }); }
});

// 모듈(+미리보기 이동·확대 transforms) → A+ 규격 JPEG ZIP + aplus-copy.txt
router.post('/api/v1/amazon-images', auth, async (req, res) => {
  const { modules, pdpUrl = '', date = '' } = req.body || {};
  if (!Array.isArray(modules) || !modules.length) return res.status(400).json({ detail: 'modules required' });
  try {
    const { data, info } = await runAmazon('images', { input: { modules, pdpUrl, date }, raw: true });
    let meta = {}; try { meta = JSON.parse(info); } catch {}
    if (!meta.count) return res.status(422).json({ detail: 'no images could be processed', fails: meta.fails || [] });
    res.set({ 'Content-Type': 'application/zip', 'X-Image-Count': String(meta.count),
      'X-Image-Fails': encodeURIComponent(JSON.stringify(meta.fails || [])),
      'Access-Control-Expose-Headers': 'X-Image-Count, X-Image-Fails' });
    res.send(data);
  } catch (e) { res.status(500).json({ detail: e.message.slice(0, 300) }); }
});

// 원본 이미지의 일부(box = x,y,w,h, 0~1 비율)를 잘라 JPEG — Amazon 이미지 자동 선택(PC·모바일) 결과 미리보기용
router.get('/api/v1/image-crop', async (req, res) => {
  const { url, box } = req.query;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || typeof box !== 'string' || !/^[\d.]+(,[\d.]+){3}$/.test(box)) {
    return res.status(400).json({ detail: 'url and box=x,y,w,h required' });
  }
  try {
    const { data } = await runAmazon('crop', { input: { url, box }, raw: true });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    res.send(data);
  } catch (e) { res.status(502).json({ detail: e.message.slice(0, 300) }); }
});

// 이어 붙은 히어로 이미지들 → 한 장 (data URL) + 가장자리 평균색
router.post('/api/v1/amazon-stack', auth, async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length < 2) return res.status(400).json({ detail: 'urls (2+) required' });
  try { res.json(await runAmazon('stack', { input: { urls } })); }
  catch (e) { res.status(500).json({ detail: e.message.slice(0, 300) }); }
});

router.get('/api/v1/jobs/:id/stream', (req, res) => {
  if (!jobs.has(req.params.id)) return res.status(404).json({ detail: 'job not found' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let last = -1, ticks = 0;
  const timer = setInterval(() => {
    const snap = snapshot(req.params.id);
    if (snap.status === 'completed') {
      send('complete', { redirect_url: `/api/v1/jobs/${req.params.id}` }); return stop();
    }
    if (snap.status === 'failed') { send('error', { error: (snap.error || '').slice(0, 300) }); return stop(); }
    if (snap.progress_percent !== last) {
      send('progress', { percent: snap.progress_percent, message: snap.log_message, step: snap.step });
      last = snap.progress_percent;
    }
    if (++ticks >= 2400) { send('error', { error: 'timeout' }); stop(); } // ~20분
  }, 500);
  const stop = () => { clearInterval(timer); res.end(); };
  req.on('close', () => clearInterval(timer));
});

// 재배포 마무리 (drain.js): 돌고 있는 크롤(파이프라인 · 동영상 장면 고르기)이 끝날 때까지 이전 서버가 기다린다
require('./drain').register({ name: 'crawl', pause: () => {}, busy: () => [...jobs.values()].filter((j) => (j.proc && !j.exited) || j.post).length });

module.exports = router;
module.exports.crawl = crawl;
module.exports.cleanUrl = cleanUrl;
module.exports.slugify = slugify;
module.exports.stripNonContent = stripNonContent;
module.exports.productSummary = productSummary;   // 벌크 엑셀 SKU 연결 (bulk-routes.js)
module.exports.OUT_DIR = OUT_DIR;
module.exports.auth = auth;   // 검토·승인 저장 (approvals.js)
setImmediate(() => { try { stripNonContent(); } catch (e) { console.warn('[crawl] stripNonContent:', e.message); } });
module.exports.publishPageShot = publishPageShot;   // 크롤이 받은 lg.com 캡처 올리기 (시험·다시 쓰기용)
