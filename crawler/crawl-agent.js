/**
 * crawl-agent.js — 크롤 에이전트 v0: LG PDP → Product Content Graph(PCG)
 *
 * 파이프라인:
 *   Firecrawl scrape(markdown+html)
 *     → markdown 문서순서 파싱 (이미지 → eyebrow → 헤드라인 → 본문 → 면책)
 *     → PDP 스코프 필터 (GNB/프로모/추천상품 제거)
 *     → html에서 비디오 수집, 섹션에 폴더 매칭으로 부착
 *     → PCG JSON 출력 (모든 텍스트는 원문 그대로 / verbatim)
 *
 * 사용법:
 *   node crawler/crawl-agent.js <PDP_URL>            # Firecrawl 호출
 *   node crawler/crawl-agent.js <PDP_URL> --cache    # out/<slug>.compare.json 재사용 (API 비용 0)
 *
 * 출력: crawler/out/<slug>.pcg.json
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;

const slugify = url => url.replace(/https?:\/\//, '').replace(/[^\w]+/g, '-').replace(/-+$/, '');

/* ────────────────────────────────────────────────
   1. Firecrawl scrape (compare-firecrawl.js와 동일 설정)
──────────────────────────────────────────────── */
async function firecrawlScrape(url) {
  const actions = [{ type: 'wait', milliseconds: 3000 }];
  for (let i = 0; i < 10; i++) {
    actions.push({ type: 'scroll', direction: 'down' });
    actions.push({ type: 'wait', milliseconds: 600 });
  }
  actions.push({ type: 'executeJavascript', script: 'window.scrollTo(0, 0);' });
  actions.push({ type: 'wait', milliseconds: 2000 });

  console.log('→ Firecrawl scrape...');
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url, formats: ['markdown', 'html'], onlyMainContent: false,
      waitFor: 5000, timeout: 120000, actions,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(`Firecrawl 실패: ${JSON.stringify(json.error || json).slice(0, 200)}`);
  return json.data;
}

/* ────────────────────────────────────────────────
   2. 스코프/노이즈 필터 규칙
──────────────────────────────────────────────── */
// 사이트 공통 자산 (PDP 내용 아님) — -icon-: 탭 버튼 아이콘(off/on 상태쌍)
const JUNK_URL = /gnb|promotion|promo|deals|installment|home-page|\/banner|membership|superbrand|microsite|\/logo|favicon|\.svg|[-_]icon[-_]/i;
// 추천상품 썸네일 renditions
const RECO_URL = /renditions\/thum-(165x165|350x350)/i;
// 제품 갤러리 이미지 (feature 섹션이 아니라 product.gallery로 분리)
const GALLERY_URL = /\/gallery\//i;
// 크롬(내비/추천) 섹션 헤딩 — 이 헤딩 구간은 수집 제외 (다음 일반 헤딩에서 재개)
const CHROME_HEADING = /^(AI recommend|Quick Links|LGs Pick|Popularity ranking|Recommended|Recently Viewed|You may also like|What people are saying|Compare|Where to buy|Find a store|Related)/i;
// 하드 스탑 헤딩 — 여기부터는 스펙/리뷰/푸터 영역이므로 수집 완전 종료
const STOP_HEADING = /^(Summary|Dimensions|All Specs?\b|Specs?$|Key Spec|PRODUCT (FEATURES|SPECIFICATIONS)|Rating|Overall Rating|Review|Average Customer|Customer Images|Filter Reviews|Pros$|Cons$|Our picks|Need help|Contact|Find locally|Support|Warranty|FAQ|Product Support)/i;
// 면책 문구 패턴 (본문에서 분리)
const DISCLAIMER = /^\\?\*/;

