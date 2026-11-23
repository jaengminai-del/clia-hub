/**
 * bulk-country.js — 벌크 엑셀이 고른 나라 것인지 확인 (2026-11-23)
 *
 * 태국·싱가포르 엑셀을 헷갈려 넣으면 같은 모델이 두 나라에서 팔리는 행이 매칭되어, 태국 엑셀에 싱가포르 내용이
 * 오류 없이 들어간다 (실측: 태국 엑셀 636행을 싱가포르 화면에 넣으면 230행). 그래서 올릴 때 나라를 확인한다.
 *
 * 증거 (강한 순서, 앞에서 결론이 나면 거기서 끝):
 *   1. 상품 ID 히스토리 — Shopee/Lazada 상품 ID 는 나라별 숍마다 따로 붙는다. 예전에 그 나라로 내보낸 엑셀의
 *      ID 를 기억해 두고 겹치는지 본다 (실측: 태국 636개 · 싱가포르 1158개 중 겹침 0). 영어권 나라끼리도 구분된다.
 *   2. 모델 코드(SKU)의 법인 코드 — 태국 EATH·TH, 싱가포르 ESL·SGP (실측: 태국 엑셀 515행 TH·0행 SG,
 *      싱가포르 엑셀 375행 SG·0행 TH)
 *   3. 상품명의 태국 문자 비율 — 20% 이상이면 태국 (실측: 태국 92~100%, 싱가포르 0%)
 * CLIA 제품 매칭 나라는 쓰지 않는다 — 싱가포르 제품이 아직 적어 싱가포르 엑셀도 태국 제품과 더 많이 맞는다 (183 대 20).
 *
 * 히스토리: 내보내기(작업 시작)할 때 그 나라로 상품 ID 를 쌓는다 — 로컬 media-cache/bulk/history.json + 버킷 bulk/history.json.
 * 처음(히스토리 없음)에는 버킷에 남아 있는 예전 업로드를 2·3 번 증거로 나라를 정해 채운다.
 */
const fs = require('fs');
const path = require('path');
const store = require('./crawl-store');

const FILE = path.join(__dirname, 'media-cache', 'bulk', 'history.json');
const KEY = 'bulk/history.json';
const THAI = /[฀-๿]/;
// 모델 코드의 판매 법인 표시 (LG SKU 의 '.' 뒤 조각)
const SKU_CODE = {
  th: (t) => /ETH$/.test(t) || t === 'TH',
  sg: (t) => /ESL$/.test(t) || /SGP/.test(t),
};
const enough = (n, all) => n >= Math.max(3, Math.ceil(all * 0.1));   // 몇 개 우연히 겹치는 것은 무시

function signals(out) {
  const rows = out.rows || [];
  const ids = [...new Set(rows.map((r) => String(r.id || '').trim()).filter((x) => /^\d{5,}$/.test(x)))];
  const sku = {};
  const ex = {};
  for (const r of rows) {
    const toks = String(r.parentSku || r.sku || '').toUpperCase().split(/[.\s+/]+/).slice(1);
    for (const [cc, is] of Object.entries(SKU_CODE)) {
      const hit = toks.find(is);
      if (hit) { sku[cc] = (sku[cc] || 0) + 1; ex[cc] = ex[cc] || hit; }
    }
  }
  const named = rows.filter((r) => String(r.name || '').trim());
  return { ids, sku, ex, rows: rows.length, thai: named.filter((r) => THAI.test(r.name)).length, named: named.length };
}

// 히스토리 없이 나라 정하기 (예전 업로드 채우기용) — 모델 코드, 그다음 태국 문자
function guess(sig) {
  const best = Object.entries(sig.sku).sort((a, b) => b[1] - a[1])[0];
  if (best && enough(best[1], sig.rows)) return best[0];
  if (sig.named >= 3 && sig.thai / sig.named >= 0.2) return 'th';
  return '';
}

