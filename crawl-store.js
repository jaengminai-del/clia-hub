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
  /(^|\/)[a-z_]+_content\.html$/,  // 매체별 1차 컨텐츠(ebay_content.html 등) — 생성 때마다 새로 렌더
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.imgdims-cache\.json$/,
  /^_trash\//,                      // 삭제한 제품 보관함 (deleteProduct) — 버킷은 trash/ 접두사로 따로 보관
  /(^|\/)\.prev\//,                 // 다시 크롤하는 동안 지난 결과 (crawler-routes stashPrev) — 로컬 전용
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
  const tmp = `${abs}.part-${process.pid}-${Date.now()}`;
  await require('stream/promises').pipeline(r.Body, fs.createWriteStream(tmp));
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
// 동기화 중인지 — 재배포 직후 약 1분은 로컬 폴더가 비어 있다 (벌크 작업 조회가 이것을 기다린다, 2026-11-23)
let pulling = null;
/** 버킷 → 로컬 동기화가 끝날 때까지(최대 ms) 기다린다. 동기화 중이 아니면 바로. */
function whenPulled(ms) {
  if (!pulling) return Promise.resolve(true);
  return Promise.race([pulling.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))]);
}
async function pullAll(opts = {}) {
  if (!enabled()) return null;
  pulling = pullAllOnce(opts);
  try { return await pulling; } finally { pulling = null; }
}
async function pullAllOnce({ log = console.log } = {}) {
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

/** 지정한 로컬 파일들의 버킷 사본을 지운다 (빌더 편집본 '원본으로', 2026-11-23). 실패해도 예외를 던지지 않는다. */
async function removePaths(absPaths) {
  if (!enabled()) return 0;
  const keys = absPaths.map(keyFor).filter(Boolean);
  if (!keys.length) return 0;
  const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  try { await client().send(new DeleteObjectsCommand({ Bucket: config().bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } })); }
  catch (e) { console.warn(`[crawl-store] 삭제 실패 ${keys.join(', ')}: ${e.message}`); return 0; }
  return keys.length;
}

/** 크롤 제품 삭제 (허브 목록의 삭제 버튼, 2026-11-05) — 버킷의 crawler-py-out/<slug>/ · crawler-out/<slug>.* 를
 *  trash/<stamp>/<원래 키> 로 복사해 둔 뒤 지운다 (되돌리기: restoreProduct). 반환: 지운 객체 수. */
async function deleteProduct(slug, stamp, meta) {
  if (!enabled()) return 0;
  const keys = await productKeys(slug);
  await pool(keys, 8, (key) => copyKey(key, `trash/${stamp}/${key}`));
  // 복구 목록용 메모 (2026-11-26) — 재배포돼도 남게 버킷에. 제품 사본보다 나중에 써서, 메모가 있으면 사본도 다 있다.
  if (meta) await putBuffer(`trash/${stamp}/${TRASH_META}`, Buffer.from(JSON.stringify({ ...meta, slug, stamp, files: keys.length })), 'application/json');
  await deleteKeys(keys);
  return keys.length;
}

