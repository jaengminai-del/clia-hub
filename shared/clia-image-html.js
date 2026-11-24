/**
 * clia-image-html.js — "이미지형 HTML 복사" (eBay(허브·단독) · Shopee/Lazada 공용, 2026-10-20)
 *
 * 미리보기(결과 HTML)를 서버가 업로드 규격 슬라이스 이미지(폭 1000px · 한 장 ≤3000px · ≤1MB)로 만들어 공개 주소에 올리고,
 * <img> 를 차례로 쌓은 HTML 을 돌려준다 → 라자다·eBay 설명란에 붙여도 미리보기와 같은 모양.
 * (마켓 편집기가 가로 배치·잘라 보이는 이미지·폰트 등을 지워도 영향 없음 — 모두 이미지에 들어 있다)
 *
 *   CLIAImageHTML.copy({ html, apiBase, button, isEditing, summaryUrl, urlsOnly })
 *   CLIAImageHTML.build({ html, apiBase, summaryUrl, urlsOnly }) → { text, count, kind, summaryErr, hash, width }  (복사 없이 만들기만)
 *     hash: 슬라이스 묶음 — ZIP 은 GET /media/slices/<hash>/<name>-images[-N].zip (빌더 이미지 다운로드, 같은 이미지)
 *   summaryUrl(선택, Shopee/Lazada): LG 제품 URL — 그 제품의 요약 설명(태국어)을 이미지 위에 붙인다 (2026-11-10)
 *   urlsOnly(선택, Shopee): 숫자 n — HTML 대신 이미지 주소만 앞에서부터 n장, 한 줄에 하나 (alt·태그 없음).
 *     Shopee 설명은 HTML 을 받지 않기 때문 (2026-11-10). 태국 제품은 그 위에 요약을 태그 없는 글로 (2026-11-24)
 */
