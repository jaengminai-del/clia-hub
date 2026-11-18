/**
 * bulk-xlsx.js — 마켓 벌크 엑셀(.xlsx) 읽기 + 칸 값만 바꿔 쓰기 (2026-11-18)
 *
 * Shopee mass update · Lazada export 파일은 서식·데이터 검증·숨은 시트가 많아 일반 라이브러리로 다시 쓰면 깨진다
 * (openpyxl 은 Shopee 파일을 못 읽었음). 그래서 압축을 풀어 시트 XML 의 해당 <c> 칸만 바꾸고, 나머지 파일은 그대로 둔다.
 *
 *   const wb = await load(buffer)
 *   wb.sheets            → [{ name, path, rows: Map<rowNo, Map<colNo, text>> }]
 *   wb.setCell(path, row, col, text)   (문자열 값. 공유 문자열 표에 추가)
 *   await wb.save()      → Buffer
 */
const JSZip = require('jszip');

const unesc = (s) => String(s).replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'"; if (k === 'amp') return '&';
  return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
// XML 에 넣을 수 없는 제어 문자는 뺀다 (탭·줄바꿈은 둔다)
const esc = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };

function colNo(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
const splitRef = (ref) => { const m = /^([A-Z]+)(\d+)$/i.exec(ref || ''); return m ? { col: colNo(m[1]), row: +m[2] } : null; };

// <si> 하나의 글자 (일반 <t> 또는 서식 있는 <r><t>; 읽는 법 표시 <rPh> 는 뺀다)
function siText(si) {
  const body = si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += m[1] ? unesc(m[1]) : '';
  return out;
}

// 시트 XML → 행 번호 → 열 번호 → 글자
function parseSheet(xml, sst) {
  const rows = new Map();
  const sd = /<sheetData\b[^>]*>([\s\S]*)<\/sheetData>/.exec(xml);
  if (!sd) return rows;
  let autoRow = 0;
  for (const rm of sd[1].matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = attr(rm[0].slice(0, rm[0].indexOf('>') + 1), 'r');
    const rowNo = rAttr ? +rAttr : autoRow + 1;
    autoRow = rowNo;
    const cells = new Map();
    let autoCol = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1];
      const ref = splitRef(attr(head, 'r'));
      const col = ref ? ref.col : autoCol + 1;
      autoCol = col;
      const t = attr(head, 't');
      const inner = cm[2] || '';
      let v = '';
      if (t === 'inlineStr') v = siText((/<is>([\s\S]*?)<\/is>/.exec(inner) || [, ''])[1]);
      else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vm) v = t === 's' ? (sst[+vm[1]] || '') : unesc(vm[1]);
      }
      if (v !== '') cells.set(col, v);
    }
    rows.set(rowNo, cells);
  }
  return rows;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
  return parts.join('/');
}

