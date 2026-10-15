# TALABA AI — Arxitektura

Hujjat sanasi: **2026-10-15** (kod `6a57238` holatiga yangilangan). Branch: `claude/talaba-ai-core`. Bu hujjat kodning hozirgi holatini tasvirlaydi; kodda yoʻq narsa “rejada” yoki “tekshirilmagan” deb aniq belgilangan. Fayl yoʻllari repozitoriy ildiziga nisbatan berilgan.

## 1. Umumiy koʻrinish

TALABA AI — Telegram bot + Telegram Mini App. Talaba material yuklaydi (PDF, DOCX, PPTX, rasm, havola…), undan manbasi koʻrsatilgan quiz, prezentatsiya, kartochka, konspekt tayyorlaydi va guruhda birga yechadi.

| Qism | Yoʻl | Texnologiya |
|---|---|---|
| Server (API + worker) | `apps/server` | Node 22, TypeScript, Fastify 5, `postgres` (postgres.js), PostgreSQL 16 + `pgvector` + `pg_trgm` |
| Mini App | `apps/miniapp` | React 19, Vite, React Router (`HashRouter`), TanStack Query |
| Umumiy kod | `packages/shared` | zod sxemalari, i18n (`uz`, `uz-Cyrl`, `ru`, `en`), limitlar |
| E2E testlar | `e2e` | Playwright (Telegram WebApp mock bilan) |

### 1.1 Jarayonlar

| Jarayon | Kirish nuqtasi | Vazifasi |
|---|---|---|
| API | `apps/server/src/main.ts` (`node dist/main.js`) | HTTP API (`/api/*`), Telegram webhook (`/telegram/webhook`), xonalar WebSocketʼi (`/ws/rooms`, `RoomHub`), imzolangan fayl yuklab olish (`/files/:a/:b`), Mini App statik fayllari (`/app/`), `/metrics`, `/healthz`, `/readyz`. `MIGRATE_ON_START` `false` boʻlmasa migratsiyalarni ishga tushiradi. `TELEGRAM_MODE=polling` boʻlsa long polling (`src/telegram/polling.ts`) ishlaydi. |
| Worker | `apps/server/src/worker-main.ts` (`node dist/worker-main.js`) | `JobWorker` (fon vazifalari), `OutboxSender` (Telegram xabarlari navbati, har 500 ms), `tickGroupRuns` (guruh quizlari jadvali, har 1000 ms), `tickReminders` (oʻqish eslatmalari, har 5 daqiqa), `closeExpiredAssignments` (muddati oʻtgan topshiriqlarni yopish, har 60 s), har soatda `cleanupExpiredExports` (7 kundan eski maʼlumot eksporti arxivlari) va `retentionCleanup` (§ 10). Har doim `migrate()` chaqiradi. |
| All-in-one | `apps/server/src/all-in-one.ts` | API va worker bitta jarayonda. Lokal ishlab chiqish, e2e testlar va kichik bitta-VM pilot uchun. |
| Operatsion CLI | `src/db/migrate-cli.ts`, `src/ops/telegram-setup.ts`, `src/ops/reapply-deletions.ts`, `ops/backup.sh`, `ops/restore.sh`, `scripts/smoke.ts`, `scripts/load-room.ts` | Migratsiya, bot sozlamalari (webhook, buyruqlar, menyu tugmasi), zaxira/tiklash, oʻchirishlarni qayta qoʻllash, smoke va yuk testi. |

Har bir jarayon `createDeps()` (`src/bootstrap.ts`) orqali bitta `Deps` obyektini yaratadi: `cfg`, `sql` (pool, `DATABASE_POOL_MAX`=20), `storage` (`LocalStorage`), `tg` (`TelegramApi` yoki `null`), `ai` (`AiClient` yoki `null`), `embedder` (`VoyageEmbedder` yoki `null`), `log`. Tashqi integratsiyalar ixtiyoriy: ular sozlanmasa tegishli funksiya oʻchadi yoki AIʼsiz (extractive) rejimga oʻtadi (`integrationStatus()` — `src/config.ts`).

### 1.2 Soʻrov oqimi

```
Telegram ilovasi ──(web_app tugma / menyu / t.me/<bot>?startapp=…)──▶ GET /app/  (Mini App, statik)
Mini App ──POST /api/auth/telegram {initData}──▶ API ──HMAC tekshiruv──▶ sessions (token_hash)
Mini App ──Authorization: Bearer <token>──▶ /api/*  ──▶ PostgreSQL
           ogʻir ish: INSERT generation_jobs + kredit rezervi + NOTIFY jobs (bitta tranzaksiya)
Worker ◀──LISTEN jobs / 1 s polling── claim (FOR UPDATE SKIP LOCKED) → bosqichlar → natija + kredit capture
Mini App ──GET /api/jobs/:id har 1,5 s (useJob)──▶ haqiqiy bosqich holati
Telegram ──POST /telegram/webhook (X-Telegram-Bot-Api-Secret-Token)──▶ Bot.handle → (fayl → job)
Worker ── notifications jadvali → OutboxSender → Bot API (rate limit, 429 retry_after)
Xona: WS /ws/rooms ⇄ RoomHub ⇄ PostgreSQL (shartli UPDATE) + NOTIFY rooms → har bir API instansiyasi
```

Mijoz job holatini **polling** bilan oladi. Worker `pg_notify('job_status', …)` yuboradi, lekin kodda bu kanalni tinglovchi yoʻq.

### 1.3 Deploy shakli

- Repozitoriyda Dockerfile, compose yoki Kubernetes manifesti **yoʻq**. Hujjatlashtirilgan yoʻl — Ubuntu 24.04 ga native oʻrnatish (`docs/deploy.md`): systemd xizmatlari `ops/talaba-api.service`, `ops/talaba-worker.service`, zaxira `ops/talaba-backup.service` + `.timer`, HTTPS uchun Caddy (`ops/Caddyfile`, `request_body max_size 60MB`). Build: `apps/server/build.mjs` (esbuild, `dist/*.js` + `dist/migrations`), Mini App: `vite build` → `apps/miniapp/dist`.
- Server HTTP tinglaydi; TLS oldida turgan reverse proxyʼda tugatilishi kerak. `NODE_ENV=production` da `PUBLIC_BASE_URL` `https://` bilan boshlanishi shart (`loadConfig`). Fastify `trustProxy` faqat `TRUST_PROXY` roʻyxatidagi proksilarga ishonadi (standart `127.0.0.1,::1` — shu hostdagi Caddy); aks holda mijoz `X-Forwarded-For` bilan rate limit va audit IPʼsini soxtalashtira olardi.
- API va worker **bitta `STORAGE_DIR`** ni koʻrishi kerak (`LocalStorage` lokal fayl tizimi): yoki bitta host, yoki umumiy disk.
- Production konfiguratsiya tekshiruvlari: `SIGNING_SECRET` ≥ 32 belgi va `dev-only` bilan boshlanmasligi; `DEV_AUTH_ENABLED=false`; bot yoqilgan boʻlsa `TELEGRAM_WEBHOOK_SECRET` majburiy; `PUBLIC_BASE_URL` https.
- Zaxira: `ops/backup.sh` (`pg_dump` custom + `storage.tar.gz` + `SHA256SUMS`, saqlash muddati `BACKUP_RETENTION_DAYS`=14), tiklash faqat boʻsh baza/katalogga (`ops/restore.sh`), keyin `ops:reapply-deletions`. Tiklash mashqi natijasi: `docs/evidence/restore-drill.json`.