(function () {
  const T = {
    en: { busy: '⏳ Building images…', done: (n) => `✓ Copied (${n} images)`, cut: (n, all) => `✓ Copied ${n} image URLs (first ${n} of ${all})`, lock: 'Please press Lock first to finish editing.',
          fail: 'Image HTML failed: ', manual: 'Copy the HTML below (Ctrl/⌘+C) and paste it into the marketplace HTML editor.', close: 'Close', copy: 'Copy', summaryFail: 'Copied the images only — the product summary could not be made: ' },
    ko: { busy: '⏳ 이미지 만드는 중…', done: (n) => `✓ 복사됨 (이미지 ${n}장)`, cut: (n, all) => `✓ 이미지 주소 ${n}개 복사됨 (${all}장 중 앞 ${n}장)`, lock: '편집을 마치려면 먼저 잠금(Lock)을 눌러 주세요.',
          fail: '이미지형 HTML 생성 실패: ', manual: '아래 HTML 을 복사(Ctrl/⌘+C)해서 마켓 HTML 편집기에 붙여 넣으세요.', close: '닫기', copy: '복사', summaryFail: '이미지만 복사했습니다 — 요약 설명을 만들지 못했습니다: ' },
    de: { busy: '⏳ Bilder werden erstellt…', done: (n) => `✓ Kopiert (${n} Bilder)`, cut: (n, all) => `✓ ${n} Bild-URLs kopiert (erste ${n} von ${all})`, lock: 'Bitte zuerst „Sperren“ drücken.',
          fail: 'Bild-HTML fehlgeschlagen: ', manual: 'HTML unten kopieren (Strg/⌘+C) und in den HTML-Editor einfügen.', close: 'Schließen', copy: 'Kopieren', summaryFail: 'Nur Bilder kopiert — Zusammenfassung fehlgeschlagen: ' },
    th: { busy: '⏳ กำลังสร้างรูปภาพ…', done: (n) => `✓ คัดลอกแล้ว (${n} รูป)`, cut: (n, all) => `✓ คัดลอกลิงก์รูป ${n} รายการ (${n} รูปแรกจาก ${all})`, lock: 'กรุณากดล็อกก่อนเพื่อจบการแก้ไข',
          fail: 'สร้าง HTML รูปภาพไม่สำเร็จ: ', manual: 'คัดลอก HTML ด้านล่าง (Ctrl/⌘+C) แล้ววางในตัวแก้ไข HTML ของมาร์เก็ตเพลส', close: 'ปิด', copy: 'คัดลอก', summaryFail: 'คัดลอกเฉพาะรูปภาพ — สร้างคำบรรยายสินค้าไม่สำเร็จ: ' },
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

  // 이미지형 HTML(또는 Shopee 는 이미지 주소 목록)을 만들어 돌려준다 — 복사·ZIP 다운로드 공용 (2026-11-11)
  //   → { text, count, kind: 'urls' | 'html', summaryErr, hash, width }
  async function build(opts) {
    const html = typeof opts.html === 'function' ? opts.html() : opts.html;
    if (!html) throw new Error('no HTML');
    const nUrls = typeof opts.urlsOnly === 'function' ? opts.urlsOnly() : opts.urlsOnly;
    const sUrl = typeof opts.summaryUrl === 'function' ? opts.summaryUrl() : opts.summaryUrl;
    // 요약 설명은 이미지와 동시에 요청 (처음 한 번은 AI 가 쓰는 시간이 걸리고, 이후엔 보관본)
    const summaryP = sUrl ? fetch((opts.apiBase || '') + '/api/v1/pdp-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sUrl }),
    }).then(async (x) => { const j = await x.json().catch(() => ({})); if (!x.ok || !j.html) throw new Error(j.error || `HTTP ${x.status}`); return j; })
      : Promise.resolve(null);
    const r = await fetch((opts.apiBase || '') + '/api/v1/slice-html', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, medium: 'shopee_lazada' }),   // 업로드 규격(폭 1000px 등)은 Shopee/Lazada spec 공통
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.html) throw new Error(d.error || `HTTP ${r.status}`);
    const set = { hash: d.hash, width: d.width };
    if (nUrls) {
      // Shopee: HTML 을 받지 않으므로 요약은 태그 없는 글로 맨 위, 그 아래 이미지 주소 (2026-11-24). 설명 한도 3,000자를 넘으면 뒤 이미지부터 뺀다
      let top = '', summaryErr = '';
      try { const sm = await summaryP; if (sm && sm.text) top = sm.text.trim() + '\n\n'; }
      catch (e) { summaryErr = e.message; }
      const urls = (d.urls || []).slice(0, nUrls);
      while (urls.length > 1 && (top + urls.join('\n')).length > 3000) urls.pop();
      return { text: top + urls.join('\n'), count: d.count, n: urls.length, kind: 'urls', summaryErr, ...set };
    }
    let text = d.html, summaryErr = '';
    try { const sm = await summaryP; if (sm) text = sm.html + '\n' + d.html; }
    catch (e) { summaryErr = e.message; }
    return { text, count: d.count, kind: 'html', summaryErr, ...set };
  }

  async function copy(opts) {
    const t = tr();
    if (opts.isEditing && opts.isEditing()) { alert(t.lock); return; }
    const html = typeof opts.html === 'function' ? opts.html() : opts.html;
    if (!html) return;
    const btn = opts.button, orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = t.busy; }
    try {
      const nUrls = typeof opts.urlsOnly === 'function' ? opts.urlsOnly() : opts.urlsOnly;
      const b = await build({ ...opts, html });
      try { await navigator.clipboard.writeText(b.text); }
      catch (_) { manualModal(b.text); }
      if (b.summaryErr) alert(t.summaryFail + b.summaryErr);
      const nOut = nUrls ? (b.n != null ? b.n : Math.min(b.count, nUrls)) : b.count;
      const label = nUrls && b.count > nOut ? t.cut(nOut, b.count) : t.done(nOut);
      if (opts.notify) { if (btn) btn.textContent = orig; opts.notify(label.replace(/^✓\s*/, '')); }
      else if (btn) { btn.textContent = label; setTimeout(() => { btn.textContent = orig; }, 3500); }
      return b;
    } catch (e) {
      alert(t.fail + e.message);
      if (btn) btn.textContent = orig;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.CLIAImageHTML = { copy, build };
})();
