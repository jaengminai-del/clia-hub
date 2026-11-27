const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const JSZip = require('jszip');
const express = require('express');
const jobs = require('../bulk-jobs');
const approvals = require('../approvals');
const crawler = require('../crawler-routes');
const store = require('../crawl-store');
const xlsx = require('../bulk-xlsx');

const sheet = 'xl/worksheets/sheet1.xml';
const hash = text => createHash('sha256').update(text).digest('hex');
const reviewed = items => Object.fromEntries(items.map(({ row, hash, contentDigest }) => [row, { hash, contentDigest }]));
const render = text => ({ text, hash: hash(text).slice(0, 20), urls: [], unified: true });
async function fixture(t, gate = '0') {
  const id = randomBytes(8).toString('hex');
  const root = path.join(jobs.DIR, id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clia-delivery-'));
  const oldDir = crawler.OUT_DIR, oldGate = process.env.APPROVAL_GATE;
  crawler.OUT_DIR = dir;
  process.env.APPROVAL_GATE = gate;
  t.after(() => {
    crawler.OUT_DIR = oldDir;
    if (oldGate === undefined) delete process.env.APPROVAL_GATE;
    else process.env.APPROVAL_GATE = oldGate;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(jobs.DIR, 'jobs', id + '.json'), { force: true });
  });
  t.mock.method(store, 'putBuffer', async () => {});
  for (const slug of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(dir, slug));
    fs.writeFileSync(path.join(dir, slug, 'mirror.json'), '{"sections": []}');
  }
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Test" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file(sheet, '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Product Name</t></is></c><c r="B1" t="inlineStr"><is><t>Parent SKU</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Alpha input</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Beta input</t></is></c></row></sheetData></worksheet>');
  await jobs.saveUpload(id, await zip.generateAsync({ type: 'nodebuffer' }), {});
  const j = { id, upload: id, status: 'ready', channel: 'shopee', sheet, descCol: 1,
    check: {}, items: [], outName: 'fixture.xlsx', notify: { lang: 'en' }, base: 'https://example.test' };
  const texts = new Map();
  for (const [i, slug] of ['alpha', 'beta'].entries()) {
    const row = i + 2, c = render(slug + ' PDP 0');
    texts.set(row, c.text);
    j.items.push({ row, slug, status: 'ok', unified: true, hash: c.hash, contentDigest: hash(c.text), ai: [] });
  }
  fs.writeFileSync(path.join(root, 'texts-' + id + '.json'), JSON.stringify(Object.fromEntries(texts)));
  return { j, root, dir, texts };
}

test('mixed, legacy and reviewed workbooks share the email and API guard, root static stays private', async t => {
  const { j, texts, root } = await fixture(t);
  const [a, b] = j.items;
  b.ai = [{ k: 'n12', ok: false, blocked: true, used: 12, all: 13 }];
  await jobs._writeResult(j, texts);
  assert.equal((await jobs.checkAction(j, [2], 'ok', 'fixture', false, reviewed(j.items))).ok, true);
  const request = global.fetch;
  const app = express();
  app.use(require('../bulk-routes').router);
  app.use(express.static(path.join(__dirname, '..')));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.mock.method(jobs, 'getJob', async () => j);
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = base + '/api/v1/bulk/jobs/' + j.id;
  const fileName = 'result-' + j.id + '.xlsx';
  const staticUrl = base + '/media-cache/bulk/' + j.id + '/' + fileName;
  const mail = t.mock.method(global, 'fetch', async (url) => {
    assert.equal(url, 'https://api.resend.com/emails');
    return new Response(null, { status: 202 });
  });
  const send = async () => {
    await jobs._sendMail(j, 'test@example.test', 'test-placeholder', 'test@example.test');
    return JSON.parse(mail.mock.calls.at(-1).arguments[1].body);
  };
  assert.ok(fs.existsSync(path.join(root, fileName)));
  assert.equal((await request(staticUrl)).status, 404);
  assert.equal((await request(staticUrl.replace('media-cache', '%6dedia-cache'))).status, 404);
  assert.equal((await request(base + '/bulk/index.html')).status, 200);
  assert.equal((await request(api + '/file')).status, 409);
  assert.equal((await request(api + '/cell?row=2')).status, 409);
  const blocked = await send();
  assert.equal(blocked.attachments, undefined);
  assert.match(blocked.text, /check=1/);
  assert.doesNotMatch(blocked.text, /\/file\b/);
  const stamp = t.mock.method(approvals, 'write');
  assert.equal((await jobs.checkAction(j, [3], 'remove')).ok, true);
  assert.equal((await jobs.checkAction(j, [3], 'ok', 'fixture', true, reviewed(j.items))).status, 409);
  assert.equal(stamp.mock.callCount(), 0);
  assert.equal(b.check, 'removed');
  assert.equal(b.checkedHash, undefined);
  const response = await request(api + '/file');
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal((await xlsx.load(bytes)).sheets[0].rows.get(3).get(1), 'Beta input');
  assert.deepEqual(Buffer.from((await send()).attachments[0].content, 'base64'), bytes);
  const proof = j.resultDigest;
  delete j.resultDigest;
  assert.equal((await request(api + '/file')).status, 409);
  assert.equal((await send()).attachments, undefined);
  j.resultDigest = proof;
  fs.writeFileSync(path.join(root, fileName), Buffer.concat([bytes, Buffer.from('stale')]));
  assert.equal((await request(api + '/file')).status, 409);
  assert.equal((await send()).attachments, undefined);
  assert.equal(a.checkedHash, a.hash);
});

