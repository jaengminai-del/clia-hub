/*
 * image-cache.js — lg.com 이미지 사본 (2026-11-28)
 *
 * 슬라이스 그리기(crawler-py/content_gen/slices.py, 크로미움)가 lg.com 이미지를 직접 부르면, 제품을 한꺼번에 많이 그릴 때
 * lg.com 이 서버를 막아 이미지가 빈칸으로 잘린다 — 운영 태국 Shopee Check(Live 140개, 11-28): '이미지 46/46장 로드 실패(빈칸)'가
 * 이어지고 140개 중 121개가 '빠진 이미지'. 같은 제품도 따로 돌리면 통과했다 (WT2116SHBB).
 * 그래서 슬라이스는 이미지를 이 사본으로만 받는다:
 *   로컬 media-cache/img/<키> → 버킷 media-img/<키> → lg.com (Node 로 받기 — 파이썬·크로미움 직접 요청과 달리 통과한다,
 *   서버 전체 동시 IMG_FETCH_CONC(기본 6)개, 막히면 잠깐 기다렸다 다시). 한 번 받은 이미지는 다시 lg.com 에 가지 않는다.
 *
 *   GET /api/v1/img-cache?url=<https://www.lg.com/...>   lg.com 주소만. 없어진 이미지(404 · 410)는 404, 끝내 못 받으면 502
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const store = require('./crawl-store');

const DIR = path.join(__dirname, 'media-cache', 'img');
const CONC = Math.max(1, Math.min(16, parseInt(process.env.IMG_FETCH_CONC, 10) || 6));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 25 * 1024 * 1024;

// lg.com 의 https 주소만 (아무 주소나 받아 주는 중계가 되지 않게)
function lgUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (u.hostname !== 'lg.com' && !u.hostname.endsWith('.lg.com')) return null;
    u.hash = '';
    return u;
  } catch (_) { return null; }
}
const keyOf = (u) => crypto.createHash('sha1').update(u.href).digest('hex');

// 저장할 때 형식을 따로 두지 않고 내용 앞부분으로 알아낸다
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/avif';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const { fn, ok, no } = q.shift(); new Promise((r) => r(fn())).then(ok, no).finally(() => { active--; next(); }); };
  return (fn) => new Promise((ok, no) => { q.push({ fn, ok, no }); next(); });
}
const slot = limiter(CONC);

// lg.com 에서 한 번 받기 — /api/proxy-image 와 같은 방식(Node https). 이미지가 아니면(막힘 안내 페이지 등) 실패
function fetchOnce(u, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(u.href, { headers: { 'User-Agent': UA, Referer: 'https://www.lg.com/', Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' } }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location && hops < 3) {
        res.resume();
        const to = lgUrl(new URL(res.headers.location, u).href);
        return to ? fetchOnce(to, hops + 1).then(resolve, reject) : reject(Object.assign(new Error(`redirect off lg.com (${status})`), { status }));
      }
      const parts = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > MAX_BYTES) { req.destroy(new Error('image too large')); return; } parts.push(d); });
      res.on('end', () => {
        const buf = Buffer.concat(parts), type = sniff(buf);
        if (status === 200 && type) return resolve(buf);
        reject(Object.assign(new Error(`lg.com ${status}${type ? '' : ' (not an image)'}`), { status, gone: status === 404 || status === 410 }));
      });
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(Object.assign(new Error('timeout'), { status: 0 })));
    req.on('error', reject);
  });
}

// 막힘(403 · 429 · 5xx · 이미지 아님 · 시간 초과)은 기다렸다 다시. 없어진 이미지(404 · 410)는 바로 끝.
// lg.com 이 한 번 막으면 서버 전체가 잠깐(COOL) 쉬었다 간다 (2026-11-28) — 예전엔 이미지마다 1.5 · 4 · 8초 뒤 다시 두드려서 막힌 동안 계속 403
//   (운영 140개 Check: 다시 그린 4개 PDP 의 이미지가 11:12 에 전부 403, 몇 분 뒤 같은 이미지는 모두 200). 기다림 합계는 슬라이스가 이미지 하나를
//   기다리는 90초(slices.py) 안으로
const api = {
  DIR,
  DELAYS: [0, 4000, 12000, 25000, 40000],
  COOL: 15000,
  fetchRemote: fetchOnce,
};
let coolUntil = 0;
const cooled = async () => { for (let w; (w = coolUntil - Date.now()) > 0;) await new Promise((r) => setTimeout(r, Math.min(w, 5000))); };
async function fromLg(u) {
  let last;
  for (const wait of api.DELAYS) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { return await slot(async () => { await cooled(); return api.fetchRemote(u); }); }
    catch (e) {
      last = e; if (e.gone) break;
      if (e.status === 403 || e.status === 429) coolUntil = Math.max(coolUntil, Date.now() + api.COOL);
    }
  }
  throw last;
}

const pending = new Map();
// 사본: 로컬 → 버킷 → lg.com. 돌려주는 것 { buf, type, from }
function get(value) {
  const u = lgUrl(value);
  if (!u) return Promise.reject(Object.assign(new Error('lg.com https image URL only'), { status: 400 }));
  const k = keyOf(u), file = path.join(api.DIR, k);
  if (pending.has(k)) return pending.get(k);
  const job = (async () => {
    try { const buf = fs.readFileSync(file); const type = sniff(buf); if (type) return { buf, type, from: 'local' }; } catch (_) {}
    const kept = await store.getBuffer(`media-img/${k}`).catch(() => null);
    if (kept && sniff(kept)) { saveLocal(file, kept); return { buf: kept, type: sniff(kept), from: 'bucket' }; }
    const buf = await fromLg(u), type = sniff(buf);
    saveLocal(file, buf);
    store.putBuffer(`media-img/${k}`, buf, type).catch((e) => console.warn('[img-cache] 버킷 업로드 실패', e.message));
    return { buf, type, from: 'lg' };
  })().finally(() => pending.delete(k));
  pending.set(k, job);
  return job;
}
function saveLocal(file, buf) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, buf); fs.renameSync(`${file}.tmp`, file); } catch (e) { console.warn('[img-cache] 저장 실패', e.message); }
}

const router = express.Router();
router.get('/api/v1/img-cache', async (req, res) => {
  try {
    const { buf, type } = await get(req.query.url);
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=86400').send(buf);
  } catch (e) {
    const code = e.status === 400 ? 400 : e.gone ? 404 : 502;
    if (code === 502) console.warn(`[img-cache] 못 받음 ${String(req.query.url).slice(0, 160)} — ${e.message}`);
    res.status(code).type('text/plain').send(e.message);
  }
});

module.exports = Object.assign(api, { router, get, lgUrl, sniff });
