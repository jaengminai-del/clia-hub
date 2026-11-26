/**
 * slice-preview.js — 상세 이미지(슬라이스)의 작은 미리보기 (2026-11-26, 벌크 Check)
 *
 *   GET /media/slices-p/<hash>/<file>  → 폭 400px JPEG (원본 /media/slices/<hash>/<file> 은 1000px — 엑셀 · 다운로드는 원본 그대로)
 *   ensure(urls)                       → 미리 만들어 둔다 (벌크 준비가 끝난 제품 — Check 화면이 바로 작은 그림을 받게)
 * 처음 요청 때 만들고 로컬(media-cache/slices-p) + 버킷(media-slices-p/)에 둔다 → 재배포 뒤에도 다시 안 만든다.
 * 만들기는 파이썬 일꾼 하나(crawler-py/preview_worker.py, Pillow)를 띄워 두고 줄 단위로 맡긴다.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./crawl-store');

const SRC = path.join(__dirname, 'media-cache', 'slices');
const DST = path.join(__dirname, 'media-cache', 'slices-p');
const W = 400;
const okName = (hash, file) => /^[0-9a-f]{20}$/.test(hash) && /^[\w-]+\.(jpg|png)$/.test(file);

let worker = null, seq = 0;
const waiting = new Map();   // id → { ok, no }
function getWorker() {
  if (worker) return worker;
  const dir = path.join(__dirname, 'crawler-py');
  const venv = path.join(dir, '.venv', 'bin', 'python');
  const py = process.env.CRAWLER_PYTHON || (fs.existsSync(venv) ? venv : 'python3');
  const w = require('child_process').spawn(py, ['preview_worker.py'], { cwd: dir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let buf = '';
  w.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m = null; try { m = JSON.parse(line); } catch (_) { continue; }
      const p = waiting.get(m.id); if (!p) continue;
      waiting.delete(m.id);
      m.ok ? p.ok() : p.no(new Error(m.error || 'preview failed'));
    }
  });
  w.stderr.on('data', (d) => console.warn('[slice-preview]', String(d).trim().slice(0, 300)));
  w.on('exit', () => { worker = null; for (const [, p] of waiting) p.no(new Error('preview worker exited')); waiting.clear(); });
  worker = w;
  return w;
}
const resize = (src, dst) => new Promise((ok, no) => {
  const id = ++seq;
  waiting.set(id, { ok, no });
  getWorker().stdin.write(JSON.stringify({ id, src, dst, w: W }) + '\n');
  setTimeout(() => { if (waiting.delete(id)) no(new Error('preview timeout')); }, 30 * 1000);
});

const making = new Map();   // 같은 그림을 동시에 두 번 만들지 않게
async function make(hash, file) {
  const dst = path.join(DST, hash, file.replace(/\.png$/, '.jpg'));
  if (fs.existsSync(dst)) return dst;
  const k = hash + '/' + file;
  if (making.has(k)) return making.get(k);
  const p = (async () => {
    const key = `media-slices-p/${hash}/${path.basename(dst)}`;
    const cached = await store.getBuffer(key).catch(() => null);   // 재배포 뒤: 버킷에 있으면 그대로
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (cached) { fs.writeFileSync(dst, cached); return dst; }
    const src = path.join(SRC, hash, file);
    if (!fs.existsSync(src)) {   // 원본도 로컬에 없으면 버킷에서 (/media/slices 와 같은 방식)
      const b = await store.getBuffer(`media-slices/${hash}/${file}`).catch(() => null);
      if (!b) return null;
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, b);
    }
    await resize(src, dst);
    store.putBuffer(key, fs.readFileSync(dst), 'image/jpeg').catch((e) => console.warn('[slice-preview] 버킷 업로드 실패', key, e.message));
    return dst;
  })().finally(() => making.delete(k));
  making.set(k, p);
  return p;
}

/** 미리 만들어 두기 — 슬라이스 주소들(/media/slices/<hash>/<file>). 실패해도 예외 없음 (요청 때 다시 만든다) */
async function ensure(urls) {
  for (const u of urls || []) {
    const m = /\/media\/slices\/([0-9a-f]{20})\/([\w-]+\.(?:jpg|png))/.exec(String(u));
    if (m) await make(m[1], m[2]).catch(() => null);
  }
}

const router = express.Router();
router.get('/media/slices-p/:hash/:file', async (req, res) => {
  const { hash, file } = req.params;
  if (!okName(hash, file)) return res.status(400).end();
  try {
    const abs = await make(hash, file);
    if (!abs) return res.status(404).end();
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
    res.type('jpeg').sendFile(abs);
  } catch (e) {
    console.warn('[slice-preview]', hash, file, e.message);
    res.redirect(302, `/media/slices/${hash}/${file}`);   // 못 만들면 원본으로
  }
});

module.exports = { router, ensure };
