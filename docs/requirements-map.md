# TALABA AI — talablar xaritasi

Master prompt (`TALABA_AI_MASTER_PROMPT.md`) boʻlimlari → kod → dalil → holat. Sana: **2026-10-15**, branch `claude/talaba-ai-core`.
Qabul mezonlarining (§ 23) batafsil natijasi alohida: [acceptance-report.md](acceptance-report.md).

Belgilar:
- ✅ — ishlaydi va avtomatik test yoki qayta bajariladigan sinov bilan tasdiqlangan;
- 🟡 — qisman: nimasi yoʻqligi yonida yozilgan;
- ⏳ — kod tayyor, lekin haqiqiy tashqi sozlama yoki muhit kerak (kalit, bot, HTTPS, haqiqiy qurilma);
- ❌ — amalga oshirilmagan.

Test yoʻllari: server — `apps/server/test/*.test.ts`, e2e — `e2e/tests/*.spec.ts`, skrinshotlar — `docs/evidence/e2e/`.

## § 1–3. Vazifa, foydalanuvchilar, tamoyillar

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Bot + Mini App + admin + umumiy backend | `apps/server` (API, bot, worker), `apps/miniapp`, admin — Mini App ichida `/admin/*` | barcha testlar | ✅ |
| Haqiqiy saqlash, eksport, ulashish; soxta javob yoʻq | Postgres + yopiq fayl ombori; AI kaliti boʻlmasa **extractive** rejim ochiq belgilanadi (“AI xizmati hozir ulanmagan”), AI javobi sifatida koʻrsatilmaydi | `quiz.test`, `slides.test`, `study.test`; `integrationStatus()` (`/readyz`) | ✅ |
| Bir materialdan konspekt, slayd, quiz, kartochka, reja | Hujjat bir marta yuklanadi; hamma vosita `document_id` boʻyicha ishlaydi | e2e `stage2.spec`, `deck.spec` | ✅ |
| Narx/hajm oldindan, natija va manba keyin | `POST /api/quizzes/estimate`, `/api/decks/estimate`; har savol/slayd/javobda manba joylashuvi | `billing.test`, e2e `core-flow` | ✅ |
| Tahrirlash, bekor qilish, davom ettirish, qayta eksport | Quiz copy-on-write versiyalar, slayd undo, job cancel, checkpointdan davom, eksport qayta | `quiz.test`, `slides.test`, `resilience.test` | ✅ |
| Texnik xato matni talabaga chiqmaydi | Barqaror xato kodlari → `lib/errors.ts` tarjimasi | `security.test` (“never leaks internals”) | ✅ |
| Pilot gipotezalari, uydirma statistika yoʻq | Hujjatlarda raqamlar faqat oʻlchangan; maqsadlar “maqsad” deb belgilangan | `cost-model.md`, `load-room.json` | ✅ |

## § 4. Rollar, hisob va kirish

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Telegram orqali serverda tekshirilgan identifikatsiya | `auth/init-data.ts` (HMAC, `auth_date`), `auth/sessions.ts` | `telegram.test` (soxta/eskirgan initData) | ✅ |
| Til: uz lotin, uz kirill, ru, en; Telegram tilidan taklif; saqlanadi | `packages/shared/src/i18n`, `suggestLang()`; kirill lugʻati lotindan transliteratsiya + qoʻlda tuzatishlar | `translit.test`, e2e `responsive.spec` (ru/en/uz-Cyrl) | ✅ |
| “Nima qilmoqchisiz?”, ixtiyoriy oʻqish joyi | `Onboarding.tsx` (3 ta oʻtkazib yuboriladigan qadam) | `01-onboarding-390.png` | ✅ |
| Workspace rollari owner/editor/viewer; xona host/participant | `access/policy.ts`, `rooms/service.ts` | `security.test`, `rooms.test`, `study.test` | ✅ |
| Moderator/admin faqat serverdan | `ADMIN_TELEGRAM_IDS`; `moderator` roli sxemada bor, lekin huquq bermaydi | `admin.test` | 🟡 moderator ishlatilmaydi |
| Taklif havolasidan kelgan foydalanuvchi onboardingsiz xonaga | `App.tsx` start_param → `/join/…` (bir sessiyada bir marta) | e2e `room.spec`, `stage4.spec` | ✅ |
| Telefon, geolokatsiya, kontakt soʻralmaydi | Hech qayerda soʻralmaydi | kod | ✅ |
| Telegramdan tashqarida — Telegramga qaytish; URLʼdagi user_id login emas | `OutsideTelegram.tsx` | `telegram.test` (“does not trust a user id in the URL”) | ✅ |

