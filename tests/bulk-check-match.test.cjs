const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const JSZip = require('jszip');
const express = require('express');
const xlsx = require('../bulk-xlsx');
const catalog = require('../bulk-catalog');
const sitemap = require('../bulk-sitemap');
const match = require('../bulk-check-match');
const crawler = require('../crawler-routes');
const jobs = require('../bulk-jobs');
const store = require('../crawl-store');
const countries = require('../bulk-country');
const url = (code, country = 'sg') => `https://www.lg.com/${country}/washers/${code.toLowerCase()}/`;
const productHead = u => `<html><head><link href='${u}' rel='canonical'><script type='application/ld+json'>{"@type": "Product"}</script>`;

test('public LG product must have exact canonical and Product evidence, without robots exclusion', () => {
  const u = new URL(url('QA101'));
  assert.equal(match.pagePublic(productHead(u.href), u), true);
  assert.equal(match.pagePublic(productHead(u.href) + '<meta CONTENT="nofollow, NOINDEX" NAME="robots"/>', u), false);
  assert.equal(match.pagePublic(productHead(u.href), u, 'googlebot: noindex'), false);
  assert.equal(match.pagePublic(productHead(url('QA102')), u), false);
  assert.equal(match.pagePublic(productHead(url('QA101', 'th')), u), false);
  // 제품 정보가 없는 응답(봇 확인 페이지 등)은 '없음'이 아니라 '모름' — 매칭에서 빼지 않는다 (2026-11-28)
  assert.equal(match.pagePublic(`<link href='${u.href}' rel='canonical'>`, u), null);
  assert.equal(match.pagePublic('<title>Access check</title>', u), null);
});

async function workbook(status) {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Products" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  const rows = [
    ['et_title_product_id', 'et_title_parent_sku', 'et_title_product_name', 'et_title_product_description', 'Price', ...(status ? ['et_title_status'] : [])],
    ['1001','QAABB101.ATH','Public washer','original-2','102','Live'],
    ['1002','QAABB102','Hidden washer','original-3','103','Live'],
    ['1003','QAABB103','Deleted washer','original-4','104','Active'],
    ['1004','QAABB104','Inactive washer','original-5','105','Inactive'],
    ['1005','QAABB105','Missing washer','original-6','106','Live'],
    ['1006','QAABB106','LG blocked temporarily','original-7','107','Active'],
    ['1007','','Washer QAABB107','original-8','108','Active'],
    ['1008','QAABB101 + QAABB102','Bundle with hidden product','original-9','109','Live'],
    ['1009','QAABB101BAD','Not the verified SKU','original-10','110','Live'],
    ['1010','QAABB110','Only in Thailand','original-11','111','Live'],
    ['1011','QAABB111','Known but absent from sitemap','original-12','112','Live'],
    ['1012','QAABB112','New to CLIA and LG blocked temporarily','original-13','113','Live'],
  ];
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>' + rows.map((row, i) => `<row r="${i+1}">` + row.slice(0,status?6:5).map((v,j) => `<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${v.replaceAll('&','&amp;')}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>');
  return zip.generateAsync({type:'nodebuffer'});
}

