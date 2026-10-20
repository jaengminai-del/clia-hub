/**
 * clia-image-html.js — "이미지형 HTML 복사" (eBay(허브·단독) · Shopee/Lazada 공용, 2026-10-20)
 *
 * 미리보기(결과 HTML)를 서버가 업로드 규격 슬라이스 이미지(폭 1000px · 한 장 ≤3000px · ≤1MB)로 만들어 공개 주소에 올리고,
 * <img> 를 차례로 쌓은 HTML 을 돌려준다 → 라자다·eBay 설명란에 붙여도 미리보기와 같은 모양.
 * (마켓 편집기가 가로 배치·잘라 보이는 이미지·폰트 등을 지워도 영향 없음 — 모두 이미지에 들어 있다)
 *
 *   CLIAImageHTML.copy({ html, apiBase, button, isEditing })
 */
(function () {
  const T = {
    en: { busy: '⏳ Building images…', done: (n) => `✓ Copied (${n} images)`, lock: 'Please press Lock first to finish editing.',
          fail: 'Image HTML failed: ', manual: 'Copy the HTML below (Ctrl/⌘+C) and paste it into the marketplace HTML editor.', close: 'Close', copy: 'Copy' },
    ko: { busy: '⏳ 이미지 만드는 중…', done: (n) => `✓ 복사됨 (이미지 ${n}장)`, lock: '편집을 마치려면 먼저 잠금(Lock)을 눌러 주세요.',
          fail: '이미지형 HTML 생성 실패: ', manual: '아래 HTML 을 복사(Ctrl/⌘+C)해서 마켓 HTML 편집기에 붙여 넣으세요.', close: '닫기', copy: '복사' },
    de: { busy: '⏳ Bilder werden erstellt…', done: (n) => `✓ Kopiert (${n} Bilder)`, lock: 'Bitte zuerst „Sperren“ drücken.',
          fail: 'Bild-HTML fehlgeschlagen: ', manual: 'HTML unten kopieren (Strg/⌘+C) und in den HTML-Editor einfügen.', close: 'Schließen', copy: 'Kopieren' },
    th: { busy: '⏳ กำลังสร้างรูปภาพ…', done: (n) => `✓ คัดลอกแล้ว (${n} รูป)`, lock: 'กรุณากดล็อกก่อนเพื่อจบการแก้ไข',
          fail: 'สร้าง HTML รูปภาพไม่สำเร็จ: ', manual: 'คัดลอก HTML ด้านล่าง (Ctrl/⌘+C) แล้ววางในตัวแก้ไข HTML ของมาร์เก็ตเพลส', close: 'ปิด', copy: 'คัดลอก' },
  };
  const tr = () => T[(window.CLIA_LANG || document.documentElement.lang || 'en').slice(0, 2)] || T.en;

  function manualModal(text) {
    const t = tr();
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = `<div style="background:#fff;border-radius:12px;padding:18px;width:min(760px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.3);font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
      <div style="margin-bottom:8px;font-weight:600;">${t.manual}</div>
      <textarea readonly style="width:100%;height:280px;font:12px/1.4 Menlo,monospace;border:1px solid #ccc;border-radius:6px;padding:8px;box-sizing:border-box;"></textarea>
      <div style="text-align:right;margin-top:10px;display:flex;gap:8px;justify-content:flex-end;">
        <button data-c style="padding:7px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;">${t.copy}</button>
        <button data-x style="padding:7px 14px;border-radius:6px;border:none;background:#262626;color:#fff;cursor:pointer;">${t.close}</button></div></div>`;
    const ta = ov.querySelector('textarea');
    ta.value = text;
    ov.querySelector('[data-x]').onclick = () => ov.remove();
    ov.querySelector('[data-c]').onclick = () => { ta.select(); document.execCommand('copy'); };
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
    ta.focus(); ta.select();
  }

  async function copy(opts) {
    const t = tr();
    if (opts.isEditing && opts.isEditing()) { alert(t.lock); return; }
    const html = typeof opts.html === 'function' ? opts.html() : opts.html;
    if (!html) return;
    const btn = opts.button, orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = t.busy; }
    try {
      const r = await fetch((opts.apiBase || '') + '/api/v1/slice-html', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, medium: 'shopee_lazada' }),   // 업로드 규격(폭 1000px 등)은 Shopee/Lazada spec 공통
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.html) throw new Error(d.error || `HTTP ${r.status}`);
      try { await navigator.clipboard.writeText(d.html); }
      catch (_) { manualModal(d.html); }
      if (btn) { btn.textContent = t.done(d.count); setTimeout(() => { btn.textContent = orig; }, 2500); }
      return d;
    } catch (e) {
      alert(t.fail + e.message);
      if (btn) btn.textContent = orig;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.CLIAImageHTML = { copy };
})();
