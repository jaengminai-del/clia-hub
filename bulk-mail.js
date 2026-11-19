/**
 * bulk-mail.js — 벌크 엑셀 완료 · 실패 알림 메일 내용 (2026-11-19)
 *
 * 내보내기 팝업에서 "완료되면 메일로 알려 주세요" 를 고른 사람에게 보낸다 (lge-d2c.com Resend — bulk-jobs.js 가 보냄).
 *   build(job, { base, attached }) → { subject, html, text }
 * 메일 프로그램마다 CSS 지원이 달라서 표(table) + 인라인 스타일로만 만든다. 언어: ko · th · en (그 밖의 언어는 en).
 */
const RETENTION_DAYS = 7;

const TX = {
  en: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel ready — ${ok} filled${rv ? ` · ${rv} to check` : ''}`,
    sFail: '[CLIA] Bulk Excel could not be made',
    pre: (ok, rv) => `${ok} products filled${rv ? `, ${rv} need checking` : ''}. The finished Excel is attached.`,
    hOk: 'Your bulk Excel is ready', hFail: 'We could not make your bulk Excel',
    lead: (ch) => `The ${ch} bulk Excel you exported from CLIA is done.`,
    leadAtt: 'The finished file is attached to this email.',
    leadBig: 'The file is too large to attach — download it with the button below.',
    file: 'File', ch: 'Channel', took: 'Time taken', min: (n) => (n < 1 ? 'under 1 min' : `${n} min`),
    stOk: 'Filled', stRep: 'Replaced a description', stBad: 'Failed', stRv: 'Need checking',
    rvH: 'Products to check', rvMore: (n) => `and ${n} more`,
    rvHow: 'Open them in CLIA, fix or confirm, then export again. Rows that failed were left as they were in the Excel.',
    open: 'Open in CLIA', dl: 'Download Excel', keep: (d) => `The download link works for ${d} days.`,
    failLead: 'The export stopped before the file was made. Nothing in your Excel was changed.',
    failWhy: 'Reason', errNoRow: 'No row could be filled — every selected product failed', failHow: 'Open it in CLIA and export again. If it keeps failing, please tell the CLIA team.',
    foot: 'You get this email because you asked to be told when this Bulk Excel export finished. Replies to this address are not read.',
    f: { crawl: 'Could not get the page from LG.com', content: 'Could not make the description', qa: 'Some original content is missing', frame: 'Video scene picked automatically — please check', summary: 'Product summary could not be made — images only', fuzzy: 'Model name is not an exact match — check the product' },
  },
  th: {
    sOk: (ok, rv) => `[CLIA] Bulk Excel พร้อมแล้ว — เติม ${ok} รายการ${rv ? ` · ต้องตรวจสอบ ${rv}` : ''}`,
    sFail: '[CLIA] สร้าง Bulk Excel ไม่สำเร็จ',
    pre: (ok, rv) => `เติมแล้ว ${ok} รายการ${rv ? ` ต้องตรวจสอบ ${rv} รายการ` : ''} แนบไฟล์ Excel ที่เสร็จแล้วมาด้วย`,
    hOk: 'ไฟล์ Bulk Excel ของคุณพร้อมแล้ว', hFail: 'สร้างไฟล์ Bulk Excel ไม่สำเร็จ',
    lead: (ch) => `งาน Bulk Excel สำหรับ ${ch} ที่ส่งออกจาก CLIA เสร็จแล้ว`,
    leadAtt: 'แนบไฟล์ที่เสร็จแล้วมากับอีเมลนี้',
    leadBig: 'ไฟล์มีขนาดใหญ่เกินกว่าจะแนบได้ — ดาวน์โหลดได้จากปุ่มด้านล่าง',
    file: 'ไฟล์', ch: 'ช่องทาง', took: 'ใช้เวลา', min: (n) => (n < 1 ? 'ไม่ถึง 1 นาที' : `${n} นาที`),
    stOk: 'เติมแล้ว', stRep: 'แทนที่รายละเอียดเดิม', stBad: 'ไม่สำเร็จ', stRv: 'ต้องตรวจสอบ',
    rvH: 'สินค้าที่ต้องตรวจสอบ', rvMore: (n) => `และอีก ${n} รายการ`,
    rvHow: 'เปิดใน CLIA แก้ไขหรือยืนยัน แล้วส่งออกอีกครั้ง แถวที่ไม่สำเร็จจะคงเดิมใน Excel',
    open: 'เปิดใน CLIA', dl: 'ดาวน์โหลด Excel', keep: (d) => `ลิงก์ดาวน์โหลดใช้ได้ ${d} วัน`,
    failLead: 'การส่งออกหยุดก่อนสร้างไฟล์ ไม่มีการเปลี่ยนแปลงใน Excel ของคุณ',
    failWhy: 'สาเหตุ', errNoRow: 'ไม่มีแถวที่เติมได้ — สินค้าที่เลือกไม่สำเร็จทั้งหมด', failHow: 'เปิดใน CLIA แล้วส่งออกอีกครั้ง หากยังไม่สำเร็จ โปรดแจ้งทีม CLIA',
    foot: 'คุณได้รับอีเมลนี้เพราะขอให้แจ้งเมื่อการส่งออก Bulk Excel เสร็จ อีเมลที่ตอบกลับมายังที่อยู่นี้จะไม่มีผู้อ่าน',
    f: { crawl: 'ดึงหน้าจาก LG.com ไม่สำเร็จ', content: 'สร้างรายละเอียดไม่สำเร็จ', qa: 'เนื้อหาต้นฉบับบางส่วนหายไป', frame: 'เลือกฉากวิดีโออัตโนมัติ — โปรดตรวจสอบ', summary: 'สร้างสรุปสินค้าไม่สำเร็จ — มีเฉพาะรูป', fuzzy: 'ชื่อรุ่นไม่ตรงกันทุกตัวอักษร — โปรดตรวจสอบสินค้า' },
  },
  ko: {
    sOk: (ok, rv) => `[CLIA] 벌크 엑셀 완성 — ${ok}개 채움${rv ? ` · 확인 필요 ${rv}개` : ''}`,
    sFail: '[CLIA] 벌크 엑셀을 만들지 못했습니다',
    pre: (ok, rv) => `${ok}개 제품을 채웠습니다${rv ? `. 확인이 필요한 제품 ${rv}개` : ''}. 완성된 엑셀을 첨부했습니다.`,
    hOk: '벌크 엑셀이 완성됐습니다', hFail: '벌크 엑셀을 만들지 못했습니다',
    lead: (ch) => `CLIA 에서 내보내기한 ${ch} 벌크 엑셀 작업이 끝났습니다.`,
    leadAtt: '완성된 파일을 이 메일에 첨부했습니다.',
    leadBig: '파일이 커서 첨부하지 못했습니다. 아래 버튼으로 받아 주세요.',
    file: '파일', ch: '채널', took: '걸린 시간', min: (n) => (n < 1 ? '1분 이내' : `${n}분`),
    stOk: '채움', stRep: '기존 설명 교체', stBad: '실패', stRv: '확인 필요',
    rvH: '확인이 필요한 제품', rvMore: (n) => `외 ${n}개`,
    rvHow: 'CLIA 에서 열어 고치거나 확인한 뒤 다시 내보내 주세요. 실패한 행은 엑셀에서 원래대로 두었습니다.',
    open: 'CLIA 에서 열기', dl: '엑셀 받기', keep: (d) => `받기 링크는 ${d}일 동안 쓸 수 있습니다.`,
    failLead: '파일을 만들기 전에 작업이 멈췄습니다. 엑셀은 바뀌지 않았습니다.',
    failWhy: '이유', errNoRow: '채울 수 있는 행이 없었습니다 — 선택한 제품이 모두 실패했습니다', failHow: 'CLIA 에서 열어 다시 내보내 주세요. 계속 안 되면 CLIA 담당자에게 알려 주세요.',
    foot: '벌크 엑셀 내보내기에서 "완료되면 메일로 알려 주세요" 를 선택하셔서 보내 드린 메일입니다. 이 주소로 회신하셔도 확인되지 않습니다.',
    f: { crawl: 'LG.com 에서 페이지를 가져오지 못했습니다', content: '설명을 만들지 못했습니다', qa: '원문 일부가 빠졌습니다', frame: '동영상 장면을 자동으로 골랐습니다 — 확인해 주세요', summary: '제품 요약을 만들지 못해 이미지만 넣었습니다', fuzzy: '모델명이 글자 그대로 같지 않습니다 — 제품을 확인해 주세요' },
  },
};

const RED = '#FD312E', INK = '#262626', MUTED = '#6B6B6B', LINE = '#E6E3DE', BG = '#F6F5F2';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chName = (c) => (c === 'lazada' ? 'Lazada' : 'Shopee');

function counts(j) {
  const its = j.items || [];
  const rvItems = its.filter((x) => (x.flags || []).some((f) => f.sev !== 'info'));
  return {
    ok: its.filter((x) => x.status === 'ok').length,
    rep: its.filter((x) => x.status === 'ok' && x.prevLen > 0).length,
    bad: its.filter((x) => x.status === 'failed').length,
    rvItems,
    mins: j.finishedAt && j.at ? Math.round((j.finishedAt - j.at) / 60000) : null,
  };
}
const reasonOf = (t, it) => {
  const f = (it.flags || []).find((x) => x.sev === 'error') || (it.flags || []).find((x) => x.sev !== 'info');
  return f ? (t.f[f.code] || f.code) : '';
};
const nameOf = (it) => it.model || it.title || it.slug || `#${it.row}`;

// ── 조각 ──
const btn = (href, label, primary) => `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;border-radius:999px;font-weight:700;font-size:14px;text-decoration:none;${primary ? `background:${RED};color:#ffffff;border:1px solid ${RED}` : `background:#ffffff;color:${INK};border:1px solid #CBC8C2`}">${esc(label)}</a>`;
const stat = (n, label, color) => `<td align="center" style="padding:14px 6px;border:1px solid ${LINE};border-radius:12px;background:#ffffff" width="25%"><div style="font-size:24px;font-weight:700;color:${color || INK};line-height:1.2">${n}</div><div style="font-size:12px;color:${MUTED};margin-top:4px">${esc(label)}</div></td>`;
const gap = '<td width="8" style="font-size:0">&nbsp;</td>';
const row = (k, v) => `<tr><td style="padding:4px 0;color:${MUTED};font-size:13px;width:96px;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;font-size:13px;color:${INK};word-break:break-all">${esc(v)}</td></tr>`;

function shell(lang, pre, inner, foot) {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CLIA</title></head>
<body style="margin:0;padding:0;background:${BG}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:Arial,'Helvetica Neue','Apple SD Gothic Neo','Noto Sans Thai',sans-serif;color:${INK}">
<tr><td style="padding:0 4px 14px"><span style="font-size:20px;font-weight:800;color:${RED};letter-spacing:.5px">CLIA</span><span style="font-size:13px;color:${MUTED};padding-left:8px">Bulk Excel</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:18px;padding:28px 28px 24px">${inner}</td></tr>
<tr><td style="padding:16px 8px 0;font-size:11px;line-height:1.6;color:#8C8A86">${esc(foot)}<br>LG Electronics · D2C · CLIA</td></tr>
</table></td></tr></table></body></html>`;
}

function build(j, { base = '', attached = false, lang } = {}) {
  const L = TX[lang || (j.notify && j.notify.lang) || j.lang] ? (lang || (j.notify && j.notify.lang) || j.lang) : 'en';
  const t = TX[L];
  const b = String(base || '').replace(/\/$/, '');
  const open = `${b}/bulk/?job=${encodeURIComponent(j.id)}&lang=${encodeURIComponent(L)}`;
  const dl = `${b}/api/v1/bulk/jobs/${encodeURIComponent(j.id)}/file`;
  const c = counts(j);
  const ch = chName(j.channel);

  if (j.status !== 'ready') {
    const why = j.error === 'no row could be filled' ? t.errNoRow : j.error;
    const inner = `<h1 style="margin:0 0 10px;font-size:22px;line-height:1.35">${esc(t.hFail)}</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6">${esc(t.failLead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${row(t.file, j.outName || '')}${row(t.ch, ch)}${why ? row(t.failWhy, why) : ''}</table>
<p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:${MUTED}">${esc(t.failHow)}</p>
${btn(open, t.open, true)}`;
    const text = [t.hFail, '', t.failLead, `${t.file}: ${j.outName || ''}`, `${t.ch}: ${ch}`, why ? `${t.failWhy}: ${why}` : '', '', t.failHow, `${t.open}: ${open}`, '', t.foot].filter((x) => x !== null).join('\n');
    return { subject: t.sFail, html: shell(L, t.failLead, inner, t.foot), text };
  }

  const rv = c.rvItems.length;
  const SHOW = 10;
  const rvRows = c.rvItems.slice(0, SHOW).map((it) => `<tr><td style="padding:9px 0;border-top:1px solid ${LINE};font-size:13px;font-weight:700;white-space:nowrap;vertical-align:top;padding-right:12px">${esc(nameOf(it))}</td><td style="padding:9px 0;border-top:1px solid ${LINE};font-size:13px;color:#C8241F;vertical-align:top">${esc(reasonOf(t, it))}</td></tr>`).join('');
  const rvBox = rv ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FFF6F5;border:1px solid #F6D5D2;border-radius:12px"><tr><td style="padding:14px 16px">
<div style="font-size:14px;font-weight:700;color:#C8241F;margin-bottom:6px">${esc(t.rvH)} · ${rv}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rvRows}</table>
${rv > SHOW ? `<div style="font-size:12px;color:${MUTED};padding-top:6px">${esc(t.rvMore(rv - SHOW))}</div>` : ''}
<div style="font-size:12px;color:${MUTED};line-height:1.6;padding-top:8px">${esc(t.rvHow)}</div></td></tr></table>` : '';
  const att = attached
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#EEF7F1;border-radius:12px"><tr><td style="padding:12px 16px;font-size:13px;line-height:1.5">📎 <b>${esc(j.outName)}</b><br><span style="color:${MUTED}">${esc(t.leadAtt)}</span></td></tr></table>`
    : `<p style="margin:0 0 20px;font-size:13px;color:${MUTED}">${esc(t.leadBig)}</p>`;

  const inner = `<h1 style="margin:0 0 10px;font-size:22px;line-height:1.35">✓ ${esc(t.hOk)}</h1>
<p style="margin:0 0 18px;font-size:14px;line-height:1.6">${esc(t.lead(ch))}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>${stat(c.ok, t.stOk)}${gap}${stat(c.rep, t.stRep, '#A15C00')}${gap}${stat(c.bad, t.stBad, c.bad ? '#C8241F' : INK)}${gap}${stat(rv, t.stRv, rv ? '#C8241F' : INK)}</tr></table>
${att}${rvBox}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">${row(t.file, j.outName || '')}${row(t.ch, ch)}${c.mins != null ? row(t.took, t.min(c.mins)) : ''}</table>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:0 8px 8px 0">${btn(open, t.open, true)}</td><td style="padding:0 0 8px">${btn(dl, t.dl, false)}</td></tr></table>
<div style="font-size:11px;color:#8C8A86;padding-top:4px">${esc(t.keep(RETENTION_DAYS))}</div>`;

  const text = [
    t.hOk, '', t.lead(ch), attached ? t.leadAtt : t.leadBig, '',
    `${t.stOk} ${c.ok} · ${t.stRep} ${c.rep} · ${t.stBad} ${c.bad} · ${t.stRv} ${rv}`,
    ...(rv ? ['', `${t.rvH}:`, ...c.rvItems.slice(0, SHOW).map((it) => `- ${nameOf(it)}: ${reasonOf(t, it)}`), ...(rv > SHOW ? [t.rvMore(rv - SHOW)] : []), t.rvHow] : []),
    '', `${t.file}: ${j.outName || ''}`, `${t.ch}: ${ch}`, ...(c.mins != null ? [`${t.took}: ${t.min(c.mins)}`] : []),
    '', `${t.open}: ${open}`, `${t.dl}: ${dl}`, t.keep(RETENTION_DAYS), '', t.foot,
  ].join('\n');
  return { subject: t.sOk(c.ok, rv), html: shell(L, t.pre(c.ok, rv), inner, t.foot), text };
}

module.exports = { build, TX };
