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
  if (j) { jobs.set(id, j); if (j.status === 'ready') kickRetries(j); }   // 재배포로 끊긴 뒤의 자동 재시도는 다시
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

// 작업의 나라 (2026-11-23): 벌크는 나라별로 완전히 나눈다 — 태국 작업이 싱가포르 화면에 보이지 않게.
// 이 기능 전에 만든 작업은 나라 기록이 없어 행의 LG.com 주소(lg.com/<cc>/…)에서 가장 많은 나라로 정한다
function countryOf(j) {
  if (j.country) return j.country;
  const n = {};
  for (const it of j.items || []) { const c = (/lg\.com\/([a-z]{2})(?:_[a-z]{2})?\//i.exec(it.url || '') || [])[1]; if (c) n[c.toLowerCase()] = (n[c.toLowerCase()] || 0) + 1; }
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || '';
}

const units = (its) => { const m = new Map(); for (const it of its) { const k = it.bundle ? 'b:' + it.row : it.slug || it.url || 'r:' + it.row; if (!m.has(k)) m.set(k, []); m.get(k).push(it); } return [...m.values()]; };
function jobView(j) {
  const done = j.status !== 'running' && j.status !== 'queued';
  // 동영상 수(장면 바꾸기 버튼)는 이 기능 전에 끝난 작업 기록에 없어서 다시 열 때 센다
  const withVideos = (it) => (it.status === 'ok' && it.slug && it.videos == null
    ? { ...it, videos: productVideos(readJson(path.join(OUT_DIR(), it.slug, 'mirror.json'))).length } : it);
  const its = done ? j.items.map((it) => { const flags = currentFlags(j, it); return withVideos(flags === it.flags ? it : { ...it, flags }); }) : j.items;
  const fin = (x) => x.status === 'ok' || x.status === 'failed';
  return { id: j.id, upload: j.upload, status: j.status, error: j.error, channel: j.channel, country: countryOf(j), phase: j.phase,
    total: its.length, done: its.filter(fin).length,
    ok: its.filter((x) => x.status === 'ok').length, failed: its.filter((x) => x.status === 'failed').length,
    replaced: its.filter((x) => x.status === 'ok' && x.prevLen > 0).length,
    crawlTotal: its.filter((x) => x.register || x.force).length, crawlDone: its.filter((x) => (x.register || x.force) && (x.crawled || x.status === 'failed')).length,
    review: its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info')).length,
    notify: j.notify ? { email: !!j.notify.email, sent: !!j.notify.sent } : null,
    skus: j.skus || [], items: its, file: j.status === 'ready' ? `/api/v1/bulk/jobs/${j.id}/file` : null, fileName: j.outName, at: j.at, finishedAt: j.finishedAt,
    // 벌크 Check (?check=1): 라이브 아닌 것 건너뜀 수 · 확인 · 뺀 수
    // 확인 · 뺀 수는 제품 기준 (같은 제품의 여러 행은 하나) — 진행 막대 · 건너뜀 수와 같은 단위
    check: j.check ? { ...j.check, confirmed: units(its).filter((u) => u.every((x) => x.check === 'ok')).length, removed: units(its).filter((u) => u.every((x) => x.check === 'removed')).length } : null,
    // 검토·승인 (approvals.js): 승인 안 된 제품 수. gate 가 켜져 있으면 엑셀 받기가 잠긴다
    approval: done ? (() => { const a = require('./approvals'); const p = a.pendingOf(its); return { gate: a.gateOn(), pending: p.length, models: p.slice(0, 20).map((x) => x.model || x.slug) }; })() : null };
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
  // PDP 요약(태국어)은 태국 제품만 — 싱가포르 등은 요약 없이 이미지만 (2026-11-23). Shopee 도 (2026-11-24, 글로 이미지 주소 위에)
  const summaryP = /lg\.com\/th\//i.test(url) ? post('/api/v1/pdp-summary', { url }, 7 * 60 * 1000).catch((e) => ({ error: e.message })) : null;
  // 빌더에서 저장한 편집본이 있으면 그것으로 (edits.js) — 없으면 크롤 데이터로 새로 만든다
  const ed = require('./edits').getEdit(require('./crawler-routes').slugify(url), channel);
  const g = ed ? { html: ed.html } : await post('/api/ebay-generate', { url, medium: 'shopee_lazada', listing }, 5 * 60 * 1000);
  if (!g.html) throw new Error('generate returned no HTML');
  const sl = await post('/api/v1/slice-html', { html: g.html, medium: 'shopee_lazada' }, 12 * 60 * 1000);
  const sm = await summaryP;
  if (channel === 'shopee') {
    // Shopee 설명은 HTML 을 받지 않는다 → Promotion(상품 설명 정보) · 요약(태국)은 태그 없는 글로 위, 그 아래 이미지 주소 (한 줄에 하나, 앞 12장),
    // 맨 아래 상품 설명 정보의 나머지 (2026-11-25 — 태국은 Product details 가 요약 자리)
    const LR = require('./listing-routes');
    const parts = LR.shopeeParts(await LR.currentFor(url).catch(() => null), url);
    const head = (parts.top ? parts.top + '\n\n' : '') + (sm && sm.text ? sm.text.trim() + '\n\n' : '');
    const tail = parts.bottom ? '\n\n' + parts.bottom : '';
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    while (urls.length > 1 && (head + urls.join('\n') + tail).length > SHOPEE_DESC_MAX) urls.pop();
    if (!urls.length) throw new Error('no images');
    const text = head + urls.join('\n') + tail;
    return { text, images: urls.length, allImages: sl.count, summaryErr: sm && sm.error ? sm.error.slice(0, 200) : '', edited: !!ed,
             tooLong: text.length > SHOPEE_DESC_MAX ? text.length : 0, urls, hash: sl.hash, loaded: sl.images_loaded, broken: sl.broken || null };
  }
  return { text: (sm && sm.html ? sm.html + '\n' : '') + sl.html, images: sl.count, allImages: sl.count, summaryErr: sm && sm.error ? sm.error.slice(0, 200) : '', edited: !!ed,
           urls: sl.urls || [], hash: sl.hash, loaded: sl.images_loaded, broken: sl.broken || null };
}

// 묶음 상품 ('A + B' 행, 2026-11-23): 구성품 크롤 결과를 빌더 번들과 같은 모양으로 합쳐(crawler-py/bundle_pto.py combine)
// 같은 렌더러(ebay_builder.py)로 그리고, 단품과 같은 슬라이스 이미지로 만든다. 묶음 결과는 media-cache/bulk/bundles/<키>/ (제품 목록엔 안 나옴)
const PY_DIR = path.join(__dirname, 'crawler-py');
const python = () => process.env.CRAWLER_PYTHON || (fs.existsSync(path.join(PY_DIR, '.venv', 'bin', 'python')) ? path.join(PY_DIR, '.venv', 'bin', 'python') : 'python3');
const runPy = (args, timeoutMs) => new Promise((resolve, reject) => require('child_process').execFile(python(), args, { cwd: PY_DIR, timeout: timeoutMs },
  (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop().slice(0, 300))) : resolve(String(out)))));
