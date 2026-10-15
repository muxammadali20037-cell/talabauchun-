# TALABA AI — Tashqi API cheklovlari va versiyalar

Hujjat sanasi: **2026-10-15**. Bu hujjat kod **tayanadigan** tashqi cheklovlarni va paket versiyalarini sanaydi. Qiymatlar koddan olingan (fayl koʻrsatilgan). Telegram va Anthropic cheklovlari vaqt oʻtishi bilan oʻzgaradi — ishga tushirishdan oldin ular rasmiy hujjatlar bilan **qayta tekshirilishi shart**:

- Bot API: <https://core.telegram.org/bots/api>
- Mini Apps: <https://core.telegram.org/bots/webapps>
- Telegram Stars toʻlovlari: <https://core.telegram.org/bots/payments-stars>
- Anthropic API va narxlar: Anthropic rasmiy hujjatlari (platform.claude.com)

Bu hujjat muallifi Telegram serverlari bilan jonli sinov oʻtkazmagan: repozitoriydagi testlar soxta Telegram serveri (`apps/server/test/helpers/fake-telegram.ts`) va WebApp mock (`e2e/tests/telegram-mock.ts`) bilan ishlaydi.

## 1. Telegram Bot API

### 1.1 Kod ishlatadigan limitlar (`packages/shared/src/limits.ts` → `TELEGRAM`)

Fayl izohi: qiymatlar `@grammyjs/types@5.0.0` dagi Bot API tur taʼriflari bilan solishtirilgan (“Bot API 9.6+: `correct_option_ids`, 1-12 options, open_period 5-2628000”) va rasmiy hujjat bilan qayta tekshirilishi kerak.

| Konstanta | Qiymat | Kodda qayerda ishlatiladi |
|---|---|---|
| `pollQuestionMax` | 300 belgi | `nativePollCompatible()`; `sendPoll` savoli shu uzunlikka kesiladi |
| `pollOptionMax` | 100 belgi | `nativePollCompatible()`; variant matni kesiladi |
| `pollOptionsMin` / `pollOptionsMax` | 1 / 12 | `nativePollCompatible()` amalda **2–12** variant talab qiladi |
| `pollExplanationMax` | 200 belgi | poll izohi (`explanation` + manba joyi) “…” bilan kesiladi |
| `pollExplanationMaxLineFeeds` | 2 | `nativePollCompatible()` |
| `pollOpenPeriodMin` / `Max` | 5 / 2 628 000 s | toʻgʻridan-toʻgʻri ishlatilmaydi; guruh runʼi `open_period` ni **10–600 s** ga cheklaydi (`group/native-quiz.ts`, `http/group-routes.ts`) |
| `messageTextMax` | 4096 belgi | bot mashq savoli va `editMessageText` matni kesiladi |
| `captionMax` | 1024 | eʼlon qilingan, kodda ishlatilmaydi |
| `callbackDataMaxBytes` | 64 bayt | eʼlon qilingan; amalda `shortId()` (UUID → 22 belgili base64url) bilan sigʻdiriladi |
| `botFileDownloadMaxBytes` | 20 MiB | bot orqali fayl qabul qilish (§ 1.4) |
| `startParamMax` | 64 | eʼlon qilingan; tekshiruv `links.ts` dagi regexʼda (§ 1.6) |

**Tekshirish kerak boʻlgan nuqta (yuqori ustuvorlik):** `sendPoll` chaqiruvi `correct_option_ids` (massiv) parametrini yuboradi (`group/native-quiz.ts`, `sendPoll()` funksiyasi). Avvalgi Bot API versiyalarida quiz poll uchun `correct_option_id` (bitta son), kamida 2 variant va `open_period` 5–600 s boʻlgan. Joriy Bot API qaysi shaklni qabul qilishini rasmiy hujjatdan tasdiqlang — mos kelmasa native guruh quizlari ishlamaydi va bu testlarda koʻrinmaydi (soxta server).

### 1.2 `sendPoll` (native guruh quizi)

`group/native-quiz.ts` yuboradigan parametrlar: `chat_id`, `question` (`"<i>/<n>. <matn>"`; prefiks bilan 300 dan oshsa prefiks tashlanadi, savol matni kesilmaydi — `pollQuestion()`), `options: [{text}]` (har biri ≤ 100), `type: "quiz"`, `is_anonymous`, `allows_multiple_answers: false`, `correct_option_ids: [indeks]` va bitta toʻgʻri javobda qoʻshimcha `correct_option_id: indeks` (eski Bot API serverlari uchun), ixtiyoriy `explanation` (≤ 200), `open_period`, `protect_content: false`.

