// 목업 v9 캡처 — node capture_v8.js [mockup-v9.html] [출력 폴더]
// 이미지(lg.com, 운영 /media/slices/)는 브라우저가 GET 으로 읽는다. 다른 요청은 보내지 않는다.
const { chromium } = require('playwright');
const path = require('path');
const file = path.resolve(process.argv[2] || 'mockup-v9.html');
const out = path.resolve(process.argv[3] || '.');

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const failed = [], errors = [];
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + file);

  const settle = async () => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(400);
  };
  const idx = m => page.evaluate(m => DATA.findIndex(p => p.model === m), m);
  const open = async (m, ch) => {
    await page.evaluate(i => openCmp(i), await idx(m));
    if (ch) await page.evaluate(c => setCh(c), ch);
    await page.evaluate(() => { const n = document.getElementById('v8note'); if (n) n.remove(); });
    await settle();
  };
  const shot = async name => { await page.screenshot({ path: path.join(out, name) }); console.log('saved', name); };

  await settle();
  await shot('list-v9.png');
  await open('IHQ18R', 'shopee'); await shot('compare-v9-shopee.png');
  await open('AS10GDBY0', 'lazada'); await shot('compare-v9-lazada-summary.png');
  await open('F2515RNEW', 'shopee');
  await page.evaluate(() => { const o = document.getElementById('pO'), k = o.querySelector('.os[data-k="6"]'); o.scrollTop = k.offsetTop - 20; o.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(600); await settle(); await shot('compare-v9-sync.png');
  await open('OLED83G4PSA', 'shopee'); await shot('compare-v9-no-blocks.png');
  await open('MS2032GAS', 'shopee');
  await page.evaluate(() => lbOpen(1)); await settle(); await shot('compare-v9-zoom.png');
  const summary = await page.evaluate(() => DATA.map(p => ({ m: p.model, st: p.st, block: p.block, slices: p.slices.length })));
  console.log(JSON.stringify(summary));
  console.log('failed requests:', failed.length); failed.slice(0, 20).forEach(u => console.log('  ', u));
  console.log('page errors:', errors.length); errors.slice(0, 20).forEach(e => console.log('  ', e));
  await browser.close();
})();
