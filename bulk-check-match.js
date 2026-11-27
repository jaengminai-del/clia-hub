// Bulk Check only: the workbook decides marketplace status; the public LG
// sitemap and the actual product page corroborate the SKU and exposure.
const { norm, skuKeys, classifyUrl } = require('./bulk-catalog');
const sitemap = require('./bulk-sitemap');
const live = (r, cols) => !cols.status || /^(live|active)$/i.test(String(r.status || '').trim());
const parsed = value => { try { const u = new URL(value); return u.origin === 'https://www.lg.com' && !u.username && !u.password ? u : null; } catch (_) { return null; } };
const keyOf = u => u.pathname.replace(/\/+$/, '').replace(/\.html?$/i, '').toLowerCase();
const entries = html => [...html.matchAll(/<(meta|link)\b[^>]*>/gi)].map(([tag, type]) => [type.toLowerCase(), Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(([, k, a, b, c]) => [k.toLowerCase(), a ?? b ?? c]))]);
const hidden = v => /\b(?:noindex|none)\b/i.test(v || '');
function pagePublic(html, u, robots) {
  if (hidden(robots)) return false;
  const tags = entries(html);
  if (tags.some(([t, a]) => t === 'meta' && /^(robots|googlebot|bingbot)$/i.test(a.name || '') && hidden(a.content))) return false;
  const canonical = parsed(tags.find(([t, a]) => t === 'link' && /\bcanonical\b/i.test(a.rel || ''))?.[1].href);
  return !!canonical && keyOf(canonical) === keyOf(u) && /"@type"\s*:\s*(?:"Product"|\[[^\]]*"Product")/i.test(html);
}
// One light request per distinct sitemap URL, shared across uploads and builds.
// A denied/timed-out page is unverified, never taken as public or retried with paid crawling.
const cache = new Map();
let active = 0;
const queue = [];
function pump() {
  while (active < 8 && queue.length) {
    const { url, resolve } = queue.shift(); active++;
    verifyPage(url).then(resolve, () => resolve(false)).finally(() => { active--; pump(); });
  }
}
async function verifyPage(u) {
  const res = await fetch(u.href, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(6500) });
  if (res.status !== 200 || !/text\/html/i.test(res.headers.get('content-type') || '') || hidden(res.headers.get('x-robots-tag'))) {
    await res.body?.cancel(); return false;
  }
  const reader = res.body?.getReader();
  if (!reader) return false;
  const decode = new TextDecoder(); let text = '', bytes = 0;
  try {
    while (bytes < 384 * 1024) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length;
      text += decode.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(text)) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const end = text.search(/<\/head\s*>/i);
  return end >= 0 && pagePublic(text.slice(0, end), u);
}
function publicPage(value) {
  const u = parsed(value); if (!u) return Promise.resolve(false);
  u.search = ''; u.hash = '';
  const k = u.href, old = cache.get(k);
  if (old && old.until > Date.now()) return old.promise;
  if (cache.size >= 3000) for (const [key, x] of cache) { if (x.until <= Date.now()) cache.delete(key); }
  const entry = { until: Infinity };
  entry.promise = new Promise(resolve => { queue.push({ url: u, resolve }); pump(); })
    .then(ok => { entry.until = Date.now() + (ok ? 5 * 60 * 1000 : 30 * 1000); return ok; });
  cache.set(k, entry); return entry.promise;
}
const tokenKeys = name => [...new Set(String(name || '').toUpperCase().split(/[^A-Z0-9.\-]+/).flatMap(s => skuKeys(s)).filter(k => /[A-Z]/.test(k) && /\d/.test(k)))];
const rowKeys = (r) => r.bundle
  ? String([r.parentSku, r.sku].find(x => /[+&]/.test(x)) || '').split(/[+&]/).map(s => skuKeys(s))
  : [r.parentSku || r.sku ? skuKeys(r.parentSku || r.sku) : tokenKeys(r.name)];
async function select(out, country, idx, probe = publicPage) {
  const cc = String(country || '').toLowerCase();
  const by = out.cols.status ? 'status' : 'match';
  const eligible = out.rows.filter(r => live(r, out.cols));
  if (!eligible.length) return { by, hits: new Map() };
  const own = Object.values(idx.products).filter(p => p.country === cc);
  const sites = [...new Set([cc, ...own.map(p => parsed(p.url)?.pathname.split('/')[1])].filter(s => sitemap.siteOk(s) && s.slice(0, 2) === cc))];
  const indices = await Promise.all(sites.map(async site => {
    try { return { site, ...(await sitemap.index(site, { directOnly: true })) }; } catch (_) { return null; }
  }));
  const ownByPath = new Map(own.flatMap(p => { const u = parsed(p.url); return u ? [[keyOf(u), p]] : []; }));
  const resolve = async keys => {
    const exact = keys.filter(key => indices.some(i => i?.idx.has(key)));
    // Don't guess the model when different exact models can explain this row.
    if (exact.length !== 1) return null;
    const key = exact[0], paths = new Map();
    for (const index of indices.filter(Boolean)) {
      for (const entry of index.idx.get(key) || []) {
        const u = parsed(entry.url);
        if (!u || u.pathname.split('/')[1] !== index.site || norm(u.pathname.split('/').filter(Boolean).at(-1).replace(/\.html?$/i, '')) !== key) continue;
        paths.set(keyOf(u), { ...entry, url: u.href, local: ownByPath.get(keyOf(u)) });
      }
    }
    const ranked = [...paths.values()].sort((a, b) => Number(!!b.local) - Number(!!a.local) || String(b.lastmod).localeCompare(String(a.lastmod)) || a.url.localeCompare(b.url));
    for (const p of ranked) if (await probe(p.url)) return p.local || { ...classifyUrl(p.url), register: true };
    return null;
  };
  const pending = new Map();
  const match = keys => { const k = JSON.stringify(keys); if (!pending.has(k)) pending.set(k, resolve(keys)); return pending.get(k); };
  const hits = new Map();
  await Promise.all(eligible.map(async r => {
    const keys = rowKeys(r);
    if (!keys.length || keys.length > 6 || (r.bundle && keys.length < 2)) return;
    const parts = await Promise.all(keys.map(match));
    if (parts.every(Boolean)) hits.set(r.row, parts);
  }));
  return { by, hits };
}
module.exports = { live, select, pagePublic, publicPage };
