/**
 * bulk-mail.js — 벌크 엑셀 완료 · 실패 알림 메일 (2026-11-19)
 *
 * 내보내기 팝업에서 "완료되면 메일로 알려 주세요" 를 고른 사람에게 보낸다 (lge-d2c.com Resend — bulk-jobs.js 가 보냄).
 *   build(job, { base, attached, lang }) → { subject, html, text }
 * 간결하게: 제목 · 한두 줄 · 버튼 하나. 메일 프로그램 호환을 위해 표 + 인라인 스타일. 언어: ko · th · en (그 밖은 en).
 */
const TX = {
  en: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel ready — ${ok} filled${rv ? ` · ${rv} to check` : ''}`,
    sFail: '[CLIA] Bulk Excel could not be made',
    hOk: 'Your bulk Excel is ready', hFail: 'Your bulk Excel could not be made',
    ok: (n) => `${n} products were filled.`, rv: (n) => `${n} need checking in CLIA.`,
    att: 'The finished file is attached.', big: 'The file is too large to attach — download it in CLIA.',
    fail: 'Nothing in your Excel was changed. Please open it in CLIA and export again.',
    open: 'Open in CLIA', foot: 'Sent because you asked to be notified. Please do not reply.',
  },
  th: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel พร้อมแล้ว — เติม ${ok} รายการ${rv ? ` · ต้องตรวจสอบ ${rv}` : ''}`,
    sFail: '[CLIA] สร้าง Bulk Excel ไม่สำเร็จ',
    hOk: 'ไฟล์ Bulk Excel พร้อมแล้ว', hFail: 'สร้างไฟล์ Bulk Excel ไม่สำเร็จ',
    ok: (n) => `เติมสินค้าแล้ว ${n} รายการ`, rv: (n) => `มี ${n} รายการที่ต้องตรวจสอบใน CLIA`,
    att: 'แนบไฟล์ที่เสร็จแล้วมาด้วย', big: 'ไฟล์ใหญ่เกินกว่าจะแนบได้ — ดาวน์โหลดได้ใน CLIA',
    fail: 'ไม่มีการเปลี่ยนแปลงใน Excel ของคุณ กรุณาเปิดใน CLIA แล้วส่งออกอีกครั้ง',
    open: 'เปิดใน CLIA', foot: 'ส่งถึงคุณเพราะขอให้แจ้งเตือน กรุณาอย่าตอบกลับ',
  },
  ko: {
    sOk: (ok, rv) => `[CLIA] 벌크 엑셀 완성 — ${ok}개 채움${rv ? ` · 확인 필요 ${rv}개` : ''}`,
    sFail: '[CLIA] 벌크 엑셀을 만들지 못했습니다',
    hOk: '벌크 엑셀이 완성됐습니다', hFail: '벌크 엑셀을 만들지 못했습니다',
    ok: (n) => `${n}개 제품을 채웠습니다.`, rv: (n) => `확인이 필요한 제품 ${n}개는 CLIA 에서 봐 주세요.`,
    att: '완성된 파일을 첨부했습니다.', big: '파일이 커서 첨부하지 못했습니다. CLIA 에서 받아 주세요.',
    fail: '엑셀은 바뀌지 않았습니다. CLIA 에서 열어 다시 내보내 주세요.',
    open: 'CLIA 에서 열기', foot: '알림을 신청하셔서 보내 드린 메일입니다. 회신하지 마세요.',
  },
};

const RED = '#FD312E', INK = '#262626', MUTED = '#8C8A86';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(lang, title, lines, href, label, foot) {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLIA</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:Arial,'Helvetica Neue','Apple SD Gothic Neo','Noto Sans Thai',sans-serif;color:${INK}">
<tr><td style="padding-bottom:20px;font-size:18px;font-weight:800;color:${RED}">CLIA</td></tr>
<tr><td style="font-size:20px;font-weight:700;line-height:1.4;padding-bottom:10px">${esc(title)}</td></tr>
<tr><td style="font-size:14px;line-height:1.7;padding-bottom:22px">${lines.map(esc).join('<br>')}</td></tr>
<tr><td><a href="${esc(href)}" style="display:inline-block;padding:11px 22px;border-radius:999px;background:${RED};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${esc(label)}</a></td></tr>
<tr><td style="padding-top:28px;font-size:11px;color:${MUTED}">${esc(foot)}</td></tr>
</table></td></tr></table></body></html>`;
}

function build(j, { base = '', attached = false, lang } = {}) {
  const want = lang || (j.notify && j.notify.lang) || j.lang;
  const L = TX[want] ? want : 'en';
  const t = TX[L];
  const open = `${String(base || '').replace(/\/$/, '')}/bulk/?job=${encodeURIComponent(j.id)}&lang=${encodeURIComponent(L)}`;
  const its = j.items || [];
  const ok = its.filter((x) => x.status === 'ok').length;
  const rv = its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info')).length;

  const done = j.status === 'ready';
  const title = done ? t.hOk : t.hFail;
  const lines = done ? [t.ok(ok), ...(rv ? [t.rv(rv)] : []), attached ? t.att : t.big] : [t.fail];
  return {
    subject: done ? t.sOk(ok, rv) : t.sFail,
    html: shell(L, title, lines, open, t.open, t.foot),
    text: [title, '', ...lines, '', `${t.open}: ${open}`, '', t.foot].join('\n'),
  };
}

module.exports = { build, TX };
