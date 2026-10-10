/**
 * crawl-store.js — 크롤링 결과를 S3 호환 버킷(Railway Storage Bucket 등)에 보관
 *
 * 서버는 지금처럼 로컬 폴더(crawler-py/out, crawler/out)에 읽고 쓰고, 이 모듈이 버킷과 동기화한다.
 *   - 서버 시작 시  pullAll()       : 버킷 → 로컬 (없거나 내용이 다른 파일만 내려받음)
 *   - 크롤 완료 시  pushProduct()   : crawler-py/out/<slug>/ → 버킷
 *   - GEO 생성 시   pushPaths()     : geo.json → 버킷
 *   - /api/pcg 후   pushCrawlerOut(): crawler/out/<slug>.* → 버킷
 * 버킷 환경 변수가 없으면 아무 것도 하지 않는다(로컬 개발 그대로).
 *
 * 로컬 PC의 크롤 데이터를 버킷에 올리거나 확인할 때 (.env 에 버킷 키 필요):
 *   node crawl-store.js status          → 올라갈 파일 수·용량, 버킷과 다른 파일 수
 *   node crawl-store.js push [--dry-run] → 로컬 → 버킷
 *   node crawl-store.js pull            → 버킷 → 로컬
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOTS = [
  { local: path.join(__dirname, 'crawler-py', 'out'), prefix: 'crawler-py-out/' },
  { local: path.join(__dirname, 'crawler', 'out'), prefix: 'crawler-out/' },
];

// 버킷에 올리지 않는 파일 — 재크롤 때 다시 만들어지는 대용량 스크린샷·백업·런타임 파일
const EXCLUDE = [
  /(^|\/)tiles\//,
  /(^|\/)(pc|mobile)_full\.png$/,
  /\.bak$/,
  /\.log$/,
  /(^|\/)progress\.json$/,
  /(^|\/)ebay_content\.html$/,      // eBay 생성 때마다 새로 렌더
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.imgdims-cache\.json$/,
];
const shouldSync = (rel) => !EXCLUDE.some((re) => re.test(rel));

// Railway 버킷 변수(BUCKET, ENDPOINT …)와 AWS SDK 프리셋 변수(AWS_*) 모두 지원
const env = (...names) => names.map((n) => (process.env[n] || '').trim()).find(Boolean) || '';
function config() {
  const bucket = env('CLIA_BUCKET', 'BUCKET', 'AWS_S3_BUCKET_NAME', 'S3_BUCKET');
  const accessKeyId = env('ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = env('SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY');
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    endpoint: env('ENDPOINT', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL', 'S3_ENDPOINT') || undefined,
    region: env('REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION') || 'auto',
    forcePathStyle: env('S3_FORCE_PATH_STYLE') === '1', // 예전에 만든 Railway 버킷은 path-style 필요
    credentials: { accessKeyId, secretAccessKey },
  };
}
const enabled = () => !!config();

let _client = null;
function client() {
  if (!_client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    const { bucket, ...opts } = config();
    _client = new S3Client(opts);
  }
  return _client;
}

const md5 = (abs) => crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex');

// 같은 파일인지: 단일 업로드 ETag(=MD5)가 있으면 MD5, 아니면 크기로 비교
function sameFile(abs, remote) {
  let st;
  try { st = fs.statSync(abs); } catch { return false; }
  if (st.size !== remote.size) return false;
  return /^[0-9a-f]{32}$/.test(remote.etag) ? md5(abs) === remote.etag : true;
}

function walk(dir, base = '') {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile() && shouldSync(rel)) out.push(rel);
  }
  return out;
}

async function listRemote(prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const map = new Map();
  let token;
  do {
    const r = await client().send(new ListObjectsV2Command({
      Bucket: config().bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of r.Contents || []) {
      map.set(o.Key, { size: o.Size, etag: String(o.ETag || '').replace(/"/g, '') });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return map;
}

async function upload(abs, key) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new PutObjectCommand({ Bucket: config().bucket, Key: key, Body: fs.readFileSync(abs) }));
}

async function download(key, abs) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await client().send(new GetObjectCommand({ Bucket: config().bucket, Key: key }));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.part-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(await r.Body.transformToByteArray()));
  fs.renameSync(tmp, abs);
}

async function pool(items, size, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

// 로컬 경로 → 버킷 키 (동기화 대상이 아니면 null)
function keyFor(abs) {
  for (const r of ROOTS) {
    const rel = path.relative(r.local, abs).split(path.sep).join('/');
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return shouldSync(rel) ? r.prefix + rel : null;
  }
  return null;
}

/** 버킷 → 로컬. 로컬에 없거나 내용이 다른 파일만 내려받는다. */
async function pullAll({ log = console.log } = {}) {
  if (!enabled()) return null;
  const stats = { downloaded: 0, unchanged: 0, failed: 0 };
  for (const r of ROOTS) {
    const remote = await listRemote(r.prefix);
    const todo = [];
    for (const [key, meta] of remote) {
      const rel = key.slice(r.prefix.length);
      if (!rel || rel.split('/').includes('..') || !shouldSync(rel)) continue;
      const abs = path.join(r.local, ...rel.split('/'));
      if (sameFile(abs, meta)) stats.unchanged++;
      else todo.push([key, abs]);
    }
    await pool(todo, 8, async ([key, abs]) => {
      try { await download(key, abs); stats.downloaded++; }
      catch (e) { stats.failed++; log(`[crawl-store] 다운로드 실패 ${key}: ${e.message}`); }
    });
  }
  return stats;
}