Native quizga faqat quyidagi savollar kiradi: nashr qilingan, turi `single`, aynan 1 toʻgʻri javob, `nativePollOk=true` (matn ≤ 300, 2–12 variant, har biri ≤ 100, izohda ≤ 2 qator uzilishi). Qolganlari “faqat Mini App” deb hisoblanadi.

### 1.3 Yuborish tezligi va 429 (`src/telegram/outbox.ts`, `src/telegram/api.ts`)

Kod izohi Telegram bots FAQʼga tayanadi: umumiy ~30 xabar/s, shaxsiy chatga ~1 xabar/s, guruhga ~20 xabar/daqiqa. `OutboxSender` (worker jarayonida) token-bucketʼlari:

| Bucket | Sigʻim | Toʻldirilish |
|---|---|---|
| Global | 25 | 25 token/s |
| Shaxsiy chat (`chat_id` musbat) | 3 | 1 token/s |
| Guruh (`chat_id` `-` bilan boshlanadi) | 3 | 20 token/daqiqa |

Bucketʼlar **jarayon xotirasida**: bir nechta worker ishlasa umumiy tezlik koʻpayadi.

Xatolarni qayta ishlash:

| Holat | Xatti-harakat |
|---|---|
| Bucket boʻsh | xabar `pending` ga qaytadi, 1 s dan keyin |
| `429` | `next_attempt_at = now + max(1, retry_after ?? 5)` s; urinishlar soni bilan cheklanmaydi |
| Tarmoq xatosi (kod 0) yoki `5xx` | backoff `min(600, 2^attempts)` s, 8 urinishgacha, keyin `dead` |
| Boshqa xato (`4xx`) | `failed`; `403` shaxsiy chatda → foydalanuvchi `bot_blocked_at` bilan belgilanadi |

Interaktiv javoblar (`callWithRetry`): `retry_after` ≤ 5 s boʻlsa kutib 2 martagacha qayta urinadi; tarmoq xatosida 1 marta. Guruh runʼida `429` → `next_send_at = now + max(1, retry_after ?? 5)` s; `403/400` → run `failed` va hostga xabar. HTTP vaqt chegaralari: oddiy chaqiruv 15 s, `sendDocument` 60 s (metod bor, lekin ishlab chiqarish kodida chaqirilmaydi), fayl yuklab olish 120 s. `answerCallbackQuery` matni 200 belgigacha kesiladi.

### 1.4 Bot orqali fayl yuklash (`getFile`)

`Bot.onFile()`: chegara = `min(20 MiB, MAX_UPLOAD_MB)`. `file_size` chegaradan katta boʻlsa yuklab olinmaydi — foydalanuvchiga Mini App orqali yuklash tugmasi yuboriladi (Mini App multipart chegarasi `MAX_UPLOAD_MB`, standart 50 MB). `downloadFile()` `getFile` dagi `file_size` ni va oqim davomida haqiqiy hajmni tekshiradi. Yuklab olish webhook ishlovchisi ichida sinxron bajariladi.

### 1.5 Webhook, polling va bot sozlamalari

- `setWebhook` (`src/telegram/setup.ts`, `pnpm --filter @talaba/server ops:telegram-setup`): `url = <PUBLIC_BASE_URL>/telegram/webhook`, `secret_token = TELEGRAM_WEBHOOK_SECRET`, `allowed_updates = [message, callback_query, poll, poll_answer, my_chat_member, pre_checkout_query]`, `max_connections: 40`, `drop_pending_updates: false`. `.env.example` boʻyicha secret: 1–256 belgi, `[A-Za-z0-9_-]`.
- Server `X-Telegram-Bot-Api-Secret-Token` sarlavhasini doimiy vaqtda taqqoslaydi; `update_id` `processed_updates` orqali bir marta ishlanadi.
- Polling (faqat lokal): `deleteWebhook`, keyin `getUpdates` (`timeout: 25`, xuddi shu `allowed_updates`).
- `setMyCommands` (`all_private_chats`, oʻzbekcha standart, `ru` va `en` uchun `language_code`), guruhlar uchun faqat `/start`; `setMyDescription`, `setMyShortDescription`; `setChatMenuButton` (`web_app`, `<PUBLIC_BASE_URL>/app/`). Main Mini App BotFatherʼda qoʻlda sozlanadi — qadamlar `docs/setup-telegram.md` da.
- Guruhda bot faqat `/start g<token>` ga javob beradi (privacy rejimiga mos).

