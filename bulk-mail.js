/**
 * bulk-mail.js — 벌크 엑셀 완료 · 실패 알림 메일 (2026-11-19)
 *
 * 내보내기 팝업에서 "완료되면 메일로 알려 주세요" 를 고른 사람에게 보낸다 (lge-d2c.com Resend — bulk-jobs.js 가 보냄).
 *   build(job, { base, attached, lang }) → { subject, html, text }
 *
 * 디자인: D2C Creative Hub 메일 디자인 시스템(contentfactoryhsad-blip/d2c-creativehub lib/studio/emailTheme.ts)을
 * 그대로 따른다 — 검은 머리 막대 + 빨간 배지, 흰 카드, 빨간 소제목 · 큰 제목 · 회색 본문, 회색 정보 칸, 8px 빨간 버튼.
 * 메일 프로그램 제약도 같다: 표로만 배치, 인라인 스타일 + bgcolor, 웹 글꼴 없음, 숨은 미리보기 줄.
 * 내용은 짧게: 제목 · 한두 줄 · 정보 칸 · 버튼 하나. 언어: ko · th · en (그 밖은 en).
 */

/** emailTheme.ts 의 T (앱 tokens-v2 밝은 테마) 를 그대로 옮김. */
const T = {
  bg: '#fafafa', surface: '#ffffff', fg: '#0a0a0a', fg2: '#171717', muted: '#666666', muted2: '#8f8f8f',
  border: '#eaeaea', accent: '#fd312e', onAccent: '#ffffff', accentWash: '#fff1f0',
  // 작은따옴표 필수 — style="..." 안에 들어간다. 태국어 메일을 위해 Thai 글꼴을 앞쪽에 둔다.
  font: "'Apple SD Gothic Neo','Pretendard','Noto Sans Thai','Leelawadee UI',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "Menlo,Consolas,'Courier New',monospace",
  radiusCard: '16px', radiusPanel: '12px', radiusButton: '8px',
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── emailTheme.ts 의 조각들 ──
const eyebrow = (s, color = T.accent) => `<div style="font-size:12px;font-weight:700;letter-spacing:0.12em;color:${color};padding-bottom:10px;">${esc(s)}</div>`;
const heading = (s) => `<div style="font-size:24px;line-height:1.3;font-weight:800;letter-spacing:-0.4px;color:${T.fg};padding-bottom:14px;">${esc(s)}</div>`;
const paragraph = (s) => `<div style="font-size:15px;line-height:1.7;color:${T.muted};padding-bottom:14px;">${esc(s)}</div>`;
const dataRow = (label, value, color) => `<tr>
    <td style="padding:11px 18px;border-top:1px solid ${T.border};font-family:${T.font};font-size:12px;font-weight:700;letter-spacing:0.08em;color:${T.muted2};width:42%;vertical-align:top;">${esc(label)}</td>
    <td style="padding:11px 18px;border-top:1px solid ${T.border};font-family:${T.font};font-size:15px;font-weight:700;color:${color || T.fg};word-break:break-all;">${esc(value)}</td>
  </tr>`;
const panel = (caption, rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${T.bg}" style="margin:8px 0 18px;background:${T.bg};border:1px solid ${T.border};border-radius:${T.radiusPanel};">
    <tr><td colspan="2" style="padding:14px 18px 4px;font-family:${T.font};font-size:12px;font-weight:700;letter-spacing:0.12em;color:${T.accent};">${esc(caption)}</td></tr>
    ${rows}
  </table>`;
const button = (label, href) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="center" style="padding:10px 0 4px;">
      <a href="${esc(href)}" style="font-family:${T.font};display:inline-block;background:${T.accent};color:${T.onAccent};font-weight:700;font-size:15px;line-height:1;padding:14px 32px;border-radius:${T.radiusButton};text-decoration:none;">${esc(label)}</a>
    </td>
  </tr></table>`;

/** emailTheme.ts 의 shell() — 머리 막대의 이름만 CLIA 로. */
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

        <tr><td bgcolor="${T.fg}" style="background:${T.fg};border-radius:${T.radiusCard} ${T.radiusCard} 0 0;padding:22px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;font-family:${T.font};">
              <div style="font-size:17px;font-weight:800;letter-spacing:-0.3px;color:${T.onAccent};">CLIA</div>
            </td>
            <td align="right" style="vertical-align:middle;font-family:${T.font};">
              <div bgcolor="${o.badgeColor || T.accent}" style="display:inline-block;background:${o.badgeColor || T.accent};border-radius:999px;color:${T.onAccent};font-size:10px;font-weight:700;letter-spacing:0.1em;padding:6px 13px;">${esc(o.badge)}</div>
            </td>
          </tr></table>
        </td></tr>

        <tr><td bgcolor="${T.surface}" style="background:${T.surface};border:1px solid ${T.border};border-top:none;border-radius:0 0 ${T.radiusCard} ${T.radiusCard};padding:34px 32px;font-family:${T.font};">
          ${o.content}
        </td></tr>

        <tr><td style="padding:20px 12px 0;font-family:${T.font};">
          <div style="font-size:12px;line-height:1.7;color:${T.muted2};text-align:center;">
            ${esc(o.footerNote)}<br><br>
            LG D2C · CLIA Content Hub
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const TX = {
  en: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel ready — ${ok} filled${rv ? ` · ${rv} to check` : ''}`,
    sFail: '[CLIA] Bulk Excel could not be made',
    hOk: 'Your bulk Excel is ready', hFail: 'Your bulk Excel could not be made',
    pOk: 'The finished file is attached to this email.', pBig: 'The file is too large to attach — download it in CLIA.',
    pFail: 'Nothing in your Excel was changed. Open it in CLIA and export again.',
    cap: 'RESULT', rFile: 'FILE', rOk: 'FILLED', rRv: 'TO CHECK', n: (x) => String(x),
    open: 'Open in CLIA', foot: 'You asked to be emailed when this export finished. This address isn’t monitored.',
  },
  th: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel พร้อมแล้ว — เติม ${ok} รายการ${rv ? ` · ต้องตรวจสอบ ${rv}` : ''}`,
    sFail: '[CLIA] สร้าง Bulk Excel ไม่สำเร็จ',
    hOk: 'ไฟล์ Bulk Excel พร้อมแล้ว', hFail: 'สร้างไฟล์ Bulk Excel ไม่สำเร็จ',
    pOk: 'แนบไฟล์ที่เสร็จแล้วมากับอีเมลนี้', pBig: 'ไฟล์ใหญ่เกินกว่าจะแนบได้ — ดาวน์โหลดได้ใน CLIA',
    pFail: 'ไม่มีการเปลี่ยนแปลงใน Excel ของคุณ เปิดใน CLIA แล้วส่งออกอีกครั้ง',
    cap: 'ผลลัพธ์', rFile: 'ไฟล์', rOk: 'เติมแล้ว', rRv: 'ต้องตรวจสอบ', n: (x) => `${x} รายการ`,
    open: 'เปิดใน CLIA', foot: 'คุณขอให้แจ้งทางอีเมลเมื่อการส่งออกนี้เสร็จ ที่อยู่นี้ไม่มีผู้ตอบกลับ',
  },
  ko: {
    sOk: (ok, rv) => `[CLIA] 벌크 엑셀 완성 — ${ok}개 채움${rv ? ` · 확인 필요 ${rv}개` : ''}`,
    sFail: '[CLIA] 벌크 엑셀을 만들지 못했습니다',
    hOk: '벌크 엑셀이 완성됐습니다', hFail: '벌크 엑셀을 만들지 못했습니다',
    pOk: '완성된 파일을 이 메일에 첨부했습니다.', pBig: '파일이 커서 첨부하지 못했습니다. CLIA 에서 받아 주세요.',
    pFail: '엑셀은 바뀌지 않았습니다. CLIA 에서 열어 다시 내보내 주세요.',
    cap: '결과', rFile: '파일', rOk: '채움', rRv: '확인 필요', n: (x) => `${x}개`,
    open: 'CLIA 에서 열기', foot: '알림을 신청하셔서 보내 드린 메일입니다. 이 주소는 회신을 확인하지 않습니다.',
  },
};

function build(j, { base = '', attached = false, lang } = {}) {
  const want = lang || (j.notify && j.notify.lang) || j.lang;
  const L = TX[want] ? want : 'en';
  const t = TX[L];
  const open = `${String(base || '').replace(/\/$/, '')}/bulk/?job=${encodeURIComponent(j.id)}&lang=${encodeURIComponent(L)}`;
  const its = j.items || [];
  const ok = its.filter((x) => x.status === 'ok').length;
  const rv = its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info')).length;
  const ch = j.channel === 'lazada' ? 'LAZADA' : 'SHOPEE';

  if (j.status !== 'ready') {
    const content = `${eyebrow(`BULK EXCEL · ${ch}`, T.muted2)}${heading(t.hFail)}${paragraph(t.pFail)}${button(t.open, open)}`;
    return {
      subject: t.sFail,
      html: shell({ lang: L, title: t.sFail, badge: 'FAILED', badgeColor: '#525252', preheader: t.pFail, content, footerNote: t.foot }),
      text: [t.hFail, '', t.pFail, '', `${t.open}: ${open}`, '', t.foot].join('\n'),
    };
  }
  const p = attached ? t.pOk : t.pBig;
  const rows = dataRow(t.rFile, j.outName || '') + dataRow(t.rOk, t.n(ok)) + (rv ? dataRow(t.rRv, t.n(rv), T.accent) : '');
  const content = `${eyebrow(`BULK EXCEL · ${ch}`)}${heading(t.hOk)}${paragraph(p)}${panel(t.cap, rows)}${button(t.open, open)}`;
  const subject = t.sOk(ok, rv);
  return {
    subject,
    html: shell({ lang: L, title: subject, badge: 'READY', preheader: `${p} ${t.rOk} ${t.n(ok)}${rv ? ` · ${t.rRv} ${t.n(rv)}` : ''}`, content, footerNote: t.foot }),
    text: [t.hOk, '', p, '', `${t.rFile}: ${j.outName || ''}`, `${t.rOk}: ${t.n(ok)}`, ...(rv ? [`${t.rRv}: ${t.n(rv)}`] : []), '', `${t.open}: ${open}`, '', t.foot].join('\n'),
  };
}

module.exports = { build, TX };
