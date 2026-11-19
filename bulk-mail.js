/**
 * bulk-mail.js — 벌크 엑셀 완료 · 실패 알림 메일 (2026-11-19)
 *
 * 내보내기 팝업에서 "완료되면 메일로 알려 주세요" 를 고른 사람에게 보낸다 (lge-d2c.com Resend — bulk-jobs.js 가 보냄).
 *   build(job, { base, attached, lang }) → { subject, html, text }
 *
 * 디자인: D2C Creative Hub 메일 디자인 시스템(contentfactoryhsad-blip/d2c-creativehub lib/studio/emailTheme.ts)을
 * 바탕으로 한다 — 흰 카드, 큰 제목 · 회색 본문, 회색 정보 칸, 8px 빨간 버튼. 머리는 CLIA 화면 상단과 같게
 * (LG 로고 | CLIA Content Hub). 로고는 메일 프로그램이 SVG 를 못 그려서 PNG(shared/assets/lg-logo-mail.png, 3배).
 * 메일 프로그램 제약도 같다: 표로만 배치, 인라인 스타일 + bgcolor, 웹 글꼴 없음, 숨은 미리보기 줄.
 * 내용은 짧게: 제목 · 한 줄 · 정보 칸 · 버튼 하나, 아래 작은 글 없음. 언어: ko · th · en (그 밖은 en).
 */