### 1.6 Deep link parametrlari va `web_app` tugmalari (`src/telegram/links.ts`)

| Havola | Shakl | Parametr |
|---|---|---|
| Mini App | `https://t.me/<bot>?startapp=<param>` | `r<token>` — xona taklifi; `w<token>` — workspace taklifi |
| Guruhga qoʻshish | `https://t.me/<bot>?startgroup=<param>` | `g<token>` — guruh quizi (30 daqiqa) |
| Bot `/start` | shaxsiy chatda `support`, `r<…>` | `r…` — Mini Appʼga oʻtish tugmasi |

- Parametr tekshiruvi: `/^[A-Za-z0-9_-]{1,64}$/` (`startAppLink`, `startGroupLink`). Kod izohi: “keep <= 64 to be safe for both” (`start` va `startapp`). Tokenlar `randomToken(16)` → 22 belgi, prefiks bilan 23 belgi.
- `web_app` tugmalari faqat `PUBLIC_BASE_URL` `https://` boʻlsa yaratiladi (`miniAppUrl()` aks holda `null` qaytaradi). URL shakli: `<PUBLIC_BASE_URL>/app/#<marshrut>`.

### 1.7 Callback data (≤ 64 bayt)

`lang:<til>`, `m:<menyu>`, `qw:start`, `qw:d:<uuid>` (41 bayt), `qw:n:<uuid>:<10|20>` (≤ 44), `qp:<uuid>` (39), `pa:<shortId>:<savol>:<variant>`, `pn:` / `ps:` / `pm:<shortId>` (25), `gs:<uuid>` (39). UUIDʼlar 22 belgili `shortId` ga siqiladi.

### 1.8 Telegram Stars (`src/billing/stars.ts`)

- Toʻlov faqat `PAYMENTS_ENABLED=true` boʻlganda; standart `false`. Migratsiya pullik tariflarni `price_stars=0` va `active=false` bilan yaratadi; admin narx qoʻymaguncha sotilmaydi.
- Invoice (`sendInvoice` — bot `/buy`; `createInvoiceLink` — Mini App): `currency: "XTR"`, `provider_token: ""` (boʻsh), `prices` — bitta element (`amount = price_stars`), `title` ≤ 32 belgi, `description` ≤ 255 belgi (kesiladi), `payload = "p_" + 24 belgi`.
- `pre_checkout_query`: `answerPreCheckoutQuery` faqat quyidagilar bajarilsa `ok:true`: toʻlov `pending`, valyuta `XTR`, summa mos, Telegram foydalanuvchisi mos, tarif faol va versiyasi invoiceʼdagi snapshot bilan bir xil. Aks holda `ok:false` va inglizcha `error_message`. Javob webhook ishlovchisida sinxron beriladi (Telegram bu soʻrovga javob uchun qisqa muddat beradi — rasmiy hujjatdan tekshiring).
- Kredit **faqat** `successful_payment` xabaridan keyin qoʻshiladi; `telegram_payment_charge_id` boʻyicha idempotent; summa/foydalanuvchi mos kelmasa toʻlov `failed`. Mini App `openInvoice` holati faqat UI uchun.
- Qaytarish: admin `refundStarPayment(user_id, telegram_payment_charge_id)` chaqiradi (`user_id` — `payments.payer_telegram_id`, boʻlmasa foydalanuvchining joriy Telegram IDʼsi; ikkalasi ham yoʻq boʻlsa `409 payer_unknown`); daftar va entitlement faqat Telegram tasdiqlagach oʻzgaradi. `refunded_payment` xizmat xabari ham shu idempotent yoʻl (`applyRefund`) bilan ishlanadi. `/paysupport` buyrugʻi mavjud.

## 2. Telegram Mini App talablari

| Talab | Qiymat / xatti-harakat | Fayl |
|---|---|---|
| HTTPS | Productionʼda `PUBLIC_BASE_URL` https boʻlishi shart; aks holda server ishga tushmaydi | `config.ts` |
| `initData` yoshi | `TELEGRAM_INITDATA_MAX_AGE_SEC` (standart 3600 s); kelajakka ≤ 300 s; uzunlik ≤ 8192 | `auth/init-data.ts` |
| Sessiya | `SESSION_TTL_HOURS` (12); 401 da mijoz `initData` bilan bir marta qayta kiradi | `auth/sessions.ts`, `lib/api.ts` |
| iframe | CSP `frame-ancestors https://web.telegram.org https://*.telegram.org` | `http/app.ts` |
| SDK | `https://telegram.org/js/telegram-web-app.js` | `apps/miniapp/index.html` |
| Marshrutlash | `HashRouter`, `/app/#/…`; `index.html` `no-cache`, assetlar 1 yil `immutable` | `main.tsx`, `http/app.ts` |