/** 고른 나라(cc)와 다른 엑셀이면 { detected, by: 'history'|'sku'|'thai', n, ... }, 맞거나 모르면 null */
function judge(sig, cc, hist) {
  if (!/^[a-z]{2}$/.test(cc || '')) return null;
  // 1. 상품 ID 히스토리
  if (sig.ids.length) {
    const over = Object.fromEntries(Object.entries(hist || {}).map(([c, set]) => [c, sig.ids.filter((x) => set.has(x)).length]));
    if (enough(over[cc] || 0, sig.ids.length)) return null;
    const other = Object.entries(over).filter(([c]) => c !== cc).sort((a, b) => b[1] - a[1])[0];
    if (other && enough(other[1], sig.ids.length)) return { detected: other[0], by: 'history', n: other[1], all: sig.ids.length };
  }
  // 2. 모델 코드
  if (enough(sig.sku[cc] || 0, sig.rows)) return null;
  const other = Object.entries(sig.sku).filter(([c]) => c !== cc).sort((a, b) => b[1] - a[1])[0];
  if (other && enough(other[1], sig.rows)) return { detected: other[0], by: 'sku', n: other[1], all: sig.rows, ex: sig.ex[other[0]] };
  // 3. 태국 문자
  if (sig.named < 3) return null;
  const isThai = sig.thai / sig.named >= 0.2;
  if (cc === 'th' ? isThai : !isThai) return null;
  return { detected: isThai ? 'th' : 'other', by: 'thai', n: sig.thai, all: sig.named };
}

// ── 히스토리 ──
let hist = null;      // { cc: Set(ids) }
let loading = null;
const toJson = (h) => JSON.stringify(Object.fromEntries(Object.entries(h).map(([c, s]) => [c, [...s]])));
const fromJson = (t) => Object.fromEntries(Object.entries(JSON.parse(t)).map(([c, a]) => [c, new Set(a)]));

async function save() {
  const txt = toJson(hist);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, txt);
  await store.putBuffer(KEY, Buffer.from(txt), 'application/json').catch((e) => console.warn('[bulk-country] 버킷 저장 실패', e.message));
}

// 처음: 버킷의 예전 업로드(bulk/<id>/source.xlsx)를 증거 2·3 으로 나라를 정해 채운다
async function seed(analyze, load) {
  const h = {};
  let n = 0;
  try {
    for (const key of (await store.listRemote('bulk/')).keys()) {
      const m = /^bulk\/([0-9a-f]{16})\/source\.xlsx$/.exec(key);
      if (!m) continue;
      try {
        const sig = signals(analyze(await load(await store.getBuffer(key)), 'history.xlsx'));
        const cc = guess(sig);
        if (!cc) continue;
        h[cc] = h[cc] || new Set();
        sig.ids.forEach((x) => h[cc].add(x));
        n++;
      } catch (_) {}
    }
  } catch (e) { console.warn('[bulk-country] 예전 업로드 읽기 실패', e.message); }
  console.log(`[bulk-country] 히스토리 시작: 예전 업로드 ${n}개 → ${Object.entries(h).map(([c, s]) => `${c} ${s.size}`).join(', ') || '없음'}`);
  return h;
}

async function history(analyze, load) {
  if (hist) return hist;
  if (!loading) {
    loading = (async () => {
      let txt = null;
      try { txt = fs.readFileSync(FILE, 'utf8'); } catch (_) {}
      if (!txt) { const b = await store.getBuffer(KEY).catch(() => null); if (b) txt = b.toString('utf8'); }
      if (txt) { try { return fromJson(txt); } catch (_) {} }
      const h = await seed(analyze, load);
      hist = h;
      if (Object.keys(h).length) await save();
      return h;
    })().then((h) => { hist = h; return h; }).finally(() => { loading = null; });
  }
  return loading;
}

/** 내보내기를 시작한 엑셀의 상품 ID 를 그 나라 히스토리에 더한다 */
async function remember(cc, out, analyze, load) {
  if (!/^[a-z]{2}$/.test(cc || '')) return;
  const h = await history(analyze, load);
  const ids = signals(out).ids;
  if (!ids.length) return;
  h[cc] = h[cc] || new Set();
  const before = h[cc].size;
  ids.forEach((x) => h[cc].add(x));
  if (h[cc].size !== before) await save();
}

/** 업로드·분석·내보내기에서: 나라가 다르면 오류 응답 본문, 맞으면 null */
async function check(out, cc, analyze, load) {
  const sig = signals(out);
  const bad = judge(sig, String(cc || '').toLowerCase(), await history(analyze, load));
  if (!bad) return null;
  return { error: `This Excel does not look like a ${String(cc).toUpperCase()} file`, code: 'wrong_country', selected: cc, ...bad,
    // 예전 화면 호환 (태국 문자 기준 값)
    thai: sig.thai, named: sig.named };
}

module.exports = { check, remember, signals, judge, guess };
