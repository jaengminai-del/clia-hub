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
    res.json({ duration: meta.duration, width: meta.width, height: meta.height, frames });
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

module.exports = { router };
