# TALABA AI — qabul hisoboti

Sana: **2026-10-15**. Branch: `claude/talaba-ai-core`. Master promptning 23-boʻlimidagi 20 ta mezon boʻyicha natija va dalil.
Talablarning toʻliq xaritasi: [requirements-map.md](requirements-map.md).

## Qanday sinaldi

| Toʻplam | Buyruq | Natija |
|---|---|---|
| Server (integratsiya + unit) | `pnpm --filter @talaba/server test` | **18 fayl, 114 test — hammasi oʻtdi** |
| Umumiy paket (transliteratsiya, kirill lugʻati) | `pnpm --filter @talaba/shared test` | 4 test oʻtdi |
| Mini App (kontrast, xabarlar) | `pnpm --filter @talaba/miniapp test` | 12 test oʻtdi |
| E2E (Playwright, Chromium, Telegram WebApp mock) | `cd e2e && npx playwright test` | **14 ssenariy — hammasi oʻtdi** |
| Production bundle smoke | `node dist/all-in-one.js` + `scripts/smoke.ts` | yuklash → quiz → 12 slayd → PPTX + PDF, 7,5 s ([dist-smoke.txt](evidence/dist-smoke.txt)) |
| Yuk sinovi | `apps/server/scripts/load-room.ts` | 100 ishtirokchi ([load-room.json](evidence/load-room.json)) |
| Backup → restore mashqi | `ops.test` + `ops/backup.sh`/`restore.sh` | [restore-drill.json](evidence/restore-drill.json) |

**Sinov muhiti:** bitta Linux konteyner (4 CPU, 17 GB RAM), Node 22, PostgreSQL 16 + pgvector, tesseract, LibreOffice, poppler.
Telegram Bot API oʻrnida testlar ichidagi **soxta Telegram server** (`apps/server/test/helpers/fake-telegram.ts`), Mini App oʻrnida Chromium + **WebApp mock** (`e2e/tests/telegram-mock.ts`) ishlatildi.
`initData` haqiqiy algoritm bilan imzolanadi va server uni haqiqiy tekshiruvdan oʻtkazadi.
AI provayderi oʻrnida SDK test dublyori ishlatildi (`AI_PROVIDER=none` rejimi ham alohida sinaldi).
Haqiqiy Telegram ilovasi, haqiqiy bot tokeni, haqiqiy Stars toʻlovi va haqiqiy Claude modeli bilan **sinov oʻtkazilmadi**: bu muhitda ular yoʻq. Kerakli sozlamalar pastda.

## 20 ta mezon

Holat: ✅ oʻtdi · 🟡 qisman · ⏳ kod sinaldi, haqiqiy tashqi muhitda tekshirish kutilmoqda.