/* ────────────────────────────────────────────────
   3. markdown → 문서순서 토큰 → 섹션 빌드
──────────────────────────────────────────────── */
function parseMarkdownToSections(md, pageUrl) {
  // 라인 단위 토큰화
  const lines = md.split('\n');
  const tokens = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) { tokens.push({ t: 'img', alt: img[1].trim(), url: img[2].trim() }); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { tokens.push({ t: 'h', level: h[1].length, text: h[2].trim() }); continue; }
    // 이미지가 문장 중간에 섞인 라인 → 이미지만 추출하고 텍스트도 유지
    const inlineImgs = [...line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
    if (inlineImgs.length) {
      inlineImgs.forEach(m => tokens.push({ t: 'img', alt: m[1].trim(), url: m[2].trim() }));
      const rest = line.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim();
      if (rest) tokens.push({ t: 'txt', text: rest });
      continue;
    }
    tokens.push({ t: 'txt', text: line });
  }

  // UI 조각 텍스트 제거
  const UI_NOISE = /^(close|Pause carousel|Play carousel|Watch the Full Movie|Video Play|Video Pause|Previous|Next|_\\{0,2}\*_|\\{0,2}\*|LG\.com utilizes|Learn more|View more|See more|Buy Now|Add to cart|Where to Buy)$/i;

  const sections = [];
  const gallery = [];   // 제품 갤러리 (/gallery/ 경로)
  let cur = null;
  let pendingImgs = []; // 헤딩보다 먼저 나오는 이미지 (LG 패턴: 이미지 → 헤딩)
  let pendingEyebrow = ''; // 이미지와 헤딩 사이의 짧은 라벨 (예: "AI DD™")
  let inChrome = false;
  let stopped = false;
  const overflowImgs = []; // 헤딩 부착 초과분 (미배정 보존)

  const flush = () => { if (cur && (cur.headline || cur.assets.length)) sections.push(cur); cur = null; };

  const okImg = (url) => {
    if (!/^https?:/.test(url)) return false;
    if (JUNK_URL.test(url) || RECO_URL.test(url)) return false;
    return /\/content\/dam\//.test(url) || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url);
  };

  // ── 카드 나열 프리패스 ──────────────────────────────────────
  // (이미지 → 짧은 타이틀) 반복 ≥2 = summary-box/캐러셀 카드 나열
  // (예: "Why LG OLED evo C6?" 6개 key-feature, Awards 뱃지 나열)
  // → 각 이미지에 카드 타이틀을 부여하고 직전 헤딩 섹션에 전부 부착
  const cardTitleOf = new Map();  // img 토큰 idx → 카드 타이틀
  const consumedTxt = new Set();  // 카드 타이틀로 소비된 txt 토큰 idx
  {
    let ci = 0;
    while (ci < tokens.length) {
      const run = [];
      let k = ci;
      while (k < tokens.length) {
        const a = tokens[k];
        if (a.t !== 'img' || !okImg(a.url) || GALLERY_URL.test(a.url)) break;
        // 이미지 다음 실질 토큰이 짧은 타이틀(≤50)인가
        let m = k + 1;
        while (m < tokens.length && tokens[m].t === 'txt' && UI_NOISE.test(tokens[m].text)) m++;
        const b = tokens[m];
        if (!(b && b.t === 'txt' && b.text.length <= 50 && !DISCLAIMER.test(b.text))) break;
        run.push({ img: k, title: m });
        // 다음 이미지까지 부가 텍스트(설명 등) 최대 2개 허용
        let n = m + 1, hops = 0;
        while (n < tokens.length && tokens[n].t === 'txt' && hops < 2) { n++; hops++; }
        k = n;
      }
      if (run.length >= 2) {
        run.forEach(p => { cardTitleOf.set(p.img, tokens[p.title].text); consumedTxt.add(p.title); });
        ci = k;
      } else ci++;
    }
  }

  // ── 이미지 소속 판정 (룩어헤드) ─────────────────────────────
  // LG PDP markdown 패턴 2종:
  //  · 선행형: ![img] → (eyebrow) → ## 헤딩 → 본문        → 이미지는 "다음" 섹션
  //  · 후행형: ## 헤딩 → 본문 → ![img] → 캡션(=alt) → 면책 → 이미지는 "현재" 섹션
  // 구분 신호: 후행형은 이미지 바로 뒤에 alt와 동일한 캡션 텍스트가 따라옴.
  const decideOwner = (idx, alt) => {
    for (let j = idx + 1; j < Math.min(idx + 6, tokens.length); j++) {
      const t = tokens[j];
      if (t.t === 'h') return 'next';                    // 텍스트 없이 헤딩 도달 → 선행형
      if (t.t === 'img') continue;
      // 비디오 컨트롤(Play/Pause)이 이미지 직후 → 미디어 블록 = 현재 섹션 후미
      if (/play video|pause video/i.test(t.text)) return 'current';
      if (UI_NOISE.test(t.text)) continue;
      if (DISCLAIMER.test(t.text)) return 'current';     // 면책은 항상 섹션 후미 → 후행형
      // 첫 실질 텍스트가 alt와 동일/유사 → 캡션 → 후행형
      if (alt && (t.text === alt || t.text.startsWith(alt.slice(0, 30)))) return 'current';
      if (t.text.length <= 40) return 'next';            // 짧은 라벨(eyebrow) → 선행형
      return 'current';                                  // 긴 본문이 이어짐 → 후행형
    }
    return 'next';
  };

  let lastAttachedAlts = []; // 방금 부착한 이미지 alt → 뒤따르는 캡션 라인 스킵용

  for (let i = 0; i < tokens.length; i++) {
    if (stopped) break;
    const tk = tokens[i];

    if (tk.t === 'h') {
      if (STOP_HEADING.test(tk.text)) { flush(); stopped = true; break; }
      if (CHROME_HEADING.test(tk.text) || tk.text.replace(/[^A-Za-z가-힣0-9]/g, '').length < 3) {
        flush(); inChrome = CHROME_HEADING.test(tk.text);
        pendingImgs = []; pendingEyebrow = ''; lastAttachedAlts = [];
        continue;
      }
      inChrome = false;
      flush();
      // 보류 이미지 중 직전 2장만 이 섹션 소속 (버퍼 오염 방지)
      // 초과분은 폐기하지 않고 미배정으로 보존 → 검수에서 확인 가능
      const attach = pendingImgs.slice(-2);
      pendingImgs.slice(0, -2).filter(im => okImg(im.url)).forEach(im =>
        overflowImgs.push({ type: 'image', url: im.url, alt: im.alt, matchedBy: 'unassigned' }));
      cur = {
        headline: tk.text,               // 원문 그대로
        eyebrow: pendingEyebrow || '',   // 원문 그대로
        body: [],
        disclaimers: [],
        assets: attach.map(im => ({ type: 'image', url: im.url, alt: im.alt, matchedBy: 'doc-order' })),
        // 제품 타이틀 섹션 → 후행 이미지 부착 금지 (KV 배너가 흡수되는 오류 방지)
        // 타이틀은 h1+h2로 중복 등장하므로 첫 섹션과 같은 헤드라인도 타이틀로 간주
        isTitle: sections.length === 0 || sections[0].headline === tk.text,
      };
      pendingImgs = []; pendingEyebrow = '';
      lastAttachedAlts = attach.map(im => im.alt).filter(Boolean);
      continue;
    }
    if (inChrome) continue;

    if (tk.t === 'img') {
      if (!okImg(tk.url)) continue;
      if (GALLERY_URL.test(tk.url)) { gallery.push({ type: 'image', url: tk.url, alt: tk.alt }); continue; }
      // 카드 나열 아이템 → 직전 헤딩 섹션에 타이틀과 함께 부착
      if (cardTitleOf.has(i)) {
        const card = { type: 'image', url: tk.url, alt: tk.alt, title: cardTitleOf.get(i), matchedBy: 'card-pair' };
        if (cur) cur.assets.push(card);
        else pendingImgs.push(tk);
        continue;
      }
      if (cur && !cur.isTitle && cur.body.length === 0 && cur.assets.length === 0) {
        // 헤딩 직후 이미지 (본문 시작 전) → 무조건 현재 섹션 소속
        cur.assets.push({ type: 'image', url: tk.url, alt: tk.alt, matchedBy: 'doc-order' });
        if (tk.alt) lastAttachedAlts.push(tk.alt);
        continue;
      }
      const owner = decideOwner(i, tk.alt);
      if (owner === 'current' && cur && !cur.isTitle) {
        cur.assets.push({ type: 'image', url: tk.url, alt: tk.alt, matchedBy: 'doc-order-trailing' });
        if (tk.alt) lastAttachedAlts.push(tk.alt);
      } else {
        pendingImgs.push(tk);
        pendingEyebrow = '';
      }
      continue;
    }

    // 텍스트
    if (consumedTxt.has(i)) continue; // 카드 타이틀로 이미 소비됨
    if (UI_NOISE.test(tk.text)) continue;
    if (DISCLAIMER.test(tk.text)) {
      (cur ? cur.disclaimers : []).push(tk.text.replace(/^\\/, ''));
      continue;
    }
    // 방금 부착한 이미지의 캡션(alt 반복) → 본문 오염 방지 스킵
    if (lastAttachedAlts.some(a => tk.text === a || tk.text.startsWith(a.slice(0, 30)))) continue;
    // 짧은 라벨 + 바로 다음이 헤딩 → 다음 섹션의 eyebrow (예: "IPS 1ms (GtG)" → ## Sharp image)
    // 단, 캐러셀/비디오 컨트롤 등 UI 텍스트는 제외.
    // 직전 토큰도 짧은 텍스트면 탭 타이틀 나열(Multi AI Search/AI Concierge/...) → eyebrow 아님
    const prevTk = tokens[i - 1];
    const prevIsShortTxt = (prevTk && prevTk.t === 'txt' && prevTk.text.length <= 40 && !DISCLAIMER.test(prevTk.text))
      // 탭 아이콘 이미지 직후의 짧은 텍스트 = 탭 타이틀 (eyebrow 아님)
      || (prevTk && prevTk.t === 'img' && /[-_]icon[-_]/i.test(prevTk.url));
    if (tk.text.length <= 40 && tokens[i + 1] && tokens[i + 1].t === 'h' &&
        !STOP_HEADING.test(tokens[i + 1].text) && !CHROME_HEADING.test(tokens[i + 1].text) &&
        !/video|slide|carousel|play|pause|next|prev/i.test(tk.text) &&
        !prevIsShortTxt) {
      pendingEyebrow = tk.text;
      continue;
    }
    if (cur) cur.body.push(tk.text);
  }
  flush();

  // 남은 보류 이미지 + 부착 초과분 → unassigned
  const unassigned = [
    ...overflowImgs,
    ...pendingImgs.filter(im => okImg(im.url))
      .map(im => ({ type: 'image', url: im.url, alt: im.alt, matchedBy: 'unassigned' })),
  ];

  return { sections, gallery, unassigned };
}

