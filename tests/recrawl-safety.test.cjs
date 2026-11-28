// 다시 크롤(force)이 실패해도 지난 크롤 결과가 남는지 · 버킷을 받는 동안 벌크를 시작하지 않는지 · 자동 재시도 동시 수 (2026-11-28)
for (const k of ['CLIA_BUCKET', 'BUCKET', 'AWS_S3_BUCKET_NAME', 'S3_BUCKET']) delete process.env[k];   // 버킷에 올리지 않게
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const cr = require('../crawler-routes');
const store = require('../crawl-store');

const FILES = ['mirror.json', 'pc.html', 'qa_report.json'];
const write = (dir, tag) => { fs.mkdirSync(dir, { recursive: true }); for (const f of FILES) fs.writeFileSync(path.join(dir, f), `${tag}:${f}`); };
const read = (dir) => Object.fromEntries(FILES.map((f) => [f, fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null]));

test('re-crawl keeps the last good result aside and restores it when the new crawl fails', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'recrawl-'));
  const { stashPrev, settlePrev, PREV } = cr._prev;
  try {
    write(out, 'old');
    stashPrev(out);
    assert.deepEqual(read(out), { 'mirror.json': null, 'pc.html': null, 'qa_report.json': null });   // 새 크롤은 빈 자리에서
    fs.writeFileSync(path.join(out, 'pc.html'), 'half-written');                                      // 실패한 크롤이 남긴 것
    settlePrev(out, false);
    assert.deepEqual(read(out), { 'mirror.json': 'old:mirror.json', 'pc.html': 'old:pc.html', 'qa_report.json': 'old:qa_report.json' });
    assert.equal(fs.existsSync(path.join(out, PREV)), false);

    // 성공하면 새 결과를 두고 지난 것은 지운다
    stashPrev(out);
    write(out, 'new');
    settlePrev(out, true);
    assert.deepEqual(read(out), { 'mirror.json': 'new:mirror.json', 'pc.html': 'new:pc.html', 'qa_report.json': 'new:qa_report.json' });
    assert.equal(fs.existsSync(path.join(out, PREV)), false);

    // 앞선 다시 크롤이 끝나지 못하고 .prev 를 남겼으면, 그것(마지막 성공)을 덮어쓰지 않는다
    stashPrev(out);
    fs.writeFileSync(path.join(out, 'mirror.json'), 'broken');
    stashPrev(out);
    settlePrev(out, false);
    assert.equal(read(out)['mirror.json'], 'new:mirror.json');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('a real forced crawl whose pipeline fails leaves the product as it was', async (t) => {
  const url = `https://www.lg.com/th/clia-test/recrawl-${process.pid}-${Date.now()}/`;
  const out = path.join(cr.OUT_DIR, cr.slugify(url));
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-py-')), 'python');
  // 파이프라인 대신: 반쯤 쓰고 실패 (운영의 can't start new thread 처럼)
  fs.writeFileSync(fake, `#!/bin/sh\necho half > "${out}/pc.html"\necho "RuntimeError: can't start new thread" >&2\nexit 1\n`, { mode: 0o755 });
  const old = process.env.CRAWLER_PYTHON;
  process.env.CRAWLER_PYTHON = fake;
  t.after(() => { if (old === undefined) delete process.env.CRAWLER_PYTHON; else process.env.CRAWLER_PYTHON = old; fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(path.dirname(fake), { recursive: true, force: true }); });
  write(out, 'good');
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ url, crawled_at: 1 }));
  await assert.rejects(cr.crawl(url, { force: true }));
  assert.deepEqual(read(out), { 'mirror.json': 'good:mirror.json', 'pc.html': 'good:pc.html', 'qa_report.json': 'good:qa_report.json' });
  assert.equal(fs.existsSync(path.join(out, '.prev')), false);
});

test('bulk upload and build wait for the bucket copy, and say so if it takes too long', async (t) => {
  const express = require('express');
  const app = express(); app.use(require('../bulk-routes').router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/bulk`;
  let pulled = false;
  t.mock.method(store, 'whenPulled', async () => pulled);
  for (const [p, init] of [['/upload?name=a.xlsx&check=1', { body: Buffer.from('x'), headers: { 'Content-Type': 'application/octet-stream' } }],
    ['/build', { body: '{}', headers: { 'Content-Type': 'application/json' } }]]) {
    const r = await fetch(base + p, { method: 'POST', ...init });
    assert.equal(r.status, 503, p);
    assert.equal((await r.json()).code, 'warming_up');
  }
  pulled = true;   // 다 받았으면 평소대로 (여기서는 내용이 엉터리라 400 · 404)
  assert.notEqual((await fetch(base + '/build', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 503);
});

test('automatic retries run two products at a time by default', () => {
  assert.equal(require('../bulk-jobs').RETRY_CONC, 2);
});

test('a PDP with only missing images is drawn again once, other problems twice', () => {
  const { _retryable: retryable } = require('../bulk-jobs');
  const img = [{ k: 'img', ok: false, n: 2, bad: 2, lg: 0 }];
  assert.equal(retryable({ status: 'ok', tries: 0 }, img), true);
  assert.equal(retryable({ status: 'ok', tries: 1 }, img), false);   // 같은 이미지가 또 빠지면 사람에게
  const sum = [{ k: 'sum', ok: false }];
  assert.equal(retryable({ status: 'ok', tries: 1 }, sum), true);
  assert.equal(retryable({ status: 'ok', tries: 2 }, sum), false);
});

test('a product with no content on lg.com is not an error: no retry, row left as it is, download not blocked', (t) => {
  const bj = require('../bulk-jobs');
  const slug = `clia-test-empty-${process.pid}`, dir = path.join(cr.OUT_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // lg.com 화면에 기능 섹션이 없어 다 숨긴 제품 (예: T2310NBTB)
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ sections: [], _lg_hidden: { visible: '0/10', sections: [{ component_id: 'AEM:heroimage' }] } }));
  assert.equal(bj._lgEmpty(slug), true);
  // 크롤이 안 된 것(섹션 0 · 숨김 없음)은 내용 없음이 아니다 — 다시 크롤
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ sections: [] }));
  assert.equal(bj._lgEmpty(slug), false);
  assert.equal(bj._lgEmpty('clia-test-missing'), false);
  const empty = { status: 'failed', empty: true };
  assert.equal(bj._retryable(empty, []), false);
  assert.equal(bj._retryable({ status: 'failed' }, []), true);
  assert.equal(bj.exportBlocked(empty), false);
  assert.equal(bj.exportBlocked({ status: 'failed' }), true);
});
