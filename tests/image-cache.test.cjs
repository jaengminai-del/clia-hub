const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const store = require('../crawl-store');
const cache = require('../image-cache');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const lg = (name) => `https://www.lg.com/content/dam/channel/wcms/th/images/${name}.jpg`;

test('only lg.com https image addresses are accepted', () => {
  assert.ok(cache.lgUrl(lg('a')));
  assert.ok(cache.lgUrl('https://lg.com/x.png'));
  for (const bad of ['http://www.lg.com/a.jpg', 'https://www.lg.com.evil.test/a.jpg', 'https://evil.test/www.lg.com/a.jpg',
    'https://user:pw@www.lg.com/a.jpg', 'https://www.lg.com:8443/a.jpg', 'file:///etc/passwd', '', null]) assert.equal(cache.lgUrl(bad), null, String(bad));
  assert.equal(cache.sniff(JPEG), 'image/jpeg');
  assert.equal(cache.sniff(Buffer.from('<html><title>Access Denied</title></html>')), null);
  assert.equal(cache.sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
});

test('image copy: lg.com once (retrying a block), then local; a gone image is not retried', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-cache-'));
  const old = { DIR: cache.DIR, DELAYS: cache.DELAYS, COOL: cache.COOL, fetchRemote: cache.fetchRemote };
  const put = [];
  t.mock.method(store, 'getBuffer', async () => null);
  t.mock.method(store, 'putBuffer', async (key, buf, type) => { put.push({ key, type }); return true; });
  const calls = new Map();
  let blocks = 2;
  Object.assign(cache, {
    DIR: dir, DELAYS: [0, 5, 5, 5], COOL: 0,
    fetchRemote: async (u) => {
      calls.set(u.pathname, (calls.get(u.pathname) || 0) + 1);
      await new Promise((r) => setTimeout(r, 20));
      if (u.pathname.includes('gone')) throw Object.assign(new Error('lg.com 404'), { status: 404, gone: true });
      if (u.pathname.includes('blocked') && blocks-- > 0) throw Object.assign(new Error('lg.com 403 (not an image)'), { status: 403 });
      if (u.pathname.includes('never')) throw Object.assign(new Error('lg.com 403 (not an image)'), { status: 403 });
      return JPEG;
    },
  });
  const app = express(); app.use(cache.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1/img-cache?url=`;
  const ask = (u) => fetch(base + encodeURIComponent(u));
  t.after(async () => { Object.assign(cache, old); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  // 같은 이미지를 동시에 여러 번 불러도 lg.com 에는 한 번
  const first = await Promise.all([1, 2, 3].map(() => ask(lg('ok'))));
  for (const r of first) { assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg'); assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG); }
  assert.equal(calls.get(new URL(lg('ok')).pathname), 1);
  assert.equal(put.length, 1); assert.match(put[0].key, /^media-img\/[0-9a-f]{40}$/); assert.equal(put[0].type, 'image/jpeg');
  // 다시 부르면 로컬 사본 — lg.com 에 가지 않는다
  assert.equal((await ask(lg('ok'))).status, 200);
  assert.equal(calls.get(new URL(lg('ok')).pathname), 1);
  // 막힘(403)은 기다렸다 다시 → 세 번째에 받음
  assert.equal((await ask(lg('blocked'))).status, 200);
  assert.equal(calls.get(new URL(lg('blocked')).pathname), 3);
  // 끝내 막히면 502, 사본은 남기지 않는다
  assert.equal((await ask(lg('never'))).status, 502);
  assert.equal(calls.get(new URL(lg('never')).pathname), 4);
  // 없어진 이미지(404)는 다시 하지 않고 404
  assert.equal((await ask(lg('gone'))).status, 404);
  assert.equal(calls.get(new URL(lg('gone')).pathname), 1);
  // lg.com 이 아닌 주소는 받지 않는다
  assert.equal((await ask('https://example.test/a.jpg')).status, 400);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('a copy kept in the bucket is used after a redeploy without asking lg.com', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-cache-'));
  const old = { DIR: cache.DIR, fetchRemote: cache.fetchRemote };
  t.mock.method(store, 'getBuffer', async (key) => (/^media-img\//.test(key) ? JPEG : null));
  t.mock.method(store, 'putBuffer', async () => true);
  let asked = 0;
  Object.assign(cache, { DIR: dir, fetchRemote: async () => { asked++; return JPEG; } });
  t.after(() => { Object.assign(cache, old); fs.rmSync(dir, { recursive: true, force: true }); });
  const got = await cache.get(lg('kept'));
  assert.equal(got.from, 'bucket'); assert.equal(asked, 0);
  assert.equal((await cache.get(lg('kept'))).from, 'local');
});

test('after lg.com blocks once, every image waits out the cool-down before asking again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-cache-'));
  const old = { DIR: cache.DIR, DELAYS: cache.DELAYS, COOL: cache.COOL, fetchRemote: cache.fetchRemote };
  t.mock.method(store, 'getBuffer', async () => null);
  t.mock.method(store, 'putBuffer', async () => true);
  const asked = [];
  let blocked = true;
  Object.assign(cache, { DIR: dir, DELAYS: [0, 10], COOL: 300, fetchRemote: async (u) => {
    asked.push([u.pathname, Date.now()]);
    if (blocked) { blocked = false; throw Object.assign(new Error('lg.com 403 (not an image)'), { status: 403 }); }
    return JPEG;
  } });
  t.after(() => { Object.assign(cache, old); fs.rmSync(dir, { recursive: true, force: true }); });
  const t0 = Date.now();
  const first = cache.get(lg('cool-a'));
  await new Promise((r) => setTimeout(r, 20));
  const second = cache.get(lg('cool-b'));   // 다른 이미지도 막힌 뒤에는 쉬었다가
  await Promise.all([first, second]);
  const after = asked.filter(([p]) => p.includes('cool-b'))[0][1] - t0;
  assert.ok(after >= 280, `second image asked lg.com ${after} ms after the block`);
});