test('reverse bucket release preserves both retries and approves the actual XLSX cell', async t => {
  const { j, dir, texts } = await fixture(t, '1');
  await jobs._writeResult(j, texts);
  const a1 = render('alpha PDP 1'), b1 = render('beta PDP 1');
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const releases = [deferred(), deferred()];
  const firstPut = deferred();
  const snapshots = [];
  store.putBuffer = async (key, bytes) => {
    if (!key.endsWith('texts-' + j.id + '.json')) return;
    const index = snapshots.push(JSON.parse(bytes)) - 1;
    if (!index) firstPut.resolve();
    await releases[index].promise;
  };
  const retryA = jobs._commitRender(j, [j.items[0]], a1, []);
  await firstPut.promise;
  const retryB = jobs._commitRender(j, [j.items[1]], b1, []);
  const confirm = jobs.checkAction(j, [2, 3], 'ok', 'fixture', true, reviewed(j.items));
  releases[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
  const held = snapshots.slice();
  const oldHash = j.items[1].hash;
  releases[0].resolve();
  await Promise.all([retryA, retryB]);
  const stale = await confirm;
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'review_changed');
  assert.equal(j.items[1].checkedHash, undefined);
  assert.equal(approvals.status('beta').status, 'pending');
  assert.equal((await jobs.checkAction(j, [2, 3], 'ok', 'fixture', false, reviewed(j.items))).ok, true);
  assert.deepEqual(held, [{ 2: a1.text, 3: texts.get(3) }]);
  assert.notEqual(oldHash, b1.hash);
  assert.deepEqual(snapshots.at(-1), { 2: a1.text, 3: b1.text });
  assert.equal(j.items[1].checkedHash, b1.hash);
  assert.equal(approvals.status('beta').hashes.shopee, b1.hash);
  const wb = await xlsx.load((await jobs.deliver(j)).bytes);
  assert.equal(wb.sheets[0].rows.get(2).get(1), a1.text);
  assert.equal(wb.sheets[0].rows.get(3).get(1), b1.text);
  assert.equal(j.items[1].checkedContentDigest, hash(wb.sheets[0].rows.get(3).get(1)));

  const approvalFile = path.join(dir, 'beta', 'approval.json');
  const record = JSON.parse(fs.readFileSync(approvalFile));
  fs.writeFileSync(approvalFile, JSON.stringify({ ...record, hashes: { lazada: b1.hash } }));
  assert.equal((await jobs.deliver(j)).code, 'not_approved');
  fs.writeFileSync(approvalFile, JSON.stringify({ ...record, hashes: { shopee: render(texts.get(3)).hash } }));
  assert.equal((await jobs.deliver(j)).code, 'not_approved');
  fs.writeFileSync(approvalFile, JSON.stringify(record));
  assert.ok((await jobs.deliver(j)).bytes);
});