/** emailTheme.ts 의 T (앱 tokens-v2 밝은 테마) 를 그대로 옮김. */
const T = {
  bg: '#fafafa', surface: '#ffffff', fg: '#0a0a0a', fg2: '#171717', muted: '#666666', muted2: '#8f8f8f',
  border: '#eaeaea', accent: '#fd312e', onAccent: '#ffffff', accentWash: '#fff1f0',
  // 작은따옴표 필수 — style="..." 안에 들어간다. 태국어 메일을 위해 Thai 글꼴을 앞쪽에 둔다.
  font: "'Apple SD Gothic Neo','Pretendard','Noto Sans Thai','Leelawadee UI',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "Menlo,Consolas,'Courier New',monospace",
  radiusCard: '16px', radiusPanel: '12px', radiusButton: '8px',
  // CLIA 화면 상단 (shared/clia-ui.css .topbar · .tb-div · .tb-title)
  hdLine: '#E6E1D6', hdTitle: '#262626',
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── emailTheme.ts 의 조각들 ──
const heading = (s) => `<div style="font-size:28px;line-height:1.3;font-weight:800;letter-spacing:-0.6px;color:${T.fg};padding-bottom:12px;word-break:keep-all;">${esc(s)}</div>`;
const paragraph = (s) => `<div style="font-size:15px;line-height:1.7;color:${T.muted};padding-bottom:14px;word-break:keep-all;">${esc(s)}</div>`;
const dataRow = (label, value, color, html, first) => `<tr>
    <td style="padding:11px 18px;border-top:${first ? '0' : `1px solid ${T.border}`};font-family:${T.font};font-size:13px;font-weight:700;letter-spacing:0;color:${T.muted2};width:40%;vertical-align:top;word-break:keep-all;">${esc(label)}</td>
    <td style="padding:11px 18px;border-top:${first ? '0' : `1px solid ${T.border}`};font-family:${T.font};font-size:15px;font-weight:700;color:${color || T.fg};word-break:break-all;">${html ? value : esc(value)}</td>
  </tr>`;
const panel = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${T.bg}" style="margin:10px 0 22px;background:${T.bg};border:1px solid ${T.border};border-radius:${T.radiusPanel};border-collapse:separate;">
    ${rows}
  </table>`;
const tag = (s) => `<span style="display:inline-block;margin-top:6px;padding:3px 9px;border-radius:999px;background:#EEF7F1;color:#1E7F4F;font-size:12px;font-weight:700;letter-spacing:0;white-space:nowrap;">✓ ${esc(s)}</span>`;
const button = (label, href) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="center" style="padding:10px 0 4px;">
      <a href="${esc(href)}" style="font-family:${T.font};display:inline-block;background:${T.accent};color:${T.onAccent};font-weight:700;font-size:15px;line-height:1;padding:14px 32px;border-radius:${T.radiusButton};text-decoration:none;">${esc(label)}</a>
    </td>
  </tr></table>`;

/** emailTheme.ts 의 shell() 짜임 — 머리는 CLIA 화면 상단, 배지 · 아래 작은 글 없음. */
function shell(o) {
  return `<!DOCTYPE html>
<html lang="${esc(o.lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${esc(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:${T.bg};font-family:${T.font};">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(o.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${T.bg}" style="background:${T.bg};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">

        <tr><td bgcolor="${T.surface}" style="background:${T.surface};border:1px solid ${T.border};border-bottom:1px solid ${T.hdLine};border-radius:${T.radiusCard} ${T.radiusCard} 0 0;padding:20px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;line-height:0;"><img src="${esc(o.logo)}" width="54" height="24" alt="LG" style="display:block;width:54px;height:24px;border:0;outline:none;text-decoration:none;font-family:${T.font};font-size:16px;font-weight:800;color:#A50034;line-height:24px;"></td>
            <td style="vertical-align:middle;padding:0 14px;"><div style="width:1px;height:16px;background:${T.hdLine};line-height:16px;font-size:0;">&nbsp;</div></td>
            <td style="vertical-align:middle;font-family:${T.font};font-size:15px;font-weight:700;color:${T.hdTitle};white-space:nowrap;">CLIA Content Hub</td>
          </tr></table>
        </td></tr>

        <tr><td bgcolor="${T.surface}" style="background:${T.surface};border:1px solid ${T.border};border-top:none;border-radius:0 0 ${T.radiusCard} ${T.radiusCard};padding:34px 32px 30px;font-family:${T.font};">
          ${o.content}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const TX = {
  en: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel ready — ${ok} matched${rv ? ` · ${rv} to check` : ''}`,
    sFail: '[CLIA] Bulk Excel could not be made',
    hOk: 'Your bulk Excel is ready', hFail: 'Your bulk Excel could not be made',
    pOk: 'The finished file is attached to this email.', pBig: 'The file is too large to attach — download it in CLIA.',
    pFail: 'Nothing in your Excel was changed. Open it in CLIA and export again.',
    rOk: 'Matched SKUs', rRv: 'SKUs to check', rFile: 'Bulk upload file', att: 'Attached to this email', n: (x) => String(x),
    open: 'Check in CLIA',
  },
  th: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel พร้อมแล้ว — จับคู่ ${ok} SKU${rv ? ` · ต้องตรวจสอบ ${rv}` : ''}`,
    sFail: '[CLIA] สร้าง Bulk Excel ไม่สำเร็จ',
    hOk: 'ไฟล์ Bulk Excel พร้อมแล้ว', hFail: 'สร้างไฟล์ Bulk Excel ไม่สำเร็จ',
    pOk: 'แนบไฟล์ที่เสร็จแล้วมากับอีเมลนี้', pBig: 'ไฟล์ใหญ่เกินกว่าจะแนบได้ — ดาวน์โหลดได้ใน CLIA',
    pFail: 'ไม่มีการเปลี่ยนแปลงใน Excel ของคุณ เปิดใน CLIA แล้วส่งออกอีกครั้ง',
    rOk: 'SKU ที่จับคู่ได้', rRv: 'SKU ที่ต้องตรวจสอบ', rFile: 'ชื่อไฟล์ Bulk Upload', att: 'แนบในอีเมลแล้ว', n: (x) => `${x} รายการ`,
    open: 'ตรวจสอบใน CLIA',
  },
  ko: {
    sOk: (ok, rv) => `[CLIA] 벌크 엑셀 완성 — 매칭 ${ok}개${rv ? ` · 확인 필요 ${rv}개` : ''}`,
    sFail: '[CLIA] 벌크 엑셀을 만들지 못했습니다',
    hOk: '벌크 엑셀이 완성됐습니다', hFail: '벌크 엑셀을 만들지 못했습니다',
    pOk: '완성된 파일을 이 메일에 첨부했습니다.', pBig: '파일이 커서 첨부하지 못했습니다. CLIA 에서 받아 주세요.',
    pFail: '엑셀은 바뀌지 않았습니다. CLIA 에서 열어 다시 내보내 주세요.',
    rOk: '매칭된 SKU', rRv: '확인 필요한 SKU', rFile: '벌크 업로드 파일명', att: '메일 첨부 완료', n: (x) => `${x}개`,
    open: 'CLIA 확인',
  },
};

function build(j, { base = '', attached = false, lang } = {}) {
  const want = lang || (j.notify && j.notify.lang) || j.lang;
  const L = TX[want] ? want : 'en';
  const t = TX[L];
  const b = String(base || '').replace(/\/$/, '');
  const open = `${b}/bulk/?job=${encodeURIComponent(j.id)}&lang=${encodeURIComponent(L)}`;
  const logo = `${b}/shared/assets/lg-logo-mail.png`;
  const its = j.items || [];
  const ok = its.filter((x) => x.status === 'ok').length;
  const rv = its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info')).length;

  if (j.status !== 'ready') {
    const content = `${heading(t.hFail)}${paragraph(t.pFail)}${button(t.open, open)}`;
    return {
      subject: t.sFail,
      html: shell({ lang: L, title: t.sFail, logo, preheader: t.pFail, content }),
      text: [t.hFail, '', t.pFail, '', `${t.open}: ${open}`].join('\n'),
    };
  }
  const p = attached ? t.pOk : t.pBig;
  // 표: 매칭된 SKU → 확인 필요한 SKU → 벌크 업로드 파일명 (메일에 첨부했으면 "메일 첨부 완료")
  const file = `${esc(j.outName || '')}${attached ? `<br>${tag(t.att)}` : ''}`;
  const rows = dataRow(t.rOk, t.n(ok), T.fg, false, true) + dataRow(t.rRv, t.n(rv), rv ? T.accent : T.fg) + dataRow(t.rFile, file, T.fg, true);
  const content = `${heading(t.hOk)}${paragraph(p)}${panel(rows)}${button(t.open, open)}`;
  const subject = t.sOk(ok, rv);
  return {
    subject,
    html: shell({ lang: L, title: subject, logo, preheader: `${p} ${t.rOk} ${t.n(ok)} · ${t.rRv} ${t.n(rv)}`, content }),
    text: [t.hOk, '', p, '', `${t.rOk}: ${t.n(ok)}`, `${t.rRv}: ${t.n(rv)}`, `${t.rFile}: ${j.outName || ''}${attached ? ` (${t.att})` : ''}`, '', `${t.open}: ${open}`].join('\n'),
  };
}

module.exports = { build, TX };