const copyKey = (from, to) => {
  const { CopyObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = config().bucket;
  return client().send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${encodeURIComponent(from).replace(/%2F/g, '/')}` }));
};
async function deleteKeys(keys) {
  const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  for (let i = 0; i < keys.length; i += 1000) {
    await client().send(new DeleteObjectsCommand({ Bucket: config().bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
}
/** 버킷에 있는 제품 하나의 키 (crawler-py-out/<slug>/… + crawler-out/<slug>.*) */
async function productKeys(slug) {
  return [...(await listRemote(`${ROOTS[0].prefix}${slug}/`)).keys(), ...(await listRemote(`${ROOTS[1].prefix}${slug}.`)).keys()];
}

// ── 휴지통 복구 (2026-11-26) ── 버킷 trash/<stamp>/<원래 키> 를 원래 키로 다시 복사한다.
//   trash/<stamp>/_meta.json     지울 때 남긴 메모 (모델 · 주소 · 지운 때). 그 전에 지운 것은 메모 없음 → 사본에서 읽는다.
//   trash/<stamp>/_restored.json 복구했다는 표시 — 목록에서 뺀다 (사본은 지우지 않고 그대로 둔다).
const TRASH_META = '_meta.json', TRASH_DONE = '_restored.json';
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** 버킷 휴지통 → [{ stamp, slug, keys: [원래 키…], meta: bool, restored: bool }] (최근 것부터) */
async function listTrash() {
  if (!enabled()) return [];
  const byStamp = new Map();
  for (const key of (await listRemote('trash/')).keys()) {
    const m = /^trash\/([^/]+)\/(.+)$/.exec(key);
    if (!m || !STAMP_RE.test(m[1])) continue;
    const e = byStamp.get(m[1]) || { stamp: m[1], slugs: new Map(), meta: false, restored: false };
    byStamp.set(m[1], e);
    const orig = m[2];
    if (orig === TRASH_META) { e.meta = true; continue; }
    if (orig === TRASH_DONE) { e.restored = true; continue; }
    let slug = null;
    if (orig.startsWith(ROOTS[0].prefix)) slug = orig.slice(ROOTS[0].prefix.length).split('/')[0];
    else if (orig.startsWith(ROOTS[1].prefix)) slug = orig.slice(ROOTS[1].prefix.length).split('.')[0];
    if (!slug || slug.startsWith('_')) continue;
    if (!e.slugs.has(slug)) e.slugs.set(slug, []);
    e.slugs.get(slug).push(orig);
  }
  const out = [];
  for (const e of byStamp.values()) for (const [slug, keys] of e.slugs) out.push({ stamp: e.stamp, slug, keys, meta: e.meta, restored: e.restored });
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

/** 휴지통 사본을 원래 키로 복사한다. 이미 원래 키에 같은 제품이 있으면 아무것도 하지 않고 { conflict: true }.
 *  중간에 실패하면 복사한 키를 다시 지워 반쪽짜리 제품이 남지 않게 한다. */
async function restoreProduct(stamp, slug) {
  if (!enabled()) return { keys: [] };
  if (!STAMP_RE.test(stamp)) throw new Error('bad stamp');
  const entry = (await listTrash()).find((e) => e.stamp === stamp && e.slug === slug);
  if (!entry) return { missing: true, keys: [] };
  if ((await productKeys(slug)).length) return { conflict: true, keys: [] };
  const done = [];
  try {
    await pool(entry.keys, 8, async (key) => { await copyKey(`trash/${stamp}/${key}`, key); done.push(key); });
  } catch (e) {
    await deleteKeys(done).catch(() => {});
    throw e;
  }
  await putBuffer(`trash/${stamp}/${TRASH_DONE}`, Buffer.from(JSON.stringify({ slug, at: Date.now() / 1000 })), 'application/json');
  return { keys: entry.keys };
}

/** 버킷 키들을 로컬 원래 자리로 내려받는다 (로컬에 없거나 다른 것만). 반환: 내려받은 수 */
async function pullKeys(keys) {
  if (!enabled()) return 0;
  let n = 0;
  const remote = new Map();
  for (const key of keys) {
    const r = ROOTS.find((x) => key.startsWith(x.prefix));
    const rel = r && key.slice(r.prefix.length);
    if (!rel || rel.split('/').includes('..') || !shouldSync(rel)) continue;
    remote.set(key, path.join(r.local, ...rel.split('/')));
  }
  await pool([...remote], 8, async ([key, abs]) => {
    if (fs.existsSync(abs)) return;
    await download(key, abs); n++;
  });
  return n;
}

/** 임의 키에 바이트 올리기 / 읽기 (이미지형 HTML 슬라이스 — media-slices/ 접두사, 시작 시 pull 대상 아님) */
async function putBuffer(key, buf, contentType) {
  if (!enabled()) return false;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new PutObjectCommand({ Bucket: config().bucket, Key: key, Body: buf, ContentType: contentType }));
  return true;
}
async function getBuffer(key) {
  if (!enabled()) return null;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const r = await client().send(new GetObjectCommand({ Bucket: config().bucket, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  } catch (e) { return null; }
}

// 큰 파일(묶음 ZIP 등)용: 메모리에 올리지 않고 디스크 ↔ 버킷 스트림
async function putFile(key, abs, contentType) {
  if (!enabled()) return false;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new PutObjectCommand({ Bucket: config().bucket, Key: key, Body: fs.createReadStream(abs),
                                             ContentLength: fs.statSync(abs).size, ContentType: contentType }));
  return true;
}
async function getToFile(key, abs) {
  if (!enabled()) return false;
  try { await download(key, abs); return true; } catch (e) { return false; }
}

module.exports = { enabled, listRemote, pullAll, whenPulled, pushAll, pushPaths, removePaths, pushProduct, pushCrawlerOut, putBuffer, getBuffer, putFile, getToFile, deleteProduct,
  listTrash, restoreProduct, pullKeys, TRASH_META, STAMP_RE };

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