const bundleKey = (it) => crypto.createHash('sha1').update(it.bundle.map((x) => x.slug).join('+')).digest('hex').slice(0, 16);
async function contentForBundle(channel, it, title) {
  const dir = path.join(DIR, 'bundles', bundleKey(it));
  fs.mkdirSync(dir, { recursive: true });
  const spec = { title: title || it.model, components: it.bundle.map((x) => ({ model: x.model || '', url: x.url, slug: x.slug })) };
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  await runPy(['bundle_pto.py', 'combine', dir, path.join(dir, 'spec.json')], 60 * 1000);
  await runPy(['ebay_builder.py', dir, '--fragment', '--medium', 'shopee_lazada', '-o', 'content.html'], 3 * 60 * 1000);
  const html = fs.readFileSync(path.join(dir, 'content.html'), 'utf8');
  const sl = await post('/api/v1/slice-html', { html, medium: 'shopee_lazada' }, 12 * 60 * 1000);
  if (channel === 'shopee') {
    const urls = (sl.urls || []).slice(0, SHOPEE_MAX_IMAGES);
    if (!urls.length) throw new Error('no images');
    return { text: urls.join('\n'), images: urls.length, allImages: sl.count, summaryErr: '', urls, hash: sl.hash, loaded: sl.images_loaded, broken: sl.broken || null };
  }
  return { text: sl.html, images: sl.count, allImages: sl.count, summaryErr: '', urls: sl.urls || [], hash: sl.hash, loaded: sl.images_loaded, broken: sl.broken || null };   // 묶음은 PDP 요약 없이 (요약은 제품 하나 기준)
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
  // 벌크 Check 검토 화면이 크게 보여 줄 근거: 빠진 lg.com 원본 그림 주소(최대 3) · 빠진 글(최대 5줄)
  const src = gone.slice(0, 3).map((x) => fullImg(dir, x.image)).filter(Boolean);
  const lines = tx.slice(0, 5).map((x) => String(x.text || '').slice(0, 160));
  return { images, texts, files, mirror, src, lines };
}

