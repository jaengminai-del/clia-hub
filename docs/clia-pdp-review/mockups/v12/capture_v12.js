// 목업 v12 언어별 캡처 — PW_CHROMIUM=<chromium> node capture_v12.js [mockup-v12.html] [출력 폴더]
// 언어(th · en · ko)마다 리스트 · 갤러리 · 비교 화면. 세 언어 사전에 빠진 문구가 없는지도 검사. 캡처는 1배 JPEG.
const { chromium } = require('playwright');
const path = require('path');
const file = path.resolve(process.argv[2] || 'mockup-v12.html');
const out = path.resolve(process.argv[3] || '.');

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const shot = async (n) => { await page.screenshot({ path: path.join(out, n), type: 'jpeg', quality: 78 }); console.log('saved', n); };
  const imgs = () => page.waitForFunction(() => [...document.images].filter((i) => i.src && i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 60000 }).catch(() => {});

  await page.goto('file://' + file + '?lang=th');
  const keys = await page.evaluate(() => { const k = (l) => Object.keys(TX[l]).sort().join(','); return { same: k('ko') === k('en') && k('en') === k('th'), ko: Object.keys(TX.ko).length, en: Object.keys(TX.en).length, th: Object.keys(TX.th).length }; });
  console.log('dictionary keys ko/en/th:', keys.ko, keys.en, keys.th, keys.same ? 'same set' : 'DIFFERENT SETS');

  for (const lang of ['th', 'en', 'ko']) {
    await page.goto('file://' + file + '?lang=' + lang);
    await page.evaluate(() => document.getElementById('note')?.remove());
    await page.waitForTimeout(400); await imgs(); await shot(`list-v12-${lang}.jpg`);
    await page.evaluate(() => { setView('grid'); }); await page.waitForTimeout(400); await imgs(); await shot(`gallery-v12-${lang}.jpg`);
    await page.evaluate(() => { S.dv = new Set(['HS']); S.grp = new Set(['Fridge']); renderList(); selAll(true); document.getElementById('ddGrp').open = true; });
    await page.waitForTimeout(300); await imgs(); await shot(`gallery-v12-${lang}-filter-select.jpg`);
    await page.evaluate(() => { document.getElementById('ddGrp').open = false; S.sel.clear(); S.dv = new Set(['MS', 'HS', 'ES']); S.grp = null; setView('list'); openCmp(DATA.findIndex((p) => p.model === 'A9-ACE')); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById('sc').scrollTop = G.anchors.s3 - 16; }); await page.waitForTimeout(400); await imgs();
    await shot(`compare-v12-${lang}.jpg`);
    // 넘치는 글: 버튼·배지·탭이 한 줄을 넘어 잘리는지
    const over = await page.evaluate(() => [...document.querySelectorAll('#vCmp .badge, #vCmp .btn, #vCmp .tab, #vCmp .ph')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim().slice(0, 40)));
    if (over.length) console.log(lang, 'overflowing:', over.join(' | '));
  }
  console.log('page errors:', errors.length); errors.slice(0, 5).forEach((e) => console.log('   ', e));
  await browser.close();
})();