Versiya tekshiruvlari (`isVersionAtLeast`, `lib/telegram.ts`, `components/ui.tsx`):

| API | Minimal versiya | Pastroq versiyada |
|---|---|---|
| `BackButton` | 6.1 | sahifa ichidagi “←” faqat Telegram tashqarisida; Telegram ichida tugma boʻlmaydi |
| `setHeaderColor`, `setBackgroundColor` | 6.1 (`try/catch` ichida) | chaqirilmaydi |
| `setBottomBarColor` | 7.10 | chaqirilmaydi |
| `disableVerticalSwipes` | 7.7 | chaqirilmaydi |
| `downloadFile` | 8.0 | `<a download>` havolasi |
| `openInvoice` | 6.1 | `"unsupported"` |
| `safeAreaInset`, `contentSafeAreaInset` | versiya tekshirilmaydi; mavjud boʻlsa ishlatiladi | CSS `env(safe-area-inset-*)` zaxira |

Hodisalar: `themeChanged`, `safeAreaChanged`, `contentSafeAreaChanged`, `viewportChanged`. `setHeaderColor` ga ixtiyoriy hex rang beriladi; Telegramʼning qaysi versiyasidan hex qabul qilinishini rasmiy hujjatdan tekshiring (xato `try/catch` bilan yutiladi).

## 3. AI provayder cheklovlari

### 3.1 Anthropic (`src/ai/client.ts`)

| Sozlama | Standart | Izoh |
|---|---|---|
| `AI_PROVIDER` | `none` | `anthropic` + `ANTHROPIC_API_KEY` boʻlsa AI yoqiladi |
| `AI_MODEL_STRONG` | `claude-opus-5-5` | strong tier |
| `AI_MODEL_FAST` | `claude-haiku-5-5` | fast tier |
| `AI_TIMEOUT_MS` | 120 000 | SDK `timeout` (bitta urinish uchun) |
| `AI_MAX_RETRIES` | 2 (0–5) | SDK `maxRetries` |
| `AI_INTERACTIVE_TIMEOUT_MS` | 45 000 | tutor, konspekt, yozuv yordamchisi: shu vaqt + 1 ta qayta urinish (foydalanuvchi kutib turadi) |
| `max_tokens` | 16 000 | `model_configs.max_tokens` bilan oʻzgartiriladi |
| `AI_BASE_URL` | yoʻq | boʻlsa server tomonidagi fallback yuborilmaydi |

- **Qayta urinishlar ikki qatlamli.** (1) SDK ichida: SDK hujjatiga koʻra 408/409/429/5xx va ulanish xatolari qayta urinadi; vaqt tugashi ham qayta urinadi, shuning uchun bitta chaqiruv eng yomon holatda ~`AI_TIMEOUT_MS × (AI_MAX_RETRIES + 1)` = 6 daqiqa davom etishi mumkin. (2) Job darajasida: `rate_limited`, `timeout`, `truncated`, `invalid_output` va 5xx — retryable; backoff 5/15/45/135/300 s, `max_attempts` (3) gacha; keyin `ai_<code>` bilan `failed` va kredit qaytariladi. Bu xatti-harakat `apps/server/test/resilience.test.ts` da soxta provayder bilan tekshirilgan.
- **Qayta urinilmaydi:** `refusal`, `not_configured` (401/403), `provider_error` (400), `disabled` (admin kill switch).
- **Sinxron yoʻllar**: tutor (`/api/tutor/ask`, 30 soʻrov/daqiqa), konspekt (`/api/documents/:id/summary?ai=1`) va yozuv yordamchisi (`/api/writing`) AI xatosini `ai_<code>` bilan HTTP 503 (retryable) yoki 502 ga aylantiradi. Ular kredit olmaydi, lekin tarifdagi kunlik AI yordam limitiga (`aiAssistPerDay`, oshsa `429 daily_ai_limit`) kiradi.
- **Server tomonidagi fallback**: model `^claude-(opus|sonnet|fable)` ga mos va `AI_BASE_URL` boʻsh boʻlsa `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`. Override orqali boshqa (eski) Opus/Sonnet modeli tanlansa, bu parametr u model uchun qoʻllab-quvvatlanishini tekshiring.
- **Narx jadvali** (`PRICES`, faqat xarajatni hisoblash uchun, USD / 1M token): `claude-opus-5-5` 4 / 20, `claude-sonnet-5-5` 2 / 10, `claude-haiku-5-5` 0,10 / 0,50. Haiku 5.5 narxi 100K tokengacha boʻlgan promptlar uchun; undan yuqori tarif hisobga olinmagan. Boshqa modellar uchun `cost_usd = null`. Ishga tushirishda narxlarni qayta tekshiring.