// 검사 기록의 이미지 주소는 끝 120자만 남아 있을 수 있다 → 크롤한 원문(pc.html)에서 그 끝으로 끝나는 전체 주소를 찾는다
function fullImg(dir, tail) {
  tail = String(tail || '');
  const abs = (u) => (/^https?:\/\//.test(u) ? u : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? 'https://www.lg.com' + u : null);
  if (/^(https?:)?\/\/|^\/content\//.test(tail)) return abs(tail);
  let html = ''; try { html = fs.readFileSync(path.join(dir, 'pc.html'), 'utf8'); } catch (_) { return null; }
  const i = html.indexOf(tail); if (i < 0) return null;
  let s = i; while (s > 0 && !/["'\s(,=]/.test(html[s - 1])) s--;
  return abs(html.slice(s, i + tail.length));
}

// ── 벌크 Check (?check=1, 2026-11-26) ──
// AI 체크: 미리 계산해 두고 화면이 한 줄씩 보여 준다. 항목: 이미지 다 불러옴 · lg.com 문구와 같음 · (태국) 요약 · Shopee 12장 · 스펙표.
//   ok=false 인 항목이 있으면 사람이 '다시 준비' / '이번 엑셀에서 빼기'. Shopee 12장 넘는 것은 자동으로 앞 12장 — 통과 + 회색 안내.
function aiChecks(j, it, c) {
  const out = [];
  const m = /^(\d+)\/(\d+)$/.exec(String((c && c.loaded) || ''));
  const notLoaded = m ? Math.max(0, +m[2] - +m[1]) : 0;
  const q = it.bundle ? { images: 0, texts: 0, mirror: null } : qaOf(it.slug);
  const lgImg = q.images;
  // 못 불러온 이미지는 엑셀에 실제로 들어가는 장(Shopee 는 앞 12장)만 센다. 자리(몇 번째 장 · 어디쯤)를 알면 화면이 PDP 위에 표시한다.
  // 자리를 모르는 예전 슬라이스(캐시)는 개수만
  const used = (c && c.urls && c.urls.length) || 0;
  const at = c && Array.isArray(c.broken) ? c.broken.filter((b) => !used || b.slice <= used).slice(0, 12) : null;
  const bad = at ? at.length : notLoaded;
  out.push({ k: 'img', ok: !bad && !lgImg, n: bad + lgImg, bad, lg: lgImg, ...(at && at.length ? { at } : {}), ...(lgImg && q.src && q.src.length ? { src: q.src } : {}) });
  out.push({ k: 'txt', ok: q.texts < 5, n: q.texts, ...(q.texts >= 5 && q.lines ? { lines: q.lines } : {}) });   // 글 몇 줄은 캐러셀 버튼 글자 같은 오탐이 많다 — 확인 필요 규칙과 같게 5줄부터
  if (!it.bundle && /lg\.com\/th\//i.test(it.url || '')) out.push({ k: 'sum', ok: !(c && c.summaryErr) });
  if (j.channel === 'shopee') out.push({ k: 'n12', ok: true, used: c ? c.images : 0, all: c ? c.allImages : 0 });
  const specs = q.mirror ? (q.mirror.sections || []).reduce((n, s) => n + ((s.specs || []).length), 0) : (it.bundle ? 1 : 0);
  out.push({ k: 'spec', ok: specs > 0 });
  return out;
}
const aiFail = (ai) => (ai || []).some((x) => !x.ok);
// 고쳐질 수 있는 문제(이미지 · 글 누락)면 한 번 자동으로 다시 (retryLater — 작업이 끝난 뒤 뒤에서):
// 마지막 크롤이 하루보다 오래됐으면 다시 크롤, 아니면 다시 그리기만 (방금 크롤한 것은 다시 크롤해도 같다 — 크롤 비용만 든다)
const retryable = (it, ai) => !it.bundle && !it.retried && ai.some((x) => !x.ok && (x.k === 'img' || x.k === 'txt'));
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
  const up = await readUpload(j.upload);
  if (!up) throw new Error('uploaded file expired');
  const wb = await xlsx.load(up.buf);
  const sheet = wb.sheets.find((x) => x.path === j.sheet);
  if (!sheet) throw new Error('sheet not found');
  let n = 0;
  for (const it of j.items) {
    if (it.status !== 'ok' || it.check === 'removed' || !texts.has(it.row)) continue;
    it.prevLen = String((sheet.rows.get(it.row) || new Map()).get(j.descCol) || '').trim().length;
    wb.setCell(j.sheet, it.row, j.descCol, texts.get(it.row));
    n++;
  }
  for (const x of j.skus || []) if (j.skuCol) wb.setCell(j.sheet, x.row, j.skuCol, x.sku);
  const buf = await wb.save();
  fs.mkdirSync(path.join(DIR, j.upload), { recursive: true });
  fs.writeFileSync(path.join(DIR, j.upload, `result-${j.id}.xlsx`), buf);
  await store.putBuffer(`bulk/${j.upload}/result-${j.id}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').catch(() => {});
  return n;
}
// Check 화면의 버튼 — 한 제품(같은 제품의 여러 행)에 한 번: ok(확인하고 다음 → 승인 기록 via 'bulk' + 본 이미지 해시) ·
//   remove(이번 엑셀에서 빼기 — 그 행들은 원래 내용 그대로) · retry(다시 준비)
async function checkAction(j, rows, action, by, override) {
  const its = j.items.filter((x) => rows.includes(x.row));
  if (!j.check || !its.length) return { error: 'not found', status: 404 };
  if (j.status !== 'ready') return { error: 'job is not ready', status: 409 };
  if (action === 'ok') {
    if (its.some((it) => it.status !== 'ok')) return { error: 'item is not ready', status: 409 };
    const who = String(by || '').slice(0, 120), done = new Set();
    for (const it of its) {
      it.check = 'ok'; it.checkedBy = who; it.checkedAt = Date.now();
      // 묶음 상품은 구성품마다 따로 검토 — 여기서는 기록하지 않는다
      if (!it.bundle && it.hash && it.slug && !done.has(it.slug)) { done.add(it.slug); require('./approvals').write(it.slug, { state: 'approved', by: who, via: override ? 'bulk-override' : 'bulk', hashes: { [j.channel]: it.hash } }); }   // override: AI 가 검토 필요라 했지만 사람이 통과
    }
  } else if (action === 'remove') {
    for (const it of its) it.check = 'removed';
    await rewrite(j, await loadTexts(j));
  } else if (action === 'retry') {
    if (its.some((it) => it.status === 'working' || it.retrying)) return { error: 'already preparing', status: 409 };
    for (const it of its) { it.check = null; it.status = 'working'; }
    redoAll(j, its).catch((e) => console.warn('[bulk] check redo', j.id, rows.join(','), e.message));
  } else return { error: 'unknown action', status: 400 };
  await persist(j, true);
  return { ok: true };
}
// 결과 엑셀 다시 쓰기는 작업마다 한 줄로 (뒤의 자동 재시도 · 빼기 · 다시 준비가 겹쳐도 차례로)
const writeChain = new Map();
function rewrite(j, texts) {
  const p = (writeChain.get(j.id) || Promise.resolve()).then(() => writeResult(j, texts), () => writeResult(j, texts));
  writeChain.set(j.id, p.catch(() => {}));
  return p;
}
// 자동 재시도 (2026-11-27): 작업이 끝난 뒤 뒤에서 — 사람은 결과를 바로 보고, 고쳐지면 그 제품이 '준비됨'으로 옮겨 간다
const retryingJobs = new Set();
function kickRetries(j) {
  if (!j.check || retryingJobs.has(j.id)) return;
  const its = j.items.filter((x) => x.retrying && x.status === 'ok');
  if (!its.length) return;
  retryingJobs.add(j.id);
  const by = new Map(); for (const it of its) { const k = it.slug || it.url; if (!by.has(k)) by.set(k, []); by.get(k).push(it); }
  Promise.all([...by.values()].map(([it, ...same]) => retryLater(j, it, same)))
    .finally(() => retryingJobs.delete(j.id));
}
async function retryLater(j, it, same) {
  const cr = require('./crawler-routes'), all = [it, ...same];
  try {
    it.retried = 1;
    const src = readJson(path.join(OUT_DIR(), it.slug, 'source.json')) || {};
    if (Date.now() / 1000 - (Number(src.crawled_at) || 0) > 24 * 3600) {   // 방금 크롤한 것은 다시 크롤해도 같다 — 다시 그리기만
      await crawlSlot(() => cr.crawl(it.url, { force: true, base: j.base })).catch((e) => console.warn('[bulk] check retry crawl', it.slug, e.message));
      catalog.invalidate();
    }
    const c = await contentSlot(() => contentFor(j.channel, it.url));
    const texts = await loadTexts(j);
    for (const x of all) {
      texts.set(x.row, c.text);
      Object.assign(x, { retried: 1, images: c.images, allImages: c.allImages, chars: c.text.length, summaryErr: c.summaryErr || '',
        imgs: c.urls || [], hash: c.hash || '', ai: aiChecks(j, x, c) });
      x.flags = flagsFor(j, x, c);
      require('./slice-preview').ensure(x.imgs).catch(() => {});
    }
    await saveTexts(j, texts, true);
    await rewrite(j, texts);
  } catch (e) { console.warn('[bulk] check retry', j.id, it.slug, e.message); }
  for (const x of all) delete x.retrying;
  await persist(j, true);
}
async function redoAll(j, its) { const [first, ...rest] = its; await redo(j, first, rest); }
// 다시 준비 (사람이 누름): 다시 크롤 → 내용 → AI 체크(자동 재시도 없이) → 엑셀 다시
async function redo(j, it, same = []) {
  const cr = require('./crawler-routes');
  try {
    if (!it.bundle) { await crawlSlot(() => cr.crawl(it.url, { force: true, base: j.base })); catalog.invalidate(); }
    const c = it.bundle ? await contentForBundle(j.channel, it, it.bundleTitle) : await contentFor(j.channel, it.url);
    it.retried = 1;
    const texts = await loadTexts(j);
    for (const x of [it, ...same]) {
      texts.set(x.row, c.text);
      Object.assign(x, { status: 'ok', error: '', images: c.images, allImages: c.allImages, chars: c.text.length, summaryErr: c.summaryErr || '',
        imgs: c.urls || [], hash: c.hash || '', ai: aiChecks(j, x, c) });
      x.flags = flagsFor(j, x, c);
    }
    await saveTexts(j, texts, true);
    await rewrite(j, texts);
  } catch (e) {
    for (const x of [it, ...same]) Object.assign(x, { status: x.error && !x.imgs ? 'failed' : 'ok', ai: [...(x.ai || []).filter((y) => y.k !== 'redo'), { k: 'redo', ok: false, msg: String(e.message || e).slice(0, 200) }] });
  }
  await persist(j, true);
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
        const key = 'bundle:' + bundleKey(it);
        if (!contentBy.has(key)) contentBy.set(key, contentSlot(() => { stop(); return contentForBundle(j.channel, it, it.bundleTitle); }));
        const c = await contentBy.get(key);
        stop();
        if (c.text.length > CELL_MAX) throw Object.assign(new Error(`too long for one Excel cell (${c.text.length} chars)`), { stage: 'content' });
        texts.set(it.row, c.text);
        if (j.check) { Object.assign(it, { ai: aiChecks(j, it, c), imgs: c.urls || [], hash: c.hash || '' }); await saveTexts(j, texts, false); require('./slice-preview').ensure(it.imgs).catch(() => {}); }
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
      it.status = 'working'; persist(j);
      if (!contentBy.has(it.slug)) contentBy.set(it.slug, contentSlot(() => { stop(); return contentFor(j.channel, it.url); }));
      let c = await contentBy.get(it.slug);
      stop();
      if (j.check) {   // 자동 재시도(다시 크롤)는 기다리지 않는다 — 작업이 끝난 뒤 뒤에서 (retryLater). 그동안 화면엔 '검토 필요 · 다시 시도 중'
        const ai = aiChecks(j, it, c);
        if (retryable(it, ai)) it.retrying = 1;
        Object.assign(it, { ai, imgs: c.urls || [], hash: c.hash || '' }); stop();
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
      const stage = (it.register || it.force) && !it.crawled ? 'crawl' : 'content';
      Object.assign(it, { status: 'failed', error: msg, flags: [{ code: stage, sev: 'error', msg }] });
    }
    persist(j);
  }));
  if (j.status === 'cancelled') return;   // 중단했으면 엑셀을 만들지 않는다
  if (paused) return;                      // 재배포: 새 서버가 이어서 엑셀까지 만든다
  j.phase = 'write';
  for (const it of j.items) {
    if (it.status !== 'ok') continue;
    it.prevLen = String((sheet.rows.get(it.row) || new Map()).get(j.descCol) || '').trim().length;
    wb.setCell(j.sheet, it.row, j.descCol, texts.get(it.row));
  }
  // SKU 번호가 비어 있던 행에 사용자가 넣은 SKU
  for (const x of j.skus || []) if (j.skuCol) wb.setCell(j.sheet, x.row, j.skuCol, x.sku);
  if (!j.items.some((x) => x.status === 'ok')) throw new Error('no row could be filled');
  if (j.check) await saveTexts(j, texts, true);
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
      await persist(j, true);
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

module.exports = { countryOf, create, cancel, setNotify, getJob, jobView, resumeAll, saveUpload, readUpload, mailReady, emailOk, CRAWL_CONC, DIR, checkAction, aiChecks };