/* ────────────────────────────────────────────────
   4. html → 비디오 수집 + 섹션 부착 (DAM 폴더 매칭)
──────────────────────────────────────────────── */
function extractVideos(html) {
  const vids = new Map();
  const add = (u, poster) => {
    if (!u || !/^https?:/.test(u) || !/\.(mp4|webm|mov)(\?|$)/i.test(u)) return;
    const key = u.replace(/[?#].*$/, '');
    if (!vids.has(key)) vids.set(key, { type: 'video', url: u, poster: poster || '', matchedBy: 'dam-folder' });
  };
  for (const m of html.matchAll(/<video[^>]*>([\s\S]*?)<\/video>/gi)) {
    const tag = m[0];
    const poster = (tag.match(/poster=["']([^"']+)["']/i) || [])[1];
    const src = (tag.match(/<video[^>]*\ssrc=["']([^"']+)["']/i) || [])[1];
    add(src, poster);
    for (const s of m[1].matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) add(s[1], poster);
  }
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+\.(?:mp4|webm|mov)[^"']*)["']/gi)) add(m[1]);
  return [...vids.values()];
}

// 자산 URL의 DAM feature 폴더 스템 (…/features/NAME-01-intro-m.jpg → 폴더+파일 앞부분)
const damFolder = u => {
  const m = (u || '').match(/\/content\/dam\/[^?#]*\//);
  return m ? m[0] : '';
};

// 파일명 스템: 확장자·모바일/데스크톱 변형(-m/-d/-gb) 제거
// 예: lg-oled-evo-c6-2026-feature-09-1-multi-ai-search-d.mp4 → …multi-ai-search
const fileStem = u => {
  const base = (u || '').replace(/[?#].*$/, '').split('/').pop() || '';
  return base.replace(/\.\w+$/, '').replace(/-(m|d|gb|gb-d|gb-m)$/i, '').replace(/-(m|d)$/i, '');
};

function attachVideos(sections, videos, unassigned) {
  // 비디오는 이미지와 폴더가 다를 수 있음(/video/ vs /feature/) →
  // ① 파일명 스템 일치 (가장 정확) → ② DAM 폴더 일치 → ③ 미배정
  const seenStems = new Set();
  for (const v of videos) {
    const stem = fileStem(v.url);
    // 같은 비디오의 -m/-d 변형 중복 방지 (스템 기준 1개만)
    if (stem && seenStems.has(stem)) continue;

    let target = stem && sections.find(s =>
      s.assets.some(a => a.type === 'image' && fileStem(a.url) === stem));
    let how = 'file-stem';

    if (!target) {
      const folder = damFolder(v.url);
      target = folder && sections.find(s => s.assets.some(a => damFolder(a.url) === folder));
      how = 'dam-folder';
    }

    if (target) {
      target.assets.push({ ...v, matchedBy: how });
      if (stem) seenStems.add(stem);
    } else {
      unassigned.push({ ...v, matchedBy: 'unassigned' });
    }
  }
}

/* ────────────────────────────────────────────────
   4.5. CSS background-image 보강 주입
   PD0041 카드 캐러셀 등은 <img> 없이 인라인 CSS 배경으로만 이미지를 실어
   Firecrawl markdown에 누락된다. html에서 추출(CSS 이스케이프 \2f→/ 복원)해
   md의 앵커 텍스트 근처에 ![alt](url) 라인으로 주입한다.
──────────────────────────────────────────────── */
function injectCssBackgroundImages(md, html, pageUrl) {
  if (!html) return md;
  const found = [];
  const seen = new Set();
  const re = /background-image\s*:\s*url\(\s*(?:&quot;|['"])?([^)'"&]+?)(?:&quot;|['"])?\s*\)/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1].replace(/\\([0-9a-fA-F]{2,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).trim();
    try {
      if (u.startsWith('//')) u = 'https:' + u;
      else if (u.startsWith('/')) u = new URL(u, pageUrl).href;
    } catch (_) { continue; }
    if (!/\/content\/dam\//.test(u)) continue;
    if (JUNK_URL.test(u) || GALLERY_URL.test(u)) continue;
    const key = u.split(/[?#]/)[0];
    if (seen.has(key)) continue;
    seen.add(key);
    // 앵커: 배경 선언 직전 마크업의 가장 가까운 텍스트 (카드 캡션/헤딩)
    const before = html.slice(Math.max(0, m.index - 3000), m.index).replace(/<[^>]+>/g, '\n');
    const lines = before.split('\n').map(s => s.trim())
      .filter(s => s.length >= 8 && s.length <= 120 && !/[{};=]/.test(s));
    found.push({ url: u, anchor: lines.length ? lines[lines.length - 1] : '' });
  }
  if (!found.length) return md;

  const mdLines = md.split('\n');
  let injected = 0;
  const tail = [];
  for (const f of found) {
    let idx = -1;
    if (f.anchor) {
      const probe = f.anchor.slice(0, 40);
      idx = mdLines.findIndex(l => l.includes(probe));
    }
    const imgLine = `![${(f.anchor || '').replace(/[\[\]]/g, '')}](${f.url})`;
    if (idx >= 0) { mdLines.splice(idx + 1, 0, imgLine); injected++; }
    else tail.push(imgLine);
  }
  if (tail.length) mdLines.push('', ...tail);
  console.log(`→ CSS 배경 이미지 보강: ${found.length}건 (앵커 주입 ${injected}, 말미 보존 ${tail.length})`);
  return mdLines.join('\n');
}

/* ────────────────────────────────────────────────
   5. 모바일/데스크톱 변형 병합 (-m / -d 접미사)
──────────────────────────────────────────────── */
function mergeVariants(assets) {
  const byStem = new Map();
  for (const a of assets) {
    const stem = a.url.replace(/[?#].*$/, '').replace(/-(m|d)(\.\w+)$/i, '$2');
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(a);
  }
  return [...byStem.values()].map(group => {
    const desktop = group.find(a => /-d\.\w+(\?|$)/i.test(a.url));
    const primary = desktop || group[0];
    const variants = group.filter(a => a !== primary).map(a => a.url);
    return variants.length ? { ...primary, variants } : primary;
  });
}

/* ────────────────────────────────────────────────
   6. 렌더링 geometry 수집 (Puppeteer 경량 패스)
   — Firecrawl은 렌더 좌표를 못 주므로 행당 이미지 수 판정용으로 보조 수집
──────────────────────────────────────────────── */
async function collectGeometry(url) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (_) {}
    await new Promise(r => setTimeout(r, 4000));
    // 전체 스크롤 → lazy-load 트리거
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let pos = 0; const step = 500;
        const t = setInterval(() => {
          window.scrollBy(0, step); pos += step;
          if (pos >= document.body.scrollHeight) { clearInterval(t); resolve(); }
        }, 90);
        setTimeout(() => { clearInterval(t); resolve(); }, 10000);
      });
      window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 2000));
    // 모든 <img> 의 렌더 좌표 수집
    return await page.evaluate(() =>
      [...document.querySelectorAll('img')].map(img => {
        const r = img.getBoundingClientRect();
        return {
          src: img.currentSrc || img.src || img.getAttribute('data-src') || '',
          rw: Math.round(r.width),
          rt: Math.round(r.top + window.scrollY),
          rl: Math.round(r.left + window.scrollX),
        };
      }).filter(g => g.src && g.rw > 50)
    );
  } finally {
    await browser.close();
  }
}

// geometry 를 PCG 자산에 병합 + 섹션별 imgsPerRow/layout.type 산출
function mergeGeometry(pcg, geo) {
  const norm = u => (u || '').replace(/[?#].*$/, '');
  const map = new Map();
  geo.forEach(g => { const k = norm(g.src); if (!map.has(k)) map.set(k, g); });

  const lookup = a => {
    const base = norm(a.url);
    let g = map.get(base);
    if (!g) g = map.get(base.replace(/-m(\.\w+)$/i, '-d$1'));   // 모바일↔데스크톱 변형
    if (!g) g = map.get(base.replace(/-d(\.\w+)$/i, '-m$1'));
    if (!g && a.variants) for (const v of a.variants) { g = map.get(norm(v)); if (g) break; }
    return g;
  };

  for (const s of pcg.sections) {
    const geos = [];
    for (const a of s.assets) {
      if (a.type !== 'image') continue;
      const g = lookup(a);
      if (g) { a.geometry = { renderWidth: g.rw, top: g.rt, left: g.rl }; geos.push(g); }
    }
    // 행당 이미지 수: 같은 행(rt 40px 근사) 내 서로 다른 left 개수의 최댓값
    let perRow = 0;
    if (geos.length) {
      const rows = {};
      geos.forEach(g => { const k = Math.round(g.rt / 40); (rows[k] = rows[k] || new Set()).add(g.rl); });
      perRow = Math.max(...Object.values(rows).map(set => set.size));
    }
    s.layout.imgsPerRow = perRow;
    s.layout.type = perRow >= 4 ? 'grid-4'
                  : perRow === 3 ? 'grid-3'
                  : (geos[0] && geos[0].rw >= 1000) ? 'full-width'
                  : s.layout.type;
  }
  return pcg;
}

/* ────────────────────────────────────────────────
   7. 검수 리포트 (validatePCG)
   — 닷컴 원본(markdown)과 PCG 산출물을 기계 대조
──────────────────────────────────────────────── */
function validatePCG(pcg, md) {
  const norm = u => (u || '').replace(/[?#].*$/, '');
  const variantsOf = u => [u, u.replace(/-m(\.\w+)$/i, '-d$1'), u.replace(/-d(\.\w+)$/i, '-m$1')];

  // ① 이미지 커버리지: md에 있는 콘텐츠 이미지가 PCG 어딘가(섹션/갤러리/미배정)에 있는가
  // 대상: LG DAM 콘텐츠 이미지만 (고객 리뷰 사진·외부 위젯 제외)
  const mdImgs = [...new Set(
    [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => norm(m[1]))
      .filter(u => /\/content\/dam\//.test(u) && !JUNK_URL.test(u) && !RECO_URL.test(u))
  )];
  const inPcg = new Set();
  const collect = a => { inPcg.add(norm(a.url)); (a.variants || []).forEach(v => inPcg.add(norm(v))); };
  pcg.sections.forEach(s => s.assets.forEach(collect));
  (pcg.product.gallery || []).forEach(collect);
  (pcg.unassignedAssets || []).forEach(collect);
  const missing = mdImgs.filter(u => !variantsOf(u).some(v => inPcg.has(v)));

  // ② 원문 보존(verbatim): 섹션 헤드라인이 md 원문에 실제로 존재하는가
  const mdNorm = md.replace(/\\/g, '').replace(/\s+/g, ' ');
  const verbatimFails = [];
  pcg.sections.forEach(s => {
    const h = (s.headline || '').replace(/\s+/g, ' ').trim();
    if (h && h.length > 4 && !mdNorm.includes(h)) {
      verbatimFails.push({ id: s.id, field: 'headline', text: h.slice(0, 60) });
    }
  });

  // ③ 구조 플래그
  pcg.review = {
    imageCoverage: {
      inMarkdown: mdImgs.length,
      captured: mdImgs.length - missing.length,
      coveragePct: mdImgs.length ? Math.round((1 - missing.length / mdImgs.length) * 100) : 100,
      missing: missing.slice(0, 30),
    },
    verbatimFails,                                      // 비어있어야 정상 (원문 훼손 0)
    emptySections: pcg.sections                          // 자산·본문 모두 빈약한 섹션
      .filter(s => !s.assets.length && (s.body || '').length < 40)
      .map(s => ({ id: s.id, headline: s.headline.slice(0, 50) })),
    unassignedCount: (pcg.unassignedAssets || []).length,
  };
  return pcg;
}

/* ────────────────────────────────────────────────
   crawlToPCG — 메인 파이프라인 (모듈로도 사용: server.js /api/pcg)
──────────────────────────────────────────────── */
async function crawlToPCG(url, { useCache = false, geometry = true } = {}) {
  if (!url) throw new Error('url required');

  const slug = slugify(url);
  let md, html, metadata = {};

  const cacheJson = path.join(OUT_DIR, `${slug}.compare.json`);
  const cacheHtml = path.join(OUT_DIR, `${slug}.fc.html`);
  const cacheMd   = path.join(OUT_DIR, `${slug}.fc.md`);
  const cacheMeta = path.join(OUT_DIR, `${slug}.fc.meta.json`);
  const cacheGeo  = path.join(OUT_DIR, `${slug}.geo.json`);

  if (useCache && fs.existsSync(cacheMd)) {
    // crawl-agent 자체 캐시 우선
    console.log('→ 캐시 재사용:', path.basename(cacheMd));
    md = fs.readFileSync(cacheMd, 'utf8');
    html = fs.existsSync(cacheHtml) ? fs.readFileSync(cacheHtml, 'utf8') : '';
    metadata = fs.existsSync(cacheMeta) ? JSON.parse(fs.readFileSync(cacheMeta, 'utf8')) : {};
  } else if (useCache && fs.existsSync(cacheJson)) {
    // compare-firecrawl.js 산출물 캐시
    console.log('→ 캐시 재사용:', path.basename(cacheJson));
    const c = JSON.parse(fs.readFileSync(cacheJson, 'utf8'));
    md = c.firecrawl.markdown;
    metadata = c.firecrawl.metadata || {};
    html = fs.existsSync(cacheHtml) ? fs.readFileSync(cacheHtml, 'utf8') : '';
  } else {
    if (!FIRECRAWL_KEY) throw new Error('FIRECRAWL_API_KEY 없음 (.env 확인)');
    const data = await firecrawlScrape(url);
    md = data.markdown || '';
    html = data.html || '';
    metadata = data.metadata || {};
    // 원시 데이터 저장 → 이후 --cache 로 파서 반복 개선 (API 비용 0)
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(cacheMd, md);
    if (html) fs.writeFileSync(cacheHtml, html);
    fs.writeFileSync(cacheMeta, JSON.stringify(metadata, null, 2));
  }

  // CSS background-image 보강: PD0041 카드 캐러셀 등은 <img> 없이 인라인 배경으로만
  // 이미지를 실어 Firecrawl markdown에 안 실린다 → html에서 추출해 md에 주입 후 파싱
  md = injectCssBackgroundImages(md, html, url);

  const { sections, gallery, unassigned } = parseMarkdownToSections(md, url);
  const videos = extractVideos(html);
  attachVideos(sections, videos, unassigned);

  // 연속 중복 헤드라인 병합 (제품명이 h1/h2로 두 번 나오는 패턴)
  const deduped = [];
  for (const s of sections) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.headline === s.headline) {
      // 내용이 더 많은 쪽 유지
      prev.body = prev.body.length >= s.body.length ? prev.body : s.body;
      prev.assets.push(...s.assets);
      prev.disclaimers.push(...s.disclaimers);
      continue;
    }
    deduped.push(s);
  }

  // 변형 병합 + 순서 부여 + 본문 합치기
  const pcgSections = deduped.map((s, i) => ({
    id: `sec-${String(i + 1).padStart(2, '0')}`,
    order: i + 1,
    eyebrow: s.eyebrow,
    headline: s.headline,
    body: s.body.join('\n'),
    disclaimers: s.disclaimers,
    layout: { type: s.assets.filter(a => a.type === 'image').length >= 3 ? 'multi-image' : 'single' },
    assets: mergeVariants(s.assets),
  }));

  const pcg = {
    version: '0.1',
    source: { url, crawledAt: new Date().toISOString(), engine: 'firecrawl' },
    product: {
      title: metadata.title || metadata.ogTitle || '',
      description: metadata.description || '',
      model: (url.match(/\/([a-z0-9-]+)\/?$/i) || [])[1] || '',
      gallery: mergeVariants(gallery),
    },
    sections: pcgSections,
    unassignedAssets: mergeVariants(unassigned),
  };

  // ── geometry 병합 (행당 이미지 수 / 렌더 좌표) ─────────────────
  if (geometry) {
    let geo = null;
    if (useCache && fs.existsSync(cacheGeo)) {
      console.log('→ geometry 캐시 재사용');
      geo = JSON.parse(fs.readFileSync(cacheGeo, 'utf8'));
    } else {
      try {
        console.log('→ geometry 수집 (Puppeteer)...');
        geo = await collectGeometry(url);
        fs.writeFileSync(cacheGeo, JSON.stringify(geo));
      } catch (e) {
        console.warn('geometry 수집 실패 (건너뜀):', e.message);
      }
    }
    if (geo) { mergeGeometry(pcg, geo); pcg.source.geometry = true; }
  }

  // ── 검수 리포트 (원본 md ↔ PCG 기계 대조) ─────────────────────
  validatePCG(pcg, md);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${slug}.pcg.json`);
  fs.writeFileSync(outFile, JSON.stringify(pcg, null, 2));
  pcg._outFile = outFile;
  return pcg;
}

module.exports = { crawlToPCG };

/* ── CLI ───────────────────────────────────────── */
if (require.main === module) {
  const url = process.argv[2];
  const useCache = process.argv.includes('--cache');
  const geometry = !process.argv.includes('--no-geo');
  if (!url) { console.error('사용법: node crawler/crawl-agent.js <PDP_URL> [--cache] [--no-geo]'); process.exit(1); }

  crawlToPCG(url, { useCache, geometry }).then(pcg => {
    console.log('\n══════════ PCG 생성 결과 ══════════');
    console.log(`모델: ${pcg.product.model} | 섹션: ${pcg.sections.length}개 | 갤러리: ${pcg.product.gallery.length}장 | 미배정: ${pcg.unassignedAssets.length}개${pcg.source.geometry ? ' | geometry ✓' : ''}`);
    pcg.sections.forEach(s => {
      const imgs = s.assets.filter(a => a.type === 'image').length;
      const vids = s.assets.filter(a => a.type === 'video').length;
      const layoutStr = s.layout.imgsPerRow ? ` [${s.layout.type}/행${s.layout.imgsPerRow}]` : '';
      console.log(`  [${s.id}] ${s.headline.slice(0, 40).padEnd(42)} img:${imgs} vid:${vids}${layoutStr}${s.eyebrow ? ' eyebrow:"' + s.eyebrow.slice(0, 16) + '"' : ''}`);
    });
    console.log(`\n✓ 저장: ${pcg._outFile}`);
  }).catch(e => { console.error('✗', e.message); process.exit(1); });
}
