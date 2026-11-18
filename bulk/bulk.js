/* bulk.js — Shopee / Lazada 벌크 엑셀 (2026-11-18)
   빌더의 "Bulk Excel" 버튼이 이 화면을 빌더 위에 띄운다 (?embed=1&channel=&lang=&corp=).
   엑셀 첨부 → 인식·매칭 애니메이션 → 매칭된 제품 목록 → 전체 선택·해제·사업부(MS·HS·ES)별 선택 → 엑셀 내보내기.
   이미 설명이 있던 칸은 교체하고 "기존 설명 교체" 로 표시. 매칭이 안 되거나 애매한 행(후보 여러 개·묶음)은 엑셀에서 그대로 둔다.
   화면 언어는 법인 언어(?lang=, 태국 → 태국어), 확인용 ?lang=ko. 서버: bulk-routes.js */
(function () {
  const TX = {
    en: {
      title: 'Bulk Excel', drop: 'Attach the Shopee / Lazada bulk Excel', dropSub: 'Drop an .xlsx file here or click to choose',
      reading: 'Reading the Excel', matching: 'Matching products', again: 'Attach another file',
      found: (n) => `${n} products matched`, of: (all) => `out of ${all} products in the file`,
      selAll: 'Select all', selNone: 'Deselect all', viewList: 'List', viewGrid: 'Gallery',
      search: 'Search model or product name', qRes: (n) => `${n} results`, qSel: 'Select results', qDesel: 'Deselect results', shift: 'Tip: Shift + click selects a range',
      grp: { TV: 'TV', Audio: 'Audio', Monitor: 'Monitor', Laptop: 'Laptop', Projector: 'Projector', Fridge: 'Fridge', Washer: 'Washer', Dryer: 'Dryer', Vacuum: 'Vacuum', Dishwasher: 'Dishwasher', Cooking: 'Cooking', Styler: 'Styler', AC: 'Air conditioner', Purifier: 'Air purifier', Dehumidifier: 'Dehumidifier', Other: 'Other' },
      rep: 'Replaces current description', skip: (n) => `${n} products were not matched — they stay as they are in the Excel`,
      rNone: 'not in CLIA', rMulti: 'several CLIA products', rBundle: 'bundle',
      askCh: 'Which marketplace is this file for?', askDesc: 'The product description column was not found. Choose it:',
      info: (n, r) => `<b>${n}</b> selected` + (r ? ` · <span class="badge b-rep">${r} replace a current description</span>` : ''),
      exp: (n) => `Export Excel (${n})`, exporting: 'Exporting…', dlAgain: 'Download again',
      prog: (d, t) => `Exporting ${d} / ${t}`, done: (ok, rep, bad) => `✓ ${ok} filled` + (rep ? ` · ${rep} replaced` : '') + (bad ? ` · <span style="color:var(--bad)">${bad} failed</span>` : ''),
      q: 'Waiting', w: 'Making…', ok: 'Filled', okRep: 'Replaced', bad: 'Failed', imgs: (n) => `${n} images`, noSummary: 'Images only — summary could not be made',
      e_not_xlsx: ['This is not an Excel (.xlsx) file', 'Upload the .xlsx file you downloaded from the Shopee / Lazada seller center, as it is.'],
      e_xls_or_locked: ['This is an old .xls file or a password-protected Excel', 'In Excel, use Save As → .xlsx, or remove the password, then upload again.'],
      e_csv: ['This is a CSV / text file', 'Download the file from the seller center in Excel (.xlsx) format.'],
      e_broken: ['The file is damaged or was not fully downloaded', 'Download it again from the seller center and upload it again.'],
      e_too_big: ['The file is too large (max {n} MB)', 'Download the products in smaller parts from the seller center.'],
      e_notMarket: ['This does not look like a Shopee / Lazada bulk Excel', 'No product ID, SKU or product description column was found. Upload the file from the seller center’s mass update / bulk manage.'],
      e_noRows: ['There are no products in this file', 'It is an empty template with headers only. Download a file that contains your products.'],
      e_other: ['The file could not be read', ''],
      noMatchT: 'No product matches a CLIA product', noMatchB: 'The file may be for another country, or these products are not crawled in CLIA yet. The Excel stays as it is.',
      misT: (f, c) => `This file looks like a ${f} file, but you opened the ${c} builder.`, misB: 'How should the description be filled?', useAs: (c) => `Fill as ${c}`,
      upFail: 'Could not read the file: ', expFail: 'Export failed: ', leave: 'The Excel is still being exported. Close anyway?',
    },
    th: {
      title: 'Bulk Excel', drop: 'แนบไฟล์ Excel แบบ bulk ของ Shopee / Lazada', dropSub: 'วางไฟล์ .xlsx ที่นี่ หรือคลิกเพื่อเลือกไฟล์',
      reading: 'กำลังอ่านไฟล์ Excel', matching: 'กำลังจับคู่สินค้า', again: 'แนบไฟล์อื่น',
      found: (n) => `จับคู่สินค้าได้ ${n} รายการ`, of: (all) => `จากทั้งหมด ${all} รายการในไฟล์`,
      selAll: 'เลือกทั้งหมด', selNone: 'ยกเลิกทั้งหมด', viewList: 'รายการ', viewGrid: 'แกลเลอรี',
      search: 'ค้นหารุ่นหรือชื่อสินค้า', qRes: (n) => `ผลการค้นหา ${n} รายการ`, qSel: 'เลือกผลการค้นหา', qDesel: 'ยกเลิกผลการค้นหา', shift: 'เคล็ดลับ: Shift + คลิก เพื่อเลือกเป็นช่วง',
      grp: { TV: 'ทีวี', Audio: 'เครื่องเสียง', Monitor: 'จอมอนิเตอร์', Laptop: 'แล็ปท็อป', Projector: 'โปรเจกเตอร์', Fridge: 'ตู้เย็น', Washer: 'เครื่องซักผ้า', Dryer: 'เครื่องอบผ้า', Vacuum: 'เครื่องดูดฝุ่น', Dishwasher: 'เครื่องล้างจาน', Cooking: 'เครื่องครัว', Styler: 'สไตเลอร์', AC: 'เครื่องปรับอากาศ', Purifier: 'เครื่องฟอกอากาศ', Dehumidifier: 'เครื่องลดความชื้น', Other: 'อื่น ๆ' },
      rep: 'แทนที่รายละเอียดเดิม', skip: (n) => `${n} สินค้าจับคู่ไม่ได้ — จะคงเดิมในไฟล์ Excel`,
      rNone: 'ไม่มีใน CLIA', rMulti: 'ตรงกับหลายสินค้าใน CLIA', rBundle: 'สินค้าชุด',
      askCh: 'ไฟล์นี้เป็นของมาร์เก็ตเพลสใด?', askDesc: 'ไม่พบคอลัมน์รายละเอียดสินค้า โปรดเลือก:',
      info: (n, r) => `เลือก <b>${n}</b> รายการ` + (r ? ` · <span class="badge b-rep">แทนที่รายละเอียดเดิม ${r} รายการ</span>` : ''),
      exp: (n) => `ส่งออก Excel (${n})`, exporting: 'กำลังส่งออก…', dlAgain: 'ดาวน์โหลดอีกครั้ง',
      prog: (d, t) => `กำลังส่งออก ${d} / ${t}`, done: (ok, rep, bad) => `✓ เติมแล้ว ${ok} รายการ` + (rep ? ` · แทนที่ ${rep}` : '') + (bad ? ` · <span style="color:var(--bad)">ไม่สำเร็จ ${bad}</span>` : ''),
      q: 'รอคิว', w: 'กำลังสร้าง…', ok: 'เติมแล้ว', okRep: 'แทนที่แล้ว', bad: 'ไม่สำเร็จ', imgs: (n) => `${n} รูป`, noSummary: 'มีเฉพาะรูป — สร้างสรุปสินค้าไม่สำเร็จ',
      e_not_xlsx: ['ไม่ใช่ไฟล์ Excel (.xlsx)', 'กรุณาอัปโหลดไฟล์ .xlsx ที่ดาวน์โหลดจาก Seller Center ของ Shopee / Lazada โดยไม่ต้องแก้ไข'],
      e_xls_or_locked: ['เป็นไฟล์ .xls แบบเก่า หรือไฟล์ Excel ที่ตั้งรหัสผ่านไว้', 'ใน Excel ให้ใช้ "บันทึกเป็น" → .xlsx หรือลบรหัสผ่าน แล้วอัปโหลดอีกครั้ง'],
      e_csv: ['เป็นไฟล์ CSV / ข้อความ', 'กรุณาดาวน์โหลดไฟล์จาก Seller Center ในรูปแบบ Excel (.xlsx)'],
      e_broken: ['ไฟล์เสียหายหรือดาวน์โหลดไม่ครบ', 'กรุณาดาวน์โหลดจาก Seller Center ใหม่แล้วอัปโหลดอีกครั้ง'],
      e_too_big: ['ไฟล์ใหญ่เกินไป (สูงสุด {n} MB)', 'กรุณาแบ่งดาวน์โหลดสินค้าจาก Seller Center เป็นหลายไฟล์'],
      e_notMarket: ['ไฟล์นี้ดูไม่ใช่ไฟล์ Excel แบบ bulk ของ Shopee / Lazada', 'ไม่พบคอลัมน์รหัสสินค้า SKU หรือรายละเอียดสินค้า กรุณาอัปโหลดไฟล์จากเมนูแก้ไขสินค้าแบบกลุ่ม (Mass Update / Bulk Manage) ของ Seller Center'],
      e_noRows: ['ไม่มีสินค้าในไฟล์นี้', 'เป็นแบบฟอร์มเปล่าที่มีแต่หัวตาราง กรุณาดาวน์โหลดไฟล์ที่มีสินค้าของคุณ'],
      e_other: ['อ่านไฟล์ไม่ได้', ''],
      noMatchT: 'ไม่มีสินค้าที่ตรงกับสินค้าใน CLIA', noMatchB: 'ไฟล์อาจเป็นของประเทศอื่น หรือสินค้าเหล่านี้ยังไม่ได้ครอว์ลใน CLIA ไฟล์ Excel จะคงเดิม',
      misT: (f, c) => `ไฟล์นี้ดูเหมือนไฟล์ ${f} แต่คุณเปิดจากตัวสร้าง ${c}`, misB: 'ต้องการเติมรายละเอียดแบบใด?', useAs: (c) => `เติมแบบ ${c}`,
      upFail: 'อ่านไฟล์ไม่ได้: ', expFail: 'ส่งออกไม่สำเร็จ: ', leave: 'กำลังส่งออก Excel อยู่ ต้องการปิดหรือไม่?',
    },
    ko: {
      title: '벌크 엑셀', drop: 'Shopee / Lazada 벌크 엑셀을 첨부하세요', dropSub: '.xlsx 파일을 여기에 끌어 놓거나 눌러서 고르세요',
      reading: '엑셀을 읽고 있습니다', matching: '제품을 매칭하고 있습니다', again: '다른 파일 첨부',
      found: (n) => `${n}개 제품이 매칭됐습니다`, of: (all) => `파일 안 ${all}개 상품 중`,
      selAll: '전체 선택', selNone: '전체 해제', viewList: '리스트', viewGrid: '갤러리',
      search: '모델명·상품명 검색', qRes: (n) => `검색 결과 ${n}개`, qSel: '검색 결과 선택', qDesel: '검색 결과 해제', shift: '팁: Shift + 클릭으로 범위 선택',
      grp: { TV: 'TV', Audio: '오디오', Monitor: '모니터', Laptop: '노트북', Projector: '프로젝터', Fridge: '냉장고', Washer: '세탁기', Dryer: '건조기', Vacuum: '청소기', Dishwasher: '식기세척기', Cooking: '조리기기', Styler: '스타일러', AC: '에어컨', Purifier: '공기청정기', Dehumidifier: '제습기', Other: '기타' },
      rep: '기존 설명 교체', skip: (n) => `매칭되지 않은 상품 ${n}개 — 엑셀에서 그대로 둡니다`,
      rNone: 'CLIA 에 없음', rMulti: 'CLIA 제품 여러 개와 맞음', rBundle: '묶음 상품',
      askCh: '어느 마켓 파일인가요?', askDesc: '상품 설명 열을 찾지 못했습니다. 골라 주세요:',
      info: (n, r) => `<b>${n}</b>개 선택` + (r ? ` · <span class="badge b-rep">${r}개는 기존 설명 교체</span>` : ''),
      exp: (n) => `엑셀 내보내기 (${n})`, exporting: '내보내는 중…', dlAgain: '다시 받기',
      prog: (d, t) => `내보내는 중 ${d} / ${t}`, done: (ok, rep, bad) => `✓ ${ok}개 채움` + (rep ? ` · ${rep}개 교체` : '') + (bad ? ` · <span style="color:var(--bad)">${bad}개 실패</span>` : ''),
      q: '대기', w: '만드는 중…', ok: '채움', okRep: '교체함', bad: '실패', imgs: (n) => `이미지 ${n}장`, noSummary: '요약을 만들지 못해 이미지만 넣음',
      e_not_xlsx: ['엑셀(.xlsx) 파일이 아닙니다', 'Shopee·Lazada 셀러 센터에서 내려받은 .xlsx 파일을 그대로 올려 주세요.'],
      e_xls_or_locked: ['예전 형식(.xls)이거나 비밀번호가 걸린 엑셀입니다', '엑셀에서 "다른 이름으로 저장 → .xlsx" 로 저장하거나 비밀번호를 풀고 다시 올려 주세요.'],
      e_csv: ['CSV·텍스트 파일입니다', '셀러 센터에서 엑셀(.xlsx) 형식으로 내려받아 주세요.'],
      e_broken: ['파일이 손상됐거나 끝까지 받지 못했습니다', '셀러 센터에서 다시 내려받아 올려 주세요.'],
      e_too_big: ['파일이 너무 큽니다 (최대 {n}MB)', '셀러 센터에서 상품을 나눠 내려받아 주세요.'],
      e_notMarket: ['Shopee·Lazada 벌크 엑셀이 아닌 것 같습니다', '상품 ID·SKU·상품 설명 열을 찾지 못했습니다. 셀러 센터의 대량 수정(Mass Update / Bulk Manage)에서 받은 파일을 올려 주세요.'],
      e_noRows: ['파일에 상품이 없습니다', '머리글만 있는 빈 양식입니다. 상품이 들어간 파일을 내려받아 올려 주세요.'],
      e_other: ['파일을 읽지 못했습니다', ''],
      noMatchT: 'CLIA 제품과 매칭되는 상품이 없습니다', noMatchB: '다른 나라 파일이거나, 이 상품들이 아직 CLIA 에 크롤되지 않았을 수 있습니다. 엑셀은 그대로입니다.',
      misT: (f, c) => `이 파일은 ${f} 파일로 보입니다 (지금 연 빌더: ${c})`, misB: '어느 방식으로 설명을 채울까요?', useAs: (c) => `${c} 방식으로 채우기`,
      upFail: '파일을 읽지 못했습니다: ', expFail: '내보내기 실패: ', leave: '엑셀을 내보내는 중입니다. 닫을까요?',
    },
    de: {
      title: 'Bulk-Excel', drop: 'Shopee-/Lazada-Bulk-Excel anhängen', dropSub: '.xlsx-Datei hier ablegen oder zum Auswählen klicken',
      reading: 'Excel wird gelesen', matching: 'Produkte werden zugeordnet', again: 'Andere Datei anhängen',
      found: (n) => `${n} Produkte zugeordnet`, of: (all) => `von ${all} Produkten in der Datei`,
      selAll: 'Alle auswählen', selNone: 'Alle abwählen', viewList: 'Liste', viewGrid: 'Galerie',
      search: 'Modell oder Produktname suchen', qRes: (n) => `${n} Treffer`, qSel: 'Treffer auswählen', qDesel: 'Treffer abwählen', shift: 'Tipp: Umschalt + Klick wählt einen Bereich',
      grp: { TV: 'TV', Audio: 'Audio', Monitor: 'Monitor', Laptop: 'Laptop', Projector: 'Beamer', Fridge: 'Kühlschrank', Washer: 'Waschmaschine', Dryer: 'Trockner', Vacuum: 'Staubsauger', Dishwasher: 'Geschirrspüler', Cooking: 'Kochen', Styler: 'Styler', AC: 'Klimaanlage', Purifier: 'Luftreiniger', Dehumidifier: 'Luftentfeuchter', Other: 'Sonstiges' },
      rep: 'Ersetzt aktuelle Beschreibung', skip: (n) => `${n} Produkte nicht zugeordnet — sie bleiben unverändert`,
      rNone: 'nicht in CLIA', rMulti: 'mehrere CLIA-Produkte', rBundle: 'Set',
      askCh: 'Für welchen Marktplatz ist diese Datei?', askDesc: 'Spalte für die Produktbeschreibung nicht gefunden. Bitte wählen:',
      info: (n, r) => `<b>${n}</b> ausgewählt` + (r ? ` · <span class="badge b-rep">${r} ersetzen eine Beschreibung</span>` : ''),
      exp: (n) => `Excel exportieren (${n})`, exporting: 'Exportiere…', dlAgain: 'Erneut herunterladen',
      prog: (d, t) => `Exportiere ${d} / ${t}`, done: (ok, rep, bad) => `✓ ${ok} gefüllt` + (rep ? ` · ${rep} ersetzt` : '') + (bad ? ` · <span style="color:var(--bad)">${bad} fehlgeschlagen</span>` : ''),
      q: 'Wartet', w: 'Wird erstellt…', ok: 'Gefüllt', okRep: 'Ersetzt', bad: 'Fehler', imgs: (n) => `${n} Bilder`, noSummary: 'Nur Bilder — Zusammenfassung fehlgeschlagen',
      e_not_xlsx: ['Keine Excel-Datei (.xlsx)', 'Laden Sie die .xlsx-Datei aus dem Shopee-/Lazada-Seller-Center unverändert hoch.'],
      e_xls_or_locked: ['Alte .xls-Datei oder passwortgeschützte Excel-Datei', 'In Excel „Speichern unter → .xlsx“ wählen oder das Passwort entfernen und erneut hochladen.'],
      e_csv: ['CSV-/Textdatei', 'Laden Sie die Datei im Seller-Center im Excel-Format (.xlsx) herunter.'],
      e_broken: ['Die Datei ist beschädigt oder unvollständig', 'Laden Sie sie im Seller-Center erneut herunter.'],
      e_too_big: ['Die Datei ist zu groß (max. {n} MB)', 'Laden Sie die Produkte in kleineren Teilen herunter.'],
      e_notMarket: ['Keine Shopee-/Lazada-Bulk-Excel', 'Keine Spalte für Produkt-ID, SKU oder Beschreibung gefunden. Laden Sie die Datei aus der Massenbearbeitung des Seller-Centers hoch.'],
      e_noRows: ['Die Datei enthält keine Produkte', 'Leere Vorlage nur mit Kopfzeilen. Laden Sie eine Datei mit Ihren Produkten herunter.'],
      e_other: ['Datei konnte nicht gelesen werden', ''],
      noMatchT: 'Kein Produkt passt zu einem CLIA-Produkt', noMatchB: 'Die Datei ist evtl. für ein anderes Land, oder die Produkte sind noch nicht in CLIA gecrawlt. Die Excel-Datei bleibt unverändert.',
      misT: (f, c) => `Diese Datei sieht wie eine ${f}-Datei aus (geöffneter Builder: ${c}).`, misB: 'Wie soll die Beschreibung gefüllt werden?', useAs: (c) => `Als ${c} füllen`,
      upFail: 'Datei konnte nicht gelesen werden: ', expFail: 'Export fehlgeschlagen: ', leave: 'Der Export läuft noch. Trotzdem schließen?',
    },
    ar: {
      title: 'Excel مجمّع', drop: 'أرفق ملف Excel المجمّع من Shopee / Lazada', dropSub: 'أسقط ملف ‎.xlsx هنا أو انقر للاختيار',
      reading: 'جارٍ قراءة الملف', matching: 'جارٍ مطابقة المنتجات', again: 'إرفاق ملف آخر',
      found: (n) => `تمت مطابقة ${n} منتجات`, of: (all) => `من أصل ${all} منتجاً في الملف`,
      selAll: 'تحديد الكل', selNone: 'إلغاء تحديد الكل', viewList: 'قائمة', viewGrid: 'معرض',
      search: 'ابحث بالطراز أو اسم المنتج', qRes: (n) => `${n} نتائج`, qSel: 'تحديد النتائج', qDesel: 'إلغاء تحديد النتائج', shift: 'تلميح: Shift + نقرة لتحديد نطاق',
      grp: { TV: 'تلفزيون', Audio: 'الصوتيات', Monitor: 'شاشة', Laptop: 'لابتوب', Projector: 'بروجكتور', Fridge: 'ثلاجة', Washer: 'غسالة', Dryer: 'مجفف', Vacuum: 'مكنسة', Dishwasher: 'غسالة صحون', Cooking: 'الطهي', Styler: 'ستايلر', AC: 'مكيف', Purifier: 'منقي هواء', Dehumidifier: 'مزيل رطوبة', Other: 'أخرى' },
      rep: 'يستبدل الوصف الحالي', skip: (n) => `لم تتم مطابقة ${n} منتجات — ستبقى كما هي`,
      rNone: 'غير موجود في CLIA', rMulti: 'عدة منتجات في CLIA', rBundle: 'مجموعة',
      askCh: 'لأي متجر هذا الملف؟', askDesc: 'لم يتم العثور على عمود وصف المنتج. اختره:',
      info: (n, r) => `تم تحديد <b>${n}</b>` + (r ? ` · <span class="badge b-rep">${r} تستبدل وصفاً حالياً</span>` : ''),
      exp: (n) => `تصدير Excel ‏(${n})`, exporting: 'جارٍ التصدير…', dlAgain: 'تنزيل مجدداً',
      prog: (d, t) => `جارٍ التصدير ${d} / ${t}`, done: (ok, rep, bad) => `✓ تم ملء ${ok}` + (rep ? ` · استبدال ${rep}` : '') + (bad ? ` · <span style="color:var(--bad)">فشل ${bad}</span>` : ''),
      q: 'في الانتظار', w: 'جارٍ الإنشاء…', ok: 'تم الملء', okRep: 'تم الاستبدال', bad: 'فشل', imgs: (n) => `${n} صور`, noSummary: 'صور فقط — تعذّر إنشاء الملخص',
      e_not_xlsx: ['هذا ليس ملف Excel ‏(.xlsx)', 'ارفع ملف ‎.xlsx الذي نزّلته من مركز البائعين في Shopee / Lazada كما هو.'],
      e_xls_or_locked: ['ملف ‎.xls قديم أو ملف Excel محمي بكلمة مرور', 'في Excel استخدم "حفظ باسم ← ‎.xlsx" أو أزل كلمة المرور ثم ارفعه مجدداً.'],
      e_csv: ['هذا ملف CSV / نصي', 'نزّل الملف من مركز البائعين بصيغة Excel ‏(.xlsx).'],
      e_broken: ['الملف تالف أو لم يكتمل تنزيله', 'نزّله مجدداً من مركز البائعين ثم ارفعه.'],
      e_too_big: ['الملف كبير جداً (الحد {n} ميغابايت)', 'نزّل المنتجات على أجزاء أصغر.'],
      e_notMarket: ['لا يبدو أن هذا ملف Excel مجمّع من Shopee / Lazada', 'لم يتم العثور على عمود معرّف المنتج أو SKU أو الوصف. ارفع الملف من التعديل المجمّع في مركز البائعين.'],
      e_noRows: ['لا توجد منتجات في هذا الملف', 'قالب فارغ بالعناوين فقط. نزّل ملفاً يحتوي على منتجاتك.'],
      e_other: ['تعذّرت قراءة الملف', ''],
      noMatchT: 'لا يوجد منتج يطابق منتجات CLIA', noMatchB: 'قد يكون الملف لدولة أخرى، أو لم يتم زحف هذه المنتجات في CLIA بعد. يبقى الملف كما هو.',
      misT: (f, c) => `يبدو هذا الملف ملف ${f} (الأداة المفتوحة: ${c})`, misB: 'كيف تريد ملء الوصف؟', useAs: (c) => `الملء كـ ${c}`,
      upFail: 'تعذّرت قراءة الملف: ', expFail: 'فشل التصدير: ', leave: 'لا يزال التصدير جارياً. الإغلاق على أي حال؟',
    },
  };
  const qs = new URLSearchParams(location.search);
  const L = TX[qs.get('lang')] ? qs.get('lang') : 'en';
  const T = TX[L];
  const t = (k, ...a) => { const v = T[k] ?? TX.en[k]; return typeof v === 'function' ? v(...a) : v; };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const EMBED = qs.get('embed') === '1';
  const home = String(qs.get('corp') || '').toLowerCase();
  const DIVS = ['MS', 'HS', 'ES'];
  // 사업부별 제품군 순서 (허브 목록과 같음)
  const GRPS = { MS: ['TV', 'Audio', 'Monitor', 'Laptop', 'Projector', 'Other'], HS: ['Fridge', 'Washer', 'Dryer', 'Vacuum', 'Dishwasher', 'Cooking', 'Styler', 'Other'], ES: ['AC', 'Purifier', 'Dehumidifier'] };
  const grpName = (g) => (T.grp || TX.en.grp)[g] || g;

  const CH0 = ['shopee', 'lazada'].includes(qs.get('channel')) ? qs.get('channel') : '';   // 빌더가 넘긴 채널
  const chName = (c) => (c === 'lazada' ? 'Lazada' : 'Shopee');
  const S = { q: '', last: null, mis: '', data: null, channel: CH0, ok: [], skip: [], sel: new Set(), job: null, busy: false };

  document.documentElement.lang = L;
  document.documentElement.dir = L === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i); });
  function chTag() { $('chTag').textContent = S.channel === 'lazada' ? 'Lazada' : 'Shopee'; $('chTag').classList.toggle('hidden', !S.channel); }
  chTag();
  $('close').onclick = () => {
    if (S.busy && !confirm(t('leave'))) return;
    if (EMBED && parent !== window) parent.postMessage('clia-bulk-close', '*');
    else if (history.length > 1) history.back(); else location.href = '/clia/';
  };
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
  const show = (id) => ['s1', 's2', 's3'].forEach((x) => $(x).classList.toggle('hidden', x !== id));

  // ── 1. 첨부 ──
  const drop = $('drop'), file = $('file');
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) attach(e.dataTransfer.files[0]); };
  file.onchange = () => { if (file.files[0]) attach(file.files[0]); file.value = ''; };
  $('again').onclick = () => { if (!S.busy) file.click(); };

  // ── 2. 인식 → 매칭 (서버는 한 번에 하지만 두 단계가 보이게 최소 시간을 둔다) ──
  // 잘못된 파일: 첨부 화면으로 돌아가 무엇이 잘못됐고 어떻게 하면 되는지 사용자 언어로 보여 준다
  function fail(code, extra) {
    const [title, body] = T['e_' + code] || TX.en['e_' + code] || T.e_other;
    show('s1');
    $('foot').style.display = 'none';
    $('et').textContent = title.replace('{n}', (extra && extra.maxMb) || 40);
    $('eb').textContent = body || (extra && extra.error) || '';
    $('ef').textContent = (extra && extra.fileName) || '';
    $('ecard').classList.remove('hidden');
  }
  async function attach(f) {
    if (S.busy) return;
    $('ecard').classList.add('hidden');
    $('pfile').textContent = f.name;
    $('pmsg').textContent = t('reading');
    $('foot').style.display = 'none';
    show('s2');
    const t0 = Date.now();
    const req = fetch('/api/v1/bulk/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })
      .then(async (r) => {
        const d = await r.json().catch(() => ({ code: r.status === 413 ? 'too_big' : 'other' }));
        if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { code: d.code || 'other', maxMb: d.maxMb });
        return d;
      });
    try {
      await Promise.race([sleep(900), req.catch(() => {})]);
      await sleep(Math.max(0, 900 - (Date.now() - t0)));
      $('pmsg').textContent = t('matching');
      const d = await req;
      await sleep(Math.max(0, 2000 - (Date.now() - t0)));
      if (!d.looksLikeMarket) return fail('notMarket', { fileName: f.name });
      if (!d.rows.length) return fail('noRows', { fileName: f.name });
      // 빌더 채널과 파일이 다르면(예: Shopee 화면에 Lazada 파일) 고를 때까지 내보내기를 막는다
      S.mis = CH0 && d.channel && d.channel !== CH0 ? d.channel : '';
      S.channel = S.mis ? '' : (CH0 || d.channel || '');
      chTag();
      S.job = null; S.q = ''; S.last = null; $('q').value = '';
      setData(d, true);
    } catch (e) {
      fail(e.code || 'other', { maxMb: e.maxMb, error: e.message, fileName: f.name });
    }
  }

  // 매칭: CLIA 제품 하나에 딱 맞는 행만 (법인 나라 제품을 먼저 본다). 나머지는 엑셀에서 그대로
  function setData(d, fresh) {
    S.data = d;
    S.ok = []; S.skip = [];
    for (const r of d.rows) {
      let c = r.candidates.map((s) => d.products[s]).filter(Boolean);
      if (home && c.some((p) => p.country === home)) c = c.filter((p) => p.country === home);
      if (r.bundle) S.skip.push({ ...r, why: 'rBundle' });
      else if (!c.length) S.skip.push({ ...r, why: 'rNone' });
      else if (c.length > 1) S.skip.push({ ...r, why: 'rMulti' });
      else S.ok.push({ ...r, p: c[0] });
    }
    if (fresh) S.sel = new Set(S.ok.map((r) => r.row));
    show('s3');
    render(fresh);
  }
  $('descSel').onchange = async () => {
    const v = +$('descSel').value;
    if (!v) return;
    const r = await fetch('/api/v1/bulk/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: S.data.id, sheet: S.data.sheet, cols: { desc: v } }) });
    const d = await r.json();
    if (r.ok) setData(d, false); else alert(d.error || 'HTTP ' + r.status);
  };
  $('askMis').onclick = (e) => { const c = e.target.closest('button'); if (c && c.dataset.ch && !S.busy) { S.channel = c.dataset.ch; chTag(); render(); } };
  $('askCh').onclick = (e) => { const c = e.target.dataset && e.target.dataset.ch; if (c) { S.channel = c; chTag(); render(); } };

  // ── 3. 목록 ──
  function itemStatus(r) {
    const it = S.job && S.job.items && S.job.items.find((x) => x.row === r.row);
    if (!it) return r.descLen > 0 ? `<span class="badge b-rep">${esc(t('rep'))}</span>` : '';
    if (it.status === 'queued') return `<span class="badge b-q">${esc(t('q'))}</span>`;
    if (it.status === 'working') return `<span class="badge b-run">${esc(t('w'))}</span>`;
    if (it.status === 'failed') return `<span class="badge b-bad">${esc(t('bad'))}</span><span class="note">${esc(it.error)}</span>`;
    return `<span class="badge ${it.prevLen > 0 ? 'b-rep' : 'b-ok'}">${esc(it.prevLen > 0 ? t('okRep') : t('ok'))}</span><span class="note">${esc(t('imgs', it.images))}</span>` +
      (it.summaryErr ? `<span class="note" style="color:var(--warn)" title="${esc(it.summaryErr)}">${esc(t('noSummary'))}</span>` : '');
  }

  function render(animate) {
    const d = S.data;
    $('askCh').classList.toggle('hidden', !!S.channel || !!S.mis);
    $('askMis').classList.toggle('hidden', !S.mis || !!S.channel);
    if (S.mis) {
      $('misT').textContent = t('misT', chName(S.mis), chName(CH0));
      $('misB').textContent = t('misB');
      $('misA').textContent = t('useAs', chName(S.mis)); $('misA').dataset.ch = S.mis;
      $('misB2').textContent = t('useAs', chName(CH0)); $('misB2').dataset.ch = CH0;
    }
    $('noMatch').classList.toggle('hidden', S.ok.length > 0);
    $('noMatchT').textContent = t('noMatchT'); $('noMatchB').textContent = t('noMatchB');
    ['ctl', 'ctl2'].forEach((id) => $(id).classList.toggle('hidden', !S.ok.length));
    document.querySelector('.srch').classList.toggle('hidden', !S.ok.length);
    if (!S.ok.length) $('skip').open = true;
    $('askDesc').classList.toggle('hidden', !!d.cols.desc);
    if (!d.cols.desc) $('descSel').innerHTML = '<option value="">—</option>' + d.columns.map((c) => `<option value="${c.col}">${c.letter} · ${esc(c.label)}</option>`).join('');
    $('rn').textContent = t('found', S.ok.length);
    $('rf').textContent = t('of', d.rows.length);
    $('list').innerHTML = S.ok.map((r, i) => `<label class="item" style="${animate ? `animation-delay:${Math.min(i, 30) * 45}ms` : 'animation:none'}">` +
      `<input type="checkbox" data-row="${r.row}">` +
      `<img src="${esc(r.p.thumb || '')}" alt="" loading="lazy">` +
      `<div style="min-width:0"><div class="m">${esc(r.p.model)}<span class="dv">${esc(r.p.dv || '')} · ${esc(grpName(r.p.grp))}</span></div><div class="s">${esc(r.name || r.p.title)}</div></div>` +
      `<div class="r" data-st="${r.row}"></div></label>`).join('');
    $('list').classList.toggle('hidden', !S.ok.length);
    $('skip').classList.toggle('hidden', !S.skip.length);
    $('skipSum').textContent = t('skip', S.skip.length);
    $('skipList').innerHTML = S.skip.map((r) => `<li>${esc(r.parentSku || r.sku || '—')} · ${esc(r.name)} <span class="badge b-q">${esc(t(r.why))}</span></li>`).join('');
    $('foot').style.display = S.ok.length ? 'block' : 'none';   // 매칭 0개면 내보낼 것이 없다
    refresh();
  }

  // 선택·상태만 다시 그린다 (목록 애니메이션은 처음 한 번)
  function refresh() {
    const n = S.ok.length;
    const cnt = (dv) => S.ok.filter((r) => r.p.dv === dv);
    const allOf = (rows) => rows.length > 0 && rows.every((r) => S.sel.has(r.row));
    // 선택 버튼: 전체 · 사업부 · 제품군 — 누르면 그 묶음을 모두 선택(이미 모두 선택이면 해제). 일부만 선택된 묶음은 반쯤 칠한 모양
    const pill = (attr, label, rows) => {
      const k = rows.filter((r) => S.sel.has(r.row)).length;
      const st = k === 0 ? '' : (k === rows.length ? 'on' : 'part');
      return `<button class="pill ${st}" ${attr}>${esc(label)}<b>${k ? k + '/' : ''}${rows.length}</b></button>`;
    };
    const ofDv = (dv) => S.ok.filter((r) => r.p.dv === dv);
    const ofGrp = (dv, g) => S.ok.filter((r) => r.p.dv === dv && r.p.grp === g);
    $('ctl').innerHTML =
      `<button class="pill ${allOf(S.ok) ? 'on' : ''}" data-act="all">${esc(t('selAll'))}<b>${n}</b></button>` +
      `<button class="pill" data-act="none">${esc(t('selNone'))}</button><span class="div"></span>` +
      DIVS.filter((dv) => ofDv(dv).length).map((dv) => pill(`data-dv="${dv}"`, dv, ofDv(dv))).join('');
    $('ctl2').innerHTML = DIVS.filter((dv) => ofDv(dv).length).map((dv) =>
      GRPS[dv].filter((g) => ofGrp(dv, g).length).map((g) => pill(`data-dv="${dv}" data-grp="${g}"`, grpName(g), ofGrp(dv, g))).join('')).filter(Boolean).join('<span class="div"></span>');
    [...$('ctl').querySelectorAll('button'), ...$('ctl2').querySelectorAll('button'), ...$('qAct').querySelectorAll('button')].forEach((b) => { b.disabled = S.busy; });
    // 검색: 맞는 상품만 보이고, 결과를 한꺼번에 선택·해제
    const hit = (r) => !S.q || [r.p.model, r.name, r.sku, r.parentSku, r.p.title, r.id].join(' ').toLowerCase().includes(S.q);
    const hits = S.ok.filter(hit);
    $('qAct').classList.toggle('hidden', !S.q);
    $('qN').textContent = t('qRes', hits.length);
    document.querySelectorAll('#list .item').forEach((el) => {
      const row = +el.querySelector('input').dataset.row;
      const r = S.ok.find((x) => x.row === row);
      el.querySelector('input').checked = S.sel.has(row);
      el.querySelector('input').disabled = S.busy;
      el.classList.toggle('off', !S.sel.has(row));
      el.classList.toggle('hidden', !hit(r));
      el.querySelector('.r').innerHTML = itemStatus(r);
    });
    // 아래 막대
    const c = S.ok.filter((r) => S.sel.has(r.row)), rep = c.filter((r) => r.descLen > 0).length;
    const j = S.job, running = j && j.status === 'running';
    if (running) {
      const prods = new Set(j.items.map((x) => x.slug)).size;
      const doneP = new Set(j.items.filter((x) => x.status === 'ok' || x.status === 'failed').map((x) => x.slug)).size;
      $('info').textContent = t('prog', doneP, prods);
      $('prog').firstElementChild.style.width = (100 * doneP / Math.max(1, prods)) + '%';
    } else if (j && j.status === 'ready') $('info').innerHTML = t('done', j.ok, j.replaced, j.failed);
    else if (j && j.status === 'failed') $('info').innerHTML = `<span style="color:var(--bad)">${esc(t('expFail') + (j.error || ''))}</span>`;
    else $('info').innerHTML = t('info', c.length, rep);
    $('prog').classList.toggle('hidden', !running);
    $('export').textContent = S.busy ? t('exporting') : t('exp', c.length);
    $('export').disabled = S.busy || !c.length || !S.channel || !S.data.cols.desc;
    $('dl').classList.toggle('hidden', !(j && j.status === 'ready' && !S.busy));
    if (j && j.file) { $('dl').href = j.file; $('dl').setAttribute('download', j.fileName || 'clia-bulk.xlsx'); }
    $('again').disabled = S.busy;
  }

  $('ctl2').onclick = (e) => $('ctl').onclick(e);
  $('ctl').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || S.busy) return;
    if (b.dataset.act === 'all') S.ok.forEach((r) => S.sel.add(r.row));
    else if (b.dataset.act === 'none') S.sel.clear();
    else if (b.dataset.dv) {
      const rows = S.ok.filter((r) => r.p.dv === b.dataset.dv && (!b.dataset.grp || r.p.grp === b.dataset.grp));
      const on = rows.every((r) => S.sel.has(r.row));
      rows.forEach((r) => (on ? S.sel.delete(r.row) : S.sel.add(r.row)));
    }
    if (S.job && S.job.status !== 'running') S.job = null;
    refresh();
  };
  // Shift + 클릭: 마지막으로 누른 상품부터 이번 상품까지(보이는 순서) 같은 상태로
  let shiftDown = false;
  $('list').addEventListener('click', (e) => { shiftDown = e.shiftKey; }, true);
  $('list').onchange = (e) => {
    const el = e.target;
    if (!el.dataset.row) return;
    const row = +el.dataset.row;
    const vis = [...document.querySelectorAll('#list .item:not(.hidden) input')].map((x) => +x.dataset.row);
    const a = vis.indexOf(S.last), z = vis.indexOf(row);
    const range = shiftDown && a >= 0 && z >= 0 ? vis.slice(Math.min(a, z), Math.max(a, z) + 1) : [row];
    range.forEach((x) => (el.checked ? S.sel.add(x) : S.sel.delete(x)));
    S.last = row;
    if (S.job && S.job.status !== 'running') S.job = null;
    refresh();
  };

  // 보기 전환: 리스트(기본, 열 때마다 리스트) · 갤러리
  let VIEW = 'list';
  function setView(v) {
    VIEW = v === 'grid' ? 'grid' : 'list';
    $('list').classList.toggle('grid', VIEW === 'grid');
    document.querySelectorAll('#view button').forEach((b) => { b.classList.toggle('on', b.dataset.v === VIEW); b.setAttribute('aria-pressed', b.dataset.v === VIEW); });
  }
  $('vList').textContent = t('viewList'); $('vGrid').textContent = t('viewGrid');
  $('view').onclick = (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); };
  setView(VIEW);
  $('q').placeholder = t('search');
  $('shiftTip').textContent = t('shift');
  $('qSel').textContent = t('qSel'); $('qDesel').textContent = t('qDesel');
  $('q').oninput = () => { S.q = $('q').value.trim().toLowerCase(); refresh(); };
  $('qAct').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || S.busy) return;
    const on = b.id === 'qSel';
    document.querySelectorAll('#list .item:not(.hidden) input').forEach((x) => (on ? S.sel.add(+x.dataset.row) : S.sel.delete(+x.dataset.row)));
    if (S.job && S.job.status !== 'running') S.job = null;
    refresh();
  };

  // ── 내보내기 ──
  $('export').onclick = async () => {
    const items = S.ok.filter((r) => S.sel.has(r.row)).map((r) => ({ row: r.row, slug: r.p.slug }));
    if (S.busy || !items.length) return;
    S.busy = true; S.job = null; refresh();
    try {
      const r = await fetch('/api/v1/bulk/build', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: S.data.id, channel: S.channel, sheet: S.data.sheet, descCol: S.data.cols.desc, items }) });
      let j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      S.job = j; refresh();
      while (j.status === 'running') {
        await sleep(2500);
        const pr = await fetch('/api/v1/bulk/jobs/' + j.id);
        if (!pr.ok) throw new Error((await pr.json().catch(() => ({}))).error || 'HTTP ' + pr.status);
        j = await pr.json();
        S.job = j; refresh();
      }
    } catch (e) {
      S.job = { ...(S.job || { items: [] }), status: 'failed', error: e.message };
    } finally {
      S.busy = false; refresh();
      if (S.job && S.job.status === 'ready') $('dl').click();
    }
  };
})();
