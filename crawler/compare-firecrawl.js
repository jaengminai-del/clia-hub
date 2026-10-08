/**
 * compare-firecrawl.js — 크롤 에이전트 1단계: Firecrawl vs 기존 Puppeteer 비교
 *
 * 목적:
 *   같은 LG PDP를 ① Firecrawl(scrape + actions)  ② 기존 Puppeteer(/api/analyze)
 *   두 방식으로 수집해 "무엇을 더 잡고 무엇을 놓치는지" 데이터로 비교한다.
 *   → 결과를 보고 Product Content Graph(PCG) 크롤 레이어 아키텍처를 확정.
 *
 * 사용법:
 *   node crawler/compare-firecrawl.js [PDP_URL]
 *   (기본 URL: 32GS75Q-B 게이밍 모니터 — 기존 문제 재현 PDP)
 *
 * 준비:
 *   .env 에 FIRECRAWL_API_KEY=fc-...
 *   Puppeteer 비교까지 하려면 node server.js 실행 중이어야 함 (없으면 FC 단독 리포트)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
const DEFAULT_URL = 'https://www.lg.com/sa_en/monitors/gaming/32gs75q-b/';
const LOCAL_API = 'http://localhost:3001/api/analyze';
const OUT_DIR = path.join(__dirname, 'out');

// ─────────────────────────────────────────────────────────────
// 1. Firecrawl scrape (스크롤 액션으로 lazy-load 트리거 + 풀페이지 스크린샷)
// ─────────────────────────────────────────────────────────────
async function firecrawlScrape(url) {
  // 스크롤을 여러 번 나눠 lazy-load/IntersectionObserver 트리거
  const actions = [{ type: 'wait', milliseconds: 3000 }];
  for (let i = 0; i < 10; i++) {
    actions.push({ type: 'scroll', direction: 'down' });
    actions.push({ type: 'wait', milliseconds: 600 });
  }
  actions.push({ type: 'executeJavascript', script: 'window.scrollTo(0, 0);' });
  actions.push({ type: 'wait', milliseconds: 2000 });

  const body = {
    url,
    formats: ['markdown', 'html', 'links', 'screenshot@fullPage'],
    onlyMainContent: false,
    waitFor: 5000,
    timeout: 120000,
    actions,
  };

  console.log('→ Firecrawl scrape 요청 중... (1~2분 소요될 수 있음)');
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(`Firecrawl 실패 (HTTP ${res.status}): ${JSON.stringify(json.error || json).slice(0, 300)}`);
  }
  return json.data; // { markdown, html, links, screenshot, metadata }
}

// ─────────────────────────────────────────────────────────────
// 2. HTML → 미디어 URL 추출 (img/srcset/source/video/poster/bg-image)
// ─────────────────────────────────────────────────────────────
const SKIP_PAT = /icon|logo|sprite|\.svg|1x1|blank|placeholder|spinner|loading|rating|star|favicon|pixel/i;

function extractMediaFromHtml(html, baseUrl) {
  const found = new Map(); // key: URL(쿼리 제거) → { url, via }
  const add = (raw, via) => {
    if (!raw) return;
    let u = raw.trim().replace(/&amp;/g, '&');
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('/')) { try { u = new URL(u, baseUrl).href; } catch (_) { return; } }
    if (!/^https?:\/\//.test(u)) return;
    if (SKIP_PAT.test(u)) return;
    const key = u.replace(/[?#].*$/, '');
    if (!/\.(jpe?g|png|webp|gif|avif|mp4|webm|mov)$/i.test(key) && !key.includes('/content/dam/')) return;
    if (!found.has(key)) found.set(key, { url: u, via });
  };

  // <img src / data-src 계열>
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy']) {
      const v = tag.match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
      if (v) add(v[1], `img@${attr}`);
    }
    const ss = tag.match(/srcset=["']([^"']+)["']/i);
    if (ss) ss[1].split(',').forEach(e => add(e.trim().split(/\s+/)[0], 'img@srcset'));
  }
  // <source srcset/src> (picture, video)
  for (const m of html.matchAll(/<source[^>]+>/gi)) {
    const tag = m[0];
    const ss = tag.match(/(?:srcset|data-srcset)=["']([^"']+)["']/i);
    if (ss) ss[1].split(',').forEach(e => add(e.trim().split(/\s+/)[0], 'source@srcset'));
    const src = tag.match(/src=["']([^"']+)["']/i);
    if (src) add(src[1], 'source@src');
  }
  // <video src / poster>
  for (const m of html.matchAll(/<video[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/src=["']([^"']+)["']/i);
    if (src) add(src[1], 'video@src');
    const poster = tag.match(/poster=["']([^"']+)["']/i);
    if (poster) add(poster[1], 'video@poster');
  }
  // inline style background-image
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/gi)) {
    add(m[2], 'bg-image');
  }
  return [...found.values()];
}

// ─────────────────────────────────────────────────────────────
// 3. 기존 Puppeteer 크롤러 호출 (/api/analyze)
// ─────────────────────────────────────────────────────────────
async function puppeteerAnalyze(url) {
  try {
    const hc = await fetch('http://localhost:3001/api/health', { signal: AbortSignal.timeout(3000) });
    if (!hc.ok) throw 0;
  } catch {
    return null; // 서버 미실행
  }
  console.log('→ 기존 Puppeteer /api/analyze 호출 중...');
  const res = await fetch(LOCAL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`/api/analyze HTTP ${res.status}`);
  return res.json(); // { features }
}

// ─────────────────────────────────────────────────────────────
// 4. 비교 리포트
// ─────────────────────────────────────────────────────────────
const norm = u => (u || '').replace(/[?#].*$/, '');

function report(url, fcData, fcMedia, pptData) {
  const md = fcData.markdown || '';
  const headings = [...md.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 30);

  const fcSet = new Set(fcMedia.map(m => norm(m.url)));
  const fcDam = fcMedia.filter(m => m.url.includes('/content/dam/'));
  const fcVideo = fcMedia.filter(m => /\.(mp4|webm|mov)(\?|$)/i.test(m.url));

  console.log('\n══════════════════════════════════════════════');
  console.log('   FIRECRAWL vs PUPPETEER 크롤 비교 리포트');
  console.log('══════════════════════════════════════════════');
  console.log(`URL: ${url}\n`);

  console.log(`◆ Firecrawl`);
  console.log(`  · markdown 길이: ${md.length.toLocaleString()}자`);
  console.log(`  · 헤딩(#~###): ${headings.length}개`);
  console.log(`  · 미디어 URL: ${fcMedia.length}개 (DAM: ${fcDam.length}, 비디오: ${fcVideo.length})`);
  console.log(`  · 풀페이지 스크린샷: ${fcData.screenshot ? '✓ ' + String(fcData.screenshot).slice(0, 80) + '…' : '✗ 없음'}`);

  let pptImgs = [], pptSet = new Set();
  if (pptData) {
    const feats = pptData.features || [];
    pptImgs = feats.flatMap(f => (f.images || []).map(i => i.url));
    pptSet = new Set(pptImgs.map(norm));
    const withText = feats.filter(f => f.headline && (f.images || []).length).length;
    console.log(`\n◆ Puppeteer (/api/analyze)`);
    console.log(`  · feature 섹션: ${feats.length}개 (이미지+헤드라인 매칭: ${withText}개)`);
    console.log(`  · 이미지 URL: ${pptSet.size}개`);
  } else {
    console.log('\n◆ Puppeteer: 서버 미실행 → 비교 생략 (node server.js 후 재실행)');
  }

  if (pptData) {
    const fcOnly = [...fcSet].filter(u => !pptSet.has(u));
    const pptOnly = [...pptSet].filter(u => !fcSet.has(u));
    const both = [...fcSet].filter(u => pptSet.has(u));
    console.log(`\n◆ 미디어 교차 비교`);
    console.log(`  · 양쪽 모두: ${both.length}개`);
    console.log(`  · Firecrawl만 발견: ${fcOnly.length}개`);
    fcOnly.slice(0, 12).forEach(u => console.log(`      + …${u.slice(-72)}`));
    console.log(`  · Puppeteer만 발견: ${pptOnly.length}개`);
    pptOnly.slice(0, 12).forEach(u => console.log(`      - …${u.slice(-72)}`));
  }

  console.log(`\n◆ Firecrawl markdown 헤딩 샘플 (원문 보존 확인용)`);
  headings.slice(0, 12).forEach(h => console.log(`   ## ${h}`));

  return { url, headings };
}

// ─────────────────────────────────────────────────────────────
async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  if (!FIRECRAWL_KEY || !FIRECRAWL_KEY.startsWith('fc-')) {
    console.error('✗ FIRECRAWL_API_KEY 가 .env 에 없거나 형식이 잘못됨 (fc-... 필요)');
    process.exit(1);
  }

  const [fcData, pptData] = await Promise.all([
    firecrawlScrape(url),
    puppeteerAnalyze(url).catch(e => { console.warn('Puppeteer 비교 실패:', e.message); return null; }),
  ]);

  const fcMedia = extractMediaFromHtml(fcData.html || '', url);
  report(url, fcData, fcMedia, pptData);

  // 전체 결과 저장 (다음 단계 스키마 설계 자료)
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = url.replace(/https?:\/\//, '').replace(/[^\w]+/g, '-').replace(/-+$/, '');
  const outFile = path.join(OUT_DIR, `${slug}.compare.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    url,
    crawledAt: new Date().toISOString(),
    firecrawl: {
      markdown: fcData.markdown,
      media: fcMedia,
      links: fcData.links,
      screenshot: fcData.screenshot,
      metadata: fcData.metadata,
      // html 은 용량이 커서 별도 파일
    },
    puppeteer: pptData,
  }, null, 2));
  if (fcData.html) fs.writeFileSync(outFile.replace('.compare.json', '.fc.html'), fcData.html);
  console.log(`\n✓ 상세 결과 저장: ${outFile}`);
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