## 2. Autentifikatsiya

### 2.1 Mini App initData (`src/auth/init-data.ts`)

`POST /api/auth/telegram` (30 soʻrov/daqiqa). Tekshiruv Telegram hujjatidagi algoritm boʻyicha:

1. `initData` uzunligi ≤ 8192, `hash` — 64 ta hex belgi.
2. `data_check_string` = `hash` dan boshqa barcha maydonlar, kalit boʻyicha saralangan `key=value`, `\n` bilan birlashtirilgan (`signature` maydoni ham ichida qoladi).
3. `secret_key = HMAC_SHA256("WebAppData", bot_token)`; `hex(HMAC_SHA256(secret_key, data_check_string))` doimiy vaqtli taqqoslash (`safeEqual`) bilan `hash` ga teng boʻlishi kerak.
4. `auth_date` yoshi ≤ `TELEGRAM_INITDATA_MAX_AGE_SEC` (standart 3600 s), kelajakka 300 s dan ortiq emas.
5. `user` JSON, `user.id` musbat xavfsiz butun son.

Muvaffaqiyatda `upsertTelegramUser()` foydalanuvchini yaratadi yoki yangilaydi, `profiles` qatorini, “Shaxsiy” nomli personal workspaceʼni (`owner` aʼzoligi bilan) va oylik bepul kreditni idempotent qoʻshadi. `ADMIN_TELEGRAM_IDS` dagi IDʼlar `platform_role='admin'` oladi (rol faqat serverda beriladi).

**Nega `initDataUnsafe` ga ishonilmaydi.** U mijoz tomonidagi imzosiz obyekt; har qanday sahifa uni soxtalashtira oladi. Server faqat imzosi tekshirilgan `initData` dagi `user` dan foydalanadi; URLʼdagi user ID hech qachon login hisoblanmaydi (`OutsideTelegram.tsx`). Mini App `initDataUnsafe.start_param` ni faqat bitta holatda oʻqiydi: sahifa qayta yuklanganda saqlangan sessiya boʻlsa, mijoz tomonida marshrutlash uchun (`lib/auth.tsx`). Taklif tokenlari baribir serverda tekshiriladi. Bitta Telegram sessiyasida taklif ekrani bir marta ochiladi (`sessionStorage` dagi `startParam.handled`), shuning uchun qayta yuklash foydalanuvchini joriy ekranidan chiqarib yubormaydi.

### 2.2 Sessiyalar (`src/auth/sessions.ts`)

- Token: `randomToken(32)` (base64url). Bazada faqat `sha256(token)` (`sessions.token_hash`, `bytea unique`) va `init_data_hash` saqlanadi.
- Muddat: `SESSION_TTL_HOURS` (standart 12). `revoked_at` va `expires_at` har soʻrovda tekshiriladi; `last_seen_at` daqiqasiga koʻpi bilan bir marta yangilanadi va `user_activity` ga kunlik qator yoziladi (retention metrikasi uchun).
- Mijoz tokenni `sessionStorage` da saqlaydi. 401 olganda bir marta `initData` bilan qayta kiradi va soʻrovni takrorlaydi (`lib/api.ts`, `lib/auth.tsx`).
- `POST /api/auth/dev` faqat `DEV_AUTH_ENABLED=true` va `NODE_ENV≠production` da ishlaydi, aks holda 404.

### 2.3 Telegram webhook

`/telegram/webhook` faqat bot tokeni **va** `TELEGRAM_WEBHOOK_SECRET` sozlanganda roʻyxatdan oʻtadi (`src/telegram/webhook.ts`). `X-Telegram-Bot-Api-Secret-Token` sarlavhasi sir bilan doimiy vaqtda taqqoslanadi, mos kelmasa 401. Har bir `update_id` ishlov berishdan oldin `processed_updates` ga `done=false` bilan **band qilinadi**, tugagach `done=true`. Shu update yana kelsa: tugagan boʻlsa — `200` (takror, qayta ishlanmaydi); hali ishlanayotgan boʻlsa — `503`, Telegram keyinroq qayta yuboradi; band qilingan, lekin 2 daqiqada tugamagan (jarayon oʻlgan) boʻlsa — yangi yetkazish uni oladi. Semantika: “kamida bir marta”, bir vaqtning oʻzida faqat bitta ishlovchi. Ishlovchi ichidagi xato foydalanuvchiga umumiy xabar bilan bildiriladi va update `done` deb belgilanadi (cheksiz qayta yetkazish boʻlmaydi). Webhook marshruti global rate limitdan chiqarilgan; logʼlarda `authorization` va secret sarlavhasi yashiriladi.

### 2.4 Admin “yangi sessiya” qoidasi (`src/http/admin-routes.ts`)

- Barcha `/api/admin/*` marshrutlari: sessiya + `platform_role='admin'` (aks holda 403).
- Har bir oʻzgartirish (`PUT`/`POST`): sessiyani yaratgan `initData` ning **`auth_date`** qiymati (`sessions.init_auth_date`) `ADMIN_FRESH_SESSION_MIN` (standart 15, ruxsat 1–240) daqiqadan yangi boʻlishi kerak, aks holda `403 admin_reauth_required`; qoʻshimcha rate limit 30/daqiqa; `audit_events` ga harakat va IP yoziladi.
- Sessiya yoshi emas, Telegram imzolagan vaqt tekshiriladi: mijozning avtomatik qayta kirishi oʻsha eski `initData` ni ishlatadi, shuning uchun u cheklovni chetlab oʻta olmaydi. Admin Mini Appni Telegramda qayta ochishi kerak (`test/admin.test.ts`: 30 daqiqalik `initData` → 403).

### 2.5 Boshqa himoya qatlamlari

- WebSocket: birinchi xabar 10 s ichida `{type:"auth", token, roomId}` boʻlishi shart; `maxPayload` 16 KiB.
- `/metrics`: `METRICS_TOKEN` (Bearer) yoki admin sessiyasi.
- Fayl havolalari: `HMAC_SHA256(SIGNING_SECRET, key\nfilename\nexp)`; muddat 300 s (deck eksporti), 600 s (maʼlumot eksporti). Saqlash kalitlari faqat serverda yaratiladi va yoʻl tekshiruvidan oʻtadi.
- HTTP sarlavhalari: `nosniff`, `referrer-policy: no-referrer`, `permissions-policy`; `/api/*` uchun `cache-control: no-store`; qolganlariga CSP (`frame-ancestors` faqat Telegram domenlari, `script-src 'self' https://telegram.org`).
- Global rate limit: 300 soʻrov/daqiqa, kalit — Bearer token xeshi (kampus NAT ortidagi sinf bitta mijoz deb sanalmasligi uchun), token boʻlmasa IP.
- JSON body ≤ 2 MiB; multipart fayl ≤ `MAX_UPLOAD_MB` (50), bitta fayl.

## 3. Avtorizatsiya modeli (`src/access/policy.ts`)

- **Workspace** (`personal` yoki `group`) — barcha obyektlar (documents, quizzes, decks, flashcards, tasks…) `workspace_id` ga ega.
- **Membership** rollari: `viewer` (1) < `editor` (2) < `owner` (3).
- `requireWorkspaceRole()`: aʼzo boʻlmasa **404** (`not_found`) — begona workspace mavjudligi oshkor qilinmaydi; rol yetmasa 403.
- `requireObjectRole(kind, id, min)` (`document`, `quiz`, `deck`): obyekt workspaceʼini topadi, rolni tekshiradi; mavjud boʻlmagan va ruxsatsiz IDʼlar bir xil 404 qaytaradi (ID taxmin qilishga qarshi).