test('reject unrelated legacy specs, changed keyed rows and missing component specs', async t => {
  const { dir, j } = await fixture(t);
  const key = 'PD0008:1:fixture', width = { label: 'Screen width', value: '42 cm' };
  const region = [{ slice: 1, y: 0.2, h: 0.5 }];
  const c = { urls: ['https://example.test/spec.jpg'], edited: true,
    specTables: [{ sourceKeys: [key], rows: [['Weight', '5 kg']], regions: region }] };
  const write = (slug, coverage) => fs.writeFileSync(path.join(dir, slug, 'qa_report.json'), JSON.stringify({ coverage }));
  const spec = it => jobs.aiChecks(j, it, c).find(x => x.k === 'spec');
  write('alpha', { missing_texts: [{ component_id: 'PD0008', text: 'Screen width' }] });
  assert.deepEqual(spec(j.items[0]).issues, [{ lines: ['Screen width'], regions: [] }]);
  assert.equal(spec(j.items[0]).blocked, true);
  const modern = { source_ownership: 2, source_specs: [{ source_key: key, rows: [width] }] };
  write('alpha', modern);
  assert.equal(spec(j.items[0]).ok, false);
  c.specTables[0].rows = [[width.label, '99 cm']];
  assert.equal(spec(j.items[0]).ok, false);
  c.specTables[0].rows = [[width.label, width.value]];
  assert.equal(spec(j.items[0]).ok, true);

  const bundle = { bundle: [{ slug: 'alpha', model: 'A' }, { slug: 'beta', model: 'B' }] };
  c.specTables[0].part = 1;
  assert.deepEqual(spec(bundle).issues, [{ model: 'B', unknown: true, regions: [] }]);
  assert.deepEqual(spec(bundle).crawlParts, [2]);
  write('beta', modern);
  assert.deepEqual(spec(bundle).issues, [{ model: 'B', rows: [width], regions: [] }]);
  assert.equal(spec(bundle).ok, false);
  c.specTables.push({ ...c.specTables[0], part: 2 });
  assert.equal(spec(bundle).ok, true);
});

test('two manual retries serialize the texts and workbook while blocking same-row actions', async t => {
  const { j, dir, texts } = await fixture(t, '1');
  for (const [index, it] of j.items.entries()) {
    it.url = 'https://www.lg.com/sg/test-product-' + index + '/';
    fs.writeFileSync(path.join(dir, it.slug, 'qa_report.json'), '{"coverage":{"source_specs":[]}}');
  }
  await jobs._writeResult(j, texts);
  t.mock.method(crawler, 'crawl', async () => {});
  t.mock.method(require('../edits'), 'getEdit', () => null);
  t.mock.method(require('../slice-preview'), 'ensure', async () => {});
  t.mock.method(global, 'fetch', async (request, options) => {
    const route = new URL(request).pathname;
    const body = JSON.parse(options.body);
    if (route === '/api/ebay-generate') return Response.json({ html: body.url });
    assert.equal(route, '/api/v1/slice-html');
    const suffix = body.html.includes('product-0') ? 'alpha' : 'beta';
    const url = 'https://example.test/fixture/' + suffix + '.jpg';
    return Response.json({ count: 1, urls: [url], hash: render(url).hash, images_loaded: '0/0', specTables: [] });
  });
  const firstWrite = Promise.withResolvers(), secondRender = Promise.withResolvers(), release = Promise.withResolvers();
  const mockFetch = global.fetch;
  global.fetch = async (request, options) => {
    const response = await mockFetch(request, options);
    if (new URL(request).pathname === '/api/v1/slice-html' && JSON.parse(options.body).html.includes('product-1')) secondRender.resolve();
    return response;
  };
  const snapshots = [];
  store.putBuffer = async (key, data) => {
    if (!key.endsWith('texts-' + j.id + '.json')) return;
    snapshots.push(JSON.parse(data));
    if (snapshots.length === 1) {
      firstWrite.resolve();
      await release.promise;
    }
  };
  try {
    assert.equal((await jobs.checkAction(j, [2], 'retry')).ok, true);
    assert.equal((await jobs.checkAction(j, [2], 'retry')).status, 409);
    assert.equal((await jobs.checkAction(j, [2], 'remove')).status, 409);
    assert.equal((await jobs.checkAction(j, [3], 'retry')).ok, true);
    await Promise.all([firstWrite.promise, secondRender.promise]);
    assert.equal(snapshots.length, 1);
  } finally {
    release.resolve();
    global.fetch = mockFetch;
  }
  const deadline = Date.now() + 3000;
  let confirmation;
  do {
    confirmation = await jobs.checkAction(j, [2, 3], 'ok', 'fixture', false, reviewed(j.items));
    if (confirmation.ok) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.equal(confirmation.ok, true);
  const bytes = (await jobs.deliver(j)).bytes;
  const wb = await xlsx.load(bytes);
  for (const it of j.items) {
    const actual = wb.sheets[0].rows.get(it.row).get(1);
    assert.equal(actual, 'https://example.test/fixture/' + it.slug + '.jpg');
    assert.equal(it.checkedContentDigest, hash(actual));
    assert.equal(approvals.status(it.slug).hashes.shopee, render(actual).hash);
  }
});

async function serve(t, j) {
  const app = express();
  app.use(express.json());
  app.use(require('../bulk-routes').router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.mock.method(jobs, 'getJob', async () => j);
  return 'http://127.0.0.1:' + server.address().port + '/api/v1/bulk';
}

test('Check API rejects missing, stale and partially matching review evidence even with override', async t => {
  const { j, texts } = await fixture(t);
  await jobs._writeResult(j, texts);
  const base = await serve(t, j);
  const stale = reviewed(j.items);
  const latest = render('new PDP after another tab retried');
  await jobs._commitRender(j, [j.items[1]], latest, []);
  const current = reviewed(j.items);
  const post = body => fetch(base + '/jobs/' + j.id + '/check', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [2, 3], action: 'ok', override: true, ...body }) });
  for (const evidence of [undefined, stale, { 2: current[2] },
    { ...current, 3: { ...current[3], contentDigest: stale[3].contentDigest } }]) {
    const reply = await post({ reviewed: evidence });
    assert.equal(reply.status, 409);
    assert.equal((await reply.json()).code, 'review_changed');
    assert.ok(j.items.every(it => !it.checkedHash));
  }
  assert.equal((await post({ reviewed: current })).status, 200);
  assert.equal(j.items[1].checkedHash, latest.hash);
});