### 3.2 Voyage embeddings (`src/search/embeddings.ts`)

`POST https://api.voyageai.com/v1/embeddings`, `model = EMBEDDINGS_MODEL` (standart `voyage-3.5`), `output_dimension: 1024` (ustun `vector(1024)`), `input_type: document | query`, vaqt chegarasi 30 s, ichki qayta urinish yoʻq, toʻplam hajmi 64. Ingest paytidagi xato job darajasida qayta urinadi; qidiruvdagi xato leksik qidiruvga tushadi.

## 4. Paket versiyalari (`package.json` dagi aniq qiymatlar)

Barcha tashqi bogʻliqliklar aniq versiyaga qotirilgan (`^`/`~` yoʻq); ichki paketlar `workspace:*`. Toʻliq qaror daraxti `pnpm-lock.yaml` da.

**Ildiz (`package.json`)**: bogʻliqliklar yoʻq; `packageManager: pnpm@10.28.0`; `engines.node: >=22`; `.nvmrc`: `22`; `pnpm-workspace.yaml`: `onlyBuiltDependencies: [esbuild]`.

**`apps/server`**

| Paket | Versiya | Tur |
|---|---|---|
| `@anthropic-ai/sdk` | 0.134.0 | dependency |
| `@fastify/multipart` | 10.1.4 | dependency |
| `@fastify/rate-limit` | 11.2.1 | dependency |
| `@fastify/static` | 10.1.6 | dependency |
| `@fastify/websocket` | 11.3.4 | dependency |
| `@talaba/shared` | workspace:* | dependency |
| `exceljs` | 4.4.0 | dependency |
| `fast-xml-parser` | 5.11.2 | dependency |
| `fastify` | 5.12.7 | dependency |
| `file-type` | 22.2.0 | dependency |
| `fontkit` | 2.0.4 | dependency |
| `ipaddr.js` | 2.5.0 | dependency |
| `jszip` | 3.10.2 | dependency |
| `node-html-parser` | 9.0.4 | dependency |
| `papaparse` | 5.7.0 | dependency |
| `pdf-lib` | 1.17.1 | dependency |
| `pdfjs-dist` | 6.4.299 | dependency |
| `postgres` | 3.4.9 | dependency |
| `pptxgenjs` | 4.0.1 | dependency |
| `undici` | 8.12.2 | dependency |
| `ws` | 8.22.0 | dependency |
| `zod` | 4.6.7 | dependency |
| `@types/fontkit` | 2.0.9 | devDependency |
| `@types/node` | 22.20.5 | devDependency |
| `@types/papaparse` | 5.5.2 | devDependency |
| `@types/ws` | 8.18.2 | devDependency |
| `esbuild` | 0.28.2 | devDependency |
| `tsx` | 4.23.15 | devDependency |
| `typescript` | 7.0.2 | devDependency |
| `vitest` | 5.0.5 | devDependency |

**`apps/miniapp`**

| Paket | Versiya | Tur |
|---|---|---|
| `@talaba/shared` | workspace:* | dependency |
| `@tanstack/react-query` | 5.104.3 | dependency |
| `react` | 19.3.1 | dependency |
| `react-dom` | 19.3.1 | dependency |
| `react-router-dom` | 7.18.4 | dependency |
| `@types/react` | 19.3.0 | devDependency |
| `@types/react-dom` | 19.3.0 | devDependency |
| `@vitejs/plugin-react` | 6.1.2 | devDependency |
| `typescript` | 7.0.2 | devDependency |
| `vite` | 8.3.4 | devDependency |
| `vitest` | 5.0.5 | devDependency |

**`packages/shared`**

| Paket | Versiya | Tur |
|---|---|---|
| `zod` | 4.6.7 | dependency |
| `typescript` | 7.0.2 | devDependency |
| `vitest` | 5.0.5 | devDependency |

