// 목업 v11 검사 + 캡처 — PW_CHROMIUM=<chromium> node check_v11.js [mockup-v11.html] [출력 폴더] [모델...]
// 이미지(운영 /media/fullshot · /media/slices)는 브라우저가 GET 으로 읽는다. 캡처는 가볍게 1배 JPEG.
const { chromium } = require('playwright');
const path = require('path');
const file = path.resolve(process.argv[2] || 'mockup-v11.html');
const out = path.resolve(process.argv[3] || '.');
const only = process.argv.slice(4);

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + file);
  await page.evaluate(() => document.getElementById('note')?.remove());
  const shot = async (name) => { await page.screenshot({ path: path.join(out, name), type: 'jpeg', quality: 78 }); console.log('saved', name); };
  const loaded = () => page.waitForFunction(() => [...document.querySelectorAll('#vCmp img[src]')].every((i) => i.complete), null, { timeout: 60000 }).catch(() => {});
  const scrollTo = async (s) => { await page.evaluate((s) => { document.getElementById('sc').scrollTop = s; }, s); await page.waitForTimeout(120); };

  // ── 목록 · 필터 · 전체 선택 승인 ──
  await page.waitForTimeout(800);
  await shot('list-v11.jpg');
  const f = await page.evaluate(() => {
    const r = {};
    r.all = visible().length;
    S.dv = new Set(['ES']); S.grp = null; renderList(); r.es = visible().map((p) => p.model);
    S.dv = new Set(['HS']); renderList(); r.hs = visible().length;
    S.grp = new Set(['Fridge']); renderList(); r.fridge = visible().map((p) => p.model);
    return r;
  });
  console.log('filter: all', f.all, '| ES', f.es.join(','), '| HS', f.hs, '| HS·Fridge', f.fridge.join(','));
  await page.evaluate(() => { document.getElementById('ddGrp').open = true; });
  await page.waitForTimeout(200); await shot('list-v11-filter.jpg');
  await page.evaluate(() => { document.getElementById('ddGrp').open = false; selAll(true); });
  await page.waitForTimeout(200); await shot('list-v11-select-all.jpg');
  const ba = await page.evaluate(() => { bulkApprove(); return { ok: DATA.filter((p) => p.st === 'ok').map((p) => p.model + ':' + p.via) }; });
  console.log('bulk approve:', ba.ok.join(' '));
  await page.evaluate(() => { DATA.forEach((p) => { p.st = 'unrev'; p.via = ''; }); S.dv = new Set(['MS', 'HS', 'ES']); S.grp = null; renderList(); });

  // ── 비교: 위치 안정 · 동시 스크롤 규칙 · 체크리스트 ──
  const models = only.length ? only : await page.evaluate(() => DATA.map((p) => p.model));
  let ratioChecked = 0; const ratioBad = []; const syncBad = []; const shiftBad = [];
  for (const m of models) {
    for (const ch of ['shopee', 'lazada']) {
      await page.evaluate(({ m, ch }) => { openCmp(DATA.findIndex((p) => p.model === m)); if (ch !== 'shopee') setCh(ch); }, { m, ch });
      await page.waitForTimeout(250);
      const before = await page.evaluate(() => ({ ...G.anchors, _r: G.rmax, _l: G.lmax }));
      // 끝까지 내려 이미지를 모두 읽게 한 뒤 다시 잰다 (자리 미리 잡기 확인)
      const sMax = await page.evaluate(() => G.sMax);
      for (let s = 0; s <= sMax; s += 700) await scrollTo(s);
      await scrollTo(sMax); await loaded();
      const after = await page.evaluate(() => { layout(); return { ...G.anchors, _r: G.rmax, _l: G.lmax }; });
      const moved = Object.keys(before).filter((k) => Math.abs(before[k] - after[k]) > 1);
      if (moved.length) shiftBad.push(`${m} ${ch} ${moved.slice(0, 3).map((k) => `${k} ${before[k]}→${after[k]}`).join(' ')}`);
      // 규칙: r=min(s,rmax), l=min(s*k,lmax)
      const sync = await page.evaluate(async () => {
        const bad = [];
        for (const f of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
          const s = Math.round(G.sMax * f); document.getElementById('sc').scrollTop = s; await new Promise((r) => requestAnimationFrame(() => r()));
          const s2 = document.getElementById('sc').scrollTop;
          const ty = (id) => -new DOMMatrix(getComputedStyle(document.getElementById(id)).transform).m42;
          const r = ty('mvR'), l = ty('mvL'), wr = Math.min(s2, G.rmax), wl = Math.min(s2 * G.k, G.lmax);
          if (Math.abs(r - wr) > 0.6 || Math.abs(l - wl) > 0.6) bad.push(`s=${s2} r ${r.toFixed(1)}/${wr.toFixed(1)} l ${l.toFixed(1)}/${wl.toFixed(1)}`);
        }
        return bad;
      });
      sync.forEach((b) => syncBad.push(`${m} ${ch} ${b}`));
      const rr = await page.evaluate(() => [...document.querySelectorAll('#vCmp img[src]')].filter((i) => i.naturalWidth).map((i) => {
        const b = i.getBoundingClientRect(); const want = i.naturalHeight / i.naturalWidth; return Math.abs(b.height / b.width - want) / want > 0.01 ? i.src.split('/').slice(-2).join('/') : '';
      }));
      ratioChecked += rr.length; rr.filter(Boolean).forEach((x) => ratioBad.push(`${m} ${ch} ${x}`));
    }
    const ck = await page.evaluate(() => { const p = DATA[S.cur], pr = progress(p); return { pr, ok: !document.getElementById('bOk').disabled, why: document.getElementById('bWhy').textContent }; });
    if (!ck.ok) console.log('approve still locked', m, ck.why);
  }
  console.log('anchors moved after images loaded:', shiftBad.length); shiftBad.slice(0, 10).forEach((x) => console.log('   ', x));
  console.log('sync rule mismatches:', syncBad.length); syncBad.slice(0, 10).forEach((x) => console.log('   ', x));
  console.log('image ratio: checked', ratioChecked, 'distorted', ratioBad.length); ratioBad.slice(0, 10).forEach((x) => console.log('   ', x));

  // ── 화면 캡처 ──
  const m0 = 'A9-ACE';
  await page.evaluate((m) => { const p = DATA.find((x) => x.model === m); p.seen.clear(); p.flags.clear(); p.st = 'unrev'; openCmp(p.i); }, m0);
  await page.waitForTimeout(400); await loaded(); await shot('compare-v11-top.jpg');
  await page.evaluate(() => { document.getElementById('sc').scrollTop = G.anchors.s3 - 16; }); await page.waitForTimeout(300); await loaded(); await shot('compare-v11-checklist.jpg');
  await page.evaluate(() => { document.getElementById('sc').scrollTop = G.rmax * 0.8; }); await page.waitForTimeout(300); await loaded(); await shot('compare-v11-wait.jpg');
  await page.evaluate(() => { flag('s5'); }); await page.waitForTimeout(150); await shot('compare-v11-flag.jpg');
  await page.evaluate(() => { flag('s5'); document.getElementById('sc').scrollTop = G.sMax; setCh('lazada'); });
  await page.waitForTimeout(300); await page.evaluate(() => { document.getElementById('sc').scrollTop = G.sMax; }); await page.waitForTimeout(300); await loaded();
  await shot('compare-v11-ready.jpg');
  console.log('page errors:', errors.length); errors.slice(0, 5).forEach((e) => console.log('   ', e));
  await browser.close();
})();