| Amal (misollar) | Minimal rol |
|---|---|
| Hujjat, quiz preview, deck koʻrish; deck eksport qilish | `viewer` |
| Yuklash, quiz/deck yaratish, savolni tahrirlash, tasdiqlash, nashr qilish, hujjatni oʻchirish | `editor` |
| Quiz muharriri (javob kalitlari bilan) | `editor` |
| Workspace takliflari, aʼzo rolini oʻzgartirish | `owner` |

Boshqa obyekt rollari:
- **Xonalar**: kirish `room_members` orqali (workspace emas). Taklif tokeni (24 soat, bazada `sha256`) yoki 6 belgili kod bilan qoʻshiladi; xona havolasi faqat shu xonaning ishtirokchi koʻrinishini beradi. Aʼzo boʻlmasa 404; host amallari faqat host/co-hostʼga.
- **Guruh quizi** (`group_quiz_runs`): natijalarni faqat host koʻradi, boshqalarga 404.
- **Joblar**: `generation_jobs.user_id` chaqiruvchiga teng boʻlmasa 404.
- **Platforma rollari**: `user`, `moderator`, `admin`. Kodda faqat `admin` tekshiriladi; `moderator` sxemada bor, lekin hech qanday huquq bermaydi.

**Qidiruvda filtr SQL ichida.** `retrieve()` (`allowed` CTE) va `chunksForScope()` (`src/search/retrieve.ts`) `WHERE` ichida `d.workspace_id in (select workspace_id from memberships where user_id = $user)`, `d.current_version_id = v.id` va `d.deleted_at is null` shartlarini qoʻllaydi; natija keyin filtrlanmaydi. `listDocuments` va `listQuizzes` roʻyxatlari ham aʼzolik shartini SQLʼda ishlatadi.

## 4. Fon vazifalari (`src/jobs/queue.ts`)

### 4.1 Hayot sikli

Statuslar: `queued` → (`extracting` | `indexing` | `generating` | `validating` | `rendering`) → `completed` | `failed` | `cancelled`. Har bir job oʻz `stages[]` roʻyxatiga ega; mijozga faqat haqiqiy bosqich soni (`stagesDone/stagesTotal`) koʻrsatiladi — oʻylab topilgan foizlar yoʻq (`jobView`).

| `kind` | Bosqichlar | `max_attempts` | Kredit |
|---|---|---|---|
| `ingest_document` | extracting, indexing | 3 | yoʻq (OCR oylik limit bilan cheklanadi) |
| `generate_quiz` | generating, validating | 3 | ha |
| `generate_deck` | generating (+ validating; `planOnly` da faqat generating) | 3 | ha |
| `regenerate_slide` | generating, validating | 3 | ha (AIʼda 1, extractiveʼda 0) |
| `export_deck` | rendering, validating | 2 | 0 |
| `data_export` | extracting, rendering | 5 | yoʻq |
| `data_delete` | extracting | 5 | yoʻq |

### 4.2 Claim, lease, heartbeat

