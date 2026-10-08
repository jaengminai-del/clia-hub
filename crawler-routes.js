/**
 * crawler-routes.js — LG.com PDP 크롤러 (Python 파이프라인) 내장 라우터
 *
 * 예전 crawler-py/api.py (FastAPI) 와 동일한 /api/v1/* 계약을 제공하되,
 * 별도 서버(8080)·터널 없이 메인 Node 서버가 crawler-py/pdp_pipeline.py 를 자식 프로세스로 실행한다.
 * server.js 의 /api/pcg-vision 도 crawl() 을 직접 호출한다.
 *   POST /api/v1/crawl                  → 202 { job_id }
 *   GET  /api/v1/jobs/:id               → 상태/결과
 *   GET  /api/v1/jobs/:id/stream        → SSE 진행률
 *   GET  /api/v1/jobs/:id/ebay-html     → eBay HTML fragment
 *   GET  /api/v1/ebay-html?url=         → URL 직접 지정 렌더
 *   GET  /api/v1/products?country=uk    → 크롤 완료 제품 목록 (허브 Product List 검색용, 크롤러에 계속 누적)
 *   GET  /api/v1/products/:slug         → 제품 1건 (원본 URL + mirror + geo)
 *   POST /api/v1/products/:slug/geo     → GEO Q&A·키워드 AI 생성 (out/<slug>/geo.json 캐시, force:true 재생성)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const CRAWLER_DIR = path.join(__dirname, 'crawler-py');
const OUT_DIR = path.join(CRAWLER_DIR, 'out');
const PIPELINE = path.join(CRAWLER_DIR, 'pdp_pipeline.py');
const RENDER_EBAY = path.join(CRAWLER_DIR, 'render_ebay.py');

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

function launchPipeline(jobId, url, usePro, geminiKey) {
  const slug = slugify(url);
  const out = path.join(OUT_DIR, slug);
  fs.mkdirSync(out, { recursive: true });
  // 원본 URL·크롤 시각 기록 — 제품 목록(/api/v1/products)이 slug만으로는 URL을 복원할 수 없어서
  fs.writeFileSync(path.join(out, 'source.json'),
    JSON.stringify({ url, crawled_at: Date.now() / 1000 }, null, 2));
  fs.writeFileSync(path.join(out, 'progress.json'),
    JSON.stringify({ percent: 0, message: '작업 대기열 등록됨', updated_at: Date.now() / 1000 }));

  const args = [PIPELINE, url, '--cache'];
  if (usePro) args.push('--pro');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (geminiKey) env.GEMINI_API_KEY = geminiKey; // BYOK

  const logFd = fs.openSync(path.join(out, 'pipeline.log'), 'w');
  const proc = spawn(resolvePython(), args, { cwd: CRAWLER_DIR, env, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  const job = jobs.get(jobId);
  Object.assign(job, { slug, out, proc, exited: false });
  proc.on('exit', () => { job.exited = true; });
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
    let tail = job.spawnError || '';
    try { tail = tail || fs.readFileSync(path.join(job.out, 'pipeline.log'), 'utf-8').slice(-500); } catch {}
    return { job_id: jobId, status: 'failed', progress_percent: prog.percent || 0,
      error: tail || 'pipeline exited without result' };
  }
  return { job_id: jobId, status: 'processing', progress_percent: prog.percent || 0,
    log_message: prog.message || '', updated_at: prog.updated_at };
}

function renderEbayHtml(out) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.join(out, 'mirror.json'))) {
      return reject(Object.assign(new Error('mirror not ready — crawl first'), { status: 404 }));
    }
    execFile(resolvePython(), [RENDER_EBAY, out], { cwd: CRAWLER_DIR, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

const router = express.Router();

router.get('/healthz', (req, res) => res.json({
  ok: true,
  master_key: !!process.env.GEMINI_API_KEY,
  firecrawl: !!process.env.FIRECRAWL_API_KEY,
}));

// 크롤 작업 등록 → { jobId, cached }. 캐시(mirror.json)가 있으면 파이프라인 없이 즉시 완료.
function startCrawl(url, { force = false, pro = false, geminiKey = null } = {}) {
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
  launchPipeline(jobId, url, pro, geminiKey);
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

// ── GEO: 크롤 원문만 근거로 AI 검색 인용용 Q&A + 타겟 키워드 생성 (제품당 1회, geo.json 저장) ──
const GEO_SCHEMA = {
  type: 'object',
  properties: {
    faq: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          a: { type: 'string' },
          source: { type: 'string', description: 'Heading of the product-page section that supports the answer' },
        },
        required: ['q', 'a', 'source'],
        additionalProperties: false,
      },
    },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['faq', 'keywords'],
  additionalProperties: false,
};

function mirrorToSourceText(mirror) {
  const parts = [`# ${mirror.product_title || ''}`];
  for (const s of mirror.sections || []) {
    if (/disclaimer/i.test(String(s.order))) continue;
    const text = String(s.text || '').trim();
    if (text) parts.push(text);
    const specs = (s.specs || []).filter((x) => x && x.label);
    if (specs.length) parts.push('## Specifications\n' + specs.map((x) => `- ${x.label}: ${x.value || ''}`).join('\n'));
  }
  return parts.join('\n\n');
}

let _anthropic = null;
async function generateGeo(slug) {
  const mirror = readJson(path.join(OUT_DIR, slug, 'mirror.json'));
  if (!mirror) throw Object.assign(new Error('mirror not found'), { status: 404 });
  if (!_anthropic) { const Anthropic = require('@anthropic-ai/sdk'); _anthropic = new Anthropic(); }
  const response = await _anthropic.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: GEO_SCHEMA } },
    system: 'You write GEO (Generative Engine Optimization) assets for LG Electronics product pages: '
      + 'question-and-answer pairs that AI shopping assistants (ChatGPT, Perplexity, Google AI Overviews, Bing Copilot) can quote, '
      + 'and the search keywords shoppers would use. Use only facts stated in the product page text you are given; '
      + 'if the page does not state something, do not ask or answer about it. Write in the same language as the product page text.',
    messages: [{
      role: 'user',
      content: `Product page text (crawled from ${(readJson(path.join(OUT_DIR, slug, 'source.json')) || {}).url || 'LG.com'}):\n\n`
        + `<product_page>\n${mirrorToSourceText(mirror)}\n</product_page>\n\n`
        + 'Return 6-8 FAQ entries that real shoppers ask (features, use, specs, compatibility), each answer 1-3 sentences grounded in the page, '
        + 'and 10-15 target keywords (short phrases, most important first).',
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('model declined: ' + ((response.stop_details || {}).category || 'refusal'));
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('no text in model response');
  const geo = { ...JSON.parse(block.text), model: response.model, generated_at: Date.now() / 1000 };
  fs.writeFileSync(path.join(OUT_DIR, slug, 'geo.json'), JSON.stringify(geo, null, 2));
  return geo;
}

router.post('/api/v1/products/:slug/geo', auth, async (req, res) => {
  const slug = path.basename(req.params.slug);
  const cached = readJson(path.join(OUT_DIR, slug, 'geo.json'));
  if (cached && !(req.body || {}).force) return res.json(cached);
  try { res.json(await generateGeo(slug)); }
  catch (e) { console.error('[geo]', slug, e.message); res.status(e.status || 500).json({ detail: e.message.slice(0, 300) }); }
});

router.post('/api/v1/crawl', auth, (req, res) => {
  const { url, force_refresh = false, use_pro_model = false } = req.body || {};
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ detail: 'valid url required' });
  }
  const { jobId, cached } = startCrawl(url, {
    force: !!force_refresh, pro: !!use_pro_model, geminiKey: req.get('x-gemini-api-key') || null,
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
      send('progress', { percent: snap.progress_percent, message: snap.log_message });
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
