/* bulk-check.js — 벌크 업로드 Check 단계 (?check=1 일 때만, 2026-11-26)
   흐름: 첨부 › 준비 › Check › 받기. 라이브 제품만 준비 · 모든 제품을 한 그리드에 나열하고 결과가 나오는 대로 칸마다 검토 필요만 빨강 (통과 칸엔 표시 없음) (2026-11-28 예시 A).
   - Status 칸이 있으면 Live/Active만, 없으면 모든 상품 행을 공개 LG.com 매칭 후보로 삼는다.
     매칭되지 않았거나 라이브가 아닌 행의 원래 내용은 그대로 둔다.
   - 건너뛴 수는 제품(모델) 기준 — 진행 막대와 같은 단위. 목록에는 엑셀 행 수도.
   - AI 체크는 서버가 계산(bulk-jobs.js aiChecks) · 화면은 기다리게 하지 않는다 (스캔 띠는 결과가 닿은 칸 위에서만).
   - 확인 = 승인 기록(approvals.js, via 'bulk' + 본 이미지 해시). 실제 다운로드 잠금은 APPROVAL_GATE 켤 때만.
   bulk.js 가 매칭(setData)까지 하고 BulkCheck.begin(core) 로 넘긴다. 기존 벌크 흐름은 그대로. */