/** 로컬 → 버킷. 버킷에 없거나 내용이 다른 파일만 올린다. */
async function pushAll({ dryRun = false, log = console.log } = {}) {
  if (!enabled()) return null;
  const stats = { uploaded: 0, unchanged: 0, failed: 0, bytes: 0 };
  for (const r of ROOTS) {
    const remote = await listRemote(r.prefix);
    const todo = walk(r.local).filter((rel) => {
      const meta = remote.get(r.prefix + rel);
      if (meta && sameFile(path.join(r.local, ...rel.split('/')), meta)) { stats.unchanged++; return false; }
      return true;
    });
    await pool(todo, 8, async (rel) => {
      const abs = path.join(r.local, ...rel.split('/'));
      stats.bytes += fs.statSync(abs).size;
      if (dryRun) { stats.uploaded++; return; }
      try { await upload(abs, r.prefix + rel); stats.uploaded++; }
      catch (e) { stats.failed++; log(`[crawl-store] 업로드 실패 ${rel}: ${e.message}`); }
    });
  }
  return stats;
}

/** 지정한 로컬 파일들을 버킷에 올린다. 실패해도 예외를 던지지 않는다(로컬 결과는 그대로 사용). */
async function pushPaths(absPaths) {
  if (!enabled()) return 0;
  let n = 0;
  await pool(absPaths, 8, async (abs) => {
    const key = keyFor(abs);
    if (!key || !fs.existsSync(abs)) return;
    try { await upload(abs, key); n++; }
    catch (e) { console.warn(`[crawl-store] 업로드 실패 ${key}: ${e.message}`); }
  });
  return n;
}

/** 크롤 완료된 제품 폴더(crawler-py/out/<slug>/) 전체를 올린다. */
function pushProduct(slug) {
  const dir = path.join(ROOTS[0].local, path.basename(slug));
  return pushPaths(walk(dir).map((rel) => path.join(dir, ...rel.split('/'))));
}

/** 보조 크롤러 캐시(crawler/out/<slug>.*)를 올린다. */
function pushCrawlerOut(slug) {
  const dir = ROOTS[1].local;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.startsWith(`${slug}.`)); } catch {}
  return pushPaths(names.map((f) => path.join(dir, f)));
}

module.exports = { enabled, pullAll, pushAll, pushPaths, pushProduct, pushCrawlerOut };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const [cmd, ...flags] = process.argv.slice(2);
  (async () => {
    if (!enabled()) {
      console.error('✗ 버킷 설정이 없습니다. .env 에 BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, ENDPOINT 를 넣으세요.');
      process.exit(1);
    }
    const mb = (b) => `${(b / 1e6).toFixed(1)}MB`;
    if (cmd === 'push' || cmd === 'status') {
      const s = await pushAll({ dryRun: cmd === 'status' || flags.includes('--dry-run') });
      const verb = cmd === 'push' && !flags.includes('--dry-run') ? '업로드' : '업로드 예정';
      console.log(`✓ ${verb} ${s.uploaded}개 (${mb(s.bytes)}), 이미 같음 ${s.unchanged}개, 실패 ${s.failed}개`);
      process.exit(s.failed ? 1 : 0);
    } else if (cmd === 'pull') {
      const s = await pullAll();
      console.log(`✓ 다운로드 ${s.downloaded}개, 이미 같음 ${s.unchanged}개, 실패 ${s.failed}개`);
      process.exit(s.failed ? 1 : 0);
    } else {
      console.log('사용법: node crawl-store.js status | push [--dry-run] | pull');
    }
  })().catch((e) => { console.error('✗', e.message); process.exit(1); });
}
