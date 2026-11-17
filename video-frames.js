/**
 * video-frames.js — 동영상 카드의 장면 고르기 (빌더 카드 목록 팝업, 2026-11-11)
 *
 * 1차 컨텐츠에서 lg.com 동영상 섹션으로 만든 카드는 포스터 이미지에 data-video-src(mp4) 가 붙어 있다
 * (crawler-py/content_gen/render_html.py _mark_video). 빌더 카드 목록에서 그 카드를 누르면 팝업에서 동영상을 보며
 * 쓸 장면을 고르고, 서버가 그 시점의 장면을 JPG 로 뽑아 공개 주소로 돌려준다 (eBay·마켓 HTML 에 넣을 수 있게).
 *
 *   GET  /api/v1/video?url=               → 동영상 (서버에 받아 둔 사본 — 구간 재생 지원, 같은 출처라 재생 막대 이동 가능)
 *   GET  /api/v1/video-frames?url=&n=8    → { duration, frames: [{ t, src }] }  미리보기 장면 n 장
 *   POST /api/v1/video-frame { url, t }   → { src, width, height }             고른 장면 (원본 해상도, 공개 주소)
 *   GET  /media/frames/:vh/:file          → 장면 이미지 (로컬 media-cache/frames, 없으면 버킷 media-frames/)
 *
 * 크롤 직후 자동 장면 (autoFrame, 2026-11-17): 텍스트 v2 크롤 결과(mirror _gen >= 2)에서 LG 포스터가 검은 화면이거나 없는
 * 동영상 섹션만, 전체 장면 중 비주얼이 가장 많은 장면(crawler-py/video_pick.py)을 포스터로 넣는다. 2·3위는 빌더 장면 고르기의 빠른 선택지.
 * 예전 크롤 결과·정상 포스터는 건드리지 않는다.
 *
 * 동영상은 lg.com 에서 Node 로 받는다 (배포 서버의 Python 직접 요청은 lg.com 이 막음). 장면 추출은 ffmpeg (Dockerfile 에 설치).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./crawl-store');

const ROOT = path.join(__dirname, 'media-cache');
const VIDEO_DIR = path.join(ROOT, 'videos');
const FRAME_DIR = path.join(ROOT, 'frames');
const MAX_BYTES = 300 * 1024 * 1024;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const vhash = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
// LG 동영상만 받는다 (임의 주소 요청 방지)
const allowed = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) && /(^|\.)(lg\.com|lge\.com)$/i.test(u.hostname); } catch (_) { return false; } };
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 120 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(-300))) : resolve(String(stdout)))));

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const req = lib.get(url, { headers: { 'User-Agent': UA, Referer: 'https://www.lg.com/' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`video HTTP ${res.statusCode}`)); }
      const tmp = `${dest}.part-${process.pid}`;
      const out = fs.createWriteStream(tmp);
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) { req.destroy(new Error('video too large')); } });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, dest); resolve(dest); });
      res.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
      req.on('error', (e) => { out.destroy(); fs.rmSync(tmp, { force: true }); reject(e); });
    });
    req.on('timeout', () => req.destroy(new Error('video download timeout')));
    req.on('error', reject);
  });
}

const pending = new Map();
// 동영상 사본 (한 번 받으면 재사용, 같은 동영상 동시 요청은 하나로)
function ensureVideo(url) {
  const vh = vhash(url);
  const dest = path.join(VIDEO_DIR, `${vh}${path.extname(new URL(url).pathname).toLowerCase() || '.mp4'}`);
  if (fs.existsSync(dest)) return Promise.resolve({ vh, file: dest });
  if (!pending.has(vh)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
    pending.set(vh, download(url, dest).finally(() => pending.delete(vh)));
  }
  return pending.get(vh).then(() => ({ vh, file: dest }));
}

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
  const j = JSON.parse(out);
  const s = (j.streams || [])[0] || {};
  return { duration: parseFloat((j.format || {}).duration) || 0, width: s.width || 0, height: s.height || 0 };
}

const grab = (file, t, out, scale) => run(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1',
  ...(scale ? ['-vf', `scale=${scale}:-2`] : []), '-q:v', scale ? '5' : '2', out]);

const publicBase = (req) => (process.env.PUBLIC_BASE_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/$/, '');

const router = express.Router();

router.get('/api/v1/video', async (req, res) => {
  const url = String(req.query.url || '');
  if (!allowed(url)) return res.status(400).json({ error: 'LG video url required' });
  try {
    const { file } = await ensureVideo(url);
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);   // Range 요청 지원 → 재생 막대 이동 가능
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 크롤 직후 자동으로 고른 장면 기록 (autoFrame) — 없으면 null
async function autoRecord(vh) {
  const fp = path.join(FRAME_DIR, vh, 'auto.json');
  try {
    if (!fs.existsSync(fp)) {
      const buf = await store.getBuffer(`media-frames/${vh}/auto.json`);
      if (!buf) return null;
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, buf);
    }
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (_) { return null; }
}

router.get('/api/v1/video-frames', async (req, res) => {
  const url = String(req.query.url || '');
  const n = Math.min(16, Math.max(2, parseInt(req.query.n, 10) || 8));
  if (!allowed(url)) return res.status(400).json({ error: 'LG video url required' });
  try {
    const { vh, file } = await ensureVideo(url);
    const dir = path.join(FRAME_DIR, vh);
    fs.mkdirSync(dir, { recursive: true });
    const meta = await probe(file);
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = +(((i + 0.5) * meta.duration) / n).toFixed(2);
      const name = `thumb-${n}-${i}.jpg`;
      if (!fs.existsSync(path.join(dir, name))) await grab(file, t, path.join(dir, name), 320);
      frames.push({ t, src: `/media/frames/${vh}/${name}` });
    }
    res.json({ duration: meta.duration, width: meta.width, height: meta.height, frames, auto: await autoRecord(vh) });
  } catch (e) {
    console.warn('[video-frames]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.post('/api/v1/video-frame', async (req, res) => {
  const { url = '', t = 0 } = req.body || {};
  if (!allowed(url)) return res.status(400).json({ error: 'LG video url required' });
  try {
    const { vh, file } = await ensureVideo(url);
    const ms = Math.max(0, Math.round(Number(t) * 1000));
    const name = `frame-${ms}.jpg`;
    const abs = path.join(FRAME_DIR, vh, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) {
      await grab(file, ms / 1000, abs, 0);
      await store.putBuffer(`media-frames/${vh}/${name}`, fs.readFileSync(abs), 'image/jpeg')
        .catch((e) => console.warn('[video-frame] 버킷 업로드 실패', e.message));
    }
    const meta = await probe(abs).catch(() => ({}));
    res.json({ src: `${publicBase(req)}/media/frames/${vh}/${name}`, width: meta.width || 0, height: meta.height || 0 });
  } catch (e) {
    console.warn('[video-frame]', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.get('/media/frames/:vh/:file', async (req, res) => {
  const { vh, file } = req.params;
  if (!/^[0-9a-f]{16}$/.test(vh) || !/^(thumb-\d+-\d+|frame-\d+)\.jpg$/.test(file)) return res.status(400).end();
  const abs = path.join(FRAME_DIR, vh, file);
  if (!fs.existsSync(abs)) {   // 재배포 후 로컬에 없으면 버킷에서 (고른 장면만 버킷에 올림)
    const buf = await store.getBuffer(`media-frames/${vh}/${file}`);
    if (!buf) return res.status(404).end();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
  res.type('jpeg').sendFile(abs);
});

// ── 크롤 직후 자동 장면 (검은·없는 포스터만) ──────────────────────────────
const PY_DIR = path.join(__dirname, 'crawler-py');
const python = () => process.env.CRAWLER_PYTHON
  || (fs.existsSync(path.join(PY_DIR, '.venv', 'bin', 'python')) ? path.join(PY_DIR, '.venv', 'bin', 'python') : 'python3');
const pick = (...args) => run(python(), [path.join(PY_DIR, 'video_pick.py'), ...args]).then((o) => JSON.parse(o));
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const isVideo = (m) => m && (m.type === 'video' || VIDEO_EXT.test(String(m.pc_url || '').split('?')[0]));
// 섹션의 동영상 — PC 용 우선 (crawler-py/content_gen/render_html.py _section_video 와 같은 기준)
function sectionVideo(s) {
  const vids = (s.media || []).filter(isVideo).map((m) => m.pc_url || m.unified_url || '').filter((u) => VIDEO_EXT.test(u.split('?')[0]));
  const pc = vids.filter((u) => !/(\/mobile\/|[-_]m(_v\d+)?\.\w+$|[-_]mobile)/i.test(u));
  return (pc[0] || vids[0] || '');
}
const posterOf = (s) => (s.media || []).find((m) => !isVideo(m) && m.role !== 'icon' && (m.pc_url || m.mobile_url || m.unified_url));

async function isBlackPoster(url) {
  if (!allowed(url)) return false;
  const dest = path.join(ROOT, 'posters', `${vhash(url)}${path.extname(new URL(url).pathname) || '.jpg'}`);
  if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); await download(url, dest); }
  return (await pick('poster', dest)).black === true;
}

async function frameAt(vh, file, t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const name = `frame-${ms}.jpg`;
  const abs = path.join(FRAME_DIR, vh, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) {
    await grab(file, ms / 1000, abs, 0);
    await store.putBuffer(`media-frames/${vh}/${name}`, fs.readFileSync(abs), 'image/jpeg')
      .catch((e) => console.warn('[auto-frame] 버킷 업로드 실패', e.message));
  }
  return `/media/frames/${vh}/${name}`;
}

/**
 * outDir/mirror.json 의 동영상 섹션 중 포스터가 검은 화면이거나 없는 것에 자동 장면을 넣는다 → 바꾼 섹션 수.
 * base: 장면 이미지 공개 주소의 앞부분 (PUBLIC_BASE_URL 이 있으면 그것). 시간 예산(budgetMs)을 넘으면 남은 섹션은 그대로.
 */