async function load(buf) {
  let zip;
  try { zip = await JSZip.loadAsync(buf); } catch (e) { throw new Error('not an .xlsx file (zip read failed)'); }
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  if (!wbXml) throw new Error('not an .xlsx file (xl/workbook.xml missing)');
  const relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) || '';
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) rels[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const sstPath = Object.values(rels).map((t) => resolvePath('xl/workbook.xml', t || '')).find((p) => /sharedStrings\.xml$/i.test(p))
    || (zip.file('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : null);
  let sstXml = sstPath ? await zip.file(sstPath).async('string') : null;
  const sst = sstXml ? [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => (m[1] ? siText(m[1]) : '')) : [];

  const sheets = [];
  const xmlByPath = {};
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
    const target = rels[rid];
    if (!target) continue;
    const p = resolvePath('xl/workbook.xml', target);
    const xml = await zip.file(p)?.async('string');
    if (!xml) continue;
    xmlByPath[p] = xml;
    sheets.push({ name: unesc(attr(m[0], 'name') || p), path: p, hidden: /state="(hidden|veryHidden)"/.test(m[0]), rows: parseSheet(xml, sst) });
  }

  const added = [];   // 새로 넣을 공유 문자열
  const sstIndex = new Map();
  const changed = new Set();

  function stringIndex(text) {
    if (sstIndex.has(text)) return sstIndex.get(text);
    const i = sst.length + added.length;
    added.push(text);
    sstIndex.set(text, i);
    return i;
  }

  // 그 칸을 문자열 값으로 바꾼다 — 칸의 서식(s)은 그대로, 없던 칸·행은 순서에 맞게 끼워 넣는다
  function setCell(path, row, col, text) {
    let xml = xmlByPath[path];
    if (!xml) throw new Error('sheet not found: ' + path);
    const ref = colName(col) + row;
    const value = String(text);
    const cellXml = (s) => (sstXml !== null
      ? `<c r="${ref}"${s ? ` s="${s}"` : ''} t="s"><v>${stringIndex(value)}</v></c>`
      : `<c r="${ref}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`);
    const rowRe = new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/row>)`);
    const rm = rowRe.exec(xml);
    if (!rm) {
      // 행이 없으면 행 번호 순서에 맞는 자리에 새 행
      const sdStart = xml.indexOf('<sheetData');
      const sdOpenEnd = xml.indexOf('>', sdStart) + 1;
      if (xml.slice(sdStart, sdOpenEnd).endsWith('/>')) {
        xml = xml.slice(0, sdStart) + `<sheetData><row r="${row}">${cellXml(null)}</row></sheetData>` + xml.slice(sdOpenEnd);
      } else {
        let at = xml.indexOf('</sheetData>');
        for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) { if (+m[1] > row) { at = m.index; break; } }
        xml = xml.slice(0, at) + `<row r="${row}">${cellXml(null)}</row>` + xml.slice(at);
      }
    } else {
      let rowXml = rm[0];
      if (rowXml.endsWith('/>')) rowXml = rowXml.slice(0, -2) + '></row>';
      const cRe = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`);
      const cm = cRe.exec(rowXml);
      if (cm) {
        rowXml = rowXml.slice(0, cm.index) + cellXml(attr(cm[0].slice(0, cm[0].indexOf('>') + 1), 's')) + rowXml.slice(cm.index + cm[0].length);
      } else {
        // 열 순서에 맞는 자리 (r 이 있는 칸 기준)
        let at = rowXml.lastIndexOf('</row>');
        for (const m of rowXml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) { if (colNo(m[1]) > col) { at = m.index; break; } }
        // 행 기본 서식(s + customFormat)이 있으면 새 칸도 그 서식
        const rowHead = rowXml.slice(0, rowXml.indexOf('>') + 1);
        const rs = /customFormat="(1|true)"/.test(rowHead) ? attr(rowHead, 's') : null;
        rowXml = rowXml.slice(0, at) + cellXml(rs) + rowXml.slice(at);
      }
      xml = xml.slice(0, rm.index) + rowXml + xml.slice(rm.index + rm[0].length);
    }
    xmlByPath[path] = xml;
    changed.add(path);
  }

  async function save() {
    for (const p of changed) {
      let xml = xmlByPath[p];
      // 칸 범위 표시(dimension)를 넓혀 둔다 — 범위 밖 칸을 무시하는 프로그램이 있다
      const dm = /<dimension\b[^>]*\bref="([A-Z]+\d+)(?::([A-Z]+\d+))?"[^>]*\/>/.exec(xml);
      if (dm) {
        let maxR = 0, maxC = 0;
        for (const m of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"/g)) { maxC = Math.max(maxC, colNo(m[1])); maxR = Math.max(maxR, +m[2]); }
        const a = splitRef(dm[1]);
        const b = splitRef(dm[2] || dm[1]);
        const ref = `${dm[1]}:${colName(Math.max(b.col, maxC))}${Math.max(b.row, maxR)}`;
        if (a) xml = xml.replace(dm[0], dm[0].replace(/ref="[^"]*"/, `ref="${ref}"`));
      }
      zip.file(p, xml);
    }
    if (added.length && sstXml !== null) {
      const extra = added.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('');
      if (/<sst\b[^>]*\/>/.test(sstXml)) sstXml = sstXml.replace(/<sst\b([^>]*)\/>/, '<sst$1></sst>');
      sstXml = sstXml.replace('</sst>', extra + '</sst>');
      const total = sst.length + added.length;
      // uniqueCount = 표의 항목 수, count = 모든 시트에서 공유 문자열을 쓰는 칸 수
      let uses = 0;
      for (const f of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
        const x = xmlByPath[f] || await zip.file(f).async('string');
        uses += (x.match(/<c\b[^>]*\bt="s"/g) || []).length;
      }
      sstXml = sstXml.replace(/<sst\b[^>]*>/, (h) => h.replace(/\buniqueCount="\d*"/, `uniqueCount="${total}"`)
        .replace(/\bcount="\d*"/, `count="${Math.max(uses, total)}"`));   // 바꿔서 안 쓰게 된 항목도 표에 남으므로 count ≥ uniqueCount 로
      zip.file(sstPath, sstXml);
      sst.push(...added); added.length = 0;
    }
    changed.clear();
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  return { sheets, setCell, save };
}

module.exports = { load, colName, colNo };