## § 5. Materiallar va manbalar kutubxonasi

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| PDF, DOCX, PPTX, TXT, matn, JPG/PNG, veb-havola, CSV/XLSX | `ingest/*` | `ingest.test` | ✅ |
| OCR (skan PDF, rasm); oʻqilmagan sahifa ochiq koʻrsatiladi | `ingest/ocr.ts` (tesseract uzb/uzb_cyrl/rus/eng); sahifa holati `ok/low_confidence/failed` | `ingest.test` (“reports blank and unreadable pages honestly”) | ✅ |
| Jami/oʻqilgan/muvaffaqiyatsiz sahifa; “toʻliq oʻqildi” faqat rost boʻlsa | `pages_ok/pages_low_conf/pages_failed`, `partial` holati | `02-document-390.png` | ✅ |
| Parolli/buzuq fayl uchun aniq yechim | `password_protected`, `corrupted` kodlari | `ingest.test` | ✅ |
| Jismoniy sahifa ≠ bosma sahifa; DOCX — sarlavha/paragraf; PPTX — slayd | `locator` (`pageIndex`, `pageLabel`, `heading`, `paragraph`, `slide`) | `ingest.test` | ✅ |
| Manba metamaʼlumoti: nom, muallif, nashr/sana, versiya, egasi, ruxsat | `documents` (`author`, `published_info`, `source_url`), `document_versions`; “Manba maʼlumotlari” tahriri | `writing.test`, e2e `stage4.spec` | ✅ |
| Yangi versiya eski quiz dalilini yashirincha oʻzgartirmaydi | `source_references` snapshot | `quiz.test` (acceptance 13) | ✅ |
| Rejim: faqat mening manbalarim | `sources_only` (standart) — “Tanlangan manbalarda topilmadi” | `study.test` | ✅ |
| Rejim: manbalar + tashqi qidiruv | `sources_plus_web` → `409 web_search_not_enabled` | — | ❌ veb-qidiruv yoʻq |
| Rejim: umumiy tushuntirish | tutor `general` — umumiy bilim `general_note` da alohida, daʼvo sifatida emas | `study-routes` | ✅ |
| Leksik + semantik qidiruv, faqat ruxsatli materiallar ichida | `search/retrieve.ts` (FTS + trigram + pgvector, RRF; filtr SQL ichida) | `security.test`, `ingest.test` (izolyatsiya) | ✅ semantik qism ⏳ `VOYAGE_API_KEY` |
| Har daʼvoga parcha; havola mavjudligi ≠ tasdiq | `locateQuote()` (aniq/fuzzy), topilmasa iqtibos tashlanadi | `quiz.test` (“drops fabricated citations”) | ✅ |
| Koʻp kitobdagi ziddiyatlarni muallif/nashr bilan koʻrsatish | — | — | ❌ |
| Fayldagi “oldingi qoidalarni unut” — maʼlumot, buyruq emas | `ingest/injection.ts` belgilaydi; AIʼga `<source>` ichida “ishonchsiz maʼlumot” | `security.test` | ✅ |
| Manbani va quizni ulashish — alohida ruxsat | Xona havolasi faqat xonani ochadi; hujjatga kirish workspace aʼzoligi bilan | `rooms.test`, `security.test` | ✅ |