test('build and persisted writers reject SKU collisions, and old incorrect XLSX proofs fail closed', async t => {
  const { j, root, texts } = await fixture(t);
  const base = await serve(t, j);
  const build = (descCol, check) => fetch(base + '/build', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: j.upload, channel: j.channel, sheet: j.sheet, descCol, skus: { 2: 'SKU-ONLY' },
      items: [{ row: 2, register: true, url: 'https://www.lg.com/sg/monitors/test/' }], check }) });
  for (const check of [false, true]) {
    const res = await build(2, check);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'sku_description_conflict');
  }
  const colliding = { ...j, skuCol: '1', skus: [{ row: 2, sku: 'SKU-ONLY' }] };
  await assert.rejects(jobs._writeResult(colliding, texts), /different columns/);
  await assert.rejects(jobs._writeResult({ ...colliding, check: null }, texts), /different columns/);

  j.skuCol = 2;
  j.skus = colliding.skus;
  await jobs._writeResult(j, texts);
  const fp = path.join(root, 'result-' + j.id + '.xlsx');
  const wb = await xlsx.load(fs.readFileSync(fp));
  assert.equal(wb.sheets[0].rows.get(2).get(2), 'SKU-ONLY');
  assert.equal(hash(wb.sheets[0].rows.get(2).get(1)), j.resultRows[2].contentDigest);
  assert.equal((await jobs.checkAction(j, [2, 3], 'ok', '', false, reviewed(j.items))).ok, true);

  // Reproduce old metadata certifying the whole file while a different cell value was written.
  wb.setCell(j.sheet, 2, 1, 'SKU-ONLY');
  const wrong = await wb.save();
  fs.writeFileSync(fp, wrong);
  j.resultDigest = hash(wrong);
  assert.equal((await jobs.deliver(j)).status, 409);
  assert.equal((await jobs.checkAction(j, [2], 'ok', '', true, reviewed(j.items))).status, 409);
});