async function autoFrame(outDir, { base = '', budgetMs = 4 * 60 * 1000 } = {}) {
  const fp = path.join(outDir, 'mirror.json');
  let mirror;
  try { mirror = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return 0; }
  if ((Number(mirror._gen) || 0) < 2) return 0;
  const root = (process.env.PUBLIC_BASE_URL || base || '').replace(/\/$/, '');
  if (!root) { console.warn('[auto-frame] 공개 주소를 몰라 건너뜀'); return 0; }
  const until = Date.now() + budgetMs;
  let changed = 0;
  for (const s of mirror.sections || []) {
    if (Date.now() > until) { console.warn('[auto-frame] 시간 예산 초과 — 나머지 섹션은 그대로'); break; }
    const vid = sectionVideo(s);
    if (!vid || !allowed(vid)) continue;
    const poster = posterOf(s);
    try {
      let reason = poster ? '' : 'missing';
      if (poster) {
        for (const u of new Set([poster.pc_url, poster.mobile_url, poster.unified_url].filter(Boolean))) {
          if (await isBlackPoster(u)) { reason = 'black'; break; }
        }
      }
      if (!reason) continue;
      const { vh, file } = await ensureVideo(vid);
      const work = path.join(FRAME_DIR, vh, '_scan');
      const res = await pick('pick', file, work).finally(() => fs.rmSync(work, { recursive: true, force: true }));
      if (!res.top || !res.top.length) continue;
      const shots = [];
      for (const x of res.top) shots.push({ t: x.t, score: x.score, src: root + await frameAt(vh, file, x.t) });
      const auto = { reason, video: vid, t: shots[0].t, score: shots[0].score, alternatives: shots.slice(1) };
      // 빌더 장면 고르기에 '자동 선택' · 2·3위를 보여 주려고 동영상별로 기록 (재배포 후에도 버킷에서)
      const rec = Buffer.from(JSON.stringify({ reason, top: shots.map((x) => ({ t: x.t, score: x.score, src: x.src.slice(root.length) })) }));
      fs.writeFileSync(path.join(FRAME_DIR, vh, 'auto.json'), rec);
      await store.putBuffer(`media-frames/${vh}/auto.json`, rec, 'application/json').catch(() => {});
      if (poster) {
        poster.poster_original = { pc_url: poster.pc_url || '', mobile_url: poster.mobile_url || '', unified_url: poster.unified_url || '' };
        Object.assign(poster, { pc_url: shots[0].src, mobile_url: '', unified_url: '', auto_frame: auto });
        delete poster.crop;
      } else {
        s.media = [{ pc_url: shots[0].src, mobile_url: '', unified_url: '', type: 'image', role: 'content', auto_frame: auto }, ...(s.media || [])];
      }
      changed++;
      console.log(`[auto-frame] ${path.basename(outDir)} #${s.order}: 포스터 ${reason === 'black' ? '검은 화면' : '없음'} → ${shots[0].t}s`);
    } catch (e) {
      console.warn('[auto-frame]', path.basename(outDir), `#${s.order}`, e.message);
    }
  }
  if (changed) {
    const tmp = `${fp}.auto-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(mirror, null, 2));
    fs.renameSync(tmp, fp);
  }
  return changed;
}

module.exports = { router, autoFrame };