**`e2e`**

| Paket | Versiya | Tur |
|---|---|---|
| `@playwright/test` | 1.64.1 | devDependency |
| `@talaba/server` | workspace:* | devDependency |
| `@types/node` | 22.20.5 | devDependency |
| `jszip` | 3.10.2 | devDependency |
| `typescript` | 7.0.2 | devDependency |

E2E Chromium yoʻli: `CHROMIUM_PATH` yoki `/opt/pw-browsers/chromium` (`e2e/playwright.config.ts`).

## 5. Server uchun tizim paketlari

| Komponent | Nima uchun | Sozlama / tekshiruv |
|---|---|---|
| **Node.js 22** | server, build, testlar | `.nvmrc`, `engines`; dalil fayllarida `v22.22.0` |
| **pnpm 10.28.0** | monorepo | `packageManager` |
| **PostgreSQL 16** | asosiy baza, navbat, `LISTEN/NOTIFY` | dalil fayllarida 16.15 |
| **pgvector** (`vector` extension) | `chunks.embedding vector(1024)`, HNSW indeks | `001_core.sql` `create extension if not exists vector` — kengaytma oʻrnatilgan va DB foydalanuvchisida yaratish huquqi boʻlishi kerak; HNSW pgvector 0.5.0+ ni talab qiladi |
| **pg_trgm** (contrib) | trigram GIN indeks, `word_similarity` | `create extension if not exists pg_trgm` |
| **tesseract-ocr** + `uzb`, `uzb_cyrl`, `rus`, `eng` til maʼlumotlari | skan PDF va rasm OCR | `TESSERACT_BIN`, `OCR_LANGS=uzb+uzb_cyrl+rus+eng`; `OMP_THREAD_LIMIT=1`, 120 s vaqt chegarasi |
| **poppler-utils** | `pdftoppm` (OCR render 200 dpi, miniatyuralar), `pdfinfo`, `pdffonts`, `pdftotext` (eksport tekshiruvi) | `PDFTOPPM_BIN`; qolgan uchtasi shu katalogdan yoki `PATH` dan |
| **LibreOffice** (`soffice`, headless) | PPTX → PDF | `LIBREOFFICE_BIN`; jarayonga 2 ta parallel, 120 s, `SAL_USE_VCLPLUGIN=svp` |
| **fonts-liberation** | Liberation Sans/Serif (Arial/Times metrikasi) — matn oʻlchash va PDF shrift tekshiruvi | `slides/measure.ts` `FONT_DIRS`; topilmasa oʻlchash taxminiy formulaga tushadi, PDF tekshiruvi esa begona shriftni rad etadi |
| **PostgreSQL client** (`pg_dump`, `pg_restore`, `psql`), `tar`, `sha256sum`, `bash` | zaxira va tiklash | `ops/backup.sh`, `ops/restore.sh` |

Fayl hajmi va resurs limitlari (`.env.example`): `MAX_UPLOAD_MB=50`, `MAX_PDF_PAGES=800`, `WORKER_CONCURRENCY=2`, `WORKER_LEASE_SEC=120`, `DATABASE_POOL_MAX=20`.

## 6. Ishga tushirishdan oldingi tekshiruv roʻyxati

1. `sendPoll` parametrlari (kod ikkalasini yuboradi: `correct_option_ids` va bitta javobda `correct_option_id`; variantlar soni, `open_period`, uzunliklar) — Bot API rasmiy hujjati bilan.
2. `startapp` / `startgroup` / `start` parametrlarining ruxsat etilgan belgilari va uzunligi.
3. Bot yuborish tezligi (bots FAQ), `getFile` 20 MB chegarasi, `answerCallbackQuery` va xabar uzunliklari.
4. Stars: `XTR`, boʻsh `provider_token`, `answerPreCheckoutQuery` javob muddati, `refundStarPayment` parametrlari.
5. Mini App: `isVersionAtLeast` chegaralari, `downloadFile`, `openInvoice`, safe area maydonlari, `initData` validatsiya algoritmi.
6. Anthropic: model IDʼlari, narxlar, `server-side-fallback-2026-07-01` beta va `fallbacks` parametri, rate limitlar.
7. Haqiqiy Telegram mijozlarida (iOS, Android, Desktop, Web) va haqiqiy Stars toʻlovi bilan qoʻlda sinov — repozitoriyda bunday sinov dalili yoʻq.
