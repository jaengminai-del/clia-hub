/**
 * clia-i18n.js — CLIA 허브에서 빌더를 열 때 법인 언어로 UI를 번역하는 공용 엔진 (261007)
 *
 * 허브가 빌더를 ?lang=de|th|ar 로 열면 화면 문구를 사전에 따라 번역한다.
 * lang 이 없거나 en 이면 아무것도 하지 않는다 (단독 실행은 영어 그대로).
 * 사전은 빌더별 i18n.js 에서 CLIA_I18N.init(dict, { skip }) 로 넘긴다.
 *   dict  : { '영어 원문': { de, th, ar } } — 원문에 {n} 같은 자리표시자를 쓰면 숫자 등 가변값도 매칭
 *   skip  : 번역하지 않을 영역 CSS 선택자 (프리뷰 컨텐츠 등 — 제품 원문은 그대로 둔다)
 */
(function () {
  const lang = (new URLSearchParams(location.search).get('lang') || 'en').slice(0, 2).toLowerCase();
  window.CLIA_LANG = lang;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function init(dict, opts) {
    if (lang === 'en' || !dict) return;
    const skipSel = ['script', 'style', 'textarea', '[contenteditable]', (opts || {}).skip].filter(Boolean).join(',');
    const exact = new Map();
    const patterns = [];
    Object.entries(dict).forEach(([src, tr]) => {
      if (!tr || tr[lang] == null) return;
      const key = norm(src);
      const names = [];
      if (/\{\w+\}/.test(key)) {
        const re = new RegExp('^' + escRe(key).replace(/\\\{(\w+)\\\}/g, (_, n) => { names.push(n); return '(.+?)'; }) + '$');
        patterns.push({ re, names, out: tr[lang] });
      } else exact.set(key, tr[lang]);
    });
    const tx = (text) => {
      const k = norm(text);
      if (!k) return null;
      if (exact.has(k)) return exact.get(k);
      for (const p of patterns) {
        const m = p.re.exec(k);
        if (m) return p.names.reduce((o, n, i) => o.split('{' + n + '}').join(m[i + 1]), p.out);
      }
      return null;
    };
    const skip = (el) => !el || (el.closest && el.closest(skipSel));
    const doText = (n) => {
      if (skip(n.parentElement)) return;
      const raw = n.nodeValue;
      const v = tx(raw);
      if (v == null) return;
      const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
      const nv = lead + v + trail;
      if (nv !== raw) n.nodeValue = nv;
    };
    // 속성(툴팁·placeholder)은 프리뷰 안의 편집 컨트롤에도 있으므로 skip 영역에서도 번역
    const doAttrs = (el) => {
      if (!el || el.closest('script,style')) return;
      ['placeholder', 'title'].forEach((a) => {
        if (!el.hasAttribute(a)) return;
        const v = tx(el.getAttribute(a));
        if (v != null && v !== el.getAttribute(a)) el.setAttribute(a, v);
      });
    };
    const walk = (root) => {
      if (root.nodeType === 3) return doText(root);
      if (root.nodeType !== 1) return;
      if (!skip(root)) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) doText(n);
      }
      doAttrs(root);
      root.querySelectorAll('[placeholder],[title]').forEach(doAttrs);
    };
    const start = () => {
      document.documentElement.lang = lang;
      walk(document.body);
      new MutationObserver((ms) => ms.forEach((m) => {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else m.addedNodes.forEach(walk);
      })).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title'] });
    };
    // alert/confirm 문구도 번역
    const _alert = window.alert.bind(window), _confirm = window.confirm.bind(window);
    window.alert = (m) => _alert(tx(String(m)) ?? m);
    window.confirm = (m) => _confirm(tx(String(m)) ?? m);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
  window.CLIA_I18N = { init, lang };
})();