(function () {
  const TX = {
    en: { steps: ['Attach', 'Prepare', 'Check', 'Download'], rows: (n) => `${n} rows`, prep: (a, b) => `Preparing ${a} / ${b}`, liveP: "matched products",
      skip: n=>`${n} products left unchanged`, view: 'View', hide: 'Hide', asOf: (d) => `Live list as of ${d}`, byStatus: 'From the Status column',
      skipRows: (n) => `${n} rows in the Excel — left as they are`, notLive: 'Not live', unknown: 'Unknown', none: "No eligible LG.com matches in this file.", unmatched: "LG.com match not verified",
      
      w_fail: "Couldn't prepare", w_retried: 'still there after a retry', redo: 'Prepare again', remove: 'Remove from this Excel',
      redoing: 'Preparing again', doneT: (n) => `${n} checked`, removed: (n) => `${n} removed`, skipped: n=>`${n} products left unchanged`, dl: 'Download Excel', err: 'Something went wrong: ', reviewChanged: 'The PDP changed. Review the updated version before confirming.' },
    th: { steps: ['แนบไฟล์', 'เตรียม', 'ตรวจ', 'ดาวน์โหลด'], rows: (n) => `${n} แถว`, prep: (a, b) => `กำลังเตรียม ${a} / ${b}`, liveP: "สินค้าที่จับคู่ได้",
      skip: n=>`คงเดิม ${n} รายการ`, view: 'ดู', hide: 'ซ่อน', asOf: (d) => `รายการไลฟ์ ณ ${d}`, byStatus: 'จากคอลัมน์ Status',
      skipRows: (n) => `${n} แถวใน Excel — คงไว้ตามเดิม`, notLive: 'ไม่ได้ไลฟ์', unknown: 'ไม่ทราบ', none: "ไม่พบสินค้าที่จับคู่กับ LG.com และเข้าเงื่อนไข", unmatched: "ยังยืนยันการจับคู่กับ LG.com ไม่ได้",
      
      w_fail: 'เตรียมไม่สำเร็จ', w_retried: 'ลองใหม่แล้วยังเหมือนเดิม', redo: 'เตรียมใหม่', remove: 'นำออกจาก Excel นี้',
      redoing: 'กำลังเตรียมใหม่', doneT: (n) => `ตรวจแล้ว ${n} รายการ`, removed: (n) => `นำออก ${n}`, skipped: n=>`คงเดิม ${n} รายการ`, dl: 'ดาวน์โหลด Excel', err: 'เกิดข้อผิดพลาด: ', reviewChanged: 'PDP มีการเปลี่ยนแปลง โปรดตรวจสอบฉบับล่าสุดก่อนยืนยัน' },
    ko: { steps: ['첨부', '준비', 'Check', '받기'], rows: (n) => `${n}행`, prep: (a, b) => `준비 중 ${a} / ${b}`, liveP: "매칭된 제품",
      skip: n=>`${n}개 제품 원본 유지`, view: '보기', hide: '닫기', asOf: (d) => `라이브 목록 기준일 ${d}`, byStatus: 'Status 칸 기준',
      skipRows: (n) => `엑셀 ${n}행 — 원래 내용 그대로`, notLive: '라이브 아님', unknown: '모름', none: "LG.com 공개 상품과 매칭된 대상이 없어요.", unmatched: "LG.com 매칭 미확인",
      
      w_fail: '준비 못 함', w_retried: '다시 해도 그대로', redo: '다시 준비', remove: '이번 엑셀에서 빼기',
      redoing: '다시 준비하는 중', doneT: (n) => `${n}개 확인 완료`, removed: (n) => `${n}개 뺌`, skipped: n=>`${n}개 제품 원본 유지`, dl: '엑셀 받기', err: '문제가 생겼어요: ', reviewChanged: 'PDP가 바뀌었어요. 최신 내용을 다시 보고 확인해 주세요.' },
    de: { steps: ['Anhängen', 'Vorbereiten', 'Prüfen', 'Herunterladen'], rows: (n) => `${n} Zeilen`, prep: (a, b) => `Vorbereitung ${a} / ${b}`, liveP: "zugeordnete Produkte",
      skip: n=>`${n} Produkte unverändert`, view: 'Ansehen', hide: 'Ausblenden', asOf: (d) => `Live-Liste vom ${d}`, byStatus: 'Aus der Spalte Status',
      skipRows: (n) => `${n} Zeilen in der Excel — bleiben unverändert`, notLive: 'Nicht live', unknown: 'Unbekannt', none: "Keine passenden LG.com-Produkte in der Datei.", unmatched: "LG.com-Zuordnung nicht bestätigt",
      
      w_fail: 'Vorbereitung fehlgeschlagen', w_retried: 'auch nach erneutem Versuch', redo: 'Neu vorbereiten', remove: 'Aus dieser Excel entfernen',
      redoing: 'Wird neu vorbereitet', doneT: (n) => `${n} geprüft`, removed: (n) => `${n} entfernt`, skipped: n=>`${n} Produkte unverändert`, dl: 'Excel herunterladen', err: 'Fehler: ', reviewChanged: 'Die PDP wurde geändert. Bitte prüfen Sie die aktuelle Version vor der Bestätigung.' },
    ar: { steps: ['إرفاق', 'تجهيز', 'تحقق', 'تنزيل'], rows: (n) => `${n} صف`, prep: (a, b) => `جارٍ التجهيز ${a} / ${b}`, liveP: "منتجات مطابقة",
      skip: n=>`${n} منتج دون تغيير`, view: 'عرض', hide: 'إخفاء', asOf: (d) => `قائمة النشط بتاريخ ${d}`, byStatus: 'من عمود Status',
      skipRows: (n) => `${n} صف في Excel — يبقى كما هو`, notLive: 'غير نشط', unknown: 'غير معروف', none: "لا توجد منتجات مطابقة مؤهلة على LG.com.", unmatched: "لم يتم تأكيد المطابقة على LG.com",
      
      w_fail: 'تعذّر التجهيز', w_retried: 'ما زال بعد إعادة المحاولة', redo: 'إعادة التجهيز', remove: 'إزالة من ملف Excel هذا',
      redoing: 'جارٍ إعادة التجهيز', doneT: (n) => `تم فحص ${n}`, removed: (n) => `أُزيل ${n}`, skipped: n=>`${n} منتج دون تغيير`, dl: 'تنزيل Excel', err: 'حدث خطأ: ', reviewChanged: 'تغيّرت صفحة تفاصيل المنتج. راجع النسخة المحدّثة قبل التأكيد.' },
  };
  // Check 화면 (덱 2026-11-27 → 그리드 2026-11-28) 문구 — 위 TX 에 덧붙인다
  const TXD = {
    en: { rmS: 'Remove', viewAll: (n) => `View all ${n}`, moreBelow: 'More below', back: '← Back', prev: 'Previous', next: 'Next', removedL: 'Removed from this Excel', fReady: 'Ready', fReview: 'Needs review', aiChk: 'AI checking', goDl: 'Confirm & download',
      okIn: 'Looks fine · include',
      rsNeed: (n) => (n === 1 ? `${n} PDP needs to be checked` : `${n} PDPs need to be checked`), rsAll: (n) => `All ${n} PDPs are ready`, rv: 'Review', redoN: (n) => `Preparing ${n} again…`,
      rcCrawl: 'Re-crawling from lg.com…', rcDraw: 'Preparing the PDP again…', rcWait: 'Waiting to retry…', rcHint: 'Checked when it succeeds', chk: 'Checked',
      allDone: 'All checked', colModel: 'Model', colDesc: 'Description', imgsN: (n) => `${n} images`, moreRows: (n) => `+ ${n} more rows`, confirmDl: (n) => `Confirm ${n} & download` },
    th: { rmS: 'นำออก', viewAll: (n) => `ดูทั้งหมด ${n}`, moreBelow: 'ยังมีด้านล่าง', back: '← กลับ', prev: 'ก่อนหน้า', next: 'ถัดไป', removedL: 'นำออกจาก Excel นี้แล้ว', fReady: 'พร้อม', fReview: 'ต้องตรวจสอบ', aiChk: 'AI กำลังตรวจ', goDl: 'ยืนยันและดาวน์โหลด',
      okIn: 'ดูแล้วโอเค · ใส่ไว้',
      rsNeed: (n) => `PDP ที่ต้องตรวจสอบ ${n} รายการ`, rsAll: (n) => `PDP ทั้ง ${n} รายการพร้อมแล้ว`, rv: 'ตรวจสอบ', redoN: (n) => `กำลังเตรียมใหม่ ${n} รายการ…`,
      rcCrawl: 'กำลังดึงข้อมูลจาก lg.com ใหม่…', rcDraw: 'กำลังเตรียม PDP ใหม่…', rcWait: 'รอลองใหม่…', rcHint: 'สำเร็จแล้วจะเป็น “ตรวจแล้ว”', chk: 'ตรวจแล้ว',
      allDone: 'ตรวจครบแล้ว', colModel: 'รุ่น', colDesc: 'คำอธิบาย', imgsN: (n) => `${n} รูป`, moreRows: (n) => `+ อีก ${n} แถว`, confirmDl: (n) => `ยืนยัน ${n} และดาวน์โหลด` },
    ko: { rmS: '빼기', viewAll: (n) => `전체 보기 ${n}`, moreBelow: '아래에 더 있음', back: '← 돌아가기', prev: '이전', next: '다음', removedL: '이번 엑셀에서 뺌', fReady: '준비됨', fReview: '검토 필요', aiChk: 'AI 확인 중', goDl: '확인하고 받기',
      okIn: '괜찮음 · 포함',
      rsNeed: (n) => `확인이 필요한 PDP ${n}개`, rsAll: (n) => `PDP ${n}개 모두 준비됨`, rv: '검토', redoN: (n) => `${n}개 다시 준비 중…`,
      rcCrawl: 'lg.com에서 다시 크롤링 중…', rcDraw: 'PDP 다시 만드는 중…', rcWait: '다시 시도 대기 중…', rcHint: '성공하면 확인됨으로 바뀌어요', chk: '확인됨',
      allDone: '모두 확인함', colModel: '모델', colDesc: '설명', imgsN: (n) => `이미지 ${n}장`, moreRows: (n) => `+ ${n}행 더`, confirmDl: (n) => `${n}개 확인하고 받기` },
    de: { rmS: 'Entfernen', viewAll: (n) => `Alle ${n} ansehen`, moreBelow: 'Weiter unten', back: '← Zurück', prev: 'Zurück', next: 'Weiter', removedL: 'Aus dieser Excel entfernt', fReady: 'Bereit', fReview: 'Zu prüfen', aiChk: 'KI prüft', goDl: 'Bestätigen & herunterladen',
      okIn: 'Passt · übernehmen',
      rsNeed: (n) => (n === 1 ? `${n} PDP muss geprüft werden` : `${n} PDPs müssen geprüft werden`), rsAll: (n) => `Alle ${n} PDPs sind bereit`, rv: 'Prüfen', redoN: (n) => `${n} werden neu vorbereitet…`,
      rcCrawl: 'Wird neu von lg.com geladen…', rcDraw: 'PDP wird neu erstellt…', rcWait: 'Wartet auf neuen Versuch…', rcHint: 'Bei Erfolg als geprüft markiert', chk: 'Geprüft',
      allDone: 'Alles geprüft', colModel: 'Modell', colDesc: 'Beschreibung', imgsN: (n) => `${n} Bilder`, moreRows: (n) => `+ ${n} weitere Zeilen`, confirmDl: (n) => `${n} bestätigen & herunterladen` },
    ar: { rmS: 'إزالة', viewAll: (n) => `عرض الكل ${n}`, moreBelow: 'المزيد بالأسفل', back: 'رجوع →', prev: 'السابق', next: 'التالي', removedL: 'أُزيل من ملف Excel هذا', fReady: 'جاهز', fReview: 'بحاجة إلى مراجعة', aiChk: 'الذكاء الاصطناعي يفحص', goDl: 'تأكيد وتنزيل',
      okIn: 'يبدو جيدًا · تضمين',
      rsNeed: (n) => `${n} صفحات تفاصيل تحتاج إلى مراجعة`, rsAll: (n) => `جميع صفحات التفاصيل (${n}) جاهزة`, rv: 'مراجعة', redoN: (n) => `جارٍ إعادة تجهيز ${n}…`,
      rcCrawl: 'جارٍ الجلب من lg.com مجددًا…', rcDraw: 'جارٍ تجهيز صفحة التفاصيل مجددًا…', rcWait: 'بانتظار إعادة المحاولة…', rcHint: 'ستُعلَّم كمُتحقَّق منها عند النجاح', chk: 'تم التحقق',
      allDone: 'تم فحص الكل', colModel: 'الطراز', colDesc: 'الوصف', imgsN: (n) => `${n} صور`, moreRows: (n) => `+ ${n} صفوف أخرى`, confirmDl: (n) => `تأكيد ${n} والتنزيل` },
  };
  // 문제 문구 (2026-11-27 장혁 피드백 '단순하게'): 오른쪽 칸 맨 위 큰 한 문장 · 다섯 언어 같은 톤. w_* 는 그리드 칸 아래 짧은 글
  const TXP = {
    en: { fam: { dish: 'Dishwasher', tower: 'WashTower', wd: 'Washer-dryer', styler: 'Styler', dryer: 'Dryer', washer: 'Washer', fridge: 'Refrigerator', buds: 'Earbuds', soundbar: 'Soundbar', speaker: 'Speaker', monitor: 'Monitor', tv: 'TV', ac: 'Air conditioner', purifier: 'Air purifier', dehum: 'Dehumidifier', micro: 'Microwave', vacuum: 'Vacuum', laptop: 'Laptop', projector: 'Projector' },
      bImg: 'lg.com image is missing', bLines: 'lg.com text is missing', bSum: 'Thai summary not made', bSpec: 'lg.com spec table is missing', bFail: "PDP couldn't be made", noOrig: 'Original image unavailable', noLocation: 'Location in PDP unknown', bSpecUnknown: 'Could not verify lg.com specifications', bPreview: 'Excel PDP needs to be prepared again', bLimit: 'Shopee limits cut off part of the Excel PDP',
      w_img: (n) => `${n} missing image${n === 1 ? '' : 's'}`, w_txt: (n) => `${n} missing line${n === 1 ? '' : 's'}`, w_spec: 'Missing spec table', w_sum: 'No Thai summary', nextP: 'Next' },
    th: { fam: { dish: 'เครื่องล้างจาน', tower: 'WashTower', wd: 'เครื่องซักอบผ้า', styler: 'สไตเลอร์', dryer: 'เครื่องอบผ้า', washer: 'เครื่องซักผ้า', fridge: 'ตู้เย็น', buds: 'หูฟังไร้สาย', soundbar: 'ซาวด์บาร์', speaker: 'ลำโพง', monitor: 'จอมอนิเตอร์', tv: 'ทีวี', ac: 'เครื่องปรับอากาศ', purifier: 'เครื่องฟอกอากาศ', dehum: 'เครื่องลดความชื้น', micro: 'ไมโครเวฟ', vacuum: 'เครื่องดูดฝุ่น', laptop: 'แล็ปท็อป', projector: 'โปรเจคเตอร์' },
      bImg: 'รูปจาก lg.com หายไป', bLines: 'ข้อความจาก lg.com หายไป', bSum: 'สร้างสรุปภาษาไทยไม่ได้', bSpec: 'ตารางสเปกจาก lg.com หายไป', bFail: 'สร้าง PDP ไม่ได้', noOrig: 'โหลดรูปต้นฉบับไม่ได้', noLocation: 'ไม่ทราบตำแหน่งใน PDP', bSpecUnknown: 'ตรวจสอบสเปกจาก lg.com ไม่ได้', bPreview: 'ต้องเตรียม PDP สำหรับ Excel ใหม่', bLimit: 'ข้อจำกัดของ Shopee ตัดเนื้อหา PDP ใน Excel',
      w_img: (n) => `รูปหายไป ${n} รูป`, w_txt: (n) => `ข้อความหายไป ${n} บรรทัด`, w_spec: 'ตารางสเปกหายไป', w_sum: 'ไม่มีสรุปภาษาไทย', nextP: 'ถัดไป' },
    ko: { fam: { dish: '식기세척기', tower: '워시타워', wd: '세탁건조기', styler: '스타일러', dryer: '건조기', washer: '세탁기', fridge: '냉장고', buds: '이어버드', soundbar: '사운드바', speaker: '스피커', monitor: '모니터', tv: 'TV', ac: '에어컨', purifier: '공기청정기', dehum: '제습기', micro: '전자레인지', vacuum: '청소기', laptop: '노트북', projector: '프로젝터' },
      bImg: 'lg.com 원본 이미지가 빠졌어요', bLines: 'lg.com 원본 문구가 빠졌어요', bSum: '태국어 요약을 못 만들었어요', bSpec: 'lg.com 원본 스펙 표가 빠졌어요', bFail: 'PDP를 만들지 못했어요', noOrig: '원본 이미지를 표시할 수 없어요', noLocation: 'PDP에서 위치를 확인할 수 없어요', bSpecUnknown: 'lg.com 원본 스펙을 확인할 수 없어요', bPreview: 'Excel용 PDP를 다시 준비해야 해요', bLimit: 'Shopee 제한으로 Excel에 PDP 전체를 담지 못했어요',
      w_img: (n) => `빠진 이미지 ${n}장`, w_txt: (n) => `빠진 문구 ${n}줄`, w_spec: '빠진 스펙 표', w_sum: '태국어 요약 없음', nextP: '다음' },
    de: { fam: { dish: 'Geschirrspüler', tower: 'WashTower', wd: 'Waschtrockner', styler: 'Styler', dryer: 'Trockner', washer: 'Waschmaschine', fridge: 'Kühlschrank', buds: 'Ohrhörer', soundbar: 'Soundbar', speaker: 'Lautsprecher', monitor: 'Monitor', tv: 'Fernseher', ac: 'Klimaanlage', purifier: 'Luftreiniger', dehum: 'Luftentfeuchter', micro: 'Mikrowelle', vacuum: 'Staubsauger', laptop: 'Laptop', projector: 'Beamer' },
      bImg: 'lg.com-Bild fehlt', bLines: 'lg.com-Text fehlt', bSum: 'Thai-Zusammenfassung fehlt', bSpec: 'lg.com-Datentabelle fehlt', bFail: 'PDP nicht erstellt', noOrig: 'Originalbild nicht verfügbar', noLocation: 'Position in der PDP unbekannt', bSpecUnknown: 'lg.com-Spezifikationen konnten nicht geprüft werden', bPreview: 'Excel-PDP muss neu vorbereitet werden', bLimit: 'Das Shopee-Limit kürzt die Excel-PDP',
      w_img: (n) => `${n} fehlende(s) Bild(er)`, w_txt: (n) => `${n} fehlende Zeile(n)`, w_spec: 'Fehlende Datentabelle', w_sum: 'Keine thailändische Zusammenfassung', nextP: 'Weiter' },
    ar: { fam: { dish: 'غسالة صحون', tower: 'WashTower', wd: 'غسالة ومجففة', styler: 'ستايلر', dryer: 'مجفف ملابس', washer: 'غسالة', fridge: 'ثلاجة', buds: 'سماعات أذن', soundbar: 'ساوندبار', speaker: 'مكبر صوت', monitor: 'شاشة', tv: 'تلفزيون', ac: 'مكيف هواء', purifier: 'منقي هواء', dehum: 'مزيل رطوبة', micro: 'ميكروويف', vacuum: 'مكنسة كهربائية', laptop: 'حاسوب محمول', projector: 'جهاز عرض' },
      bImg: 'صورة lg.com مفقودة', bLines: 'نص lg.com مفقود', bSum: 'لم يُنشأ الملخص التايلاندي', bSpec: 'جدول مواصفات lg.com مفقود', bFail: 'تعذّر إنشاء PDP', noOrig: 'الصورة الأصلية غير متاحة', noLocation: 'الموضع في صفحة التفاصيل غير معروف', bSpecUnknown: 'تعذّر التحقق من مواصفات lg.com', bPreview: 'يجب إعادة تجهيز صفحة التفاصيل لملف Excel', bLimit: 'حدود Shopee قطعت جزءًا من صفحة التفاصيل في Excel',
      w_img: (n) => `${n} صورة مفقودة`, w_txt: (n) => `${n} سطر مفقود`, w_spec: 'جدول مواصفات مفقود', w_sum: 'لا يوجد ملخص تايلاندي', nextP: 'التالي' },
  };
  const tOf = (L) => Object.assign({}, TX.en, TXD.en, TXP.en, TX[L] || {}, TXD[L] || {}, TXP[L] || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DN = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
  const CK = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>', XX = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  let C = null;   // { core, T, job, units, idx, skip, el }

  const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? `${m[2]}/${m[3]}` : s; };   // 11/05
  const modelOf = (r) => (r.p && r.p.model) || String(r.parentSku || r.sku || '').split('.')[0] || String(r.name || '').slice(0, 40) || '—';

  // Status is optional. The server only supplies verified public PDP matches.
  function classify(core) {
    const { S, d } = core;
    const hasStatus = !!d.cols?.status;
    const live = [], skip = [];
    for (const r of [...S.ok, ...S.reg, ...S.skip]) {
      const isProduct = ['clia', 'new', 'bundle'].includes(r.kind);
      const eligible = !hasStatus || /^(live|active)$/i.test(String(r.status || '').trim());
      if (eligible && isProduct) live.push(r);
      else skip.push({ r, model: modelOf(r), status: eligible ? 'unmatched' : r.status || 'unknown' });
    }
    const models = new Map();
    for (const x of skip) {
      const k = x.model.toUpperCase() + ':' + x.status;
      if (!models.has(k)) models.set(k, { model: x.model, status: x.status, rows: 0 });
      models.get(k).rows++;
    }
    return { live, skip, models: [...models.values()], by: hasStatus ? 'status' : 'match', asOf: '' };
  }

  // ── 화면 틀 ──
  function steps(core, step) {
    const T = C.T;
    let st = document.getElementById('ckSteps');
    if (!st) { st = document.createElement('div'); st.id = 'ckSteps'; st.className = 'ck-steps'; document.querySelector('.hd').after(st); }
    st.innerHTML = T.steps.map((x, i) => `<span class="ck-st ${i < step ? 'ck-d' : i === step ? 'ck-o' : ''}">${core.esc(x)}</span>`).join('<span class="ck-sep">›</span>');
  }
  function frame(core, step, full) {   // full: 화면 전체 틀 (검수 · 끝 · 완료 — 버튼 줄이 늘 같은 자리)
    steps(core, step);
    document.querySelector('.body').classList.add('hidden');
    let el = document.getElementById('ck');
    if (!el) { el = document.createElement('div'); el.id = 'ck'; el.className = 'ck'; document.querySelector('.body').after(el); }
    el.classList.toggle('ck-full', step === 2 || !!full);
    return el;
  }
  const units = (j) => {   // 한 제품 = 같은 제품의 행들 (진행 막대 · 건너뜀 수와 같은 단위)
    const m = new Map();
    for (const it of j.items || []) { const k = it.bundle ? 'b:' + it.row : it.slug || it.url || 'r:' + it.row; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return [...m.values()];
  };
  const uDone = (u) => u.every((x) => x.status === 'ok' || x.status === 'failed' || x.status === 'cancelled');

  function prepView(core) {
    const T = C.T, e = core.esc, j = C.job, us = j ? units(j) : null;
    const total = us ? us.length : C.liveN, done = us ? us.filter(uDone).length : 0;
    const sk = C.skip;
    const el = frame(core, 1);
    el.innerHTML = `<div class="ck-wrap"><div class="ck-card">
      <div class="ck-file"><svg viewBox="0 0 24 24"><path d="M4 3h11l5 5v13H4z"/><path d="M15 3v5h5"/></svg><b>${e(C.fileName)}</b><span>${e(T.rows(C.rowsN))}</span></div>
      ${total ? `<div class="ck-pt">${e(T.prep(done, total))}<span>${e(T.liveP)}</span></div><div class="ck-bar"><i style="width:${total ? done / total * 100 : 0}%"></i></div>` : `<div class="ck-pt">${e(T.none)}</div>`}
      ${sk.n ? `<div class="ck-skip">${e(T.skip(sk.n))} ${sk.models.length ? `<a href="#" id="ckView">${e(C.open ? T.hide : T.view)}</a>` : ''}<span class="ck-src">${e(sk.by === 'status' ? T.byStatus : sk.asOf ? T.asOf(fmtDate(sk.asOf)) : '')}</span></div>
        ${C.open ? `<div class="ck-sl"><div class="ck-slh">${e(T.skipRows(sk.rows))}</div>${sk.models.map((x) => `<div><span>${e(x.model)}</span><span class="ck-m">${e(x.status === 'unmatched' ? T.unmatched : x.status === 'unknown' ? T.unknown : x.status || T.notLive)}${x.rows > 1 ? ` · ${e(T.rows(x.rows))}` : ''}</span></div>`).join('')}</div>` : ''}` : ''}
    </div></div>`;
    const v = document.getElementById('ckView'); if (v) v.onclick = (ev) => { ev.preventDefault(); C.open = !C.open; prepView(core); };
  }

  // ── Check: 전체 그리드 (2026-11-28 결정 · 예시 A — 덱 · 양쪽 더미를 대신) ──
  // 처음부터 모든 제품이 한 그리드에 칸으로 있고, 서버(bulk-jobs.js CONTENT_CONC)의 결과가 닿는 대로 그 칸만 스캔 띠가 한 번 훑는다 →
  // 통과 칸엔 표시를 두지 않고(11/28), 검토 필요는 빨간 테두리 + 문제 자리 빨간 칸(PDP 를 그 자리까지 내려 둠). 연출 때문에 기다리게 하지 않는다 — 몰리면 간격을 줄인다.
  // 위 고정 줄: 가운데 큰 숫자(진행 중엔 'AI 확인 중 n / N' + 얇은 막대) · 버튼은 늘 같은 자리(끝 쪽) — '검토 N' · '확인하고 받기'.
  // 사람이 정할 것은 목록으로 늘어놓지 않는다 (2026-11-28 장혁 피드백): 하나씩 검수 화면(viewer 'review') — 가운데 큰 카드 · 비교 칸 · 위 고정 버튼 셋,
  // 하나 정하면 다음으로. 돌아가기는 그리드로, 다 정하면 끝 화면(확인하고 받기).
  // 결과 화면 (2026-11-28 장혁 시안 확정): 첫 판이 끝나면 바로(자동 재시도를 기다리지 않음 — 운영 140개에서 4분 반을 헛기다림) 장면이 바뀐다 —
  // 그리드는 사라지고 확인이 필요한 PDP 만 위쪽에 큰 칸으로 한 줄(문제 자리까지 내려 둠 · 빨간 칸), 가운데 위 '확인이 필요한 PDP 6개'(검정 · 숫자와 글 같은 크기)
  // 바로 아래 가운데 버튼 하나 '검토' — 다음 화면(검수 화면)의 'n / N' · 버튼 줄과 같은 자리. 저절로 넘어가지 않음(Enter 도). 0개면 '모두 준비됨' + 확인하고 받기.
  // 모션: 스프링(stiffness 260 · damping 26, 라이브러리 없이 linear() 이징)으로 아주 조금 올라옴 — PDP 14px(50ms 차례) · 머리글 8px · 검수 화면 가운데 카드 16px.
  // 자동 재시도 중인 것도 그 줄에 — 칸 아래 찾은 문제 · 지금 하는 일(lg.com 다시 크롤 · PDP 다시 그림 · 차례 기다림) · '성공하면 확인됨',
  // 다시 크롤 · 그림 중이면 띠가 천천히 반복해 훑는다(보이는 칸만). 계속 물어보다 통과하면 잠깐 ✓ 확인됨 → 줄에서 빠지고 숫자가 줄어든다(다 빠지면 '모두 준비됨').
  // 결과 화면은 한 번만 (돌아온 뒤엔 위 '검토' 버튼으로).
  // 칸을 누르면 그 제품의 자세히 보기(viewer 'all'), 돌아오면 같은 상태.
  // 자동 재시도는 서버가 뒤에서 — 고쳐지면 그 칸이 준비됨으로 옮겨 간다. 100~300개여도 부드럽게: 작은 미리보기 앞 몇 장만 · lazy, 연출은 보이는 몇십 개만.
  const small = (u) => String(u || '').replace('/media/slices/', '/media/slices-p/');
  const ukey = (u) => (u[0].bundle ? 'b:' + u[0].row : u[0].slug || u[0].url || 'r:' + u[0].row);
  // 제품군 (2026-11-27 장혁 피드백): 크롤 데이터엔 카테고리가 따로 없어 lg.com 주소의 카테고리 경로로 — 묶음은 첫 구성품.
  //   순서가 중요하다 (워시타워 · 세탁건조기 · 식기세척기가 '세탁'보다 먼저, 'tv-soundbars/qned' 는 TV · 'speakers/soundbars' 는 사운드바)
  const FAM_RULES = [['dish', /dishwasher|geschirrsp/], ['tower', /wash-?tower/], ['wd', /washer-dryer|waschtrockner/], ['styler', /styler/], ['dryer', /(?<!washers-)dryers?|trockner/],
    ['washer', /wash|waesche|laundry/], ['fridge', /refrigerator|fridge|freezer|kuehl/], ['buds', /earbuds|xboombuds/], ['soundbar', /(speakers|lautsprecher)[\/-]soundbars?|\/soundbars?\//],
    ['speaker', /speaker|xboom|lautsprecher|soundsuite/], ['monitor', /monitor/], ['tv', /(^|[\/-])tvs?([\/-]|$)|qned|oled|nanocell|uhd|lifestyle-screens|stanbyme|fernseher/],
    ['ac', /air-condition|klimaanlage/], ['dehum', /dehumidifier|entfeuchter/], ['purifier', /puricare|purifier|luftreiniger/], ['micro', /microwave|mikrowelle/],
    ['vacuum', /vacuum|staubsauger/], ['laptop', /gram|laptop|notebook/], ['projector', /projector|beamer/]];
  function familyOf(u) {
    const it = u[0], b = (it.bundle || [])[0] || {};
    const s = String(it.bundle ? b.url || b.slug || '' : it.url || it.slug || '').toLowerCase().replace(/^https?:\/\/[^/]+\/[a-z_]+\//, '').replace(/^www-lg-com-[a-z_]+-/, '');
    const hit = FAM_RULES.find(([, re]) => re.test(s));
    return hit ? (C.T.fam[hit[0]] || '') : '';
  }
  const aiRows = (u) => (u[0].status === 'failed' ? [{ k: 'fail', ok: false, msg: u[0].error }] : u[0].ai || []);
  // 이미지: 슬라이스에서 못 가져온 것이나 크롤에서 빠진 것이나 사람 눈에는 같은 '빠진 이미지'
  const whyImg = (x) => C.T.w_img(x.n);
  const why = (x) => ({ img: () => whyImg(x), txt: () => C.T.w_txt(x.n), sum: () => C.T.w_sum, spec: () => x.unknown ? C.T.bSpecUnknown : C.T.w_spec, preview: () => C.T.bPreview, n12: () => C.T.bLimit, fail: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : ''), redo: () => C.T.w_fail + (x.msg ? ' — ' + x.msg : '') }[x.k] || (() => x.k))();
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  const EZ = { out: 'cubic-bezier(.16,1,.3,1)', p3out: 'cubic-bezier(.33,1,.68,1)', p3in: 'cubic-bezier(.32,0,.67,0)', io: 'cubic-bezier(.45,0,.55,1)' };
  const busy = (u) => u.some((x) => x.status === 'working' || x.retrying);
  // 자동 재시도에서 지금 하는 일 (2026-11-28, 서버 retryLater 가 it.redo 를 둔다): crawl lg.com 다시 크롤 · draw PDP 다시 그림 · 없으면 차례 기다림. 사람이 누른 '다시 준비'는 null
  const redoOf = (u) => { const it = u.find((x) => x.retrying); return !it ? null : it.redo === 'crawl' || it.redo === 'draw' ? it.redo : 'wait'; };
  const redoLine = (u) => ({ crawl: C.T.rcCrawl, draw: C.T.rcDraw, wait: C.T.rcWait }[redoOf(u)] || C.T.redoing);
  const settled = (u) => u.every((x) => x.status === 'ok' || x.status === 'failed' || x.status === 'cancelled');
  const passed = (u) => !busy(u) && u.every((x) => x.status === 'ok') && aiRows(u).every((x) => x.ok);
  const isRemoved = (u) => u.every((x) => x.check === 'removed');
  const isOk = (u) => u.every((x) => x.check === 'ok');

  const rel = (el) => { const a = el.getBoundingClientRect(), b = C.dk.root.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
  function problems(it) {
    if (it.status === 'failed') return [{ kind: 'fail' }];
    const out = [];
    for (const check of it.ai || []) {
      if (check.ok) continue;
      if (check.k === 'img') {
        const broken = (check.at || []).filter((b) => !b.lgGone);
        for (const b of broken) out.push({ kind: 'img', src: b.src, regions: b.regions || [b] });
        const missing = check.issues || (check.src || []).map((src) => ({ src }));
        for (const issue of missing) out.push({ kind: 'img', ...issue });
        if ((check.bad || 0) > broken.length || (check.lg || 0) > missing.length || (!broken.length && !missing.length)) {
          out.push({ kind: 'img' });
        }
      } else if (check.k === 'txt' || check.k === 'spec' || check.k === 'sum' || check.k === 'preview' || check.k === 'n12') {
        const kind = check.k === 'txt' ? 'lines' : check.unknown && check.k === 'spec' ? 'specUnknown' : check.k;
        const issues = check.issues && check.issues.length ? check.issues : [{ lines: check.lines }];
        for (const issue of issues) out.push({ kind: check.k === 'spec' && issue.unknown ? 'specUnknown' : kind, ...issue });
      }
    }
    return out;
  }

  const pdpImgs = it => it.imgs || [];
  // 문제 자리 (issues[].regions — 몇 번째 장 slice · y · h · x · w, 장 안의 비율): 장마다 [{ i: 문제 번호, … }]. 검수 카드 · 그리드 칸이 같이 쓴다
  function regionsBySlice(issues, n) {
    const out = Array.from({ length: n }, () => []);
    issues.forEach((issue, i) => {
      for (const r of issue.regions || []) {
        if (!out[r.slice - 1] || !Number.isFinite(r.y) || !Number.isFinite(r.h) ||
            r.y < 0 || r.y >= 1 || r.h <= 0 || r.h > 1) continue;
        const x = r.x ?? 0, w = r.w ?? 1;
        if (!Number.isFinite(x) || !Number.isFinite(w) || x < 0 || w <= 0 || x + w > 1.00001) continue;
        out[r.slice - 1].push({ i, kind: issue.kind, gone: r.kind === 'gone', y: r.y, h: r.h, x, w });
      }
    });
    return out;
  }
  function cardEl(core, u) {
    const e = core.esc, it = u[0], issues = problems(it);
    const images = it.status === 'failed' ? [] : pdpImgs(it);
    const marks = regionsBySlice(issues, images.length).map((ms) => ms.map((m) =>
      `<span class="dk-bad${m.gone ? ' gone' : ''}${m.kind === 'img' ? '' : ' dk-copy-mark'}" data-issue="${m.i}" aria-hidden="true" style="top:${m.y * 100}%;height:${m.h * 100}%;left:${m.x * 100}%;width:${m.w * 100}%"></span>`));
    const slices = images.map((src, k) =>
      `<span class="dk-si"><img src="${e(small(src))}" alt="" decoding="async">${marks[k].join('')}</span>`).join('');
    const el = document.createElement('div'); el.className = 'dk-card';
    const detail = `<div class="ck-imgs">${slices}</div>`;
    const body = images.length && window.CliaMarket ? CliaMarket.page(C.job.channel, { body: detail }) : detail;
    el._issues = issues;
    el._content = JSON.stringify([it.status === 'failed', pdpImgs(it), it.ai]);
    el.innerHTML = `<div class="dk-ph"><div class="dk-sc">${body}</div></div><div class="dk-mo">${e(it.model || '')}</div><div class="dk-st"></div>`;
    C.dk.root.appendChild(el); cardState(el, u); return el;
  }
  function cardState(el, u) {
    const bad = aiRows(u).filter((x) => !x.ok);
    el.classList.toggle('dk-busy', busy(u)); el.classList.toggle('dk-ok', passed(u)); el.classList.toggle('dk-rm', isRemoved(u));
    // 사람이 정할 문제가 남은 카드: 나머지 장은 어둡게, 문제 장만 선명하게 (CSS .dk-prob)
    el.classList.toggle('dk-prob', !passed(u) && !isRemoved(u) && !busy(u) && !isOk(u) && el._issues.length > 0);
    el.querySelector('.dk-st').textContent = isRemoved(u) ? C.T.removedL : busy(u) ? C.T.redoing
      : passed(u) ? C.T.fReady : bad.map(why).join(' · ');
  }
  async function refresh(core) { try { C.job = await core.api('/api/v1/bulk/jobs/' + C.job.id); C.units = units(C.job); } catch (_) {} }
  const running = () => C.job.status === 'running' || C.job.status === 'queued';
  const needs = () => C.units.filter((u) => !isRemoved(u) && !isOk(u) && !passed(u));   // 사람이 아직 정하지 않은 것 (다시 준비 중 포함)
  // 칸 상태: wait(결과 전) · ok(통과) · bad(검토 필요) · busy(다시 준비 중) · in(사람이 포함) · out(뺌)
  const catOf = (u, landed) => (!landed ? 'wait' : isRemoved(u) ? 'out' : busy(u) ? 'busy' : passed(u) ? 'ok' : isOk(u) ? 'in' : 'bad');
  // Framer Motion 식 스프링을 라이브러리 없이: 물리 시뮬레이션 → CSS linear() 이징 + 실제 길이(ms). linear() 를 모르는 브라우저는 EZ.out
  function spring({ stiffness = 260, damping = 26, mass = 1 } = {}) {
    let x = 0, v = 0, t = 0; const dt = 1 / 240, pts = [];
    for (; t < 3; t += dt) { v += ((-stiffness * (x - 1) - damping * v) / mass) * dt; x += v * dt; pts.push(x); if (t > 0.1 && Math.abs(1 - x) < 0.0005 && Math.abs(v) < 0.001) break; }
    const out = []; for (let i = 0; i <= 48; i++) out.push(pts[Math.min(pts.length - 1, Math.round((pts.length - 1) * i / 48))].toFixed(4));
    const ease = `linear(${out.join(',')})`, ok = (() => { try { return CSS.supports('animation-timing-function', ease); } catch (_) { return false; } })();
    return { easing: ok ? ease : EZ.out, duration: Math.round(t * 1000) };
  }
  const SPR = spring();
  // 아래에서 아주 조금 올라오며 나타남 (위치는 transform 만) — 모션 줄이기면 움직이지 않음
  const rise = (x, dy, delay = 0) => (reduced() || !x ? null : x.animate([{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: SPR.duration, easing: SPR.easing, delay, fill: 'backwards' }));
  const fadeIn = (x, ms, dy) => (reduced() ? null : x.animate([{ opacity: 0, transform: `translateY(${dy}px)`, filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: ms, easing: EZ.out, fill: 'backwards' }));
  function roll(id, v) {   // 숫자가 바뀔 때 위에서 내려앉기 (블러 · 페이드). 진행 중 숫자는 연출 없이 (몰려오면 계속 다시 시작돼 안 보임)
    const b = document.getElementById(id); if (!b || b.textContent === String(v)) return; b.textContent = v;
    if (!reduced() && !b.getAnimations().length) b.animate([{ transform: 'translateY(-40%)', opacity: 0, filter: 'blur(3px)' }, { transform: 'none', opacity: 1, filter: 'blur(0)' }], { duration: 300, easing: EZ.out });
  }
  const imgsReady = (ims) => Promise.all(ims.map((im) => (im.complete ? 0 : new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); }))));

  function grid(core) {
    const T = C.T, e = core.esc, gv = C.gv || (C.gv = { scroll: 0, seen: false, summed: false });
    if (C.g) { C.g.alive = false; if (C.g.io) C.g.io.disconnect(); }
    C.units = units(C.job);
    const N = C.units.length, byId = (id) => document.getElementById(id), restore = gv.seen;
    const el = frame(core, 2);
    el.innerHTML = `<div class="gd" id="gd"><div class="gd-top"><div class="gd-acts"><button class="dk-act" id="gdRev" type="button" disabled>${e(T.rv)}</button><button class="dk-act pri" id="gdGo" type="button" disabled>${e(T.goDl)}</button></div>
      <div class="gd-nums" id="gdNums" aria-live="polite"></div><div class="gd-sub"><div class="gd-prog" id="gdProgW"><i id="gdProg"></i></div><div class="gd-note" id="gdNote" aria-live="polite"></div></div></div>
      <div class="gd-list" id="gdList"><div class="gd-grid" id="gdGrid"></div></div></div><div id="ckGo"></div>`;
    const G = C.g = { alive: true, root: byId('gd'), list: byId('gdList'), tiles: new Map(), landed: new Set(), q: [], qs: new Set(), follow: !restore, chain: Promise.resolve(), mode: running() ? 'scan' : 'done', fT: 0 };
    gv.seen = true;
    const unitOf = (k) => { if (G.byU !== C.units) { G.byU = C.units; G.by = new Map(C.units.map((u) => [ukey(u), u])); } return G.by.get(k); };
    // 칸: PDP 썸네일(장을 세로로 쌓음 — 문제 자리 표시는 PDP 와 같이 움직이게 안에) · 모델 · 한 줄
    const gridEl = byId('gdGrid'), frag = document.createDocumentFragment();
    for (const u of C.units) {
      const t = document.createElement('div'), it = u[0];
      t.className = 'gd-it gd-wait'; t._k = ukey(u); t._cat = 'wait'; t.dataset.row = it.row;
      t.innerHTML = `<div class="gd-pdp" tabindex="-1" aria-label="${e(it.model || '')}"><div class="gd-mv"></div><span class="gd-band"></span></div>
        <div class="gd-mt"><div class="gd-mo">${e(it.model || '')}</div><div class="gd-st"></div></div>`;
      G.tiles.set(t._k, t); frag.appendChild(t);
    }
    gridEl.appendChild(frag);

    // PDP 내용: 통과한 칸은 앞 3장만(lazy) — 칸 높이를 채우기에 충분. 문제 칸은 마지막 문제 자리 다음 장까지(바로 불러옴 · 몇 개뿐)
    function fill(t, u) {
      const it = u[0], key = JSON.stringify([it.status === 'failed', pdpImgs(it), it.ai]);
      if (t._content === key) return false;
      t._content = key;
      const imgs = it.status === 'failed' ? [] : pdpImgs(it), marks = regionsBySlice(problems(it), imgs.length), open = !passed(u);
      const last = open ? marks.reduce((a, ms, k) => (ms.length ? k : a), -1) : -1, n = Math.min(imgs.length, Math.max(3, last + 2));
      const mv = t.querySelector('.gd-mv');
      mv.innerHTML = imgs.slice(0, n).map((src, k) => `<span class="gd-si"><img src="${e(small(src))}" alt="" decoding="async"${open ? '' : ' loading="lazy"'}>${open ? marks[k].map((m) =>
        `<span class="gd-mk" style="top:calc(${m.y * 100}% - 4px);height:calc(${m.h * 100}% + 8px);left:calc(${m.x * 100}% + 3px);width:calc(${m.w * 100}% - 6px)"></span>`).join('') : ''}</span>`).join('');
      mv.style.transform = ''; t._ty = 0; t._marks = last >= 0;
      t.querySelector('.gd-pdp').classList.toggle('none', !imgs.length);
      return true;
    }
    // 문제 자리가 보이게 PDP 를 그만큼 내려 둔다 (자리는 첫 문제 표시)
    async function focus(t, anim) {
      const mv = t.querySelector('.gd-mv'), pdp = mv.parentElement, mk = mv.querySelector('.gd-mk'), tok = t._ft = {};
      if (!mk) { if (t._ty) { t._ty = 0; mv.style.transform = ''; } return; }
      await imgsReady([...mv.querySelectorAll('img')]);
      if (t._ft !== tok || !G.alive) return;
      const H = pdp.clientHeight, y = mk.getBoundingClientRect().top - mv.getBoundingClientRect().top;
      const ty = Math.round(Math.max(0, Math.min(mv.offsetHeight - H, y - H * 0.35))), from = t._ty || 0;
      if (ty === from) return;
      t._ty = ty; mv.style.transform = `translateY(${-ty}px)`;
      if (anim && !reduced()) mv.animate([{ transform: `translateY(${-from}px)` }, { transform: `translateY(${-ty}px)` }], { duration: 600, easing: EZ.io });
    }
    // 스캔 띠: 결과가 닿은 칸을 한 번 훑고(0.42초) → 검토 필요면 빨강 (그동안 결과 표시는 숨김)
    //   띠는 칸 높이만 한 투명 판의 아래 끝에 그려져 있어 transform 의 % 만으로 위 → 아래 (칸 크기를 읽지 않음 — 많아도 레이아웃을 다시 하지 않게)
    function sweep(t) {
      const band = t.querySelector('.gd-band');
      t.classList.add('gd-scan');
      band.animate([{ transform: 'translateY(-100%)', opacity: 1 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 420, easing: EZ.io })
        .finished.catch(() => {}).then(() => t.classList.remove('gd-scan'));
    }
    function paint(t, u, anim) {
      const prev = t._cat, cat = catOf(u, G.landed.has(t._k)), changed = cat !== 'wait' && fill(t, u);
      const rd = cat === 'busy' ? redoOf(u) : null, reasons = aiRows(u).filter((x) => !x.ok).map(why).join(' · '), sk = [cat, rd, reasons].join('|');
      if (t._sk !== sk && !t._checked) {   // 상태 줄 (다시 크롤 · 다시 그림 · 기다림이 바뀌어도)
        t._sk = sk;
        t.className = `gd-it gd-${cat}${rd ? ' gd-rd gd-' + (rd === 'wait' ? 'queue' : rd) : ''}${G.vis.has(t) ? ' gd-vis' : ''}${t.classList.contains('gd-hide') ? ' gd-hide' : ''}`;
        const st = t.querySelector('.gd-st');
        if (rd) {   // 자동 재시도: 찾은 문제 · 지금 하는 일 · 성공하면 확인됨 (세 줄, 짧게)
          st.innerHTML = `<span class="gd-l1">${e(reasons)}</span><span class="gd-l2">${e(redoLine(u))}</span><span class="gd-l3">${e(T.rcHint)}</span>`;
          st.title = [reasons, redoLine(u), T.rcHint].filter(Boolean).join(' · ');
        } else st.textContent = st.title = { wait: '', ok: T.fReady, busy: T.redoing, in: T.okIn, out: T.removedL }[cat] ?? reasons;   // 사람이 정한 것: 포함 · 뺌 (검수 화면과 같은 말)
      }
      if (cat !== prev || changed) {
        t._cat = cat;
        t.querySelector('.gd-pdp').tabIndex = cat === 'wait' ? -1 : 0;
        const scan = anim && !reduced() && G.vis.has(t) && cat !== 'wait' && cat !== 'busy' && (prev === 'wait' || prev === 'busy' || changed);   // 보이는 칸만
        if (scan) sweep(t);
        if (t._marks && (changed || prev === 'wait')) setTimeout(() => focus(t, anim), scan ? 380 : 0);
      }
      return cat !== prev;
    }
    function nums() {
      let ok = 0, rev = 0, out = 0, bz = 0;
      for (const t of G.tiles.values()) { const c = t._cat; if (c === 'ok' || c === 'in') ok++; if (c === 'bad' || c === 'busy') rev++; if (c === 'out') out++; if (c === 'busy') bz++; }
      const box = byId('gdNums'), key = G.mode + (out ? 'o' : '');
      if (box._key !== key) {
        box._key = key;
        box.innerHTML = G.mode === 'scan' ? `<div class="gd-n"><span>${e(T.aiChk)}</span><b id="gdA">${G.landed.size}</b><span class="of">/ ${N}</span></div>`
          : `<div class="gd-n"><span class="ck">${CK}</span><b id="gdA">${ok}</b><span>${e(T.fReady)}</span></div><div class="gd-n bad"><i class="dot"></i><b id="gdB">${rev}</b><span>${e(T.fReview)}</span></div>${out ? '<div class="gd-n out"><span id="gdC"></span></div>' : ''}`;
      }
      byId('gdProgW').classList.toggle('off', G.mode !== 'scan');
      const note = byId('gdNote'), nt = G.mode === 'done' && bz ? T.redoN(bz) : '';   // 스캔 뒤 자동 재시도 · 다시 준비 중: 끝날 때까지 그리드에서
      if (note.textContent !== nt) note.textContent = nt;
      if (G.mode === 'scan') { byId('gdA').textContent = G.landed.size; byId('gdProg').style.width = (G.landed.size / Math.max(1, N) * 100) + '%'; }
      else { roll('gdA', ok); roll('gdB', rev); const c = byId('gdC'); if (c) c.textContent = T.removed(out); }
      const rb = byId('gdRev');
      rb.disabled = G.mode === 'scan' || !rev;   // 다시 준비 중인 것은 검수 화면이 건너뛴다
      byId('gdGo').disabled = G.mode === 'scan' || C.job.status !== 'ready' || rev > 0;
    }
    // 결과가 나오는 대로 아래 줄을 따라 내려간다 — 사람이 스크롤하면 그만
    function follow(t) {
      if (!G.follow || G.mode !== 'scan' || G.vis.has(t) || performance.now() < G.fT) return;
      G.fT = performance.now() + 450;
      const y = t.offsetTop - G.list.offsetTop;   // 아래 줄일 때만 (늦게 온 윗줄 때문에 되돌아가지 않음)
      if (y > G.list.scrollTop) G.list.scrollTo({ top: y - t.offsetHeight - 24, behavior: reduced() ? 'auto' : 'smooth' });
    }
    // 보이는 칸 (연출 · 따라가기는 이것만): 칸 위치를 매번 읽지 않게 IntersectionObserver 로
    G.vis = new Set();
    G.io = new IntersectionObserver((es) => { for (const en of es) { if (en.isIntersecting) G.vis.add(en.target); else G.vis.delete(en.target); en.target.classList.toggle('gd-vis', en.isIntersecting); } }, { root: G.list, rootMargin: '80px 0px' });   // gd-vis: 보이는 칸만 반복 띠
    for (const t of G.tiles.values()) G.io.observe(t);
    ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((ev) => G.list.addEventListener(ev, () => { G.follow = false; }, { passive: true }));
    function land(k, anim) {
      G.qs.delete(k); const t = G.tiles.get(k), u = unitOf(k); if (!t || !u || !G.alive) return;
      G.landed.add(k); paint(t, u, anim); if (anim) follow(t);
    }
    function update(anim) {
      for (const [k, t] of G.tiles) {
        const u = unitOf(k); if (!u) continue;
        if (!G.landed.has(k)) { if (settled(u) && !G.qs.has(k)) { G.qs.add(k); G.q.push(k); } continue; }
        paint(t, u, anim);
      }
      nums();
      if (byId('gdRh')) row(anim);   // 결과 화면: 통과한 칸은 줄에서 빠지고 숫자가 줄어든다
    }
    const onResize = () => {
      if (!G.alive) { removeEventListener('resize', onResize); return; }
      clearTimeout(G.rz); G.rz = setTimeout(() => {
        if (byId('gdRh')) bigVars([...G.tiles.values()].filter((t) => !t.classList.contains('gd-hide')).length);
        for (const t of G.tiles.values()) if (t._marks) focus(t, false);
      }, 150);
    };
    addEventListener('resize', onResize);
    function leaveGrid() { if (!G.alive) return false; G.alive = false; document.removeEventListener('keydown', G.rsKey); gv.scroll = G.list.scrollTop; removeEventListener('resize', onResize); G.io.disconnect(); return true; }
    // 칸을 누르면 그 제품의 자세히 보기 (비교 칸 포함) — 돌아가기는 이 그리드 같은 상태로
    function openAt(t) {
      if (!t || t._cat === 'wait' || !leaveGrid()) return;
      viewer(core, 'all', Math.max(0, C.units.findIndex((u) => ukey(u) === t._k)), 'grid');
    }
    // 검토 필요는 하나씩 (가운데 큰 카드 · 비교 칸 · 위 고정 버튼 셋) — 장면은 바로 바뀌고 가운데 카드만 아래에서 16px 올라온다 (스프링)
    function review() {
      if (!leaveGrid()) return;
      viewer(core, 'review', 0, 'grid');
      rise(document.querySelector('#dk .dk-cc.dk-on'), 16);
    }
    gridEl.addEventListener('click', (ev) => {
      const t = ev.target.closest('.gd-it');
      if (t && ev.target.closest('.gd-pdp, .gd-mt')) { if (G.root.classList.contains('gd-rs')) review(); else openAt(t); }   // 결과 화면의 칸 = 검토
    });
    gridEl.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('gd-pdp')) { ev.preventDefault(); openAt(ev.target.closest('.gd-it')); }
    });
    byId('gdRev').onclick = () => review();
    const confirmGo = () => { if (leaveGrid()) finishView(core, true); };
    byId('gdGo').onclick = confirmGo;
    // 자동 재시도 · 다시 준비 중인 칸: 끝날 때까지 2초마다 (통과하면 그 칸이 준비됨으로) → 다 끝나면 결과 알림 (한 번만)
    const anyBusy = () => C.units.some((u) => busy(u) && !isRemoved(u));
    async function watch() {
      if (G.watching || running()) return;
      if (!gv.summed && C.job.status === 'ready') result();   // 첫 판이 끝나면 바로 (자동 재시도는 결과 화면에서 계속)
      G.watching = true;
      while (G.alive && anyBusy()) { await sleep(2000); if (!G.alive) break; await refresh(core); if (G.alive) update(true); }
      G.watching = false;
    }
    // 결과 화면: 장면이 바로 바뀐다 — 그리드 · 위 줄은 숨고 확인이 필요한 칸만 크게, 머리글 · 버튼 '검토' 는 검수 화면의 'n / N' · 버튼 줄 자리.
    //   Enter 도 '검토', Esc 는 그리드로 (그 뒤엔 위 '검토' 버튼)
    const inRow = (t) => t._cat === 'bad' || t._cat === 'busy';   // 결과 화면 줄: 확인이 필요한 것 + 자동 재시도 중인 것
    function result() {
      gv.summed = true;
      const bad = [...G.tiles.values()].filter(inRow);
      const head = document.createElement('div'); head.className = 'gd-rh'; head.id = 'gdRh';
      head.innerHTML = '<h2 id="gdRhH"></h2><button class="dk-act pri" id="gdRhGo" type="button"></button>';
      G.root.insertBefore(head, G.list);
      G.root.classList.add('gd-rs');
      for (const t of G.tiles.values()) t.classList.toggle('gd-hide', !bad.includes(t));
      G.list.scrollTop = 0; bigVars(bad.length); headline(bad.length);
      for (const t of bad) if (t._marks) { t._ty = 0; t.querySelector('.gd-mv').style.transform = ''; focus(t, false); }   // 큰 칸 크기로 문제 자리 다시
      const b = byId('gdRhGo'); b.onclick = () => (G.rowN ? review() : confirmGo());
      G.rsKey = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); leaveResult(); }
        else if (ev.key === 'Enter' && !ev.target.closest?.('button, a, input')) { ev.preventDefault(); b.click(); }
      };
      document.addEventListener('keydown', G.rsKey);   // 버튼에 포커스를 두지 않는다 (검수 화면 버튼 자리에 포커스 테두리가 남지 않게) — Enter 는 위에서
      rise(byId('gdRhH'), 8);
      bad.slice(0, 24).forEach((t, k) => rise(t, 14, 40 + k * 50));
    }
    // 머리글 · 버튼: n 개면 '확인이 필요한 PDP n개' + 검토, 0 이면 '모두 준비됨' + 확인하고 받기. 글이 같으면 숫자만 굴린다
    function headline(n) {
      const h = byId('gdRhH'), b = byId('gdRhGo'); if (!h) return;
      const num = n || N, full = (n ? T.rsNeed : T.rsAll)(num), at = full.indexOf(String(num));   // 숫자는 글과 같은 크기 · 굵기 (자리만 <b>)
      const txt = [full.slice(0, at), full.slice(at + String(num).length)].map(e), key = (n ? 'n' : 'a') + txt.join('|');
      if (h._key === key) roll('gdRhN', num);
      else { const first = h._key == null; h._key = key; h.innerHTML = `${txt[0]}<b id="gdRhN">${num}</b>${txt[1]}`; if (!first) rise(h, 8); }
      const bl = n ? T.rv : T.goDl; if (b.textContent !== bl) b.textContent = bl;
      G.rowN = n;
    }
    // 결과 화면 줄 다시: 통과한 칸은 살짝 작아지며 사라지고(짧게) 남은 칸은 제자리로 미끄러진다 (FLIP · 위치는 transform 만). 모션 줄이기면 바로
    const row = (anim) => (G.rowChain = (G.rowChain || Promise.resolve()).then(() => rowNow(anim)).catch(() => {}));
    async function rowNow(anim) {
      if (!G.alive || !byId('gdRh')) return;
      const tiles = [...G.tiles.values()], out = tiles.filter((t) => !t.classList.contains('gd-hide') && !inRow(t)), back = tiles.filter((t) => t.classList.contains('gd-hide') && inRow(t));
      const n = tiles.filter(inRow).length;
      if (!out.length && !back.length) { headline(n); return; }
      // 자동 재시도가 통과한 칸: 잠깐(~1초) ✓ '확인됨' 을 보여 준 뒤 줄에서 빠진다
      const won = out.filter((t) => t._cat === 'ok' && !t._checked);
      if (won.length) {
        for (const t of won) {
          t._checked = true; t.classList.add('gd-checked');
          const st = t.querySelector('.gd-st'); st.innerHTML = `<span class="gd-okl">${CK}${e(T.chk)}</span>`; st.title = T.chk;
          if (!reduced()) rise(st.firstElementChild, 6);
        }
        await sleep(1000);
        if (!G.alive || !byId('gdRh')) return;
      }
      anim = anim && !reduced();
      const stay = tiles.filter((t) => !t.classList.contains('gd-hide') && inRow(t)), first = new Map(anim ? stay.map((t) => [t, t.getBoundingClientRect()]) : []);
      if (anim) await Promise.all(out.map((t) => t.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(.94)' }], { duration: 260, easing: EZ.p3in, fill: 'forwards' }).finished.catch(() => {})));
      if (!G.alive || !byId('gdRh')) return;
      for (const t of out) {   // 그리드로 돌아가면 보통 통과 칸
        t.classList.add('gd-hide'); t.getAnimations().forEach((a) => a.cancel());
        if (t._checked) { t._checked = false; t._sk = null; t.classList.remove('gd-checked'); const u = unitOf(t._k); if (u) paint(t, u, false); }
      }
      for (const t of back) t.classList.remove('gd-hide');
      bigVars(n); headline(n);
      for (const t of back) { if (t._marks) { t._ty = 0; t.querySelector('.gd-mv').style.transform = ''; focus(t, false); } if (anim) rise(t, 14); }
      for (const [t, r0] of first) {
        const r1 = t.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
        if (Math.abs(dx) + Math.abs(dy) >= 1) t.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: SPR.duration, easing: SPR.easing });
      }
      if (first.size && [...first.keys()].some((t) => t._marks)) for (const t of first.keys()) if (t._marks) focus(t, false);   // 칸 폭이 바뀌었으면 문제 자리 다시
    }
    function leaveResult() {
      const head = byId('gdRh'); if (!head) return;
      document.removeEventListener('keydown', G.rsKey); head.remove(); G.root.classList.remove('gd-rs');
      for (const t of G.tiles.values()) { t.classList.remove('gd-hide'); if (t._marks) { t._ty = 0; t.querySelector('.gd-mv').style.transform = ''; focus(t, false); } }
    }
    // 결과 화면 칸 크기: 한 줄에 다 들어가면 그 폭(150~196px), 아니면 196px 로 여러 줄(좁으면 두 칸씩) · PDP 높이는 남은 높이에 맞춰 (430px 까지)
    function bigVars(n) {
      const w = G.list.clientWidth, h = G.list.clientHeight, narrow = innerWidth <= 560, gap = narrow ? 14 : 22, avail = w - (narrow ? 28 : 48);
      const fit = (avail - gap * (Math.max(1, n) - 1)) / Math.max(1, n);
      const bw = Math.floor(fit >= 150 ? Math.min(196, fit) : Math.max(128, Math.min(196, (avail - gap) / 2))), bh = Math.round(Math.max(150, Math.min(430, h - 64, bw * 2.2)));
      G.root.style.setProperty('--bw', bw + 'px'); G.root.style.setProperty('--bh', bh + 'px');
    }

    (async () => {
      // 이미 끝난 것은 연출 없이 바로 (이어 보기 · 자세히 보기에서 돌아올 때)
      update(false); while (G.q.length) land(G.q.shift(), false);
      nums();
      if (restore) G.list.scrollTop = gv.scroll;
      else if (!reduced()) {
        fadeIn(G.root.querySelector('.gd-top'), 420, 6);
        const lr = G.list.getBoundingClientRect(); let m = 0;
        for (const t of G.tiles.values()) { if (m >= 44 || t.getBoundingClientRect().top > lr.bottom) break; fadeIn(t, 420, 8).effect.updateTiming({ delay: m++ * 8 }); }
      }
      const anim = !reduced();
      let pumping = true;
      const pump = (async () => {
        while (G.alive && (pumping || G.q.length)) {
          if (!G.q.length) { await sleep(40); continue; }
          // 몰려오면 한 번에 여러 칸 (화면이 서버를 따라잡게) · 간격도 줄인다
          for (let n = Math.max(1, Math.ceil(G.q.length / 12)); n > 0 && G.q.length; n--) land(G.q.shift(), anim);
          nums();
          if (anim) await sleep(Math.max(14, Math.min(90, 900 / (G.q.length + 1))));
        }
      })();
      while (G.alive && running()) { await sleep(600); if (!G.alive) break; await refresh(core); if (G.alive) update(anim); }
      pumping = false; await pump;
      if (!G.alive) return;
      if (G.mode === 'scan') {   // 다 끝남: 막대는 사라지고 숫자가 '준비됨 · 검토 필요'로 (블러 페이드), 따라 내려갔으면 맨 위로
        const box = byId('gdNums');
        if (anim) { await sleep(400); await box.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(6px)' }], { duration: 200, easing: EZ.p3in, fill: 'forwards' }).finished.catch(() => {}); }
        if (!G.alive) return;
        G.mode = 'done'; nums(); box.getAnimations().forEach((a) => a.cancel());
        if (anim) fadeIn(box, 520, 6);
        if (G.follow && G.list.scrollTop > 0) G.list.scrollTo({ top: 0, behavior: anim ? 'smooth' : 'auto' });
      }
      if (C.job.status !== 'ready') { alertLine(core, T.err + (C.job.error || C.job.status)); return; }
      watch();   // 다 끝나면(자동 재시도까지) 결과 알림
    })().catch((err) => alertLine(core, T.err + err.message));
  }

  // ── 검수 화면 (2026-11-27): 검토 필요만(review) · 전체 보기(all, 선택) 같은 화면 ──
  // 2026-11-28 그리드부터: 스캔이 끝나면 'review'(하나씩, from 'grid') · 칸을 누르면 'all' 로 그 제품부터. 둘 다 돌아가기는 그리드 같은 상태로
  // PDP 는 가운데 크게 · 이전/다음은 양옆 · 위에 'n / N' 과 한 줄(상태 · 모델 · 이유 — 한 번만) · 아래 고정 버튼 셋(빼기 · 다시 준비 · 괜찮음·포함).
  // 검토 필요 카드면 화면 배경부터 다르게 (와인 톤) — 준비됨(기본 톤) · 뺌(회색)과 한눈에 구분. 하나 처리하면 다음 건으로 자동으로.
  // 키보드: ← → 넘기기 · ↑ ↓ · 스페이스로 PDP 내리기 · (전체 보기) Esc 돌아가기
  function viewer(core, mode, start, from) {
    const T = C.T, e = core.esc, rtl = document.documentElement.dir === 'rtl', all = mode === 'all';
    const open = (u) => !isRemoved(u) && !isOk(u) && !passed(u);   // 사람이 아직 정하지 않은 것
    let list = all ? C.units.slice() : needs(), i = Math.max(0, Math.min(list.length - 1, start)), el = null, alive = true, polling = false;
    if (!all) { const j = list.findIndex((u) => open(u) && !busy(u)); if (j >= 0) i = j; }
    const view = frame(core, 2);
    view.innerHTML = '<div class="dk dk-br" id="dk"></div><div id="ckGo"></div>';
    const back = all || from === 'grid';   // 돌아가기: 전체 보기 · 그리드에서 온 검토 (같은 자리)
    if (back) document.getElementById('ckSteps').insertAdjacentHTML('afterbegin', `<button class="ck-sback" id="dkBack" type="button">${e(T.back)}</button>`);
    C.dk = { root: document.getElementById('dk'), els: new Map(), side: new Map(), pile: [], minis: [], q: [], readyN: 0, shown: 0 };
    const D = C.dk;
    // 위: 'n / N' + 진행 막대 · 그 아래 고정 버튼 셋 · 카드 바로 위 제목(모델 / 상태 · 이유)
    // 가운데: 캐러셀 — 카드가 가로 한 줄, 가운데 카드가 크고 앞뒤 PDP 는 일부만 보이며 끝으로 갈수록 흐려짐. 넘기면 줄 전체가 미끄러지고
    //         카드 안 이미지는 살짝 늦게 따라옴(패럴랙스). 드래그 · 스와이프 · 가로 휠 · ← → 로 넘기기. 라이브러리 없이 CSS 전환 + 포인터 이벤트
    const ARL = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>', ARR = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
    D.root.insertAdjacentHTML('beforeend', `<div class="dk-top"><div class="dk-count"><b id="dkI"></b><span id="dkNn"></span></div><div class="dk-prog"><i id="dkProg"></i></div></div><div class="dk-cap" id="dkCap"></div>
      <div class="dk-viewport" tabindex="0"><div class="dk-stage"><div class="dk-car" id="dkCar"><div class="dk-track" id="dkTrack"></div></div>
      <button class="dk-arw" id="dkPrev" type="button" aria-label="${e(rtl ? T.next : T.prev)}">${ARL}</button><button class="dk-arw" id="dkNext" type="button" aria-label="${e(rtl ? T.prev : T.next)}">${ARR}</button>
      <div class="dk-cmp" id="dkCmp" hidden><div class="dk-cmp-box"><div class="dk-cmp-h"></div><div class="dk-cmp-b"></div><div class="dk-cmp-s"></div><div class="dk-cmp-location"></div></div><div class="dk-cnav"></div></div></div></div>
      <div class="dk-bar"><button class="dk-act" data-a="remove" type="button">${e(T.rmS)}</button><button class="dk-act" data-a="retry" type="button">${e(T.redo)}</button><button class="dk-act" data-a="ok" type="button">${e(T.okIn)}</button></div>`);
    const cap = document.getElementById('dkCap'), car = document.getElementById('dkCar'), track = document.getElementById('dkTrack');
    const stage = car.closest('.dk-stage'), viewport = stage.parentElement;
    const stageRel = node => {
      const r = node.getBoundingClientRect(), origin = (G.compact ? stage : D.root).getBoundingClientRect();
      return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    };
    const prevB = document.getElementById('dkPrev'), nextB = document.getElementById('dkNext');   // 왼쪽 · 오른쪽 (아랍어는 왼쪽이 다음)
    prevB.onclick = () => go(rtl ? 1 : -1); nextB.onclick = () => go(rtl ? -1 : 1);
    const acts = [...D.root.querySelectorAll('.dk-act')];
    // 오른쪽 칸 (2026-11-27 장혁 피드백 '단순하게'): 맨 위 큰 한 문장(무슨 일인지) + 그 아래 lg.com 원본(빠진 문구 · 이미지). 화면에 같은 말은 한 번만.
    //   카드 바로 옆, 꼭지가 문제 자리를 가리킴. 문제가 여럿이면 칸 바로 밑에 '1/3 ⌄' — 누르면 다음 문제로, 칸 내용도 그 문제 것으로
    const cmpEl = document.getElementById('dkCmp'), cmpBox = cmpEl.querySelector('.dk-cmp-box'), cmpH = cmpEl.querySelector('.dk-cmp-h'), cmpB = cmpEl.querySelector('.dk-cmp-b'), cmpS = cmpEl.querySelector('.dk-cmp-s'), cmpN = cmpEl.querySelector('.dk-cnav');
    const HEAD = { img: T.bImg, lines: T.bLines, sum: T.bSum, spec: T.bSpec, specUnknown: T.bSpecUnknown, preview: T.bPreview, n12: T.bLimit, fail: T.bFail };
    let cmpT = 0, pointFrame = 0, sliding = false;
    function cmp(later) {
      if (later) {
        clearTimeout(cmpT);
        sliding = true; cmpEl.hidden = true;
        cmpT = setTimeout(() => { sliding = false; cmp(); }, later);
        return;
      }
      const c = el, ps = c && c.classList.contains('dk-prob') ? c._issues : [];
      const k = c ? c._pi || 0 : 0, p = ps[k];
      if (!p || sliding || (drag && drag.on) || !alive) { cmpEl.hidden = true; return; }
      const marks = issueMarks(c, k);
      const src = /^(https?:)?\/\//i.test(p.src || '') ? p.src : '';
      if (cmpEl._issue !== p) {
        cmpEl._issue = p;
        cmpS.textContent = '';
        cmpH.textContent = HEAD[p.kind];
        if (src) {
          cmpB.innerHTML = '<img alt="" decoding="async">';
          const im = cmpB.firstChild;
          im.onerror = () => { if (cmpEl._issue !== p) return; im.hidden = true; cmpS.textContent = T.noOrig; cmp(); };
          im.onload = () => cmp();
          im.src = src;
        } else if (p.rows && p.rows.length) {
          cmpB.innerHTML = `<ul class="dk-pl">${p.rows.map(r => `<li>${e(r.label)} · ${e(r.value)}</li>`).join('')}</ul>`;
        } else {
          cmpB.innerHTML = p.lines && p.lines.length ? `<ul class="dk-pl">${p.lines.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : '';
        }
        if (p.model) cmpB.insertAdjacentHTML('afterbegin', `<p><strong>${e(p.model)}</strong></p>`);
        const keepFocus = cmpN.contains(document.activeElement);
        cmpN.innerHTML = ps.length > 1 ? `<em>${k + 1}/${ps.length}</em><button type="button" aria-label="${e(T.nextP)}" title="${e(T.nextP)}">${DN}</button>` : '';
        const nb = cmpN.querySelector('button'); if (nb) { nb.onclick = () => seek(el, k + 1); if (keepFocus) nb.focus({ preventScroll: true }); }
      }
      cmpBox.dataset.location = marks.length ? 'mapped' : 'unknown';
      cmpBox.querySelector('.dk-cmp-location').textContent = ['fail', 'preview', 'specUnknown', 'n12'].includes(p.kind) || marks.length ? '' : T.noLocation;
      const rc = stageRel(c.querySelector('.dk-sc'));
      // Point to the visible part of this issue only. A scrolled-out region has no arrow.
      const visible = marks.map(stageRel).find((r) => r.w > 0 && r.y + r.h >= rc.y && r.y < rc.y + rc.h);
      const target = visible && (Math.max(rc.y, visible.y) + Math.min(rc.y + rc.h, visible.y + visible.h)) / 2;
      const room = rtl ? rc.x - 12 : G.w - rc.x - rc.w - 12;
      const W = Math.round(Math.max(0, Math.min(320, G.panel, G.stacked ? G.w - 32 : room - 4)));
      cmpEl.style.width = W + 'px'; cmpEl.hidden = false;
      // Keep natural source image sizing. Scroll only evidence longer than the available card.
      cmpEl.style.setProperty('--evidence-height', Math.max(100, G.ch - (cmpEl.offsetHeight - cmpB.offsetHeight) - 4) + 'px');
      const H = cmpEl.offsetHeight, boxH = cmpBox.offsetHeight;
      const y = G.stacked ? G.y + G.ch + 10 : Math.round(Math.max(G.y, Math.min(G.y + Math.max(0, G.ch - H), visible ? target - boxH * 0.4 : G.y)));
      const x = G.stacked ? (G.w - W) / 2 : rtl ? rc.x - 12 - W : rc.x + rc.w + 12;
      cmpEl.style.transform = `translate(${Math.round(x)}px,${y}px)`;
      stage.style.minHeight = Math.max(G.y + G.ch + 16, y + H + 16) + 'px';
      const alignPoint = () => {
        const offset = target - stageRel(cmpBox).y - cmpBox.clientTop;
        const show = !G.stacked && !!visible && offset >= 0 && offset <= cmpBox.clientHeight;
        cmpBox.classList.toggle('dk-point', show);
        if (show) cmpEl.style.setProperty('--ay', offset + 'px');
        if (alive && cmpEl.getAnimations().some(a => a.playState === 'running')) pointFrame = requestAnimationFrame(alignPoint);
      };
      cancelAnimationFrame(pointFrame);
      alignPoint();
    }
    const sgn = rtl ? -1 : 1, GAP = 28, PAR = 64, WIN = 2;   // 다음 카드 방향 · 카드 사이 · 패럴랙스 폭 · 앞뒤로 둘 카드 수
    // 카드는 화면 높이에 맞춰 크게 (상세 이미지까지 보게) — 폭은 높이의 ~75%, 320~520px, 가운데. 위 168px 는 숫자 · 버튼 · 모델 · 짧은 한 줄
    const geo = () => {
      const root = rel(D.root), compact = root.w <= 700 || root.h < 520;
      D.root.classList.toggle('dk-compact', compact);
      viewport.tabIndex = compact ? 0 : -1;
      if (!compact) {
        const y = 168, ch = Math.max(340, root.h - y - 16);
        const cw = Math.round(Math.max(320, Math.min(520, ch * 0.75, root.w * 0.36)));
        const x = Math.round((root.w - cw) / 2);
        const side = Math.max(60, Math.min(cw * 0.55, (root.w - cw) / 2 - GAP - 72));
        return { x, y, ch, cw, w: root.w, side, step: cw + GAP, panel: Math.max(200, side + GAP + 6) };
      }
      const st = rel(viewport), y = 18, stacked = st.w < 700;
      const ch = Math.max(190, st.h - y - (stacked ? 265 : 16));
      const cw = Math.round(Math.min(stacked ? st.w - 104 : st.w * 0.36, 520, Math.max(250, ch * 0.75)));
      const x = Math.round((st.w - cw) / 2);
      const side = Math.max(0, Math.min(cw * 0.55, x - GAP - 52));
      return { x, y, ch, cw, w: st.w, side, step: cw + GAP, compact, stacked, panel: stacked ? st.w - 32 : x - 60 };
    };
    let G = geo();
    const cards = new Map();   // list 번호 → 카드 (가운데 ± WIN 장만)
    function place() {   // 캐러셀 틀 · 화살표 · 끝으로 갈수록 흐려지는 가장자리
      G = geo(); stage.style.minHeight = (G.y + G.ch + 16) + 'px'; const L = G.x - GAP - G.side, W = G.cw + 2 * (GAP + G.side), f = ((G.side + GAP) / W * 100).toFixed(1);
      Object.assign(car.style, { left: L + 'px', top: G.y + 'px', width: W + 'px', height: G.ch + 'px' });
      const m = `linear-gradient(to right, transparent 0%, #000 ${f}%, #000 ${100 - f}%, transparent 100%)`; car.style.webkitMaskImage = m; car.style.maskImage = m;
      prevB.style.top = nextB.style.top = (G.y + G.ch / 2 - 20) + 'px'; prevB.style.left = (G.compact ? 6 : L - 52) + 'px'; nextB.style.left = (G.compact ? G.w - 46 : L + W + 12) + 'px';
    }
    const cardLeft = (k) => G.side + GAP + sgn * k * G.step;
    function mk(k, before) {
      const c = cardEl(core, list[k]); track.insertBefore(c, before || null); c.classList.add('dk-cc'); fullCard(c, G);
      c.style.left = cardLeft(k) + 'px'; c.style.top = '0px';
      c.addEventListener('click', () => { if (!moved && k !== i) go(k - i); });
      cards.set(k, c); return c;
    }
    // 패럴랙스: 줄이 미끄러질 때 카드 안 내용이 반대쪽으로 조금 밀렸다가 더 늦게(0.78초) 제자리로 — 쉬고 있을 땐 늘 0 (가장자리가 비지 않게)
    const inners = () => [...cards.values()].map((c) => c.querySelector('.dk-sc > *')).filter(Boolean);
    function parallax(from, anim) {   // from: 움직이기 시작할 때 내용이 뒤처진 정도(px). anim 이 없으면 그 자리 (끄는 중)
      for (const n of inners()) {
        if (!anim || reduced()) { n.style.transition = 'none'; n.style.transform = from ? `translate3d(${from}px,0,0)` : ''; continue; }
        if (from != null) { n.style.transition = 'none'; n.style.transform = `translate3d(${from}px,0,0)`; void n.offsetWidth; }
        n.style.transition = 'transform .78s cubic-bezier(.16,1,.3,1) .04s'; n.style.transform = 'translate3d(0,0,0)';
      }
    }
    function layout(anim, kick) {   // kick: 넘긴 방향(+1 다음 · -1 이전) — 패럴랙스 시작점
      if (anim && !reduced()) track.style.transition = 'transform .52s cubic-bezier(.16,1,.3,1)'; else track.style.transition = 'none';
      track.style.transform = `translate3d(${-sgn * i * G.step}px,0,0)`;
      if (anim && !reduced()) cmp(620);
      else { clearTimeout(cmpT); sliding = false; }
      for (let k = i - WIN; k <= i + WIN; k++) if (k >= 0 && k < list.length && !cards.has(k)) mk(k);
      for (const [k, c] of cards) {
        const on = k === i; if (c.classList.contains('dk-on') && !on) setTimeout(() => { if (!c.classList.contains('dk-on')) c.querySelector('.dk-sc').scrollTop = 0; }, 560);   // 다시 오면 맨 위부터
        const entering = on && !c.classList.contains('dk-on');
        c.classList.toggle('dk-on', on);
        if (entering) seek(c, 0);
        if (Math.abs(k - i) > WIN) { cards.delete(k); setTimeout(() => c.remove(), anim ? 560 : 0); }
      }
      if (el !== cards.get(i)) viewport.scrollTop = 0;
      el = cards.get(i);
      parallax(kick ? sgn * kick * PAR : null, anim);
      panel();
      for (const v of [list[i + WIN + 1], list[i - WIN - 1]]) if (v) for (const src of pdpImgs(v[0]).slice(0, 2).map(small)) { const im = new Image(); im.src = src; }   // 그다음 장 미리
    }
    // 드래그 · 스와이프 (세로로 움직이면 PDP 스크롤에 양보) · 트랙패드 가로 밀기
    let drag = null, moved = false, wheelLock = 0;
    car.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, t: performance.now(), on: false, id: ev.pointerId }; moved = false; });
    car.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.on) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; if (Math.abs(dy) >= Math.abs(dx)) { drag = null; return; } drag.on = true; moved = true; cmpEl.hidden = true; car.setPointerCapture(ev.pointerId); car.classList.add('dk-drag'); }
      const edge = (sgn * dx > 0 && i === 0) || (sgn * dx < 0 && i === list.length - 1), ddx = edge ? dx * 0.3 : dx;   // 끝에서는 덜 끌림
      track.style.transition = 'none'; track.style.transform = `translate3d(${-sgn * i * G.step + ddx}px,0,0)`;
      parallax(-ddx * 0.22, false);   // 끄는 동안 내용은 덜 따라옴
    });
    const endDrag = (ev) => {
      const d = drag; drag = null; car.classList.remove('dk-drag'); if (!d || !d.on) return;
      const dx = ev.clientX - d.x, v = dx / Math.max(1, performance.now() - d.t), s = sgn * dx, sv = sgn * v;
      if ((s < -60 || sv < -0.45) && go(1)) return; if ((s > 60 || sv > 0.45) && go(-1)) return;
      layout(true);   // 제자리로
    };
    car.addEventListener('pointerup', endDrag); car.addEventListener('pointercancel', endDrag);
    car.addEventListener('wheel', (ev) => {
      if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY)) return;
      ev.preventDefault(); const now = performance.now(); if (now < wheelLock || Math.abs(ev.deltaX) < 20) return;
      wheelLock = now + 450; go(sgn * Math.sign(ev.deltaX));
    }, { passive: false });
    const stateOf = (u) => (isRemoved(u) ? 'rm' : busy(u) ? 'busy' : passed(u) || isOk(u) ? 'ok' : 'review');
    function panel() {
      const u = list[i], it = u[0], g = G, s = stateOf(u);
      D.root.dataset.st = s;   // 화면 배경 · 카드 테두리가 상태를 따른다
      document.getElementById('dkI').textContent = i + 1; document.getElementById('dkNn').textContent = ' / ' + list.length;
      document.getElementById('dkProg').style.width = ((i + 1) / list.length * 100) + '%';
      // 위엔 모델명과 제품군만 표시.
      const fam = familyOf(u);
      cap.innerHTML = `<div class="dk-cr"><b>${e(it.model || '')}</b>${fam ? `<span class="dk-fam">${e(fam)}</span>` : ''}</div>` + (s === 'busy' ? `<span>${e(redoLine(u))}</span>` : '');
      cmp();
      cap.style.left = g.x + 'px'; cap.style.width = g.cw + 'px';
      (rtl ? nextB : prevB).disabled = !i; (rtl ? prevB : nextB).disabled = i >= list.length - 1;
      // 버튼 셋은 늘 같은 자리 — 상태에 맞지 않는 것은 흐리게
      const can = { remove: s !== 'rm' && s !== 'busy', retry: s !== 'rm' && s !== 'busy', ok: s === 'review' && u.every(x => x.status === 'ok' && !(x.ai || []).some(a => !a.ok && a.blocked)) };
      acts.forEach((b) => { b.disabled = !can[b.dataset.a]; });
    }
    acts.forEach((b) => { b.onclick = async () => {
      const u = list[i], a = b.dataset.a;
      acts.forEach((x) => { x.disabled = true; });
      if ((await act(core, u, a, a === 'ok' ? { override: true } : null)) !== true) { sync(); return; }
      sync();
      if (!alive) return;
      if (all) { if (i < list.length - 1) go(1); return; }
      // 검토: 아직 정하지 않은 다음 건으로 (다시 준비 중인 것은 건너뜀) — 없으면 다시 준비가 끝나길 기다렸다가 완료로
      const n = list.length, j = [...Array(n).keys()].map((k) => (i + 1 + k) % n).find((k) => open(list[k]) && !busy(list[k]));
      if (j != null && j !== i) { const d = Math.sign(j - i); i = j; layout(true, d); return; }
      if (j === i && open(list[i]) && !busy(list[i])) return;
      if (!list.some((x) => open(x))) { leave(); return; }
    }; });
    function sync() {   // 서버 상태로 목록 · 지금 카드 · 줄 다시
      const by = new Map(C.units.map((u) => [ukey(u), u]));
      list = list.map((u) => by.get(ukey(u)) || u);
      for (const [k, c] of cards) {
        const it = list[k][0];
        if (c._content === JSON.stringify([it.status === 'failed', pdpImgs(it), it.ai])) {
          cardState(c, list[k]);
          if (c === el && c.classList.contains('dk-prob') && c._pi == null) seek(c, 0);
        } else {
          const replacement = mk(k, c);
          c.remove();
          if (c === el) {
            el = replacement;
            el.classList.add('dk-on');
            seek(el, 0);
          }
        }
      }
      panel();
      if (!polling && list.some((u) => busy(u) && !isRemoved(u))) {
        polling = true;
        (async () => {
          while (alive && list.some((u) => busy(u) && !isRemoved(u))) {
            await sleep(2000); await refresh(core); if (!alive) break; sync();
            if (!all && !list.some((x) => open(x))) { leave(); break; }   // 다시 준비가 통과로 끝나 남은 게 없으면 완료로
            if (!all && busy(list[i]) === false && !open(list[i])) { const j = list.findIndex((x) => open(x) && !busy(x)); if (j >= 0 && j !== i) { const d = Math.sign(j - i); i = j; layout(true, d); } }
          }
          polling = false;
        })();
      }
    }
    function go(d) { const j = i + d; if (j < 0 || j >= list.length) return false; i = j; layout(true, Math.sign(d)); return true; }
    function fullCard(c, g) {   // 크게 + 위치 막대 + '아래에 더 있음' (끝까지 내리면 사라짐)
      c.classList.add('dk-full'); c.style.width = g.cw + 'px';
      const ph = c.querySelector('.dk-ph'), sc = c.querySelector('.dk-sc'); ph.style.height = g.ch + 'px';
      const cm = c.querySelector('.cm'); if (cm) cm.style.zoom = (g.cw / 426).toFixed(3);
      const more = document.createElement('div'); more.className = 'dk-more'; more.setAttribute('aria-hidden', 'true'); more.innerHTML = `<span>${e(T.moreBelow)} ↓</span>`;   // 표시만 (누르는 것 아님 — 버튼은 위에만)
      ph.appendChild(more);
      // 위치 막대: 맥은 스크롤바가 숨어 있어서 직접 그린다 (어디쯤인지 · 얼마나 남았는지)
      const rail = document.createElement('div'); rail.className = 'dk-rail'; rail.innerHTML = '<i></i>'; ph.appendChild(rail);
      const upd = () => {
        const max = sc.scrollHeight - sc.clientHeight, k = max > 0 ? sc.scrollTop / max : 0, hh = Math.max(24, rail.clientHeight * sc.clientHeight / Math.max(1, sc.scrollHeight));
        rail.firstChild.style.height = hh + 'px'; rail.firstChild.style.transform = `translateY(${(rail.clientHeight - hh) * k}px)`; rail.hidden = max <= 4;
        more.classList.toggle('dk-end', sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4);
        // 위치 막대 위 빨간 표시 = 문제 자리 (지금 보는 문제는 더 굵게)
        const ps = c.classList.contains('dk-prob') ? c._issues : [];
        rail.querySelectorAll('s').forEach((x) => x.remove());
        ps.forEach((_, k) => {
          const mark = issueMarks(c, k)[0];
          if (!mark) return;
          const tick = document.createElement('s');
          if (k === c._pi) tick.className = 'on';
          tick.style.top = (Math.min(1, topIn(sc, mark) / Math.max(1, sc.scrollHeight)) * 100) + '%';
          rail.appendChild(tick);
        });
      };
      c._upd = upd;
      const update = () => { upd(); if (c === el) cmp(); };
      sc.addEventListener('scroll', update, { passive: true });
      c.querySelectorAll('img').forEach((im) => {
        im.addEventListener('load', update, { once: true });
        im.addEventListener('error', update, { once: true });
      });
      requestAnimationFrame(update);
    }
    const issueMarks = (c, k) => [...c.querySelectorAll(`.dk-bad[data-issue="${k}"]`)].filter((mark) => {
      const im = mark.parentElement.firstElementChild;
      return im.complete && im.naturalWidth > 0;
    });
    const topIn = (sc, n) => n.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    function seek(c, k) {
      if (!c || !c._issues.length || !c.classList.contains('dk-prob')) return;
      const n = c._issues.length;
      k = ((k % n) + n) % n;
      c._pi = k;
      c.querySelectorAll('.dk-bad').forEach((r) => r.classList.toggle('dk-cur', Number(r.dataset.issue) === k));
      const hot = c.querySelectorAll('.dk-cur');
      c.querySelectorAll('.dk-hot').forEach(slice => slice.classList.remove('dk-hot'));
      for (const mark of hot) mark.closest('.dk-si').classList.add('dk-hot');
      c.classList.toggle('dk-hotsi', hot.length > 0 && c._issues[k].kind === 'img');
      if (c === el) cmp();
      const first = c.querySelector('.dk-cur'), sc = c.querySelector('.dk-sc'), token = c._seek = {};
      sc.scrollTo({ top: sc.scrollTop, behavior: 'instant' });
      if (!first) { c._upd(); return; }
      const ims = [...c.querySelectorAll('.ck-imgs img')];
      const upto = ims.slice(0, ims.indexOf(first.parentElement.firstElementChild) + 1);
      const apply = () => {
        if (!alive || c !== el || c._seek !== token || c._pi !== k || !c.classList.contains('dk-prob')) return;
        const mark = issueMarks(c, k)[0];
        if (mark) sc.scrollTo({ top: Math.max(0, topIn(sc, mark) - 64 - sc.clientHeight * 0.12), behavior: reduced() ? 'instant' : 'smooth' });
        c._upd();
        cmp();
      };
      Promise.all(upto.map((im) => im.complete ? null : new Promise((resolve) => {
        im.addEventListener('load', resolve, { once: true });
        im.addEventListener('error', resolve, { once: true });
      }))).then(() => { if (reduced()) apply(); else setTimeout(apply, 560); }); // 9ce27fd: 카드가 정착한 뒤 문제 위치로 스크롤
    }
    function scrollBy(page, px) {   // ↓ · ↑ 조금, 스페이스 · Page Down 한 화면
      const sc = el && el.querySelector('.dk-sc'); if (!sc) return;
      sc.scrollBy({ top: px != null ? px : page * sc.clientHeight * 0.85, behavior: reduced() ? 'auto' : 'smooth' });
    }
    function key(ev) {
      // 오른쪽 칸의 근거 목록(스크롤 영역) 안에서만 키를 그 목록에 맡긴다 — 칸 밑 '다음' 버튼을 누른 뒤에도 N · ← → 는 그대로
      if (ev.target && (ev.target.closest?.('.dk-cmp-b') || /input|textarea|select/i.test(ev.target.tagName))) return;
      if (ev.target === viewport && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(ev.key)) return;
      const k = ev.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { ev.preventDefault(); scrollBy(0, k === 'ArrowDown' ? 160 : -160); return; }
      if (k === ' ' && ev.target && ev.target.closest('button, a')) return;
      if (k === ' ' || k === 'PageDown' || k === 'PageUp') { ev.preventDefault(); scrollBy(k === 'PageUp' || (k === ' ' && ev.shiftKey) ? -1 : 1); return; }
      if (k === 'Home' || k === 'End') { ev.preventDefault(); const sc = el && el.querySelector('.dk-sc'); if (sc) sc.scrollTo({ top: k === 'Home' ? 0 : sc.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' }); return; }
      if ((k === 'n' || k === 'N') && el && el.classList.contains('dk-prob')) { ev.preventDefault(); seek(el, (el._pi || 0) + 1); return; }
      if (k === 'ArrowRight') { ev.preventDefault(); go(rtl ? -1 : 1); } else if (k === 'ArrowLeft') { ev.preventDefault(); go(rtl ? 1 : -1); } else if (k === 'Escape' && back) { ev.preventDefault(); leave(true); }
    }
    function onResize() { if (!alive) return; place(); for (const [k, c] of cards) { c.style.left = cardLeft(k) + 'px'; c.style.width = G.cw + 'px'; c.querySelector('.dk-ph').style.height = G.ch + 'px'; const cm = c.querySelector('.cm'); if (cm) cm.style.zoom = (G.cw / 426).toFixed(3); c._upd(); } layout(false); if (el) seek(el, el._pi || 0); }
    const cmpSize = new ResizeObserver(() => cmp());
    cmpSize.observe(cmpBox);
    function leave(toGrid) {   // toGrid: 돌아가기 · Esc — 그리드에서 왔으면 그리드로. 아니면(다 정함 · 끝 화면에서 옴) 끝 화면으로
      if (!alive) return;
      alive = false; cancelAnimationFrame(pointFrame); clearTimeout(cmpT); cmpSize.disconnect(); document.removeEventListener('keydown', key); removeEventListener('resize', onResize);
      if (toGrid && from === 'grid') grid(core); else finishView(core);
    }
    document.addEventListener('keydown', key);
    if (back) document.getElementById('dkBack').onclick = () => leave(true);
    // 처음 자리 · 배경색은 바로 (비교 칸이 왼쪽 위에서 날아오지 않게, 배경이 물들지 않게) — 그 뒤 문제 자리를 따라갈 때만 움직인다
    cmpEl.style.transition = D.root.style.transition = 'none';
    place(); layout(false); sync();
    requestAnimationFrame(() => requestAnimationFrame(() => { cmpEl.style.transition = D.root.style.transition = ''; }));
    addEventListener('resize', onResize);
  }
  async function act(core, items, action, opts) {
    let who = ''; try { who = sessionStorage.getItem('clia_user') || localStorage.getItem('clia-bulk-mail') || ''; } catch (_) {}
    const rows = items.map(it => it.row);
    const reviewed = action === 'ok' ? Object.fromEntries(items.map(it =>
      [it.row, { hash: it.hash, contentDigest: it.contentDigest }])) : undefined;
    try {
      C.job = await core.api(`/api/v1/bulk/jobs/${C.job.id}/check`, { rows, action, by: who, override: !!(opts && opts.override), reviewed });
      C.units = units(C.job); alertLine(core, ''); return true;
    } catch (e) {
      if (e.code === 'review_changed') {
        await refresh(core);
        alertLine(core, C.T.reviewChanged);
        return 'review_changed';
      }
      alertLine(core, C.T.err + e.message);
      return false;
    }
  }
  function alertLine(core, msg) { const g = document.getElementById('ckGo'); if (g) g.innerHTML = msg ? `<div class="ck-why">${core.esc(msg)}</div>` : ''; }
  // 끝 · 완료 (2026-11-27 · 2026-11-28 그리드와 같은 위 줄): 가운데 한 줄(상태) · 버튼은 그리드와 같은 자리(끝 쪽) · 본문은 엑셀 시트.
  //   버튼은 늘 위 (벌크 Check 전체 규칙 — 아래에는 누르는 것을 두지 않는다)
  function pageFrame(core, step, line, btns, body) {
    const el = frame(core, step, true);
    el.innerHTML = `<div class="gd gd-pg" id="dk"><div class="gd-top"><div class="gd-acts" id="dkBar">${btns}</div><div class="gd-nums dk-line" id="dkLine">${line}</div></div>
      <div class="dk-body"><div class="xs-wrap">${body}</div></div></div><div id="ckGo"></div>`;
    return el;
  }
  const finLine = (core, todo) => { const T = C.T, ck = C.job.check || {}, removed = C.units.filter(isRemoved).length;
    return `<b>${core.esc(T.allDone)}</b><span>${core.esc([T.fReady + ' ' + todo.length, removed ? T.removed(removed) : '', ck.skipModels ? T.skipped(ck.skipModels) : ''].filter(Boolean).join(' · '))}</span>`; };
  const doneLine = (core) => { const T = C.T, ck = C.job.check || {};
    return `${CK}<b>${core.esc(T.doneT(ck.confirmed || 0))}</b><span>${core.esc([ck.removed ? T.removed(ck.removed) : '', ck.skipModels ? T.skipped(ck.skipModels) : ''].filter(Boolean).join(' · '))}</span>`; };
  const dlBtn = (core) => `<a class="dk-act pri" id="ckDl" href="${core.esc(C.job.file || '#')}" download>${core.esc(C.T.dl)}</a>`;
  // 끝: 준비된 것을 한 번에 확인 (승인 기록 via 'bulk' + 본 이미지 해시) → 받기. 시트는 설명 칸이 빈 채로 미리 보이고, 확인하면 채워진다
  async function finishView(core, go) {   // go: 그리드의 '확인하고 받기'로 왔으면 바로 확인 → 받기
    const T = C.T, e = core.esc;
    // 전체 보기에서 다시 준비한 것: 끝날 때까지 기다렸다가, 걸리면 검토로
    while (C.units.some((u) => busy(u) && !isRemoved(u))) { alertLine(core, T.redoing + '…'); await sleep(2000); await refresh(core); }
    if (needs().length) return viewer(core, 'review', 0, 'grid');   // 아직 정할 것이 있으면 하나씩 (돌아가기는 그리드로)
    const todo = C.units.filter((u) => passed(u) && !isOk(u) && !isRemoved(u));
    if (!todo.length) return doneView(core);
    const sh = sheet(core);
    pageFrame(core, 2, finLine(core, todo), `<button class="dk-act" id="ckView" type="button">${e(T.viewAll(C.units.length))}</button><button class="dk-act pri" id="ckAll" type="button">${e(T.confirmDl(todo.length))}</button>`, sh.html);
    document.getElementById('ckView').onclick = () => viewer(core, 'all', 0, 'finish');
    const b = document.getElementById('ckAll');
    b.onclick = async () => {
      document.querySelectorAll('#dkBar .dk-act').forEach((x) => { x.disabled = true; });
      const anim = !reduced(), okP = act(core, todo.flat(), 'ok');
      if (anim) fillSheet(core, sh, true);   // 시트 연출은 바로, 다운로드는 확인 요청이 끝나는 대로 (연출을 기다리지 않음)
      const outcome = await okP;
      if (outcome === 'review_changed') {
        const seen = new Map(todo.flat().map(it => [it.row, it]));
        const changed = C.units.findIndex(u => u.some(it => {
          const prior = seen.get(it.row);
          return prior && (prior.hash !== it.hash || prior.contentDigest !== it.contentDigest);
        }));
        viewer(core, 'all', Math.max(0, changed), 'finish');
        alertLine(core, T.reviewChanged);
        return;
      }
      if (!outcome) { const msg = (document.getElementById('ckGo') || {}).textContent || ''; await finishView(core); alertLine(core, msg); return; }
      download(); doneTop(core);
      if (!anim) fillSheet(core, sh, false);
    };
    if (go) b.click(); else b.focus();
  }
  function download() { if (C.job.file) { const a = document.createElement('a'); a.href = C.job.file; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); } }
  function doneTop(core) {   // 같은 자리에서: 확인 버튼 → 엑셀 받기, 위 한 줄 → 완료
    steps(core, 3);
    const line = document.getElementById('dkLine'), bar = document.getElementById('dkBar'); if (!line || !bar) return;
    line.innerHTML = doneLine(core); bar.innerHTML = dlBtn(core);
    if (!reduced()) [line, bar].forEach((x) => x.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: EZ.out }));
  }
  function doneView(core) { const sh = sheet(core); pageFrame(core, 3, doneLine(core), dlBtn(core), sh.html); fillSheet(core, sh, false); }
  // 엑셀 시트: 행 = 제품(엑셀 순서) · 행 번호 · 모델 · 설명 칸(강조). 9행 넘으면 앞 8행 + '+N행' 막대. 뺀 행은 처음부터 회색 빗금
  function sheet(core) {
    const T = C.T, e = core.esc;
    const rows = C.units.flatMap((u) => u.map((x) => ({ row: x.row, model: x.model || x.title || '', u, rm: isRemoved(u) }))).sort((a, b) => a.row - b.row);
    const MAXR = 9, vis = rows.length > MAXR ? rows.slice(0, MAXR - 1) : rows, rest = rows.slice(vis.length), restOk = rest.filter((r) => !r.rm).length;
    const fill = (r) => (r.rm ? `<span class="xs-rmv">${e(T.removedL)}</span>`
      : `<span class="xs-fill">${(r.u[0].imgs || []).slice(0, 3).map((s) => `<img src="${e(small(s))}" alt="">`).join('')}<em>${e(T.imgsN((r.u[0].imgs || []).length))}</em></span>`);
    const html = `<div class="xs" id="xs"><div class="xs-hd"><i></i>${e(C.fileName || 'result.xlsx')}</div>
      <div class="xs-row xs-h"><span class="xs-n"></span><span class="xs-m">${e(T.colModel)}</span><span class="xs-d">${e(T.colDesc)}</span></div>
      ${vis.map((r, k) => `<div class="xs-row${r.rm ? ' xs-out' : ''}" data-k="${k}"><span class="xs-n">${r.row}</span><span class="xs-m">${e(r.model)}</span><span class="xs-d">${fill(r)}</span></div>`).join('')}
      ${rest.length ? `<div class="xs-row xs-more"><span class="xs-n">…</span><span class="xs-m">${e(T.moreRows(rest.length))}</span><span class="xs-d"><span class="xs-bar"><i id="xsBar"></i></span></span></div>` : ''}</div>`;
    return { html, vis, rest, restOk };
  }
  // 내보내기 (확인하고 받기): 통과한 PDP 카드가 작아지며 그 행의 설명 칸으로 들어가 칸이 채워진다.
  //   앞 몇 장(최대 5)만 날아가고 나머지 행은 한꺼번에 · 아래 행은 막대로 — 100개여도 ~2초. anim 이 없으면 바로 채운 상태
  //   모션: 나타나기 expo.out → 칸으로 power3.out · 시차 90ms · 겹침 (HyperFrames). 아랍어는 칸 오른쪽부터
  async function fillSheet(core, sh, anim) {
    const e = core.esc, rtl = document.documentElement.dir === 'rtl', { vis, rest, restOk } = sh;
    const xs = document.getElementById('xs'); if (!xs) return;
    const wrap = xs.parentNode, rowEl = (k) => xs.querySelector(`.xs-row[data-k="${k}"]`), bar = document.getElementById('xsBar');
    const okRows = vis.map((r, k) => ({ r, k })).filter((x) => !x.r.rm), barTo = (rest.length ? restOk / rest.length * 100 : 100) + '%';
    if (!anim) { okRows.forEach(({ k }) => rowEl(k).classList.add('xs-on', 'xs-now')); if (bar) bar.style.width = barTo; return; }
    const fly = okRows.slice(0, 5), rel2 = (n) => { const a = n.getBoundingClientRect(), b = wrap.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height }; };
    const src = rel2(xs), sx = src.x + src.w / 2 - 60, sy = src.y + src.h * 0.5 - 85;   // 카드 120×170 이 시트 가운데에서 나와
    fly.forEach(({ r, k }, n) => {
      const c = document.createElement('div'); c.className = 'xs-card'; c.innerHTML = `<img src="${e(small((r.u[0].imgs || [])[0] || ''))}" alt="">`; wrap.appendChild(c);
      const d = rel2(rowEl(k).querySelector('.xs-d')), s = (d.h - 8) / 170, tx = rtl ? d.x + d.w - 16 - 120 * s : d.x + 6, ty = d.y + 4, x0 = sx + (n - 2) * 14, y0 = sy + Math.abs(n - 2) * 6;
      const a = c.animate([{ transform: `translate(${x0}px,${y0 + 16}px) scale(.86)`, opacity: 0, easing: EZ.out },
        { transform: `translate(${x0}px,${y0}px) scale(1) rotate(${(n - 2) * 2}deg)`, opacity: 1, offset: 0.24, easing: EZ.p3out },
        { transform: `translate(${tx}px,${ty}px) scale(${s})`, opacity: 1 }], { duration: 820, delay: n * 90, fill: 'both' });
      setTimeout(() => rowEl(k).classList.add('xs-on'), n * 90 + 700);   // 칸에 닿을 즈음 채워지기 시작 (겹침)
      a.finished.then(() => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EZ.p3in, fill: 'forwards' }).finished.then(() => c.remove()), () => c.remove());
    });
    await sleep(Math.max(0, fly.length - 1) * 90 + 640);
    okRows.slice(fly.length).forEach(({ k }, n) => setTimeout(() => { const x = rowEl(k); if (x) x.classList.add('xs-on'); }, n * 40));   // 나머지는 한꺼번에
    if (bar) bar.animate([{ width: '0%' }, { width: barTo }], { duration: 520, easing: EZ.out, fill: 'forwards' });
  }

  // ── 시작 · 이어 보기 ──
  async function begin(core) {
    const { S, d } = core;
    if (!d.cols || !d.cols.desc) return false;   // 설명 칸을 못 찾은 파일은 예전 흐름(칸 고르기)으로
    C = { core, T: tOf(core.L), job: null, units: [], open: false, fileName: d.fileName, rowsN: d.rows.length };
    const k = classify(core);
    const liveProducts = new Set(k.live.map((r) => (r.kind === 'bundle' ? 'b:' + r.row : r.p.slug || r.p.url)));
    C.skip = { n: k.models.length, models: k.models, rows: k.skip.length, by: k.by, asOf: k.asOf };
    C.liveN = liveProducts.size;
    prepView(core);
    if (!k.live.length) return true;
    const items = k.live.map((r) => (r.kind === 'bundle'
      ? { row: r.row, title: r.name, bundle: r.p.parts.map((x) => (x.register ? { url: x.url, register: true } : { slug: x.slug })) }
      : r.kind === 'new' ? { row: r.row, url: r.p.url, register: true, alts: r.p.alts, fuzzy: r.p.fuzzy } : { row: r.row, slug: r.p.slug }));
    try {
      C.job = await core.api('/api/v1/bulk/build', { id: d.id, channel: S.channel || d.channel || 'shopee', sheet: d.sheet, descCol: d.cols.desc, country: core.home(), lang: core.L, items,
        check: { skipModels: k.models.length, skipRows: k.skip.length, by: k.by, asOf: k.asOf } });
      C.skip = { ...C.skip, n: C.job.check?.skipModels ?? C.skip.n, rows: C.job.check?.skipRows ?? C.skip.rows };
      core.remember(C.job.id);
      grid(core);
    } catch (e) { alertLine(core, C.T.err + e.message); }
    return true;
  }
  async function resume(core, job) {
    C = { core, T: tOf(core.L), job, units: units(job), open: false, fileName: job.fileName || '', rowsN: 0, liveN: units(job).length,
      // 이어 볼 때는 건너뛴 목록 없이 숫자만
      skip: { n: (job.check && job.check.skipModels) || 0, models: [], rows: (job.check && job.check.skipRows) || 0, by: job.check && job.check.by, asOf: job.check && job.check.asOf } };
    if (job.status === 'running' || job.status === 'queued' || job.status === 'ready') return grid(core);   // 이어 볼 때: 이미 끝난 칸은 연출 없이 바로
    prepView(core); alertLine(core, C.T.err + (job.error || job.status));
  }
  window.BulkCheck = { begin, resume, _classify: classify, _units: units };
})();
