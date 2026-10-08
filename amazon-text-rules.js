/**
 * Amazon A+ 텍스트 규정 — 특수부호 제거 (서버측 사본)
 *
 * Amazon은 A+ 콘텐츠 텍스트에 상표/저작권 기호(® ™ © ℠), 각주 기호(* † ‡ ※ 위첨자),
 * 장식 문자·이모지가 포함되면 승인을 거부한다. 아마존으로 나가는 모든 텍스트에 적용한다.
 * eBay는 닷컴 원문 재현이 목적이므로 적용하지 않는다.
 *
 * ⚠ 동일 규칙이 amazon-aplus/index-test3.html 안에도 인라인으로 들어있다
 *   (standalone 툴이라 외부 로드 의존을 두지 않음). 규칙 변경 시 양쪽을 함께 고칠 것.
 *
 * 유지하는 문자: ° ± × ÷ % & / - ~ 따옴표 통화기호 및 모든 언어 문자
 */

const AMZ_BANNED_CHARS = new RegExp([
  '[\\u00AE\\u2122\\u2120\\u00A9\\u2117]',                  // ® ™ ℠ © ℗
  '[*\\uFF0A\\u2217\\u2731\\u204E]',                        // * ＊ ∗ ✱ ⁎
  '[\\u2020\\u2021\\u00A7\\u00B6\\u203B\\u2042]',           // † ‡ § ¶ ※ ⁂
  '[\\u00B9\\u00B2\\u00B3\\u2070\\u2071\\u2074-\\u207F]',   // ¹ ² ³ ⁰ ⁴~⁹ ⁽ ⁾ ⁿ (각주 위첨자)
  '[\\u2022\\u2023\\u25A0-\\u25FF\\u2605\\u2606]',          // • ‣ ■ ◆ ◇ ★ ☆ (장식 불릿)
  '[\\u2190-\\u21FF\\u2794-\\u27BF]',                       // ← → ⇒ ➤ (장식 화살표)
  '[\\u2600-\\u26FF\\u2700-\\u2793]',                       // ☀ ✓ ✔ ✕ 등 기호
  '[\\uFE0F\\u200B-\\u200D\\uFEFF]',                        // 이모지 변이자·제로폭 문자
  '[\\u{1F000}-\\u{1FAFF}]',                                // 이모지
].join('|'), 'gu');

// URL·식별자는 건드리지 않는다 (기호 제거 시 링크가 깨진다)
const AMZ_SKIP_KEYS = new Set([
  'url', 'imageUrl', 'pc_url', 'mobile_url', 'unified_url', 'src', 'srcset',
  'href', 'videoUrl', 'poster', 'thumbnail', 'id', 'moduleId', 'component_id',
]);

/** 문자열 하나를 아마존 규정에 맞게 정리 */
function stripAmazonSymbols(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    .replace(AMZ_BANNED_CHARS, '')
    .replace(/\(\s*\)/g, '')                    // 각주만 들어있던 빈 괄호
    .replace(/[ \t\u00A0]{2,}/g, ' ')           // 기호 제거로 생긴 이중 공백
    .replace(/[ \t]+([,.;:!?%)\]])/g, '$1')     // 문장부호 앞에 남은 공백
    .split('\n').map(l => l.trim()).join('\n')  // 줄머리 '*' 제거 후 남는 들여쓰기
    .trim();
}

/** 객체/배열을 재귀적으로 정리 (URL 키는 제외) */
function sanitizeAmazonDeep(v) {
  if (typeof v === 'string') return stripAmazonSymbols(v);
  if (Array.isArray(v)) return v.map(sanitizeAmazonDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      out[k] = AMZ_SKIP_KEYS.has(k) ? v[k] : sanitizeAmazonDeep(v[k]);
    }
    return out;
  }
  return v;
}

module.exports = { stripAmazonSymbols, sanitizeAmazonDeep, AMZ_BANNED_CHARS };