| # | Mezon | Holat | Dalil | Izoh |
|---|---|---|---|---|
| 1 | Bot → Mini App: botga yuborilgan kitob shu hisobda koʻrinadi, boshqa hisobda yoʻq | ✅ ⏳ | `telegram.test` › “a book sent to the bot appears in the same account's Mini App library, not in another account's” | Haqiqiy bot bilan ⏳ |
| 2 | Matnli va skan PDF oʻqiladi; oʻqilmagan sahifa yashirilmaydi; bob/sahifa tanlash mos | ✅ | `ingest.test` (text PDF + page labels + outline; scanned PDF OCR “reports blank and unreadable pages honestly”); e2e `core-flow` | Qoʻlyozma va murakkab formula sifati oʻlchanmagan |
| 3 | Foydalanuvchi savollaridan 4 variantli quiz, har toʻgʻri javob manbasi ochiladi | ✅ | `quiz.test` › acceptance 3; e2e `core-flow` (`04-quiz-editor-390.png`, `05-practice-feedback-390.png`) | |
| 4 | Kitobda javobi yoʻq savol tekshirishda qoladi, soxta citation yoʻq | ✅ | `quiz.test` › acceptance 4; AI dublyori bilan “drops fabricated citations” | |
| 5 | Takror variant / ikki toʻgʻri javob nashrdan oldin aniqlanadi; aralashtirishdan keyin baho oʻzgarmaydi | ✅ | `quiz.test` › acceptance 5, “grades by option id after shuffling” | Kalit pozitsiyalari aralashtiriladi (A/B/C/D taqsimoti `quality/summary-extractive.json` da) |
| 6 | Native Telegram quiz: guruhga yuboriladi, javob hodisalari ishlanadi, anonimdan shaxsiy natija yoʻq | ✅ ⏳ | `telegram.test` › acceptance 6 (4 test, uzun savol testi bilan) | Soxta Bot API bilan. Haqiqiy test guruhida ⏳ (bot token + guruh) |
| 7 | Kamida ikki hisob bitta havola orqali bitta xonaga kirib, bitta savolni koʻradi | ✅ ⏳ | `rooms.test` › acceptance 7; e2e `room.spec` (ikki brauzer konteksti, `startapp` havola), `stage4.spec` (co-host) | Haqiqiy Telegram mijozlarida ⏳ |
| 8 | Server balli: mijoz soʻrovini oʻzgartirib ball qoʻshib boʻlmaydi; takror/kech javob ball bermaydi; kalit responseʼda yoʻq | ✅ | `rooms.test` › acceptance 8; `quiz.test` (editor maʼlumotiga begona kirish) | |
| 9 | Reconnect: javob/natija tiklanadi; host chiqishi qoidasi | ✅ | `rooms.test` › acceptance 9 (server soati, reconnect, host ketsa pauza); `study.test` › co-host | |
| 10 | Yuklama: 100 virtual qatnashuvchi; p95 < 1 s — pilot maqsad | ✅ (dev muhit) | [load-room.json](evidence/load-room.json): qoʻshilish p95 262 ms, savol fan-out p95 165 ms, javob ack p95 8 ms, `GET /api/me` p95 116 ms, xona holati p95 122 ms; 300 javob, 0 dublikat, 0 notoʻgʻri ball | Bitta konteyner, loopback tarmoq. **Kafolat emas** — production server, TLS va real tarmoqda qayta oʻlchash kerak |
| 11 | 12 slaydli namuna → tahrir → bitta slaydni qayta yaratish → PPTX/PDF; fayl ochiladi, matn tahrirlanadi, sahifadan chiqish yoʻq | ✅ | `slides.test` › acceptance 11; e2e `deck.spec`; [evidence/slides](evidence/slides/) (3 uslub, PNG renderlar) | |
| 12 | Statistika: jadvaldagi qiymat, birlik, davr grafik bilan aynan mos; manbasiz fakt tasdiqlanmaydi | ✅ | `study.test` › acceptance 12; `slides.test` › acceptance 12; e2e `stage2.spec` (`15-stats-360.png`) | |
| 13 | Versiya: manba/quiz oʻzgarsa eski attempt bahosi va artifakt dalili buzilmaydi | ✅ | `quiz.test` › “keeps old attempts on their version (acceptance 5 + 13)”; `source_references` snapshot | |
| 14 | Workspace ruxsati: viewer tahrirlay olmaydi; boshqa workspace hujjati/qidiruvi/eksportiga kira olmaydi; bekor qilingan taklif ishlamaydi | ✅ | `security.test` (acceptance 14/18), `rooms.test` (revoked invites), `slides.test` (permissions), `study.test` (workspace invites) | |
| 15 | Worker qayta ishga tushsa job tiklanadi; provider timeout/429 — cheklangan retry, tushunarli holat | ✅ | `resilience.test` (SIGKILL, oxirgi urinishda oʻlish, 429, timeout, lease boshqaga oʻtganda yozmaslik) | |
| 16 | Toʻlov: muvaffaqiyatli, muvaffaqiyatsiz, bekor, takroriy webhook, refund — ledger bilan mos | ✅ ⏳ | `billing.test` › acceptance 16 (6 test) | Soxta Bot API bilan. Haqiqiy Stars ⏳ (`PAYMENTS_ENABLED=true` + bot) |
| 17 | Mobil UX: Android, iOS, Desktop Telegramda asosiy oqim; kichik ekran, klaviatura, safe area | 🟡 ⏳ | e2e `responsive.spec`: 21 ekran × 320/360/390/430/1024/1440 px × och/toʻq mavzu, safe area insetlari bilan, gorizontal scroll yoʻq; 3 til × 320 px | Faqat Chromium + mock. **Haqiqiy qurilmalarda sinalmagan**; klaviatura ochilishi brauzerda simulyatsiya qilinmagan |
| 18 | Xavfsizlik: eskirgan/soxta initData, prompt injection, xavfli upload, SSRF, maxfiy URL, ruxsat almashtirish | ✅ | `telegram.test` (initData, webhook secret), `security.test` (SSRF + DNS rebinding + redirect, injection, ID almashtirish, imzolangan havola, upload limit), `ingest.test` (niqoblangan/makrosli fayl), `admin.test` (eskirgan admin imzosi → 403) | Antivirus skaneri ulanmagan |
| 19 | Oʻchirish soʻrovi, indeks/kesh tozalash, backupʼdan tiklash amalda | ✅ | `ops.test` (eksport, backup → oʻchirish → tiklash → oʻchirishni qayta qoʻllash), [restore-drill.json](evidence/restore-drill.json) (backup 223 ms, restore 808 ms, qator va fayl sha256 mos), `outbox.test` (retention) | |
| 20 | Oʻzbek lotin/kirill, rus, ingliz: aralash matn, buzilgan harf, gorizontal scroll yoʻq | ✅ 🟡 | Kalitlar toʻliqligi TypeScript turi bilan majburiy; `translit.test` (kirill lugʻatida lotin, `ʻ`/`ʼ` qoldigʻi yoʻq); e2e `responsive.spec` › ru/en/uz-Cyrl — 21 ekranda boshqa til qoldigʻi va scroll yoʻq ([21-home-*-320.png](evidence/e2e/)) | Rus/ingliz tarjimalari ona tilida soʻzlashuvchi tomonidan koʻrib chiqilmagan |

