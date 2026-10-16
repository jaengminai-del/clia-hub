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

function launchPipeline(jobId, url, usePro, geminiKey, fullAi) {
  const slug = slugify(url);
  const out = path.join(OUT_DIR, slug);
  fs.mkdirSync(out, { recursive: true });
  // 원본 URL·크롤 시각 기록 — 제품 목록(/api/v1/products)이 slug만으로는 URL을 복원할 수 없어서
  fs.writeFileSync(path.join(out, 'source.json'),
    JSON.stringify({ url, crawled_at: Date.now() / 1000 }, null, 2));
  fs.writeFileSync(path.join(out, 'progress.json'),
    JSON.stringify({ percent: 0, message: '작업 대기열 등록됨', step: 'queued', updated_at: Date.now() / 1000 }));

  const args = [PIPELINE, url, '--cache'];
  if (usePro) args.push('--pro');
  if (fullAi) args.push('--full-ai'); // 기존 방식(스크린샷 + Gemini 분석·시각 QA) 강제
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (geminiKey) env.GEMINI_API_KEY = geminiKey; // BYOK

  const logFd = fs.openSync(path.join(out, 'pipeline.log'), 'w');
  const proc = spawn(resolvePython(), args, { cwd: CRAWLER_DIR, env, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  const job = jobs.get(jobId);
  Object.assign(job, { slug, out, proc, exited: false });
  proc.on('exit', (code) => {
    job.exited = true;
    // 크롤 결과를 버킷에 보관 (재배포해도 유지)
    if (code === 0 && fs.existsSync(path.join(out, 'mirror.json'))) {
      store.pushProduct(slug).then((n) => n && console.log(`[crawl-store] ${slug}: ${n}개 파일 업로드`));
    }
  });
  proc.on('error', (e) => { job.exited = true; job.spawnError = e.message; });
}

function snapshot(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const mirrorFp = path.join(job.out, 'mirror.json');
  const prog = readJson(path.join(job.out, 'progress.json')) || { percent: 0, message: '' };

  if (fs.existsSync(mirrorFp) && fs.statSync(mirrorFp).mtimeMs / 1000 >= job.startedAt - 1) {
    return {
      job_id: jobId, status: 'completed', progress_percent: 100,
      completed_at: fs.statSync(mirrorFp).mtimeMs / 1000,
      result: { ...(readJson(mirrorFp) || {}), _qa: readJson(path.join(job.out, 'qa_report.json')) },
    };
  }
  if (job.exited) {
    let error = job.spawnError || '';
    if (!error) {
      // pipeline.log 의 Python 트레이스백 원문 대신, 사람이 읽을 수 있는 마지막 오류 한 줄만 전달
      try {
        const lines = fs.readFileSync(path.join(job.out, 'pipeline.log'), 'utf-8')
          .replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
        const last = lines.reverse().find((l) => /error|exception|✗|failed|실패/i.test(l)) || lines[0] || '';
        error = last.replace(/^[\w.]+(Error|Exception):\s*/, (m) => m.split('.').pop()).slice(0, 300);
        // 자주 나는 원인은 사용자 문장으로
        if (/JSONDecodeError/.test(error)) error = 'The AI analysis returned an incomplete response (this page is very long). Please try again.';
        else if (/GEMINI_API_KEY/.test(error)) error = 'GEMINI_API_KEY is not set on the server.';
        else if (/FIRECRAWL|402|Payment Required/i.test(error)) error = 'Page collection failed (Firecrawl key or credits). ' + error.slice(0, 120);
        else if (/429|RESOURCE_EXHAUSTED|quota/i.test(error)) error = 'The AI service quota was exceeded. Please try again later.';
      } catch {}
    }
    return { job_id: jobId, status: 'failed', progress_percent: prog.percent || 0,
      error: error || 'pipeline exited without result' };
  }
  return { job_id: jobId, status: 'processing', progress_percent: prog.percent || 0,
    log_message: prog.message || '', step: prog.step || '', updated_at: prog.updated_at };
}

const mediumOf = (m) => (/^[a-z_]{2,32}$/.test(m || '') ? m : 'ebay');

function renderEbayHtml(out, medium = 'ebay') {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.join(out, 'mirror.json'))) {
      return reject(Object.assign(new Error('mirror not ready — crawl first'), { status: 404 }));
    }
    execFile(resolvePython(), [RENDER_CONTENT, out, mediumOf(medium)], { cwd: CRAWLER_DIR, maxBuffer: 64 * 1024 * 1024,
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
  master_key: !!process.env.GEMINI_API_KEY,
  firecrawl: !!process.env.FIRECRAWL_API_KEY,
}));

// 크롤 작업 등록 → { jobId, cached }. 캐시(mirror.json)가 있으면 파이프라인 없이 즉시 완료.
function startCrawl(url, { force = false, pro = false, geminiKey = null, fullAi = false } = {}) {
  const slug = slugify(url);
  const out = path.join(OUT_DIR, slug);
  if (fs.existsSync(path.join(out, 'mirror.json')) && !force) {
    const jobId = 'cached_' + crypto.randomBytes(6).toString('hex');
    jobs.set(jobId, { url, slug, out, startedAt: 0, proc: null, exited: true });
    return { jobId, cached: true };
  }
  if (force && fs.existsSync(out)) {
    for (const f of ['mirror.json', 'final.json', 'pc.md', 'pc.html', 'pc_full.png', 'progress.json']) {
      try { fs.unlinkSync(path.join(out, f)); } catch {}
    }
  }
  const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
  jobs.set(jobId, { url, slug, startedAt: Date.now() / 1000 });
  launchPipeline(jobId, url, pro, geminiKey, fullAi);
  return { jobId, cached: false };
}

// 크롤 후 완료까지 대기해 mirror(+_qa) 반환 — /api/pcg-vision 등 서버 내부용
async function crawl(url, opts = {}) {
  const { jobId } = startCrawl(url, opts);
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const snap = snapshot(jobId);
    if (snap.status === 'completed') return snap.result;
    if (snap.status === 'failed') throw new Error(snap.error || 'pipeline failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('crawl timeout');
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
  const { url, force_refresh = false, use_pro_model = false, full_ai = false } = req.body || {};
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ detail: 'valid url required' });
  }
  const { jobId, cached } = startCrawl(url, {
    force: !!force_refresh, pro: !!use_pro_model, fullAi: !!full_ai, geminiKey: req.get('x-gemini-api-key') || null,
  });
  if (cached) {
    return res.status(202).json({ job_id: jobId, status: 'completed', cached: true,
      message: '기분석 캐시 존재 — /api/v1/jobs/{job_id} 로 결과 조회', estimated_duration_seconds: 0 });
  }
  res.status(202).json({ job_id: jobId, status: 'queued',
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
  try { res.type('html').send(await renderEbayHtml(jobs.get(req.params.id).out)); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message }); }
});

router.get('/api/v1/ebay-html', auth, async (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ detail: 'url required' });
  try { res.type('html').send(await renderEbayHtml(path.join(OUT_DIR, slugify(req.query.url)))); }
  catch (e) { res.status(e.status || 500).json({ detail: e.message }); }
});

router.get('/api/v1/content-html', auth, async (req, res) => {
  if (typeof req.query.url !== 'string') return res.status(400).json({ detail: 'url required' });
  try { res.type('html').send(await renderEbayHtml(path.join(OUT_DIR, slugify(req.query.url)), req.query.medium)); }
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

module.exports = router;
module.exports.crawl = crawl;
module.exports.slugify = slugify;
