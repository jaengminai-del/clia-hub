const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jobs = require('../bulk-jobs');
const crawler = require('../crawler-routes');
const edits = require('../edits');

test('dropped child and legacy spec evidence never borrow a rendered parent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-review-'));
  const oldDir = crawler.OUT_DIR;
  crawler.OUT_DIR = dir;
  try {
    const product = path.join(dir, 'test');
    fs.mkdirSync(product);
    fs.writeFileSync(path.join(product, 'mirror.json'), JSON.stringify({ sections: [] }));
    const qa = path.join(product, 'qa_report.json');
    const parent = [{ slice: 1, y: 0.2, h: 0.3 }];
    const c = { urls: ['export'], sections: { ST0001: parent, 'ST0001:0:parent': parent }, specTables: [] };
    const item = { slug: 'test', status: 'ok' };
    const check = () => Object.fromEntries(jobs.aiChecks({ channel: 'lazada' }, item, c).map(x => [x.k, x]));
    fs.writeFileSync(qa, JSON.stringify({ coverage: { source_ownership: 2, source_specs: [], missing_images: [
      { component_id: 'ST0001', source_key: 'ST0001:1:child', section: 'ST0001', image: 'https://example.test/child.jpg' }
    ] } }));
    assert.deepEqual(check().img.issues[0].regions, []);
    fs.writeFileSync(qa, JSON.stringify({ coverage: { missing_texts: [{ component_id: 'PD0008', text: 'Screen width' }] } }));
    const { spec, txt } = check();
    assert.equal(spec.ok, false);
    assert.deepEqual(spec.issues, [{ lines: ['Screen width'], regions: [] }]);
    assert.equal(txt.ok, true);
    assert.deepEqual(jobs._fixPlan(item, [spec]), { crawl: true, draw: false });
    fs.writeFileSync(qa, JSON.stringify({ coverage: {} }));
    assert.equal(check().spec.unknown, true);
    assert.equal(check().spec.ok, false);
  } finally {
    crawler.OUT_DIR = oldDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Excel membership, locations and approval use one retained PDP, also for saved edits', async t => {
  const oldFetch = global.fetch, oldEdit = edits.getEdit, oldDir = crawler.OUT_DIR;
  const listing = require('../listing-routes'), oldCurrent = listing.currentFor;
  const xlsx = require('../bulk-xlsx'), JSZip = require('jszip');
  const approvals = require('../approvals'), originalWrite = approvals.write, originalGetJob = jobs.getJob;
  const app = require('express')();
  app.use(require('../bulk-routes').router);
  let activeJob, stampedHash;
  const server = app.listen(0, '127.0.0.1');
  await require('node:events').once(server, 'listening');
  jobs.getJob = async () => activeJob;
  approvals.write = (_slug, doc) => { stampedHash = doc.hashes.shopee; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-membership-'));
  const url = 'https://www.lg.com/sg/test/';
  const slug = crawler.slugify(url), product = path.join(dir, slug);
  const source_key = 'PD0008:1:abcdef0123456789';
  const rows = [{ label: 'Screen width', value: '42 cm' }];
  const raw = '<div class="lg-container"><section class="lg-gallery">gallery</section><section>PDP detail</section></div>';
  const saved = raw.replace('PDP detail', 'Saved PDP detail');
  const calls = [];
  let edit, lengths, removedGallery, remainingDetailSlice, sections, specTables;

  try {
    crawler.OUT_DIR = dir;
    fs.mkdirSync(product);
    fs.writeFileSync(path.join(product, 'mirror.json'), JSON.stringify({ sections: [{ specs: rows }] }));
    fs.writeFileSync(path.join(product, 'qa_report.json'), JSON.stringify({ coverage: {
      source_ownership: 2, source_specs: [{ source_key, component_id: 'PD0008', rows }],
    } }));
    edits.getEdit = () => edit && { html: saved };
    listing.currentFor = async () => null;
    global.fetch = async (target, init) => {
      const route = new URL(target).pathname, body = JSON.parse(init.body);
      calls.push({ route, body });
      if (route === '/api/ebay-generate') return Response.json({ html: raw });
      if (route !== '/api/v1/slice-html') throw new Error(route);
      const first = body.review && removedGallery ? 2 : 1;
      const urls = Array.from({ length: remainingDetailSlice + 2 - first }, (_, i) =>
        `https://example.test/slices/${body.review ? 'pdp' : 'classic'}/${'x'.repeat(lengths)}/${i + first}.jpg`);
      return Response.json({ html: urls.join('\n'), hash: body.review ? 'authoritative' : 'classic',
        count: urls.length, urls, images_loaded: '0/0', sections, specTables });
    };
    const initial = new JSZip();
    initial.file('xl/workbook.xml', '<workbook><sheets><sheet name="Test" r:id="rId1"/></sheets></workbook>');
    initial.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    initial.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>Original</t></is></c></row></sheetData></worksheet>');
    const bytes = await initial.generateAsync({ type: 'nodebuffer' });
    const cases = [
      { title: 'original spec 13 becomes actual Excel spec 12 with gallery removed', spec: 12, long: 0, filtered: true, ok: true },
      { title: 'authoritative spec 13 is outside the actual 12', spec: 13, long: 0, filtered: false, ok: false },
      { title: 'table split across retained and omitted slices', spec: 13, partial: true, long: 0, filtered: false, ok: false },
      { title: '3000-character cutoff after filtering leaves authoritative spec 12 out', spec: 12, long: 270, filtered: true, ok: false },
    ];
    for (edit of [false, true]) {
      for (const scenario of cases) {
        await t.test(`${edit ? 'saved' : 'generated'}: ${scenario.title}`, async () => {
          calls.length = 0;
          lengths = scenario.long;
          removedGallery = scenario.filtered;
          remainingDetailSlice = scenario.spec;
          const region = [{ slice: scenario.spec, y: 0.1, h: 0.5 }];
          if (scenario.partial) region.unshift({ slice: 12, y: 0.8, h: 0.2 });
          sections = edit ? {} : { [source_key]: region };
          specTables = [{ sourceKeys: edit ? [] : [source_key], rows: [['Screen width', '42 cm']], regions: region }];
          const c = await jobs._contentFor('shopee', url, { check: true });
          assert.equal(c.unified, true);
          assert.equal(c.hash, 'authoritative');
          assert.deepEqual(c.text.split('\n'), c.urls);
          assert.equal(c.urls.length, scenario.long ? 9 : 12);
          assert.equal(calls.filter(x => x.route.endsWith('/slice-html')).length, 1);
          assert.equal(calls.at(-1).body.review, true);
          assert.equal(calls.at(-1).body.html, edit ? saved : raw);
          const item = { slug, row: 2, status: 'ok', unified: true, imgs: c.urls, hash: c.hash,
            contentDigest: createHash('sha256').update(c.text).digest('hex') };
          item.ai = jobs.aiChecks({ channel: 'shopee' }, item, c);
          const spec = item.ai.find(a => a.k === 'spec');
          assert.equal(spec.ok, scenario.ok);
          assert.equal(item.ai.every(a => a.ok), scenario.ok);
          assert.equal(jobs.exportBlocked(item), !scenario.ok);
          if (!scenario.ok) assert.deepEqual(spec.issues[0].regions, scenario.partial && !edit ? [region[0]] : []);
          const id = require('node:crypto').randomBytes(8).toString('hex');
          const folder = path.join(jobs.DIR, id);
          try {
            await jobs.saveUpload(id, bytes, {});
            const j = { id, upload: id, status: 'ready', channel: 'shopee', sheet: 'xl/worksheets/sheet1.xml',
              descCol: 1, check: {}, items: [item] };
            await jobs._writeResult(j, new Map([[2, c.text]]));
            const wb = await xlsx.load(fs.readFileSync(path.join(folder, `result-${id}.xlsx`)));
            assert.equal(wb.sheets[0].rows.get(2).get(1), scenario.ok ? c.text : 'Original');
            const view = jobs.jobView(j);
            assert.equal(view.file, null);
            assert.deepEqual(view.items[0].imgs, c.urls);
            activeJob = j;
            stampedHash = undefined;
            if (scenario.ok) {
              assert.equal((await jobs.checkAction(j, [2], 'ok', '', false, { 2: item })).ok, true);
              assert.equal(stampedHash, c.hash);
              assert.ok(jobs.jobView(j).file);
            } else {
              assert.equal((await jobs.checkAction(j, [2], 'ok', '', true)).status, 409);
              assert.notEqual(item.check, 'ok');
              assert.equal(stampedHash, undefined);
              const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/bulk/jobs/${id}/file`;
              const response = await oldFetch(endpoint);
              assert.equal(response.status, 409);
              assert.equal((await response.json()).code, 'pdp_export_blocked');
            }
          } finally {
            fs.rmSync(folder, { recursive: true, force: true });
            fs.rmSync(path.join(jobs.DIR, 'jobs', id + '.json'), { force: true });
          }
        });
      }
    }
    const prior = {
      urls: Array.from({ length: 12 }, (_, i) => `export-${i + 1}`),
      allImages: 13, review: { urls: Array.from({ length: 12 }, (_, i) => `preview-${i + 1}`),
        specSections: { [source_key]: [{ slice: 12 }] } },
    };
    const stale = { slug, row: 2, status: 'ok', check: 'ok', imgs: prior.urls };
    stale.ai = jobs.aiChecks({ channel: 'shopee' }, stale, prior);
    assert.equal(stale.ai.find(a => a.k === 'spec').ok, false);
    const oldJob = { id: 'test', status: 'ready', check: {}, items: [stale] };
    assert.equal(jobs.jobView(oldJob).check.confirmed, 0);
    assert.equal(jobs.jobView(oldJob).file, null);
    assert.equal((await jobs.checkAction(oldJob, [2], 'ok', '', true)).status, 409);

    edit = false;
    lengths = 0;
    removedGallery = true;
    remainingDetailSlice = 12;
    calls.length = 0;
    const classic = await jobs._contentFor('lazada', url);
    assert.equal(classic.hash, 'classic');
    assert.equal(classic.text.includes('/classic/'), true);
    assert.equal(calls[0].body.listing, true);
    assert.equal(calls[0].body.reviewMap, undefined);
    assert.equal(calls[1].body.review, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    approvals.write = originalWrite;
    jobs.getJob = originalGetJob;
    global.fetch = oldFetch;
    edits.getEdit = oldEdit;
    crawler.OUT_DIR = oldDir;
    listing.currentFor = oldCurrent;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
