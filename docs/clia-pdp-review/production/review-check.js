// 검토·승인 화면(/review/) 브라우저 확인 — node review-check.js <서버 주소> <캡처 폴더>
// 목록 · 갤러리 · BU 필터 · 비교(두 채널 끝까지 스크롤 → 승인 → 서버 기록) · 동시 스크롤 규칙 · 범위 맞추기 저장 · 세 언어 넘침 검사
// 승인·범위 저장은 서버에 기록한다 → 운영 주소에는 돌리지 말 것 (로컬 시험 서버용)
const { chromium } = require('playwright');
const path = require('path');
const base = (process.argv[2] || 'http://127.0.0.1:3011').replace(/\/$/, '');
const out = path.resolve(process.argv[3] || '.');
if (/railway\.app|lgecreativehub/i.test(base)) { console.error('운영 주소에는 돌리지 않습니다'); process.exit(1); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  const shot = async (n) => { await page.screenshot({ path: path.join(out, n), type: 'jpeg', quality: 78 }); console.log('saved', n); };
  const imgs = () => page.waitForFunction(() => [...document.images].filter((i) => i.src && i.getBoundingClientRect().top < innerHeight && i.getBoundingClientRect().bottom > 0).every((i) => i.complete), null, { timeout: 30000 }).catch(() => {});
  const fail = [];
  const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail.push(msg); };

  await page.goto(base + '/review/?lang=ko&country=th');
  await page.waitForSelector('#rows tr.r');
  await page.fill('#who', 'Local tester'); await page.dispatchEvent('#who', 'change');
  check(await page.locator('#rows tr.r').count() >= 3, 'list shows products');
  await imgs(); await shot('review-list-ko.jpg');
  await page.click('#viewSeg button[data-v=grid]'); await imgs(); await shot('review-gallery-ko.jpg');
  check(await page.locator('#cards .card').count() >= 3, 'gallery cards');
  await page.evaluate(() => { S.dv = new Set(['HS']); renderList(); });
  check(await page.evaluate(() => visible().every((p) => p.dv === 'HS')), 'BU filter HS');
  await page.evaluate(() => { S.dv = new Set(['MS', 'HS', 'ES']); setView('list'); });

  // 비교: A9-ACE
  await page.evaluate(() => openCmp(DATA.find((p) => p.model === 'A9-ACE').slug));
  await page.waitForFunction(() => C && CHS.every((ch) => C.d[ch]) && G, null, { timeout: 120000 });
  await page.waitForTimeout(300); await imgs(); await shot('review-compare-top-ko.jpg');
  const r = await page.evaluate(() => {
    // 동시 스크롤 규칙: 오른쪽 = min(s, rmax), 왼쪽 = min(s·k, lmax) — 여러 위치에서
    const sc = $('sc'), bad = [];
    for (const f of [0, 0.1, 0.33, 0.5, 0.8, 1]) {
      sc.scrollTop = G.sMax * f; update();
      const s = sc.scrollTop, ty = (e) => -new DOMMatrix(getComputedStyle(e).transform).m42;
      const rr = ty($('mvR')), ll = ty($('mvL'));
      if (Math.abs(rr - Math.min(s, G.rmax)) > 1 || Math.abs(ll - Math.min(s * G.k, G.lmax)) > 1) bad.push(f);
    }
    const im = [...document.querySelectorAll('#mvR img.sl')].filter((e) => e.complete && e.naturalWidth);
    const distorted = im.filter((e) => Math.abs(e.clientHeight / e.clientWidth - e.naturalHeight / e.naturalWidth) > 0.01).length;
    return { bad, distorted, loaded: im.length };
  });
  check(!r.bad.length, `sync scroll rule (${r.bad.length} mismatches)`);
  check(!r.distorted, `slice aspect ratio (${r.distorted} distorted of ${r.loaded} loaded)`);
  check(await page.locator('#bOk').isDisabled(), 'approve locked before checklist');
  // 두 채널 끝까지 천천히 내리기 (스크롤 체크리스트)
  for (const ch of ['shopee', 'lazada']) {
    await page.evaluate((c) => setCh(c), ch); await page.waitForTimeout(200);
    const max = await page.evaluate(() => G.sMax);
    for (let y = 0; y <= max + 900; y += 450) { await page.evaluate((v) => { $('sc').scrollTop = v; }, y); await page.waitForTimeout(25); }
    if (ch === 'shopee') { await page.evaluate(() => { $('sc').scrollTop = G.anchors.s2 - 16; }); await page.waitForTimeout(300); await imgs(); await shot('review-compare-checklist-ko.jpg'); }
  }
  const pr = await page.evaluate(() => progress());
  check(pr.n === pr.all && pr.all > 0, `checklist complete ${pr.n}/${pr.all}`);
  check(!(await page.locator('#bOk').isDisabled()), 'approve enabled after checklist');
  await page.click('#bOk'); await page.waitForTimeout(500);
  const ap = await page.evaluate(async () => (await (await fetch('/api/v1/approvals?slugs=' + C.p.slug)).json()).items[C.p.slug]);
  check(ap.status === 'approved' && ap.by === 'Local tester' && ap.via === 'checklist' && ap.hashes && ap.hashes.shopee, `approval saved on server (${ap.status}, ${JSON.stringify(ap.hashes)})`);
  await shot('review-compare-approved-ko.jpg');

  // 범위 맞추기: 시작 +100 저장 → 서버 값 → 자동으로
  await page.click('#cropBtn'); await page.click('#cropEd button:has-text("+100")'); await page.waitForTimeout(200); await shot('review-crop-ko.jpg');
  const want = await page.evaluate(() => CROP.top);
  await page.click('#cropEd button.pri'); await page.waitForTimeout(500);
  const got = await page.evaluate(async () => (await (await fetch(`/api/v1/review/item/${C.p.slug}?channel=lazada`)).json()).data.shot);
  check(got.top === want && got.manual, `crop saved (${got.top} = ${want}, manual)`);
  await page.evaluate(() => cropAuto()); await page.waitForTimeout(800);
  const back = await page.evaluate(async () => (await (await fetch(`/api/v1/review/item/${C.p.slug}?channel=shopee`)).json()).data.shot);
  check(!back.manual && back.top === want - 100, `crop back to automatic (${back.top})`);

  // 승인 취소 → 다시 미검토
  await page.click('#bUndo'); await page.waitForTimeout(500);
  const un = await page.evaluate(async () => (await (await fetch('/api/v1/approvals?slugs=' + C.p.slug)).json()).items[C.p.slug]);
  check(un.status === 'pending', 'undo approval → pending');

  // 목록에서 전체 선택 → 선택 승인 (일괄)
  await page.evaluate(() => closeCmp()); await page.waitForTimeout(600);
  await page.evaluate(() => { S.q = 'GC-X257'; renderList(); selAll(true); });
  await page.click('#selbar .btn.pri'); await page.waitForTimeout(600);
  const bk = await page.evaluate(async () => { const p = DATA.find((x) => x.model === 'GC-X257CMEW'); return (await (await fetch('/api/v1/approvals?slugs=' + p.slug)).json()).items[p.slug]; });
  check(bk.status === 'approved' && bk.via === 'bulk', `bulk approve saved (${bk.status}/${bk.via})`);
  await page.evaluate(() => { S.q = ''; renderList(); });

  // 세 언어: 사전 키가 같은지 · 넘침
  const keys = await page.evaluate(() => { const k = (l) => Object.keys(TX[l]).sort().join(','); return k('ko') === k('en') && k('en') === k('th'); });
  check(keys, 'dictionary keys same in ko/en/th');
  for (const lang of ['th', 'en', 'ko']) {
    await page.goto(`${base}/review/?lang=${lang}&country=th`); await page.waitForSelector('#rows tr.r'); await imgs();
    await shot(`review-list-${lang}.jpg`);
    await page.evaluate(() => openCmp(DATA.find((p) => p.model === 'OLED48C6PSA').slug));
    await page.waitForFunction(() => C && CHS.every((ch) => C.d[ch]) && G, null, { timeout: 120000 });
    await page.evaluate(() => { $('sc').scrollTop = G.anchors.s3 - 16; }); await page.waitForTimeout(400); await imgs();
    await shot(`review-compare-${lang}.jpg`);
    const over = await page.evaluate(() => [...document.querySelectorAll('#vCmp .badge, #vCmp .btn, #vCmp .tab, #vCmp .ph, .top .btn, .top .sel')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim().slice(0, 40)));
    check(!over.length, `${lang}: no overflowing buttons/badges ${over.join(' | ')}`);
  }
  check(!errors.length, `page errors: ${errors.length} ${errors.slice(0, 3).join(' | ')}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
  process.exit(fail.length ? 1 : 0);
})();