## § 6. AI Quiz Studio

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Kitob + bob/sahifa | `from_source`, sahifa/boʻlim doirasi | e2e `core-flow` | ✅ |
| Savollar roʻyxati + manba | `from_questions` (AI bilan javob topadi; AIʼsiz savol `needs_review`, kalitsiz qoladi) | `quiz.test`, `quality/summary-extractive.json` | ✅ (AIʼsiz cheklangan) |
| Savol-javob roʻyxatidan variantlar | `from_qa` | `quiz.test` (acceptance 3) | ✅ |
| Mavzu + tashqi ishonchli manbalar | Faqat foydalanuvchi qoʻshgan URL/hujjat orqali; avtomatik tashqi qidiruv yoʻq | — | 🟡 |
| Jadval/statistik hisobotdan savollar | `study/stats.ts` → quiz | `study.test` (acceptance 12) | ✅ |
| Avvalgi xatolardan mashq | `from_mistakes` | `study.test` (xatolar daftari) | ✅ |
| Sozlamalar: til, fan, mavzu, son, qiyinlik nisbati, vaqt, tartib, aralashtirish, izoh, natija ochilishi | `QuizSettings` (`packages/shared/src/schemas/quiz.ts`) | `quiz.test` | ✅ |
| 4 variant/1 toʻgʻri standart; koʻp javobli tur alohida | `allowMultipleCorrect` | `quiz.test` | ✅ |
| Son tarif limitiga bogʻliq | `maxQuestionsPerQuiz` (joylangan roʻyxatlar ham) | `quiz.test` (“plan's question limit”) | ✅ |
| Qoʻshimcha turlar | Toʻgʻri/notoʻgʻri ✅ (`includeTrueFalse`); juftini topish — alohida oʻyin ✅; ketma-ketlik, boʻsh joy, qisqa javob, rasm boʻyicha savol — sxemada bor, generatsiya yoʻq | `quiz.test` (True/False), `study.test` (matching) | 🟡 |
| Savol maydonlari: barqaror ID, versiya, tur, til, mavzu, qiyinlik, kognitiv daraja, holat | `questions` (`stable_id`, `cognitive_level`, `status`…) | migratsiya `001_core.sql` | ✅ |
| Kalit faqat serverdagi yopiq qismda | `private_answer_keys` | `quiz.test`, `rooms.test` | ✅ |
| Izoh va chalgʻituvchilar nega notoʻgʻri | `explanation`, `why_wrong` | e2e `05-practice-feedback-390.png` | ✅ |
| 8 ta tekshirish qoidasi | `quiz/validate.ts` (`clarity`, `source_support`, `single_correct`, `options_distinct`, `facts_numbers`, `explanation_locator`, `not_duplicate`, `translation`) | `quiz.test` (acceptance 5) | ✅ |
| Generatsiya va tekshirish alohida; mustaqil tekshiruvchi | AI “koʻr” validatsiya — javob kalitini koʻrmaydi | `quiz.test` (AI test double) | ✅ (haqiqiy model ⏳) |
| Model “ishonch foizi” koʻrsatilmaydi | Faqat tekshiruv natijalari | kod | ✅ |
| 50 soʻralsa 18 sifatli → 18 + sabab | `produced/requested` + izoh | `quality/summary-extractive.json` | ✅ |
| Foydalanuvchi javobi manbaga zid → yashirin almashtirmaslik | Dalil topilmasa `needs_review`, kalit oʻzgartirilmaydi | `quiz.test` (acceptance 4) | ✅ |
| Preview → Tahrirlash → Nashr; “Xato haqida bildirish”; yangi versiya | `QuizEditor.tsx`, `question_reports`, copy-on-write | `quiz.test`, `admin.test` (moderatsiya) | ✅ |

## § 7. Quizni botda va guruhda ishlatish

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| A. Botda shaxsiy mashq (izoh, manba, xatolarni takrorlash) | `telegram/bot.ts` (`qp:`, `pa:`, `pm:` tugmalari) | `telegram.test` (flow A) | ✅ (soxta Bot API bilan; haqiqiy bot ⏳) |
| B. Guruhda native quiz; anonimdan shaxsiy reyting yoʻq; faqat oʻz poll javoblari | `group/native-quiz.ts`; `correct_option_ids` + `correct_option_id` | `telegram.test` (acceptance 6) | ✅ / ⏳ haqiqiy guruh |
| Native quizga sigʻmagan savollar Mini Appga | `nativePollCompatible()` | `telegram.test` | ✅ |
| C. Mini App jonli xona: ochish → ulashish → qoʻshilish → boshlash → sinxron → natija | `rooms/*`, `Room.tsx` | `rooms.test`, e2e `room.spec` | ✅ |
| Ulashish foydalanuvchi amali bilan; `startapp`; URLʼda kalit/maxfiy yoʻq | `shareToTelegram()`, `r<token>` | e2e `room.spec` (URL shakli tekshiriladi) | ✅ |
| Taklif tokeni: muddatli, bekor qilinadigan; boshqa obyektlarga ruxsat bermaydi | `invitations` (sha256), `rotateInvite`, `revokeInvite` | `rooms.test` | ✅ |
| Guruhga yozish — aʼzolik/ruxsat va host sozlamasi; privacy mode | Bot faqat hostning `/start g<token>` ga javob beradi; ruxsat yoʻq boʻlsa hostga tushuntiradi | `telegram.test` (“reports a missing permission”) | ✅ |
| 429 va limitlar: navbat/retry | `telegram/outbox.ts` (token bucket, `retry_after`, bitta yuboruvchi) | `telegram.test`, `outbox.test` | ✅ |

## § 8. Jonli musobaqa va oʻquv oʻyinlari

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Rejimlar: yakka, jamoa, mustaqil vaqtda, host boshqaradigan | `individual`, `teams`, `async` (topshiriq), `live` | `rooms.test`, `study.test` (Quiz Battle, topshiriq), e2e `stage4.spec` | ✅ |
| Host: lobby, boshlash, pauza, davom, yakunlash | `hostAction` | `rooms.test` | ✅ (oldindan rejalashtirish — topshiriq muddati orqali) |
| Server vaqti, takror javob ball bermaydi, ack commitdan keyin | shartli `UPDATE`, `unique`, `clock_timestamp()` | `rooms.test` (acceptance 8) | ✅ |
| Kalit/yashirin izoh vaqtidan oldin berilmaydi | `viewFor` proyeksiyasi; topshiriqda muddatgacha `hidden` | `rooms.test`, `study.test` | ✅ |
| Aralashtirilgan variant barqaror ID bilan baholanadi | HMAC tartib + ID boʻyicha baholash | `rooms.test`, `quiz.test` | ✅ |
| Qayta ulanishda holat tiklanadi | `stateFor()` | `rooms.test` (acceptance 9) | ✅ |
| Host chiqsa pauza yoki co-host | `pauseIfHostAway` (DB dan host/co-host), `setCoHost` | `study.test` (co-host), e2e `stage4.spec` | ✅ |
| 100/0 ball; tezlik bonusi ixtiyoriy, ≤ 50, oldindan koʻrsatiladi; jamoa — oʻrtacha | `RoomSettings` | `study.test` (teams) | ✅ |
| Teng ball qoidasi | Teng ball — bir xil oʻrin; tartib: ball → toʻgʻri javoblar soni → oldinroq qoʻshilgan | `rooms/service.ts` | 🟡 qoida UIʼda alohida tushuntirilmagan |
| Oʻyinlar: Quiz Battle + bitta moslashtirish oʻyini | Quiz Battle (jamoalar), “Atama–taʼrif” | `study.test`, e2e `stage2.spec` | ✅ |
| Quiz Duel, Xatoni top, Ketma-ketlik, Imtihon marafoni; XP va badge | — | — | ❌ (4-bosqich) |

## § 9. Presentation Studio

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Sozlamalar: til, auditoriya, davomiylik, slayd soni, uslub, muallif, ixtiyoriy universitet/fan; 16:9, 12 slayd | `DeckNew`, `DeckSettings` | e2e `deck.spec` | ✅ |
| Jarayon: talab → reja → koʻrsatish → slaydlar → izohlar/himoya savollari → render tekshiruvi → eksport | `slides/*` (`planOnly`, `verify.ts`) | `slides.test`, e2e `deck.spec` | ✅ |
| Tavsiya etilgan oqim (titul … manbalar) | `extractive.ts`, `ai-gen.ts` | `docs/evidence/slides/` | ✅ |
| Bir slayd — bir fikr; 22–28 pt; sigʻmasa boʻlinadi, kichraytirilmaydi | `layout.ts`, `measure.ts` | `slides.test` (“splits overflowing content”) | ✅ |
| Belgilar buzilmaydi (oʻzbek lotin/kirill) | PDF tekshiruvida `ʻ ʼ ў қ ғ ҳ` | `slides.test` | ✅ |
| 3 uslub: Academic Clean, Modern Data, Creative Seminar | `themes.ts` | `layout.test`, `docs/evidence/slides/sample-12-*` | ✅ |
| Fotosurat/AI rasm (manba, huquq belgisi) | — | — | ❌ slaydlarda rasm yoʻq |
| Grafik haqiqiy jadval qiymatidan | Kod bilan native chart | `slides.test` (acceptance 12) | ✅ |
| Tartib, matn, dizayn, bitta slaydni qayta yaratish, bekor qilish | `DeckScreen`, `slide_versions`, revision qulfi | `slides.test`, e2e `deck.spec` | ✅ |
| Bitta slayd qayta yaratish — butun deck narxi olinmaydi | 1 kredit (AI), 0 (extractive) | `slides.test` | ✅ |
| Tahrirlanadigan PPTX + PDF; preview va eksport bir modeldan; fayl tekshiruvi | `render-pptx.ts`, PDF aynan shu PPTXʼdan, `verify.ts` | `slides.test`, `dist-smoke.txt` | ✅ |
| Murakkab formula → LaTeX manbasi | — | — | ❌ |
| Nutq matni, himoya savollari, quiz tugmasi | Slayd izohlari, `defense_qa`, “Quiz yaratish” | `slides.test` (“creates a draft quiz”) | ✅ |
| Bir sahifali handout | — | — | ❌ |

## § 10. Aniq statistika va ilmiy dalillar

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Raqam xotiradan toʻqilmaydi; foydalanuvchi jadvali/hisobotidan | `study/stats.ts` — katakchadan aniq qiymat, qator/ustun joylashuvi | `study.test` (acceptance 12) | ✅ |
| Qiymat, birlik, hudud, davr, manba, tekshirish sanasi; hisoblangan qiymatda formula | `stat_facts` maydonlari, `pct_change/diff/ratio` + formula | `study.test`, e2e `15-stats-360.png` | ✅ |
| Namuna maʼlumot “misol” deb belgilanadi | `sample` ogohlantirishi | `study.test`, `slides.test` | ✅ |
| Rasmiy manbalarni ochib tekshirish (veb) | Faqat foydalanuvchi bergan URL/fayl; avtomatik qidiruv yoʻq | — | 🟡 |
| DOI, iqtibos, muallif, adabiyot uydirilmaydi | Yozuv yordamchisi faqat kiritilgan maʼlumotdan; yetishmagani `missing` | `writing.test` | ✅ |
| Statistik quiz javobi hisobot versiyasiga bogʻlangan | `source_references` + versiya | `quiz.test` (acceptance 13) | ✅ |

## § 11. AI oʻquv yordamchisi va yozma ishlar

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Rejimlar: soddaroq, misol, ishora, meni tekshir | tutor `style`: `simpler`, `example`, `hint`, `check_me` | `study.test`, e2e `12-tutor-390.png` | ✅ |
| Masala rasmi boʻyicha yordam (vision) | — | — | ❌ |
| Mat./fiz./iqtisod: berilganlar → usul → hisob → tekshirish | Promptda koʻrsatma (AI bilan) | — | ⏳ AI kaliti |
| Dasturlash kodi sandboxda | — | — | ❌ sandbox yoʻq |
| Yozuv yordamchisi: reja, annotatsiya, bibliografiya, ravonlashtirish, mezonga solishtirish | `study/writing.ts`, `Writing.tsx` | `writing.test`, e2e `stage4.spec` | ✅ (ravonlashtirish/mezon ⏳ AI) |
| Iqtibos va oʻz izohi ajratiladi; “100% original” vaʼdasi yoʻq | Iqtibos oʻzgarsa ogohlantirish; halollik banneri | `writing.test` | ✅ |
| Tibbiyot/huquq — oʻquv tushuntirish | Promptda cheklov | kod | 🟡 alohida test yoʻq |

## § 12. Imtihon tayyorgarligi va shaxsiy reja

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Sana, mavzular, kunlik vaqt → kunlik reja; oxirgi kun takrorlash | `study/plans.ts` | `study.test` | ✅ |
| Boshlangʻich diagnostika quizi | Mavzu ogʻirligi xatolar daftaridan olinadi; alohida diagnostika quizi yoʻq | `study.test` | 🟡 |
| Oʻtkazib yuborilgan kun qayta taqsimlanadi, ayblovsiz; avtomatik bajarilmaydi | `study/plans.ts` (`rescheduled_count`, vazifa oʻchirilmaydi) | `study.test` | ✅ |
| Kartochka (interval takrorlash), xatolar daftari, taraqqiyot | SM-2, `mistakes.ts` | `study.test`, e2e `stage2.spec` | ✅ |
| Dars jadvali, fokus taymeri | — | — | ❌ |
| Bildirishnoma: ixtiyoriy, sokin soatlar, oʻchirish; Asia/Tashkent; UTC | `notify/reminders.ts` | `reminders.test` | ✅ (yetkazish ⏳ bot) |

## § 13. Guruh workspace va hamkorlik

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Materiallar, quiz, deck, izoh, vazifa, masʼul, muddat, holat; “kim nima qilmoqda” | `workspaces`, `tasks`, `comments`, `workspace_events` | `study.test`, e2e `stage2.spec` | ✅ |
| Oʻzgarishlar tarixi, oldingi versiyani tiklash | Slaydlar: `slide_versions` + restore; quiz: versiyalar saqlanadi | `slides.test` | ✅ (quiz versiyasini UIʼdan tiklash 🟡) |
| Oʻqituvchi uchun read-only havola | `viewer` rolli taklif | `security.test` | ✅ |
| Slayd tahrir qulfi, jim ustidan yozmaslik | revision + 120 s qulf, `409` konflikt UI | `slides.test`, `30-deck-conflict-390.png` | ✅ |
| Ulashish: shaxsiy (standart), workspace, taklif havolasi | ✅; ochiq shablon — sxemada bor, UI yoʻq | — | 🟡 |
| Individual xato tahlili faqat oʻsha talaba va hostga | Natija proyeksiyalari | `rooms.test`, `study.test` | ✅ |

## § 14. Telegram bot interfeysi

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| /start tanlovlari; /help, /quiz, /slides, /library, /progress, /settings, /support, /terms, /privacy, /paysupport (+ /buy) | `telegram/bot.ts`, buyruqlar uz/ru/en `ops:telegram-setup` | `telegram-setup.test` | ✅ / ⏳ token |
| Botga fayl → umumiy kutubxona | `onMessage` → ingest job | `telegram.test` (acceptance 1) | ✅ |
| Quiz uchun qisqa wizard | `qw:d` (hujjat), `qw:n` (son) | `telegram.test` | ✅ |
| Deck uchun bot wizard | Bot decklar roʻyxatini va Mini Appni ochadi; yaratish Mini Appda | — | 🟡 |
| Ortga/Bekor qilish/Davom ettirish; tugallanmagan ishni tiklash | `/cancel`, `pn:`/`ps:` | `telegram.test` | ✅ |
| Tez qabul tasdigʻi, tayyor boʻlganda xabar; Mini App yopilsa ish davom etadi | Job + outbox | `telegram.test`, `resilience.test` | ✅ |
| Limitdan katta fayl → web upload | `file_too_large` → Mini App yuklash | `telegram.test` | ✅ |
| Bot bloklansa natija saqlanadi | Outbox `blocked` belgisi | `telegram.test` | ✅ |

## § 15. Premium koʻrinish va UX/UI

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Ranglar (#4F46E5, #0F172A, #F8FAFC, #10B981), kontrast tekshiruvi, och/toʻq mavzu | `styles/app.css` tokenlari | `contrast.test`, e2e `responsive.spec` (dark contrast) | ✅ |
| 16 px matn, ≥ 44×44 px, 8 px tizim, reduced-motion | `design-system.md` | kod | ✅ |
| Pastki navigatsiya: Bosh sahifa · Yaratish · Guruhlar · Kutubxona · Profil | `Shell.tsx` | barcha skrinshotlar | ✅ |
| Bosh sahifa: davom ettirish, 4 asosiy amal, deadline, bugungi takrorlash | `Home.tsx` | `20-home-*.png` | ✅ |
| Majburiy ekranlar (onboarding … admin) | `design-system.md` § 10 | e2e | ✅ |
| Loading/empty/error/success/offline/ruxsat yoʻq/qisman holatlar; autosave | `components/ui.tsx` | `design-system.md` § 9 | ✅ |
| Takroriy bosish ikki buyurtma yaratmaydi | Idempotentlik kalitlari + advisory lock | `quiz.test` (parallel soʻrov) | ✅ |
| 320–1440 px; safe area; BackButton | `responsive.spec` (21 ekran × 6 kenglik × 2 mavzu; 3 til × 320 px) | e2e | ✅ brauzerda / ⏳ haqiqiy qurilmalar |
| Screen reader label, klaviatura, faqat rangga tayanmaslik | aria-label, `aria-pressed`, matnli belgilar | e2e lokatorlari role/label bilan | 🟡 skrinrider bilan qoʻlda sinalmagan |

## § 16. Arxitektura va AI vazifalari

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| TypeScript, React, Bot API adapteri, Postgres, vektor qidiruv, yopiq ombor, fon ishchilari, realtime | `architecture.md` | — | ✅ (Next.js oʻrniga Vite: Mini App toʻliq mijoz tomonida) |
| eve runtime bahosi | ADR-8: qabul qilinmadi, sababi yozilgan; sinab koʻrilmagan | `architecture.md` § 8 | 🟡 |
| Vercel AI Gateway | Ishlatilmaydi; `AI_BASE_URL` Anthropic-mos shlyuzga ruxsat beradi | `config.ts` | 🟡 |
| Alohida AI bosqichlari, tiplangan sxemalar, xarajat hisobi | `ai/client.ts` (zod), `usage_events` | `quiz.test`, `slides.test` | ✅ |
| Tejamkor/kuchli model; timeout, cheklangan retry, kill switch | strong/fast tier, `model_configs`, `AI_INTERACTIVE_TIMEOUT_MS` | `resilience.test`, `admin.test` | ✅ |
| Ogʻir ish fon navbatida; job holatlari; idempotentlik; restart yoʻqotmaydi; haqiqiy progress | `jobs/queue.ts` (lease, checkpoint, `LeaseLost`) | `resilience.test` (acceptance 15) | ✅ |
| Xabar yuborilmasa artifakt yoʻqolmaydi; bir job — bir billing | Outbox; reserve/capture/release | `resilience.test`, `billing.test` | ✅ |

## § 17. Maʼlumotlar va API shartnomalari

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Domenlar (hisob, manba, ish, quiz, musobaqa, slayd, oʻqish, operatsiya) | 7 ta migratsiya; jadvallar `architecture.md` § 7 | `ops.test` (restore) | ✅ (`projects` ishlatilmaydi) |
| FK, unique, indeks, tranzaksiya; Telegram ID bigint | migratsiyalar | — | ✅ |
| API oqimlari hujjatlashtirilgan | `architecture.md`, `api-and-limits.md` | — | ✅ |
| Ruxsat serverda; pagination | `access/policy.ts`; `limit/cursor` | `security.test` | ✅ |
| Host va ishtirokchi javoblari ajratilgan; preview kalit qaytarmaydi | `viewFor`, alohida editor endpoint | `quiz.test`, `rooms.test` | ✅ |

## § 18. Xavfsizlik, maxfiylik, tiklanish

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| initData imzosi va `auth_date`; qisqa sessiya; webhook secret | `init-data.ts`, `sessions.ts`, `webhook.ts` | `telegram.test` | ✅ |
| Kalitlar faqat server env; frontend/git/logda yoʻq | `.env.example` boʻsh; log redaction | `security.test`, kod | ✅ |
| Admin — qoʻshimcha himoya (yangi Telegram imzosi) va audit | `init_auth_date` ≤ 15 daqiqa, `audit_events` (IP) | `admin.test` | ✅ |
| Upload: MIME/ichki tur, limitlar, makros yoʻq; SSRF; HTML sanitizatsiya | `detect.ts`, `url-fetch.ts`, `html.ts` | `ingest.test`, `security.test` | ✅ (antivirus skaneri ❌) |
| Private fayllar, qisqa muddatli imzolangan havola | `LocalStorage` + HMAC havola | `security.test` | ✅ |
| Manba oʻchirilsa indeks/keshdan ham | `deleteDocument`: chunks (embedding bilan), sahifalar, fayl oʻchiriladi; dalil snapshotlari quizda qoladi | `ops.test` | ✅ |
| Eksport/oʻchirish soʻrovi; backup + restore mashqi | `account/data.ts`, `ops/backup.sh`, `ops/restore.sh` | `ops.test`, `restore-drill.json` | ✅ |
| Loglarda shaxsiy material va prompt yoʻq; AIʼga nima ketishi koʻrsatilgan | `InfoPage` (maxfiylik), `architecture.md` § 6 | kod | ✅ |

## § 19. Kredit, obuna, toʻlov

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Free / Student Plus / Group-Teacher; narx xarajatdan | `billing/plans.ts`, `cost-model.md` | `billing.test` | ✅ (yakuniy narx — biznes qarori) |
| Kredit oldindan koʻrsatiladi; ikki bosish — bitta debit; reserve → capture → release | `billing/credits.ts` | `quiz.test`, `billing.test` | ✅ |
| Stars: XTR, `successful_payment` serverda, charge ID boʻyicha takror zararsiz, /paysupport, refund | `billing/stars.ts` | `billing.test` (acceptance 16) | ✅ / ⏳ `PAYMENTS_ENABLED` + haqiqiy bot |
| Tarif admin tomonidan; sotilgan shart oʻzgarmaydi | Plan versiyasi + entitlement snapshot | `billing.test` | ✅ |

## § 20. Administrator paneli va monitoring

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Foydalanuvchilar, faollik, generatsiya muvaffaqiyati, navbat, provider xatolari, p95, AI xarajati, kredit, toʻlov, support, bildirishlar | `admin/service.ts`, `Admin.tsx`, `/metrics` | `admin.test`, `41-admin-overview-1024.png` | ✅ |
| Tarif, model, feature flag, moderatsiya, job retry, support; audit; model rollback | admin marshrutlari | `admin.test` | ✅ (template boshqaruvi 🟡) |
| Mahsulot koʻrsatkichlari: birinchi natijaga vaqt, D1/D7/D30, eksport muvaffaqiyati… | agregat SQL | `admin.test` | ✅ |

## § 21. Tarqalish va taqdimot

| Talab | Amalga oshirilishi | Dalil | Holat |
|---|---|---|---|
| Ulashish orqali tarqalish (majburiy emas) | Xona/topshiriq havolasi | e2e | ✅ |
| Referral mukofoti | — | — | ❌ (ixtiyoriy) |
| Brand, bot avatari briefi, slogan | `docs/brand.md` | — | ✅ |
| 3 ta demo ssenariy | `docs/demo-scenarios.md` | — | ✅ |
| Avtomatik reklama xabari yoʻq | Bot faqat soʻralgan/ruxsatli xabar yuboradi | `reminders.test` | ✅ |

## § 22. Bosqichlar

| Bosqich | Holat | Qayerda |
|---|---|---|
| 0 — aniqlik | ✅ | shu hujjat, `architecture.md`, `cost-model.md`, `acceptance-report.md` |
| 1 — vertikal yadro | ✅ (haqiqiy Telegram ⏳) | `acceptance-report.md` 1–11 |
| 2 — oʻqish va jamoa | ✅ (veb-qidiruv ❌) | `study.test`, e2e `stage2.spec` |
| 3 — tijoriy va operatsion | ✅ (haqiqiy Stars ⏳) | `billing.test`, `admin.test`, `ops.test`, e2e `stage3.spec` |
| 4 — kengaytirish | 🟡 qilingan: topshiriq rejimi, co-host, Toʻgʻri/Notoʻgʻri, eslatmalar, yozuv yordamchisi. Qolgan: qoʻshimcha oʻyinlar, XP/badge, DOCX/handout eksport, maʼruza audiosidan konspekt, real vaqtli birgalikda tahrir | e2e `stage4.spec` |

## § 24. Xatoda keyingi qadam

| Vaziyat | Amalga oshirilishi | Holat |
|---|---|---|
| Kitob juda katta | `file_too_large(_for_plan)` + hajm, bob tanlash, web upload | ✅ |
| OCR noaniq | `low_confidence` sahifalar ajratib koʻrsatiladi | ✅ |
| Savol manbada yoʻq | “topilmadi”, `needs_review`, toʻqilmaydi | ✅ |
| AI javob bermadi | retry/backoff, `ai_*` kodi, kredit qaytadi | ✅ |
| Internet uzildi | offline banner, GET kesh; serverga yetmagan javob “qabul qilindi” deyilmaydi | ✅ |
| Bot guruhda yozolmaydi | hostga sabab + Mini App havolasi | ✅ |
| Export buzildi | `failed`, fayl berilmaydi, qayta eksport | ✅ |
| Bir slaydni ikki kishi tahrirladi | `409` + konflikt ekrani | ✅ |
| Takror toʻlov hodisasi | charge ID boʻyicha bitta | ✅ |
| Limit tugadi | `402 credits_insufficient` / `429 daily_ai_limit` + tariflar sahifasi | ✅ |

## § 25. Yakuniy materiallar

| Material | Qayerda |
|---|---|
| Kod, migratsiyalar, testlar | `apps/*`, `apps/server/src/db/migrations`, `apps/server/test`, `e2e/tests` |
| `.env.example`, tashqi sozlamalar | `.env.example`, `acceptance-report.md` (“Tashqi sozlamalar”) |
| BotFather, webhook, Main Mini App, buyruqlar, guruh | `setup-telegram.md` |
| Kontent/AI oqimlari, job va avtorizatsiya | `architecture.md` |
| Dizayn tokenlari, komponentlar, holatlar | `design-system.md` |
| PPTX/PDF namunalar, quiz va xona dalili | `evidence/slides/`, `evidence/e2e/`, `evidence/quality/` |
| API cheklovlari, paket versiyalari | `api-and-limits.md` |
| Admin/operator, monitoring, backup/restore | `operations.md`, `deploy.md`, `evidence/restore-drill.json` |
| Mezonlar hisoboti | `acceptance-report.md` |
| Xarajat modeli va kengaytirish | `cost-model.md`, `architecture.md` § 9 |
