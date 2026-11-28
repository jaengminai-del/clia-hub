// lg.com 화면에 기능 섹션이 없는 제품 숨기기 (lg-visibility.js) — 다 숨겨 빈 PDP 가 되지 않게 (2026-11-28)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lgVis = require('../lg-visibility');

const media = (n) => Array.from({ length: n }, (_, i) => ({ pc_url: `https://www.lg.com/x/feature-${i}.jpg` }));
const boxes = { items: [] };   // lg.com 캡처에 그 이미지가 하나도 안 보임
const write = (dir, sections) => fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ sections }));
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'mirror.json'), 'utf8'));

test('feature sections only in page data are hidden, but never all of a PDP', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgvis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 스펙이 남는 제품: 기능 섹션을 숨기고 스펙만
  write(dir, [{ component_id: 'AEM:feature', media: media(4) }, { component_id: 'PD0008', specs: [{ label: 'a', value: 'b' }] }]);
  assert.equal(lgVis.applyTo(dir, boxes).kept, 1);
  assert.deepEqual(read(dir).sections.map((s) => s.component_id), ['PD0008']);
  // 다 기능 섹션뿐인 제품(운영 T2310NBTB): 숨기지 않는다
  write(dir, [{ component_id: 'AEM:a', media: media(2) }, { component_id: 'AEM:b', media: media(3) }]);
  assert.equal(lgVis.applyTo(dir, boxes), null);
  assert.equal(read(dir).sections.length, 2);
});

test('a PDP emptied by the old rule is restored, a partly hidden one is left alone', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgvis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hidden = [{ component_id: 'AEM:a', order: 1 }, { component_id: 'AEM:b', order: 2 }];
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ sections: [], _lg_hidden: { sections: hidden } }));
  assert.equal(lgVis.heal(dir), true);
  assert.deepEqual(read(dir).sections.map((s) => s.component_id), ['AEM:a', 'AEM:b']);
  assert.equal(read(dir)._lg_hidden, undefined);
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ sections: [{ component_id: 'PD0008' }], _lg_hidden: { sections: hidden } }));
  assert.equal(lgVis.heal(dir), false);
  assert.equal(read(dir).sections.length, 1);
});