Bu ish davomida testlar topgan va tuzatilgan xatolar (bir qismi):
- kirill interfeysida “yoʻq” → “ёʻқ” chiqardi (toʻgʻrisi “йўқ”);
- topshiriqni yuborgandan keyin eskirgan keshdan “Boshlash” tugmasi koʻrinardi;
- sahifa qayta yuklanganda taklif ekrani qayta ochilardi;
- guruh quizida 300 belgiga yaqin savol jimgina kesilardi;
- admin “yangi sessiya” cheklovini avtomatik qayta kirish chetlab oʻtardi;
- outbox ikki jarayonda bir xabarni ikki marta yuborishi mumkin edi.

## AI sifati etaloni (§ 23 oxiri)

[quality/summary-extractive.json](evidence/quality/summary-extractive.json) va [quality/etalon-extractive.csv](evidence/quality/etalon-extractive.csv) — `apps/server/scripts/eval-quality.ts`. Uch turdagi material: matnli darslik, skan PDF, statistik jadval.

| Material / usul | Soʻralgan | Yaratilgan | Dalil tasdiqlangan | Koʻrib chiqish kerak |
|---|---|---|---|---|
| Darslik / manbadan | 15 | 15 | 15 | 15 |
| Darslik / savollar roʻyxatidan | 6 | 6 | 0 | 6 |
| Skan / manbadan | 10 | 10 | 10 | 10 |
| Statistika / jadvaldan | 4 | 4 | 4 | 4 |

- Bu natija **AIʼsiz (extractive) rejimda** olingan. AIʼsiz rejimdagi har bir savol odam tekshiruvini talab qiladi (`review_required`).
- “Savollar roʻyxatidan” usulida AIʼsiz javob topilmaydi: savollar kalitsiz, `needs_review` holatida qoladi. Bu taxmin qilinmaydi.
- CSV dagi `wrong_key`, `ambiguous`, `unsupported_evidence` ustunlari **odam tekshiruvi uchun boʻsh qoldirilgan**. `apps/server/scripts/score-review.ts` toʻldirilgan CSV boʻyicha xato ulushini hisoblaydi.
- AI rejimidagi etalon (`AI_PROVIDER=anthropic`) API kaliti yoʻqligi sababli **ishga tushirilmagan**.
- Etalondan oʻtish kelajakdagi savollarning xatosizligini isbotlamaydi: foydalanuvchi bildirishlari (`question_reports`) va admin moderatsiyasi davom etadi.

## Bosqichlar boʻyicha natija

