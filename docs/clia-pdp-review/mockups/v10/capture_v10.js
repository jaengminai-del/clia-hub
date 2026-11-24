// 목업 v10 캡처 — PW_CHROMIUM=<chromium> node capture_v10.js [mockup-v10.html] [출력 폴더]
// 이미지(운영 /media/fullshot · /media/slices)는 브라우저가 GET 으로 읽는다. 다른 요청은 보내지 않는다.
const { chromium } = require('playwright');
const path = require('path');
const file = path.resolve(process.argv[2] || 'mockup-v10.html');
const out = path.resolve(process.argv[3] || '.');

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + file);
  const settle = async () => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForFunction(() => [...document.images].every((i) => i.complete) && !document.querySelector('#all .cols .ahint'), null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  const open = async (m, opts = {}) => {
    await page.evaluate(({ m, o }) => {
      document.getElementById('v8note')?.remove();
      openCmp(DATA.findIndex((p) => p.model === m));
      Object.assign(S, o);
      renderCmp();
    }, { m, o: opts });
    await settle();
  };
  const shot = async (name) => { await page.screenshot({ path: path.join(out, name) }); console.log('saved', name); };

  const scrollR = async (frac) => {
    await page.evaluate(async (f) => { const g = areaGeom(); g.R.scrollTop = g.r0 + (g.rmax - g.r0) * f; g.R.dispatchEvent(new Event('scroll')); await new Promise((r) => setTimeout(r, 300)); }, frac);
    await settle();
  };
  await settle();
  await shot('list-v10.png');
  await open('A9-ACE', { view: 'side', ch: 'shopee' }); await shot('compare-v10-side-top.png');
  await scrollR(0.3); await shot('compare-v10-side-sync.png');
  await scrollR(0.8); await shot('compare-v10-side-wait.png');
  await open('A9-ACE', { view: 'side', ch: 'lazada' }); await scrollR(0.2); await shot('compare-v10-side-lazada-sync.png');
  await open('A9-ACE', { view: 'all', mode: 'page', base: 390 }); await shot('compare-v10-all-mobile.png');
  await open('A9-ACE', { view: 'all', mode: 'page', base: 1000 }); await shot('compare-v10-all-pc.png');
  await open('OLED48C6PSA', { view: 'all', mode: 'page', base: 390 }); await shot('compare-v10-all-long.png');
  await open('WT2116SHEG', { view: 'all', mode: 'images' }); await shot('compare-v10-all-images.png');
  await open('GC-X257CMEW', { view: 'side', ch: 'shopee' }); await shot('compare-v10-side-shopee.png');
  await open('45GX950A-B', { view: 'side', ch: 'lazada' }); await shot('compare-v10-side-lazada.png');

  // 비율 검사: 모든 제품, 세 줄 보기(모바일·PC) + 나란히 보기, 화면 비율 vs 원본 비율
  const models = await page.evaluate(() => DATA.map((p) => p.model));
  let checked = 0; const bad = [];
  for (const m of models) {
    for (const o of [{ view: 'side', ch: 'shopee' }, { view: 'side', ch: 'lazada' }]) {
      await open(m, o);
      const r = await page.evaluate(() => {
        const res = [];
        for (const im of document.querySelectorAll('#all .col img, #pO img, #pR img')) {
          if (!im.naturalWidth) continue;
          const b = im.getBoundingClientRect(); if (!b.width) continue;
          const want = im.naturalHeight / im.naturalWidth, got = b.height / b.width;
          res.push(Math.abs(got - want) / want > 0.01 ? `${im.src.split('/').slice(-2).join('/')} 화면 ${b.width.toFixed(1)}x${b.height.toFixed(1)} 원본 ${im.naturalWidth}x${im.naturalHeight}` : '');
        }
        return res;
      });
      checked += r.length; r.filter(Boolean).forEach((x) => bad.push(`${m} ${JSON.stringify(o)} ${x}`));
    }
  }
  console.log('image ratio check: checked', checked, 'distorted', bad.length); bad.slice(0, 20).forEach((b) => console.log('   ', b));
  console.log('page errors:', errors.length); errors.slice(0, 10).forEach((e) => console.log('   ', e));
  await browser.close();
})();