test('Check uploads, authorizes only public matches, and downloads a workbook containing only the permitted changes', async t => {
  const selected = new Map();
  const productList = {};
  for (const code of ['QAABB101','QAABB102','QAABB103','QAABB104','QAABB106','QAABB107','QAABB111']) {
    const u = url(code); const slug = crawler.slugify(u);
    productList[slug] = { url:u, slug, country:'sg', model:code };
    if (!code.endsWith('111')) selected.set(code,[{url:u,lastmod:''}]);
  }
  selected.set('QAABB112',[{url:url('QAABB112'),lastmod:''}]);   // LG.com 사이트맵엔 있지만 CLIA 에 크롤된 적 없는 새 제품
  t.mock.method(catalog,'productIndex',()=>({products:productList,byModel:new Map(Object.values(productList).map(p=>[p.model,[p.slug]]))}));
  let sitemapDown = false;   // 사이트맵을 못 받는 경우(운영 서버에서 lg.com 이 막음)도 아래에서 확인
  t.mock.method(sitemap,'index',async (site)=>{if(sitemapDown)throw new Error('LG.com sitemap not available');return {idx:site==='sg' ? selected : new Map([['QAABB110', [{url:url('QAABB110','th')}]]])};});
  t.mock.method(countries, 'check', async ()=>null);
  t.mock.method(countries, 'remember', async ()=>{});
  t.mock.method(store, 'putBuffer', async ()=>{});
  const orig = global.fetch, contacted = [];
  t.mock.method(global,'fetch',async (request, options)=>{
    const u = new URL(request);
    if (u.hostname === '127.0.0.1') return orig(request, options);
    assert.equal(u.hostname,'www.lg.com');
    const sku=u.pathname.split('/').filter(Boolean).at(-1);
    contacted.push(sku);
    const status = sku.endsWith('103') ? 404 : sku.endsWith('106') || sku.endsWith('112') ? 503 : 200;
    const html=productHead(u.href)+(sku.endsWith('102') ? '<meta name="robots" content="noindex"/>' : '')+'</head></html>';
    return new Response(html,{status,headers:{'content-type':'text/html'}});
  });
  const made = [];
  const app=express(); app.use(express.json()); app.use(require('../bulk-routes').router);
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api/v1/bulk`;
  t.after(async ()=>{await new Promise(resolve=>server.close(resolve));for(const id of made)fs.rmSync(path.join(jobs.DIR,id),{recursive:true,force:true});});
  let j, rendered;
  t.mock.method(jobs,'create',opts=>{ j={...opts,id:opts.upload,status:'ready'}; return j; });
  t.mock.method(jobs,'getJob',async id=>j?.id===id ? j : null);
  t.mock.method(jobs,'jobView',()=>j);
  for (const status of [true,false]) {
    const bytes=await workbook(status);
    const upload=await fetch(base+'/upload?country=sg&name=shopee.xlsx&check=1',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes});
    const parsed=await upload.json(); assert.equal(upload.status,200,JSON.stringify(parsed)); made.push(parsed.id);
    assert.equal(parsed.rows.length,12);
    assert.equal(parsed.checkMatchBy,status?'status':'match');
    // 7(QAABB106) · 13(QAABB112): 사이트맵에 있고 LG.com 이 잠깐 막았을 뿐 → 포함 (2026-11-28). 4(QAABB103 404) · 3(QAABB102 noindex) → 원본 유지
    const allowed=status?[2,7,8,13]:[2,5,7,8,13];
    assert.deepEqual(parsed.rows.filter(r=>r.candidates.length||r.lg||r.bundleParts).map(r=>r.row),allowed);
    if(status)assert.ok(!contacted.includes('qaabb104'));
    // Malformed/mismatched UI item mappings do not widen the server output scope.
    const request={id:parsed.id,sheet:parsed.sheet,country:'sg',channel:'shopee',descCol:4,check:{},skus:{8:'DONT-WRITE'},items:parsed.rows.map(r=>({row:r.row,slug:crawler.slugify(url('QAABB102'))}))};
    const build=await fetch(base+'/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    assert.equal(build.status,200,JSON.stringify(await build.json()));
    assert.deepEqual(j.items.map(it=>it.row),allowed); assert.deepEqual(j.skus,[]);
    assert.equal(j.check.skipRows,12-allowed.length);
    assert.ok(j.items.every(it=>!!it.register===(it.row===13)&&!it.url.includes('qaabb102')));   // 13: CLIA 에 없던 새 제품 → 크롤해서 등록
    rendered=new Map();
    for(const it of j.items){it.status='ok';it.unified=true;it.hash='0123456789abcdefabcd';it.ai=[];it.check='ok';it.checkedHash=it.hash;it.checkedChannel='shopee';const text='https://cdn.example.test/'+it.model+'.jpg';it.contentDigest=createHash('sha256').update(text).digest('hex');it.checkedContentDigest=it.contentDigest;rendered.set(it.row,text);}
    await jobs._writeResult(j,rendered);
    const res=await fetch(base+'/jobs/'+j.id+'/file');assert.equal(res.status,200);
    const [before,after]=await Promise.all([xlsx.load(bytes),xlsx.load(Buffer.from(await res.arrayBuffer()))]);
    for(const [r,row] of before.sheets[0].rows)for(const [c,value] of row) {
      assert.equal(after.sheets[0].rows.get(r).get(c),c===4&&rendered.has(r)?rendered.get(r):value);
    }
  }
  // 사이트맵을 못 받으면: 이미 CLIA 에 크롤된 제품만 모델로 매칭, CLIA 에 없는 것(105 · 112)은 그대로 — 404 인 103 · noindex 인 102 는 여전히 빠짐
  sitemapDown = true;
  const down = await fetch(base+'/upload?country=sg&name=shopee.xlsx&check=1',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await workbook(true)});
  const downParsed = await down.json(); assert.equal(down.status,200,JSON.stringify(downParsed)); made.push(downParsed.id);
  assert.deepEqual(downParsed.rows.filter(r=>r.candidates.length||r.lg||r.bundleParts).map(r=>r.row),[2,7,8,12]);
});