| Bosqich | Ishlaydigan natija | Dalil |
|---|---|---|
| 0 — aniqlik | Talablar xaritasi, arxitektura qarorlari (ADR), xarajat modeli, qabul mezonlari | `requirements-map.md`, `architecture.md`, `cost-model.md` |
| 1 — vertikal yadro | Telegram auth → yuklash/OCR → manbali quiz → tahrir/nashr → botda yechish → guruhga ulashish → jonli xona → natija; deck → PPTX/PDF | mezonlar 1–11, e2e `core-flow`, `room.spec`, `deck.spec` |
| 2 — oʻqish va jamoa | Manbali tutor, konspekt, statistika, kartochka, xatolar daftari, imtihon rejasi, workspace vazifalari, Quiz Battle, juftlash oʻyini | `study.test`, e2e `stage2.spec` |
| 3 — tijoriy va operatsion | Stars toʻlovi, tarif/kredit ledger, refund, admin, support, `/metrics`, backup/restore, yuk va xavfsizlik testlari | `billing.test`, `admin.test`, `ops.test`, `security.test`, e2e `stage3.spec` |
| 4 — kengaytirish (qisman) | Topshiriq (mustaqil vaqtda), co-host, Toʻgʻri/Notoʻgʻri savollar, eslatmalar (sokin soatlar), yozma ishlar yordamchisi | `study.test`, `writing.test`, `reminders.test`, e2e `stage4.spec` |

## Amalga oshirilmagan (ochiq roʻyxat)

- Veb-qidiruv rejimi (`sources_plus_web`), koʻp manbadagi ziddiyatlarni koʻrsatish.
- Masala rasmi boʻyicha yordam (vision), dasturlash uchun kod sandbox.
- Slaydlarda rasm/fotosurat, formula uchun LaTeX, bir sahifali handout, DOCX eksport.
- Quiz Duel, “Xatoni top”, ketma-ketlik oʻyini, imtihon marafoni, XP/badge, referral.
- Ketma-ketlik, boʻsh joy, qisqa javob va rasm boʻyicha savol turlari (sxemada bor, generatsiya yoʻq).
- Dars jadvali, fokus taymeri, alohida diagnostika quizi.
- Ochiq shablonlar UI, `moderator` roli huquqlari, `projects` jadvali.
- Real vaqtli birgalikda matn tahriri, maʼruza audiosidan konspekt.
- Antivirus skaneri, S3-mos ombor, Docker image (bu muhitda Docker daemon yoʻq edi).

## Tashqi sozlamalar — ishga tushirish uchun kerak

| Sozlama | Nima uchun | Qayerda |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Bot va Mini App kirishi | BotFather → [setup-telegram.md](setup-telegram.md) |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook himoyasi (productionda majburiy) | `openssl rand -hex 32` |
| `PUBLIC_BASE_URL` (**HTTPS** domen) | Telegram webhook va Mini App faqat HTTPS bilan ishlaydi | DNS + Caddy ([deploy.md](deploy.md)) |
| BotFather: Main Mini App, menyu tugmasi, guruhga qoʻshish ruxsati | `startapp` havolalari, guruh quizi | `pnpm --filter @talaba/server ops:telegram-setup` + BotFather |
| `SIGNING_SECRET` (≥ 32 belgi) | Havola va taklif imzolari | `openssl rand -hex 32` |
| `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` | AI quiz/slayd/tutor/yozuv yordamchisi; busiz extractive rejim | Anthropic Console |
| `EMBEDDINGS_PROVIDER=voyage`, `VOYAGE_API_KEY` (ixtiyoriy) | Semantik qidiruv; busiz leksik + trigram | Voyage AI |
| `PAYMENTS_ENABLED=true` + tarif narxlari (Stars) | Pullik rejalar; avval haqiqiy botda sinov | Admin → Tariflar |
| `ADMIN_TELEGRAM_IDS` | Admin paneli | Telegram user ID |
| `METRICS_TOKEN`, `DELETION_LOG_PATH`, `SUPPORT_CHAT_ID`, `TERMS_URL`, `PRIVACY_URL` | Monitoring, oʻchirishlar jurnali, support, huquqiy sahifalar | `.env` |

Shundan keyin qilinadigan qoʻlda sinovlar:
- haqiqiy test guruhida native quiz (6);
- ikki haqiqiy Telegram hisobi bilan xona (7);
- Android, iOS va Desktop Telegramda asosiy oqim (17);
- haqiqiy Stars toʻlovi va refund (16);
- AI rejimida sifat etaloni va odam tekshiruvi;
- production serverda yuk sinovini qayta oʻlchash (10).