- `JobWorker.claim()`: bitta `UPDATE … WHERE id = (SELECT … ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. Shartlar: terminal emas, `run_after <= now()`, lease yoʻq yoki muddati oʻtgan, `attempts < max_attempts`, `kind` shu worker handlerʼlarida bor. Claim paytida `attempts + 1`, `locked_by`, `lease_expires_at = now() + WORKER_LEASE_SEC` (standart 120).
- Uygʻonish: `LISTEN jobs` + har 1 s polling; parallellik `WORKER_CONCURRENCY` (standart 2, 1–16).
- Heartbeat: har `leaseSec/3` (≥ 1 s) da `locked_by` mos kelsa lease uzaytiriladi.
- Worker oʻlib qolsa lease tugaydi va job boshqa worker tomonidan qayta olinadi.
- **Lease himoyasi**: `stage`, `saveCheckpoint`, `complete`, `fail`, `cancel` yozuvlari `where locked_by = <shu worker>` sharti bilan bajariladi. Lease boshqa workerga oʻtgan boʻlsa (masalan, uzoq GC pauzasidan keyin) eski worker `LeaseLost` oladi va hech narsa yozmaydi — natija va kredit ikki marta yakunlanmaydi (`test/resilience.test.ts`).

### 4.3 Checkpoint va davom ettirish

`ctx.stage()` / `ctx.saveCheckpoint()` `generation_jobs.checkpoint` (jsonb) ga yozadi. Handlerʼlar qayta urinishda bajarilgan ishni oʻtkazib yuboradi: ingest — `pages` da mavjud sahifalar; quiz — `candidates`; deck — `drafts`/`outline`; slayd — `draft`. Natija yozilishi idempotent: yangi urinish avvalgi urinish yozgan savollar/slaydlarni almashtiradi.

### 4.4 Qayta urinish va yakun

- `JobError(code, retryable)`; nomaʼlum xatolar retryable hisoblanadi. Backoff: `min(300, 5·3^(attempts−1))` s → 5, 15, 45, 135, 300 s.
- Ichki tafsilotlar `job_events` ga (operator uchun), talabaga faqat barqaror `error_code` boradi.
- `reapExhausted()` (≥ 15 s da bir): lease tugagan va `attempts ≥ max_attempts` boʻlgan job → `failed / worker_lost`, kredit rezervi qaytariladi. Busiz oxirgi urinishda oʻlgan job abadiy qayta olinishi mumkin edi.
- Bekor qilish: `POST /api/jobs/:id/cancel` → `cancel_requested=true`; handler bosqichlar orasida `throwIfCancelled()` chaqiradi → `cancelled` + kredit qaytariladi.

### 4.5 Idempotentlik kalitlari

`generation_jobs.idempotency_key` va `credit_ledger.idempotency_key` — `unique`. Takroriy bosish yangi job yoki ikkinchi yechim yaratmaydi. Bir vaqtda kelgan ikki bir xil soʻrov tranzaksiya ichida `pg_advisory_xact_lock(hashtextextended(key, 0))` (`lockIdempotencyKey`) bilan navbatga qoʻyiladi: ikkinchisi birinchisi yaratgan jobni qaytaradi (`test/quiz.test.ts`, parallel soʻrov testi).

| Manba | Kalit |
|---|---|
| Hujjat ingest | `ingest:<versionId>` |
| Quiz yaratish | `quiz:<userId>:<mijoz kaliti>` (Mini App: `crypto.randomUUID()`; bot: `bot:<callback_id>`) |
| Deck yaratish / rejadan generatsiya | `deck:<userId>:<kalit>`, `deckgen:<deckId>:<kalit>` |
| Slaydni qayta yaratish | `regen:<slideId>:<revision>:<kalit>` |
| Eksport | `export:<exportId>` (bir xil revision+format uchun mavjud eksport qaytariladi) |
| Maʼlumot soʻrovi | `data:<requestId>` |

### 4.6 Kredit daftari (`src/billing/credits.ts`)

Balans = `SUM(credit_ledger.amount)`. Yozuv turlari: `grant`, `reserve`, `capture`, `release`, `purchase`, `refund`, `adjust`.

1. **Reserve** — job yaratish bilan **bitta tranzaksiyada**: `users` qatori `FOR UPDATE` bilan bloklanadi, balans yetmasa `402 credits_insufficient`; manfiy `reserve` yozuvi (`reserve:<kalit>`).
2. **Capture** — muvaffaqiyatda: haqiqiy narx (≤ rezerv) qoladi, qolgani `release` bilan qaytariladi; `capture` yozuvi (summa 0) yakunni belgilaydi.
3. **Release** — xato yoki bekor qilishda toʻliq qaytarish.

Oylik bepul grant: `free:<userId>:<YYYY-MM>`, miqdori `plans.credits` (`free` uchun 60). Narxlar `DEFAULT_PRICING` (pilot uchun vaqtinchalik qiymatlar; xarajat hisobi — `docs/cost-model.md`), `feature_flags.pricing` orqali admin oʻzgartira oladi. Quyidagilar kredit olmaydi: hujjat ingest (faqat OCR oylik limiti — `maxOcrPagesPerMonth`, standart 300), tutor, konspekt, yozuv yordamchisi, eksport. AI ishlatadigan tutor/konspekt/yozuv yordamchisi oʻrniga tarifdagi kunlik **AI yordam limiti** (`aiAssistPerDay`, `usage_events` boʻyicha) qoʻllanadi — oshsa `429 daily_ai_limit`. Tarif shuningdek fayl hajmini (`maxUploadMb`) va quizdagi savollar sonini (`maxQuestionsPerQuiz`, joylangan roʻyxatlar ham) cheklaydi.

## 5. Kontent va AI oqimlari

### 5.1 Ingest (`src/ingest/*`)

- **Aniqlash** (`detect.ts`): fayl tarkibi (magic bytes, `file-type`) va kengaytma mos boʻlishi kerak. Qabul: PDF, DOCX, PPTX, XLSX, CSV, TXT/MD, JPG/PNG. Rad: makrosli (`docm/pptm/xlsm`), eski binar (`doc/ppt/xls`), `html/htm/svg/zip/rar/exe/js`. HTML faqat URL orqali qabul qilinadi.
- **PDF** (`pdf.ts`, `pdfjs-dist`): sahifa matn qatlami; 40 harfdan kam boʻlsa OCR. OCR: `pdftoppm` (200 dpi, kulrang) → `tesseract --psm 3` (`OCR_LANGS=uzb+uzb_cyrl+rus+eng`), oʻrtacha soʻz ishonchliligi ≥ 60 → `ok`, ≥ 35 → `low_confidence`, aks holda `failed`. Sahifa ≤ `MAX_PDF_PAGES` (800); parolli → `password_protected`; buzuq → `corrupted`. Boʻlimlar: PDF outline + boʻlim sarlavhasiga oʻxshash birinchi qator (`bob`, `глава`, `chapter`…). Bosma sahifa yorligʻi (`pageLabel`) saqlanadi.
- **DOCX/PPTX** (`docx.ts`, `pptx.ts`): ZIP ≤ 5000 yozuv, har bir XML qism ≤ 30 MB; PPTX slaydlar taqdimot tartibida, makrolar ishga tushirilmaydi. **XLSX/CSV** (`tabular.ts`): ≤ 5000 qator, ≤ 60 ustun; jadvallar `metadata.tables` ga. **Matn**: UTF-8 (BOM), UTF-16LE, windows-1251 zaxira dekodlash; joylangan matn 20 – 2 000 000 belgi.
- **URL** (`url-fetch.ts`, SSRF himoyasi): faqat `http/https`, port 80/443, URL ichida login/parol yoʻq, `localhost/.local/.internal` taqiqlangan; DNS natijasidagi **har bir** manzil global unicast boʻlishi shart (aralash javob rebinding deb rad etiladi); TCP ulanish tekshirilgan IPʼga mahkamlanadi; har bir redirect qayta tekshiriladi (≤ 3); hajm ≤ 8 MB, vaqt ≤ 15 s.
- **Chunking** (`chunker.ts`): sahifa/boʻlim ichida, gap chegarasida, ≤ 1200 belgi, 1 gap ustma-ust; har bir chunk aniq `locator` (sahifa, slayd, varaq yoki boʻlim+sarlavha+URL) oladi. Embedder boʻlsa 64 tadan toʻplamda vektor yoziladi.
- **Prompt injection aniqlash** (`injection.ts`): ingliz/oʻzbek/rus regex naqshlari; topilganlar `metadata.injectionFlags` ga (≤ 20) audit uchun yoziladi. Material har doim maʼlumot sifatida ishlatiladi — detektor hech narsani bloklamaydi.
- Yakun: `ready` / `partial` / `failed` va haqiqiy sahifa sonlari (`pages_ok`, `pages_low_conf`, `pages_failed`); botdan kelgan boʻlsa natija outbox orqali xabar qilinadi.

### 5.2 Qidiruv (`src/search/*`)

Soʻrov tokenlari (stop-soʻzlar, oʻzbek/rus qoʻshimchalarini yengil kesish, ≤ 16 token) → uchta roʻyxat, har biri top 50: (1) `to_tsvector('simple')` + prefiks `tsquery`, (2) `pg_trgm` `word_similarity` (`<%`), (3) `pgvector` kosinus masofa (faqat embedder sozlanganda). Natijalar **RRF** (`Σ 1/(60+rank)`) bilan birlashtiriladi, limit ≤ 50. Embedding xatosi leksik qidiruvga tushiradi. `describeLocator()` sahifasi yoʻq manbaga sahifa raqami toʻqimaydi.

### 5.3 Quiz Studio (`src/quiz/*`)

1. **Generatsiya** (`pipeline.ts`): usullar `from_source`, `from_questions`, `from_qa`, `from_mistakes`. AI yoqilgan boʻlsa `aiGenerateFromChunks` (≤ 60 chunk) yoki `aiAnswerAndDistract`; aks holda extractive generator (`extractive-gen.ts`: taʼrif→atama, boʻsh joyni toʻldirish, `includeTrueFalse` yoqilgan boʻlsa materialdagi taʼriflardan Toʻgʻri/Notoʻgʻri; distraktorlar materialning oʻz atamalaridan). AIʼga ham `includeTrueFalse` boʻlsa savollarning koʻpi bilan choragi `true_false` boʻlishi mumkinligi aytiladi. Yaratilgan variantlar saqlashdan oldin aralashtiriladi; foydalanuvchi yozgan variantlar va `true_false` (Toʻgʻri, Notoʻgʻri tartibi) oʻz tartibida qoladi.
2. **Dalil tekshiruvi**: model qaytargan iqtibos `locateQuote()` bilan chunk matnida qidiriladi — normallashtirilgan aniq moslik (`exact_quote`) yoki 1–3 gaplik oynada ≥ 90 % qamrov (`fuzzy_quote`). Topilmasa iqtibos tashlanadi va savol `unverified`. Foydalanuvchi javobi uchun `findEvidenceForAnswer()` (javob qamrovi ≥ 0,75, savol ≥ 0,25).
3. **Deterministik tekshiruvlar** (`validate.ts`): `clarity`, `source_support`, `single_correct`, `options_distinct`, `facts_numbers`, `explanation_locator`, `not_duplicate`, `translation`, `review_required` (extractive), `answer_length`.
4. **AI “koʻr” validatsiya** (`aiBlindValidate`): alohida chaqiruv savolni, aralashtirilgan variantlarni (faqat harflar) va dalil parchasini koʻradi, **javob kalitini koʻrmaydi**; 8 tadan toʻplam. Natija: `ai_blind_check`, `ai_single_correct`, `ai_clarity`.
5. **Koʻrib chiqish**: biror tekshiruv `pass` boʻlmasa → `needs_review`. Muharrir dalilni oʻzi tasdiqlashi (`confirm-evidence`), tasdiqlashi (`approve` — `fail` tekshiruvlar yoki tasdiqlanmagan dalil bilan bloklanadi) va nashr qilishi (`publish` — hamma savol `approved` va `sources_only` rejimida dalil `verified`) mumkin. Avtomatik nashr yoʻq.
6. **Versiyalar**: `quiz_versions` (`draft/published/archived`). Nashrdan keyingi tahrir `ensureDraft()` orqali **copy-on-write** yangi draft yaratadi (`stable_id` saqlanadi); avvalgi urinishlar oʻz versiyasiga ishora qilishda davom etadi. Tahrirdan keyin faqat deterministik tekshiruvlar qayta ishlaydi (AI validatsiya qayta chaqirilmaydi).
7. **Javob kalitlari** `private_answer_keys` jadvalida alohida; oddiy savol soʻrovlari ularni oʻqimaydi. Kalit faqat muharrir koʻrinishida, mashq javobidan keyin, xonada `reveal` bosqichida va native guruh quizida Telegramʼga (`sendPoll` talab qiladi) beriladi.

### 5.4 Presentation Studio (`src/slides/*`)

Material → reja → slaydlar → bitta layout modeli → preview/PPTX/PDF → tekshiruv.

- **Material** (`material.ts`): `chunksForScope` (≤ 3000 chunk, sahifa/boʻlim doirasi) + jadvallar.
- **Reja**: AI (`slide_plan`) yoki extractive (`extractive.ts`). `planOnly` → `plan_ready`, talaba rejani tahrirlab `generate` qiladi. Sarlavha, mundarija, savollar va manbalar slaydlarini server oʻzi qoʻshadi.
- **Yozish**: AI `slide_write` (8 slayddan toʻplamlarda — uzun deck bitta javobga sigʻmay qolmasligi uchun; himoya savollari birinchi toʻplamdan); har bir faktik bandda iqtibos chunkda topilishi shart, aks holda iqtibos olib tashlanadi. Chart/table slaydlari modelga yozdirilmaydi — jadval sonlaridan kod bilan quriladi.
- **Layout** (`layout.ts`, `measure.ts`): 13,333×7,5 dyuymli slaydda absolyut joylashtirilgan elementlar; matn haqiqiy shrift metrikasi bilan oʻlchanadi (`fontkit` + Liberation Sans/Serif, kenglik zaxirasi 5 %). Sigʻmasa matn kichraytirilmaydi, “(davomi)” slaydiga boʻlinadi.
- **Bitta model**: Mini App preview (`SlidePreview.tsx`), PPTX (`render-pptx.ts`, `pptxgenjs`: tahrirlanadigan matn, native jadval va chart) va PDF (LibreOfficeʼda **aynan shu PPTXʼdan**, jarayonga koʻpi bilan 2 ta parallel `soffice`, har biriga alohida profil, 120 s) bir xil `LaidOutSlide[]` dan chiziladi.
- **Tekshiruv** (`verify.ts`): PPTX — ochilishi, slaydlar soni, XML yaroqliligi, matn tahrirlanishi (rasm emas), native chart/jadval soni. PDF — ochilishi, sahifa soni, 16:9 oʻlcham, shriftlar joylangan va ruxsat etilgan oiladan, soʻzlar sahifa ichida va rejalashtirilgan quti ichida, sarlavhalar mavjud, `ʻ ʼ ў қ ғ ҳ` belgilari yoʻqolmagan. Biror tekshiruv oʻtmasa eksport `failed` va yuklab olish havolasi berilmaydi. Miniatyuralar (50 dpi) saqlanadi.
- **Tahrir**: slayd `revision` boʻyicha optimistik bloklash, 120 s lik qulf, `slide_versions` tarixi, undo yangi revision sifatida, bitta slaydni qayta yaratish boshqalariga tegmaydi. Mavzular: Academic Clean, Modern Data, Creative Seminar (kontrast testi: `layout.test.ts`).

### 5.5 Oʻqish vositalari (`src/study/*`)

- **Tutor** (`tutor.ts`): standart `sources_only`; `sources_plus_web` → `409 web_search_not_enabled` (veb-qidiruv amalga oshirilmagan). Topilgan parchalar savol bilan ≥ 0,34 qamrovga ega boʻlishi kerak; hech narsa topilmasa “topilmadi” qaytadi. AIʼsiz — eng mos gaplar iqtibos bilan; AI bilan — har bir daʼvo iqtibosi chunkda tekshiriladi, tekshirilmaganlar `verified:false`.
- **Konspekt** (`summary.ts`): har bir 1-darajali boʻlimdan eng maʼlumotli gaplar (extractive, oʻzi iqtibos); `?ai=1` da AI qisqartiradi va har bir band qayta tekshiriladi.
- **Statistika** (`stats.ts`): jadval katakchasidan aniq qiymat → `stat_facts` (qator/ustun bilan), `pct_change/diff/ratio` hisoblash, faktlardan quiz. Hech narsa xotiradan yoki taxminan yozilmaydi.
- **Kartochkalar** (SM-2), **xatolar daftari**, **imtihon rejasi**, **juftlash oʻyini** (kalit serverda, `game_sessions.private_key`).
- **Yozuv yordamchisi** (`writing.ts`, `POST /api/writing`): reja (AIʼsiz — tanlangan manbalar boʻlimlaridan skelet), annotatsiya (AIʼsiz — extractive), adabiyotlar roʻyxati (GOST/OʻzDSt yoki APA 7 — **faqat** hujjatga kiritilgan muallif/nashr/URL maʼlumotidan; yil yoki nashriyot toʻqilmaydi, yetishmagani `missing` roʻyxatida qaytadi va hujjat sahifasidagi “Manba maʼlumotlari” (`PATCH /api/documents/:id`) orqali toʻldiriladi), matnni ravonlashtirish (AI; «…» ichidagi iqtiboslar oʻzgargan boʻlsa ogohlantiradi) va baholash mezoniga solishtirish (AI; matnda yoʻq parcha dalil sifatida qaytmaydi, baho qoʻyilmaydi). Ishni talaba oʻrniga yozmaydi va “100% original” kabi vaʼda bermaydi.
- **Eslatmalar** (`src/notify/reminders.ts`, workerʼda har 5 daqiqa): faqat bot chatini ochgan, bloklamagan va bildirishnomalarni oʻchirmagan foydalanuvchilarga — kuniga bitta oʻqish dayjesti (mahalliy vaqt 09:00–21:00, “sokin soatlar”dan tashqari) va guruh vazifasi muddatiga 24 soatdan kam qolganda ijrochiga eslatma (sokin soatlarda yuborish soat tugaguncha kechiktiriladi). Har bir xabar `dedupe_key` bilan bir marta.

### 5.6 Jonli xonalar (`src/rooms/*`)

- **Holat manbai** — PostgreSQL `rooms` qatori. Har bir oʻtish bitta **shartli `UPDATE`** (`status`/`phase` sharti, `state_version + 1`), shuning uchun parallel bosishlar yoki bir nechta instansiya ikki marta oʻtkaza olmaydi.
- **Server soati**: `question_started_at` va `deadline_at` — `clock_timestamp()`. Javob faqat `clock_timestamp() <= deadline_at` boʻlsa qabul qilinadi; kechikish va ball serverda hisoblanadi (100 + ixtiyoriy tezlik bonusi ≤ 50). Har bir holat xabarida `serverNow` bor, mijoz soat farqini hisoblaydi (`lib/room.ts`).
- **Takror javob**: `unique (room_id, question_id, user_id)`; ack faqat commitʼdan keyin.
- **Har bir foydalanuvchiga oʻz variant tartibi**: `HMAC_SHA256(SIGNING_SECRET, room:user:question:option)` boʻyicha saralash — qayta ulanishda barqaror, ishtirokchilar orasida har xil (`true_false` savollari bundan mustasno — Toʻgʻri/Notoʻgʻri tartibi saqlanadi). `RoomSettings.shuffleOptions=false` boʻlsa hamma uchun asl tartib.
- **Fan-out**: har bir oʻzgarish `NOTIFY rooms 'state:<id>'` yoki `'answers:<id>'`; har bir API instansiyasi `LISTEN` qiladi va faqat oʻz soketlariga har bir tomoshabin uchun alohida proyeksiya (`viewFor`) yuboradi. Javob hisobchisi xona boʻyicha 500 ms da bir marta yangilanadi.
- **Proyeksiya**: ishtirokchi `reveal` dan oldin kalitni va boshqalarning tanlovini olmaydi; kod faqat hostga; reyting hostga, tugagach `showLeaderboard` boʻlsa hammaga.
- **Muddat tugashi**: har bir API instansiyasi har 250 ms da `deadline_at` oʻtgan savollarni `reveal` ga oʻtkazadi; `autoAdvance` yoqilgan boʻlsa 6 s dan keyin keyingi savol.
- **Co-host**: host bitta ishtirokchini co-host qilib tayinlay oladi (`POST /api/rooms/:id/cohost`, `setCoHost`); co-host host boshqaruvlarini oladi.
- **Host ketib qolsa**: host soketi yopilgach `hostGraceSec` (standart 20 s) dan keyin, host ham, co-host ham ulanmagan boʻlsa xona `paused`, qolgan vaqt saqlanadi; davom ettirishda kamida 3 s beriladi.
- **Jamoalar** (Quiz Battle): 2–4 jamoa, yangi ishtirokchi eng kichik jamoaga; jamoa bali — aʼzolar ballarining **oʻrtachasi**.
- **Topshiriq — mustaqil vaqtda** (`settings.mode = "async"`, `src/rooms/assignment.ts`): oʻqituvchi muddat tanlaydi (24 soat / 3 kun / 7 kun); taklif havolasi muddat bilan birga tugaydi. Har bir talaba oʻz vaqtida **bir marta** yechadi (`attempts_one_per_assignment` unique indeksi; qayta “boshlash” oʻsha urinishni qaytaradi). Javob serverda mashq dvigateli bilan baholanadi, lekin muddat tugaguncha talabaga toʻgʻri/notoʻgʻri, ball va izoh **qaytarilmaydi** (`hidden: true`). Muddat oʻtgach (worker, har 60 s) yoki oʻqituvchi “Hozir yakunlash” bosganda xona yopiladi, ochiq urinishlar yakunlanadi, natija va reyting ochiladi. Oʻqituvchi kim boshlagan/topshirganini koʻradi. Muddatdan keyin javob — `409 assignment_closed`.

### 5.7 Telegram guruhidagi native quiz (`src/group/native-quiz.ts`)

Faqat nashr qilingan, turi `single` (True/False savollari ham kirmaydi), bitta toʻgʻri javobli va `nativePollOk` (Telegram poll limitlariga sigʻadigan) savollar ishlatiladi, qolganlari “faqat Mini App” deb hisoblanadi. Host `startgroup` havolasi (`g<token>`, 30 daqiqa) bilan guruhni tanlaydi; bot guruhda faqat hostdan kelgan `/start g<token>` ga javob beradi; boshlash tugmasini faqat host bosa oladi. Worker har soniyada `FOR UPDATE SKIP LOCKED` bilan muddati kelgan runʼlarni oladi va `sendPoll` (`type: quiz`) yuboradi: bitta toʻgʻri javobli savolda `correct_option_id` va `correct_option_ids` ikkalasi ham beriladi; “3/10.” raqami savol bilan 300 belgiga sigʻmasa raqam tashlab yuboriladi, savol kesilmaydi. Keyingi poll `open_period + 3` s dan keyin. Anonim runʼlarda shaxsiy natija yoʻq, faqat `poll` yangilanishidagi umumiy sonlar.

## 6. AI sozlamalari (`src/ai/client.ts`)

AI faqat `AI_PROVIDER=anthropic` **va** `ANTHROPIC_API_KEY` boʻlganda yoqiladi; aks holda barcha oqimlar extractive rejimda ishlaydi va Mini App “AI sozlanmagan” xabarini koʻrsatadi. `AI_BASE_URL` ixtiyoriy (Anthropic-mos shlyuz).

| Task | Tier | Effort | Qayerda |
|---|---|---|---|
| `quiz_generate` | strong | medium | `quiz/ai-gen.ts` |
| `quiz_from_questions` | strong | medium | `quiz/ai-gen.ts` |
| `quiz_validate` | strong | low | `quiz/ai-gen.ts` (koʻr validatsiya) |
| `slide_plan` | strong | medium | `slides/ai-gen.ts` |
| `slide_write`, `slide_regenerate` | fast | low | `slides/ai-gen.ts` |
| `tutor` | fast | low | `study/tutor.ts`, `study/summary.ts` |
| `writing` | fast | low / medium | `study/writing.ts` (yozuv yordamchisi, `POST /api/writing`) |

- **Tierlar**: `AI_MODEL_STRONG` (standart `claude-opus-5-5`), `AI_MODEL_FAST` (standart `claude-haiku-5-5`).
- **Task boʻyicha override** (`model_configs`): model, effort, `max_tokens`, `enabled`. 30 s kesh. `enabled=false` → `AiError("disabled")` (kill switch). Har bir oʻzgarish oldingi qiymatni `previous` ga saqlaydi; `rollback` uni tiklaydi yoki overrideʼni oʻchirib standartga qaytaradi; audit yoziladi.
- **Strukturali chiqish**: `client.beta.messages.parse()` + `betaZodOutputFormat(zodSchema)` + `output_config.effort`; standart `max_tokens` 16000. `stop_reason=refusal` → qayta urinilmaydi; `max_tokens` → `truncated` (retryable); parse boʻlmasa → `invalid_output` (retryable).
- **Server tomonidagi fallback**: model nomi `^claude-(opus|sonnet|fable)` ga mos va `AI_BASE_URL` yoʻq boʻlsa `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"` yuboriladi.
- **Xato xaritasi**: `RateLimitError` → `rate_limited` (retryable), `APIConnectionTimeoutError` → `timeout` (retryable), 401/403 → `not_configured`, 400 → `provider_error`, ≥ 500 → retryable `provider_error`. Job ichida bular `JobError("ai_<code>", retryable)` ga aylanadi; tutorʼda HTTP 503/502.
- **Vaqt va qayta urinish**: `AI_TIMEOUT_MS` (120 000), `AI_MAX_RETRIES` (2, 0–5) — SDK darajasida; ustiga job darajasidagi qayta urinish (§ 4.4). Foydalanuvchi kutib turgan interaktiv soʻrovlar (tutor, konspekt, yozuv yordamchisi) `AI_INTERACTIVE_TIMEOUT_MS` (45 000) va bitta qayta urinish bilan cheklanadi.
- **Hisob**: har bir chaqiruv (muvaffaqiyatli yoki yoʻq) `usage_events` ga: provider, model, task, kirish/chiqish tokenlari, `cost_usd`, latency, `ok`. Narx jadvali (`PRICES`) faqat `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` uchun; boshqa model uchun `cost_usd = null`.
- **`UNTRUSTED_DATA_RULES`**: material `<source>` teglarida beriladi va “ishonchsiz maʼlumot, koʻrsatma emas” deb belgilanadi; sahifa, iqtibos, statistika, muallif toʻqish taqiqlanadi. Material ichidagi `<source>`/`<table>` teglari olib tashlanadi.

**Provayderga nima yuboriladi:** system prompt; tanlangan manbalardan chunk matnlari (hujjat nomi va joylashuv tavsifi bilan); slaydlar uchun jadval qatorlari (har jadvaldan ≤ 30); talabaning savoli/javobi, quiz savollar roʻyxati, slayd yoʻriqnomasi, yozuv yordamchisiga berilgan matn va rubrika; deck sozlamalari (sarlavha, mavzu, auditoriya, davomiylik, fan, talablar); til. Koʻr validatsiyada savol, aralashtirilgan variantlar va dalil parchasi.

**Yuborilmaydi:** foydalanuvchi ID, Telegram ID, ism, username, workspace/job ID (`meta` faqat `usage_events` ga yoziladi), sessiya tokenlari, asl fayllar (faqat ajratilgan matn), koʻr validatsiyada javob kaliti, boshqa foydalanuvchilarning materiallari (qidiruv aʼzolik bilan filtrlangan). Alohida: `EMBEDDINGS_PROVIDER=voyage` boʻlsa chunk matnlari (indekslashda) va qidiruv soʻrovi Voyage AIʼga yuboriladi — bu `AI_PROVIDER` ga bogʻliq emas.

## 7. Maʼlumotlar modeli (`apps/server/src/db/migrations/*.sql`)

Migratsiyalar: `001_core`, `002_group_polls`, `003_slides`, `004_study`, `005_ops`, `006_payment_payer`, `007_reliability` (`processed_updates.done/claimed_at`, `sessions.init_auth_date`, `rooms.assignment_due_at`, topshiriqda bitta urinish indeksi, takroriy indekslarni olib tashlash); `schema_migrations` jadvali, advisory lock.

| Domen | Jadvallar |
|---|---|
| Hisoblar | `users` (Telegram ID, til, platforma roli, `deleted_at`), `profiles` (oʻqish joyi, bildirishnoma sozlamalari), `sessions` (token xeshi), `user_activity` (kunlik faollik) |
| Kirish | `workspaces`, `memberships` (rol), `invitations` (token xeshi, muddat, `max_uses`) |
| Manbalar | `documents`, `document_versions` (fayl, holat, sahifa sonlari), `pages` (matn, usul, OCR ishonchliligi), `sections`, `chunks` (`tsvector`, trigram, `vector(1024)` HNSW), `source_references` (dalil snapshotʼi) |
| Ish | `generation_jobs`, `job_events`, `artifacts`, `artifact_versions` (fayl xeshi, tekshiruvlar), `projects` (kodda ishlatilmaydi) |
| Quiz | `quizzes`, `quiz_versions`, `questions`, `options`, `private_answer_keys`, `question_checks`, `question_reports`, `attempts`, `attempt_answers` |
| Xonalar | `rooms`, `teams`, `room_members`, `room_answers`, `scores`, `room_events` |
| Guruh quizi | `group_quiz_runs`, `telegram_polls`, `poll_answers` |
| Slaydlar | `decks`, `slides`, `slide_versions`, `exports` |
| Oʻqish | `flashcards`, `review_events`, `study_plans`, `tasks`, `comments`, `stat_facts`, `game_sessions`, `workspace_events` |
| Operatsiyalar | `notifications` (outbox), `processed_updates`, `bot_states`, `usage_events`, `plans`, `payments` (`payer_telegram_id` — hisob oʻchirilgandan keyin ham qaytarish uchun), `credit_ledger`, `entitlements`, `audit_events`, `support_tickets`, `feature_flags`, `model_configs`, `data_requests` |

Muhim tamoyillar:
- **`private_answer_keys`** savol/variantlardan ajratilgan, tasodifan mijozga seriyalashtirilmasligi uchun.
- **`source_references`** — iqtibos, joylashuv va hujjat nomi yaratilgan paytda nusxalanadi; hujjat oʻchirilsa yoki yangi versiya chiqsa quiz dalili oʻzgarmaydi (`document_id`, `chunk_id` → `on delete set null`).
- **Versiyalash**: quiz — copy-on-write versiyalar; slaydlar — `slide_versions` (`change_kind`, `restored_from`); hujjat — `document_versions`; eksport — `artifact_versions` (`source_revision`).
- **`audit_events`**: admin harakatlari (oldin/keyin), hujjat oʻchirish, toʻlov qaytarish, hisob oʻchirish.
- **Oʻchirish jurnali**: hisob oʻchirilgach `DELETION_LOG_PATH` (zaxira katalogidan tashqarida) ga JSON qator qoʻshiladi; eski zaxiradan tiklangach `ops:reapply-deletions` uni qayta qoʻllaydi.
- Sxemada boʻlgan, lekin kodda ishlatilmaydigan qiymatlar: savol turlari `matching`, `ordering`, `fill_blank`, `short_answer` (generatsiya faqat `single/multiple/true_false`); `quizzes.visibility` ning `workspace/link/public_template` qiymatlari (kirish faqat workspace aʼzoligi bilan); `private_answer_keys.accepted_answers` faqat nusxalanadi.

## 8. Arxitektura qarorlari (ADR)

**ADR-1. Monorepo, hamma joyda TypeScript.** *Kontekst:* server, Mini App va bot bir xil sxema, xato kodlari va tarjimalardan foydalanadi. *Qaror:* pnpm workspace; `@talaba/shared` da zod sxemalari, i18n va limitlar. *Oqibat:* API shakli bitta joyda; server buildʼi (`build.mjs`) shared paketni bundle qiladi. Narx: barcha qismlar bir xil Node/TS versiyasiga bogʻlangan.

**ADR-2. Navbat va fan-out uchun PostgreSQL (Redis yoʻq).** *Kontekst:* job yaratish, kredit rezervi va natijani yozish atomik boʻlishi kerak; pilot hajmi kichik. *Qaror:* `generation_jobs` + `FOR UPDATE SKIP LOCKED` + lease/heartbeat/checkpoint; `LISTEN/NOTIFY` (`jobs`, `rooms`); outbox — `notifications` jadvali. *Oqibat:* job va kredit bitta tranzaksiyada; bitta maʼlumotlar ombori zaxiralanadi. Narx: Postgres asosiy tor joy; `NOTIFY` yuklamasi va worker pollingʼi (1 s) bazaga tushadi.

**ADR-3. Fayllar uchun `LocalStorage` + imzolangan havolalar.** *Qaror:* yopiq katalog (`0700`/`0600`), kalitlar faqat serverda, yuklab olish HMAC imzoli qisqa muddatli havola orqali. *Oqibat:* API va worker bitta disk koʻradi. *S3-mos omborga oʻtish uchun:* `LocalStorage` interfeysini (`put/get/stream/size/exists/delete/sign/verify/pathFor`) yopiq bucket bilan amalga oshirish; `pathFor()` (lokal yoʻl) ishlatiladigan joylarni vaqtinchalik faylga yuklab olishga oʻzgartirish; imzolashni bucketʼning presigned URLʼi bilan almashtirish yoki `/files` orqali proksilash; `ops/backup.sh` dagi `tar` ni bucket zaxirasi bilan almashtirish. Bu **amalga oshirilmagan**.

**ADR-4. Anthropic Claude, rasmiy SDK orqali.** *Qaror:* `@anthropic-ai/sdk` (`beta.messages.parse` + zod), strong/fast tierlar, task boʻyicha override, kill switch, `usage_events`. *Oqibat:* chiqish sxema bilan tekshiriladi; model almashtirish deploysiz. Narx: provayderga bogʻliqlik; narx jadvali qoʻlda yangilanadi.

**ADR-5. Embeddings ixtiyoriy (Voyage).** *Kontekst:* Anthropic embeddings API taklif qilmaydi. *Qaror:* `EMBEDDINGS_PROVIDER=voyage` boʻlsa 1024 oʻlchamli vektor; boʻlmasa FTS + trigram. *Oqibat:* tizim embeddingsiz ishlaydi; semantik qidiruv sifati sozlamaga bogʻliq. Sifat farqi oʻlchanmagan.

**ADR-6. AIʼsiz extractive zaxira rejim.** *Qaror:* quiz, slayd, tutor, konspekt AIʼsiz ham ishlaydi — faqat manbadagi gaplardan. Extractive savollar har doim `review_required` ogohlantirishini oladi. *Oqibat:* AI kaliti yoki provayder ishlamasa ham mahsulot ishlaydi; sifat pastroq.

**ADR-7. PDF va tekshiruv uchun LibreOffice + poppler.** *Qaror:* PDF yuklab olinadigan PPTXʼdan headless LibreOffice bilan olinadi; `pdfinfo/pdffonts/pdftotext/pdftoppm` bilan tekshiriladi. *Oqibat:* ikkala format bir xil matnga ega; tekshiruvdan oʻtmagan fayl berilmaydi. Narx: CPU/RAM (kod izohiga koʻra har bir `soffice` ~200 MB), jarayonga 2 ta slot.

**ADR-8. “eve” runtime qabul qilinmadi.** *Kontekst:* master promptʼning 16-boʻlimida “eve” runtime varianti tilga olingan. *Holat:* repozitoriyda eveʼga oid bogʻliqlik, kod yoki sinov yoʻq — u oʻrnatilmagan va **sinab koʻrilmagan**. *Qaror:* uzoq ishlar loyihaning oʻz Postgres navbatida (lease, heartbeat, checkpoint, `reapExhausted`, idempotentlik kalitlari) bajariladi. *Asos (kod asosida, oʻlchov emas):* job yaratish, kredit rezervi va natija yozish bitta Postgres tranzaksiyasida; tashqi runtime qoʻshilsa bu atomiklik ikki tizimga boʻlinardi va qoʻshimcha infratuzilma kerak boʻlardi. Qayta urinish/davom ettirish xatti-harakati testlar bilan qoplangan (`test/resilience.test.ts`, `test/helpers/crash-worker.ts`). *Qayta koʻrib chiqish sharti:* agar navbat Postgresʼning tor joyiga aylansa yoki koʻp bosqichli uzoq workflowʼlar kerak boʻlsa.

## 9. Masshtablash rejasi

**Gorizontal kengayadi:**
- **API** — holatsiz (sessiya, job, xona holati Postgresʼda). Istisno: xona WebSocketʼlari. Har bir instansiya `LISTEN rooms` qiladi va oʻz soketlariga yuboradi, shuning uchun sticky sessiya shart emas. Lekin har bir instansiya 250 ms lik `sweep` soʻrovini bajaradi; host-away taymeri instansiya xotirasida (instansiya qayta ishga tushsa yoʻqoladi).
- **Worker** — `SKIP LOCKED` tufayli bir nechta worker xavfsiz. Outbox token-bucketʼlari jarayon xotirasida, shuning uchun bir vaqtda faqat bitta jarayon yuboradi: har bir `tick` `pg_try_advisory_xact_lock` oladi, olmagan jarayon kutadi. Yuborish oʻrtasida oʻlgan jarayonning `sending` qatorlari 2 daqiqadan keyin qayta navbatga qaytadi (kamida bir marta yetkazish; `test/outbox.test.ts`).

**Tor joylar:**
- **PostgreSQL** — navbat, NOTIFY, qidiruv (GIN, HNSW), xona holati. Pool: `DATABASE_POOL_MAX` jarayonga.
- **LibreOffice CPU/RAM** — PDF eksport; jarayonga 2 ta parallel konvertatsiya.
- **OCR CPU** — Tesseract (`OMP_THREAD_LIMIT=1`), sahifaga 200 dpi render; `WORKER_CONCURRENCY` bilan cheklanadi.
- **AI provayder** — rate limit va latency; SDK + job darajasidagi qayta urinish.

**Yuk testi** (`docs/evidence/load-room.json`, `scripts/load-room.ts`): bitta dev konteynerda (4 CPU, Intel Xeon 2,10 GHz, 17 GB RAM, Node v22.22.0, PostgreSQL 16.15 lokal, loopback tarmoq, bitta Node jarayoni (tsx), `fsync=on`), 100 ishtirokchi, 3 savol:

| Koʻrsatkich | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Xonaga qoʻshilish (HTTP), ms | 100 | 246 | 262 | 270 | 271 |
| Savol fan-out, ms | 300 | 31 | 165 | 166 | 166 |
| Javob ack, ms | 300 | 4 | 8 | 11 | 16 |
| `GET /api/me`, ms | 1000 | 59 | 116 | 132 | 146 |
| Xona holati (REST), ms | 250 | 94 | 122 | 137 | 145 |

Hamma WS ulanishi: 492 ms; rad etilgan javob: 0; yaxlitlik: 300 javob, 0 dublikat, 0 notoʻgʻri ball; reyting hajmi 100. Fayldagi maqsad: “pilot target p95 < 1000 ms for API and answer confirmation (not a guarantee)”. **Bu raqamlar bitta dev konteynerda oʻlchangan va kafolat emas**: haqiqiy tarmoq, TLS, bir nechta instansiya va production Postgresʼda qayta oʻlchash kerak.

## 10. Tekshirilmagan yoki amalga oshirilmagan

- Haqiqiy Telegram mijozida, haqiqiy Bot API va haqiqiy Stars toʻlovi bilan sinov — repozitoriyda dalil yoʻq (testlar soxta Telegram serveri va WebApp mock bilan ishlaydi).
- Veb-qidiruv (`sources_plus_web`) — amalga oshirilmagan.
- S3-mos ombor, konteyner/orkestratsiya fayllari — yoʻq.
- Saqlash muddatlari (`src/ops/retention.ts`, har soat): maʼlumot eksporti arxivlari — 7 kun; `processed_updates` — 7 kun; yuborilgan/muvaffaqiyatsiz bot xabarlari — 30 kun; tugagan joblarning `job_events` — 90 kun; deckning eng oxirgisi boʻlmagan 30 kundan eski eksportlari (fayl, miniatyura, qator). `usage_events` va `audit_events` uchun muddat belgilanmagan (hisob va audit uchun saqlanadi).
- Embeddings bilan va embeddingsiz qidiruv sifatini taqqoslash oʻlchanmagan.
