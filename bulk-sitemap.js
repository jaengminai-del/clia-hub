/**
 * bulk-sitemap.js — 모델명으로 같은 나라 LG.com 제품 주소 찾기 (2026-11-19)
 *
 * 벌크 엑셀에서 CLIA 에 없는 상품을 일괄 등록할 때 쓴다. LG.com 이 나라별로 공개하는 sitemap.xml
 * (https://www.lg.com/<site>/sitemap.xml — th·my·sg·ph·vn·id·uk·de … 확인) 에서 주소 끝(모델명)이 같은 것을 고른다.
 * 태국 실측: 지난 배치의 실제 제품 주소 540개 중 535개가 사이트맵에 있음, 모델명으로 532개 찾음.
 * 같은 제품이 여러 카테고리 주소에 있으면(약 11%) 가장 최근에 바뀐 주소를 고르고 나머지 개수를 알려 준다.
 *
 *   lookup(site, keys) → { url, alts } | null      keys = 엑셀 SKU·상품명에서 뽑은 모델 키 (bulk-catalog skuKeys)
 * 사이트맵은 12시간 캐시 (메모리 + media-cache/sitemaps). 직접 받기가 막히면 Firecrawl 로 한 번 더.
 */
const fs = require('fs');
const path = require('path');
const { norm } = require('./bulk-catalog');

const DIR = path.join(__dirname, 'media-cache', 'sitemaps');
const TTL = 12 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const siteOk = (s) => /^[a-z]{2}(_[a-z]{2})?$/.test(String(s || ''));
const cache = new Map();   // site → { at, idx: Map<key, [{url, lastmod}]>, count } | Promise

async function getText(url, directOnly) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    if (r.ok && /<(urlset|sitemapindex)\b/.test(t)) return t;
  } catch (_) {}
  // 서버 위치에 따라 LG.com 이 봇 요청을 막을 때 — 크롤과 같은 Firecrawl 로 받는다
  if (directOnly) return '';
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return '';
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false }), signal: AbortSignal.timeout(120000) });
    const j = await r.json().catch(() => ({}));
    const t = (j.data && (j.data.rawHtml || j.data.html)) || '';
    return /<(urlset|sitemapindex)\b/.test(t) ? t : '';
  } catch (_) { return ''; }
}

const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function build(site, directOnly) {
  const file = path.join(DIR, `${site}.xml`);
  let xml = '';
  try { if (Date.now() - fs.statSync(file).mtimeMs < TTL) xml = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (!xml) {
    xml = await getText(`https://www.lg.com/${site}/sitemap.xml`, directOnly);
    // 사이트맵 목록(sitemapindex)이면 하위 사이트맵을 이어 붙인다 (최대 30개)
    const subs = /<sitemapindex\b/.test(xml) ? [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => unesc(m[1])).slice(0, 30) : [];
    for (const u of subs) {
      if (directOnly && !/^https:\/\/www\.lg\.com\//.test(u)) continue;
      xml += await getText(u, directOnly);
    }
    if (!xml) throw new Error(`LG.com sitemap not available for ${site}`);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, xml);
  }
  const idx = new Map();
  let count = 0;
  for (const m of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g)) {
    const url = unesc(m[1]).trim();
    let segs;
    try { const u = new URL(url); if (!/(^|\.)lg\.com$/.test(u.hostname)) continue; segs = u.pathname.split('/').filter(Boolean); } catch (_) { continue; }
    if (segs[0] !== site || segs.length < 3) continue;       // 같은 나라, 카테고리/…/모델
    const key = norm(segs[segs.length - 1].replace(/\.html?$/i, ''));
    if (key.length < 4 || !/\d/.test(key) || !/[A-Z]/.test(key)) continue;   // 모델명처럼 생긴 것만
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ url, lastmod: m[2] || '' });
    count++;
  }
  return { at: Date.now(), idx, count };
}

async function index(site, { directOnly = false } = {}) {
  if (!siteOk(site)) throw new Error('bad site');
  const cacheKey = directOnly ? `${site}:direct` : site;
  const c = cache.get(cacheKey);
  if (c && !(c instanceof Promise) && Date.now() - c.at < TTL) return c;
  if (c instanceof Promise) return c;
  const p = build(site, directOnly).then((v) => { cache.set(cacheKey, v); return v; }).catch((e) => { cache.delete(cacheKey); throw e; });
  cache.set(cacheKey, p);
  return p;
}

// 모델 키 → 주소. 정확히 같은 키 → 사이트맵 쪽에 접미사가 붙은 키(WT1410NHWW → wt1410nhww-b422) → 엑셀 쪽에 붙은 키
function pick(list, fuzzy) {
  const uniq = [...new Map(list.map((x) => [x.url, x])).values()];
  uniq.sort((a, b) => String(b.lastmod).localeCompare(String(a.lastmod)) || a.url.length - b.url.length);
  return { url: uniq[0].url, alts: uniq.length - 1, fuzzy: !!fuzzy };   // fuzzy: 모델명이 글자 그대로 같지 않음 → 화면에서 확인 필요
}
async function lookup(site, keys) {
  const { idx } = await index(site);
  for (const k of keys) if (idx.has(k)) return pick(idx.get(k));
  for (const k of keys) {
    if (k.length < 6) continue;
    const hits = [];
    for (const [sk, list] of idx) {
      if ((sk.startsWith(k) && sk.length - k.length <= 5) || (k.startsWith(sk) && sk.length >= 6 && k.length - sk.length <= 4)) hits.push(...list);
    }
    if (hits.length) return pick(hits, true);
  }
  return null;
}

module.exports = { lookup, index, siteOk };
