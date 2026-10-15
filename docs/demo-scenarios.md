# Mahsulot namoyishi: uchta ssenariy

Har bir ssenariy avtomatik e2e testda ham bajariladi (qavsda) — namoyishdan oldin oʻsha testni ishga tushirib,
muhit tayyorligini tekshiring. Raqamlar faqat shu namoyishdagi haqiqiy natija sifatida aytiladi; reklama uchun
oʻlchanmagan tezlik, foydalanuvchi soni yoki baho kafolati yozilmaydi.

## 1. “Kitobdan manbali quiz” (`e2e/tests/core-flow.spec.ts`, `stage2.spec.ts`)

1. Botga darslik PDF’ini yuboring (yoki Mini App → Kutubxona → Yuklash). Sahifalar holati koʻrinadi:
   oʻqilgan / OCR shubhali / oʻqilmagan — yashirilmaydi.
2. Hujjat → **Quiz yaratish** → bob tanlash, 10 savol, aralash qiyinlik. Narx oldindan koʻrsatiladi.
3. Muharrir: har savolda **dalil** — kitobdagi aynan iqtibos va sahifa (“sahifa 2 (kitobda: 1)”). Dalili topilmagan savol
   “tekshirish kerak” holatida qoladi va nashr qilinmaydi. Bitta savolni tahrirlang → tekshiruvlar qayta ishlaydi.
4. **Tasdiqlash → Nashr**. **Oʻynash → Oʻzim mashq qilaman**: notoʻgʻri javobda toʻgʻri javob va manba.
5. Xatolar daftari → “Xatolarim asosida” quiz; konspekt va kartochkalar shu kitobdan.
6. Kitobda yoʻq savol (masalan, “Kvant kompyuterlari…”) — tushuntiruvchi “materialda topilmadi” deydi, toʻqimaydi.

## 2. “Materialdan chiroyli prezentatsiya” (`e2e/tests/deck.spec.ts`)

1. Hujjat → **Prezentatsiya yaratish** → mavzu, 12 slayd, uslub (Academic Clean), muallif/guruh. Narx koʻrsatiladi.
2. Ixtiyoriy: avval **reja** → slaydni olib tashlash/qoʻshish → “Slaydlarni yaratish”.
3. Koʻrinish: har slaydda manba izohi, dalil belgisi; slaydni bosib toʻliq ekranda koʻrish.
4. Bitta slayd matnini tahrirlang (oʻzbek ʻ ʼ va kirill harflari bilan) → faqat shu slaydni **qayta yarating** — qolganlari oʻzgarmaydi; **bekor qilish** bilan qaytaring.
5. **PPTX** va **PDF** eksport → server tekshiruvlari (14/14: fayl ochiladi, slaydlar soni, matn sahifadan chiqmaydi, shriftlar…) va sahifa rasmlari.
   PPTX’ni PowerPoint/Keynote/Google Slides’da oching — matn tahrirlanadi (rasm emas).
6. “Shu materialdan quiz”.

Namuna fayllar: `docs/evidence/slides/sample-12.pptx`, `sample-12.pdf`, `sample-stats.*`.

## 3. “Guruh bilan bilim bellashuvi” (`e2e/tests/room.spec.ts`, `stage2.spec.ts`)

1. Nashr qilingan quiz → **Oʻynash → Xona ochish** → vaqt, tezlik bonusi, reyting, **Quiz Battle: 2 jamoa**.
2. **Ulashish** → Telegram’ning ulashish oynasi (`t.me/<bot>?startapp=r…`). Ikkinchi telefon havolani ochadi → bir bosishda xonaga kiradi; jamoasi koʻrsatiladi.
3. Boshlash → hamma bir vaqtda bir xil savolni koʻradi; vaqt server soati boʻyicha. Javob “qabul qilindi” deb tasdiqlanadi.
4. Internetni oʻchirib-yoqish: javob/holat tiklanadi. Boshlovchi chiqib ketsa — xona pauzaga oʻtadi.
5. Natija: shaxsiy ball, jamoa reytingi (aʼzolar ballarining oʻrtachasi — kichik jamoa zarar koʻrmaydi).
6. Muqobil: **Guruhga yuborish** — bot Telegram guruhida native quiz-soʻrovnoma bilan oʻtkazadi.
7. Guruh loyihasi: Guruhlar → yangi loyiha → taklif havolasi (`startapp=w…`) → vazifa tayinlash, izoh, faoliyat tarixi.