test('component rejection revokes an otherwise confirmed bundle for API and mail', async t => {
  const { j, texts } = await fixture(t, '1');
  j.items = [{ ...j.items[0], slug: '', bundle: [{ slug: 'alpha' }, { slug: 'beta' }] }];
  await jobs._writeResult(j, texts);
  assert.equal((await jobs.checkAction(j, [2], 'ok', '', false, reviewed(j.items))).ok, true);
  for (const slug of ['alpha', 'beta']) {
    approvals.write(slug, { state: 'approved', hashes: { lazada: render(slug).hash } });
  }
  const base = await serve(t, j);
  const endpoint = base + '/jobs/' + j.id + '/file';
  const request = global.fetch;
  const mail = t.mock.method(global, 'fetch', async url => {
    assert.equal(url, 'https://api.resend.com/emails');
    return new Response(null, { status: 202 });
  });
  const send = async () => {
    await jobs._sendMail(j, 'test@example.test', 'test-placeholder', 'test@example.test');
    return JSON.parse(mail.mock.calls.at(-1).arguments[1].body);
  };
  assert.equal((await request(endpoint)).status, 200);
  assert.equal((await send()).attachments.length, 1);
  approvals.write('beta', { state: 'rejected', comment: 'Synthetic QA rejection' });
  const response = await request(endpoint);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'not_approved');
  assert.equal((await send()).attachments, undefined);
  assert.equal(j.items[0].check, 'ok');
});

test('automatic retry keeps distinct blank-slug bundles in their own XLSX rows', async t => {
  const { j, dir, texts, root } = await fixture(t);
  const titles = ['A and B', 'C and D'];
  const combinations = [['alpha', 'beta'], ['gamma', 'delta']];
  const specKey = 'PD0008:1:abcdef0123456789';
  for (const [index, it] of j.items.entries()) {
    it.slug = '';
    it.url = '';
    it.bundleTitle = titles[index];
    it.bundle = combinations[index].map(slug => ({ slug }));
    it.retrying = 1;
    it.ai = [{ k: 'preview', ok: false, blocked: true }];
    for (const [part, slug] of combinations[index].entries()) {
      const folder = path.join(dir, slug);
      fs.mkdirSync(folder, { recursive: true });
      const source_specs = part === 0 ? [{ source_key: specKey,
        rows: [{ label: 'Width', value: index ? '52 cm' : '42 cm' }] }] : [];
      fs.writeFileSync(path.join(folder, 'qa_report.json'), JSON.stringify({ coverage: { source_ownership: 2, source_specs } }));
    }
  }
  const called = [];
  t.mock.method(require('node:child_process'), 'execFile', (_file, args, _options, done) => {
    if (args[0] === 'ebay_builder.py') {
      const spec = JSON.parse(fs.readFileSync(path.join(args[1], 'spec.json')));
      called.push(spec);
      fs.writeFileSync(path.join(args[1], args[args.indexOf('-o') + 1]), spec.title);
    }
    queueMicrotask(() => done(null, '', ''));
  });
  t.mock.method(require('../slice-preview'), 'ensure', async () => {});
  const expected = titles.map((_, i) => Array.from({ length: i + 1 }, (_, n) => 'https://example.test/bundle-' + i + '-' + n + '.jpg'));
  t.mock.method(global, 'fetch', async (url, request) => {
    assert.equal(new URL(url).pathname, '/api/v1/slice-html');
    const i = titles.indexOf(JSON.parse(request.body).html);
    assert.ok(i >= 0);
    const urls = expected[i];
    return Response.json({ urls, count: urls.length, hash: render(urls.join('\n')).hash, images_loaded: '0/0',
      specTables: [{ part: 1, sourceKeys: [specKey], rows: [['Width', i ? '52 cm' : '42 cm']], regions: [{ slice: 1 }] }] });
  });
  await jobs._kickRetries(j);
  const wb = await xlsx.load(fs.readFileSync(path.join(root, 'result-' + j.id + '.xlsx')));
  for (const [i, it] of j.items.entries()) {
    const urls = expected[i], text = urls.join('\n');
    assert.deepEqual(called.find(spec => spec.title === titles[i]).components.map(part => part.slug), combinations[i]);
    assert.deepEqual(it.imgs, urls);
    assert.equal(it.hash, render(text).hash);
    assert.equal(it.ai.find(x => x.k === 'spec').ok, true);
    assert.equal(it.ai.find(x => x.k === 'n12').used, i + 1);
    assert.equal(wb.sheets[0].rows.get(it.row).get(1), text);
    assert.equal(j.resultRows[it.row].contentDigest, hash(text));
    assert.equal(it.retrying, undefined);
  }
});
