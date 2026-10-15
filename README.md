# TALABA AI

**Materialni yuklang — tushuning, tayyorlang va birga oʻrganing.**

Talabalar uchun Telegram bot va Telegram Mini App. Talaba kitob, maʼruza, savollar roʻyxati yoki jadval yuboradi.
Tizim undan quyidagilarni tayyorlaydi:
- manbasi koʻrsatilgan quiz;
- tahrirlanadigan PPTX/PDF prezentatsiya;
- konspekt va kartochkalar;
- imtihon rejasi.

Quizni guruh bilan Telegram native quizida, Mini App jonli xonasida yoki muddatli topshiriq sifatida yechish mumkin.

> Holat va har bir talab boʻyicha dalil: [docs/acceptance-report.md](docs/acceptance-report.md) · [docs/requirements-map.md](docs/requirements-map.md)

## Imkoniyatlar

- **Kutubxona:** PDF, DOCX, PPTX, TXT, CSV/XLSX, JPG/PNG, veb-havola.
  - Skan sahifalar OCR qilinadi (oʻzbek lotin/kirill, rus, ingliz); oʻqilmagan sahifalar ochiq koʻrsatiladi.
  - Qidiruv faqat foydalanuvchi koʻrishga haqli materiallar ichida.
- **Quiz Studio:** kitobdan, savollar roʻyxatidan, savol-javoblardan, jadvaldan yoki xatolardan quiz yaratiladi.
  - Har bir javob manbadagi parcha bilan tasdiqlanadi; 8 ta tekshiruv qoidasi ishlaydi.
  - Nashrdan oldin preview va tahrir bor; versiyalar saqlanadi.
  - Javob kalitlari faqat serverda.
- **Quizni ishlatish:**
  - botning oʻzida mashq;
  - Telegram guruhida native quiz;
  - Mini App jonli xonasi: yakka yoki jamoaviy, co-host bilan;
  - mustaqil vaqtda topshiriq: muddat bor, natija muddatdan keyin ochiladi.
- **Presentation Studio:** reja → slaydlar → tahrir → bitta slaydni qayta yaratish → tahrirlanadigan PPTX va undan olingan PDF.
  - 3 ta uslub; grafiklar haqiqiy jadval qiymatlaridan chiziladi.
  - Eksportdan oldin fayl avtomatik tekshiriladi.
- **Oʻqish:**
  - manbali tutor: soddaroq, misol, ishora, “meni tekshir”;
  - konspekt, statistik faktlar;
  - kartochkalar (interval takrorlash), xatolar daftari, imtihon rejasi;
  - eslatmalar (sokin soatlar bilan);
  - yozma ishlar yordamchisi.
- **Guruh loyihalari:** rollar (owner/editor/viewer), taklif havolalari, vazifalar, izohlar, faoliyat tarixi.
- **Tijoriy va operatsion qism:** Telegram Stars, kredit ledgeri (reserve/capture/release), refund, admin paneli, Prometheus `/metrics`, maʼlumot eksporti va hisobni oʻchirish, backup/restore.

AI kaliti boʻlmasa tizim **AIʼsiz (extractive) rejimda** ishlaydi va buni foydalanuvchiga ochiq aytadi; AI javobini soxtalashtirmaydi.

## Tuzilma

```
apps/server     Fastify API, Telegram bot, worker (jobs, outbox), PostgreSQL migratsiyalari, testlar
apps/miniapp    React 19 + Vite Mini App (HashRouter, /app/)
packages/shared zod sxemalari, i18n (uz, uz-Cyrl, ru, en), limitlar
e2e             Playwright ssenariylari (Telegram WebApp mock bilan)
ops             systemd xizmatlari, Caddyfile, backup.sh / restore.sh
docs            hujjatlar va dalillar (docs/evidence)
```

## Lokal ishga tushirish

Talablar: Node 22, pnpm 10, PostgreSQL 16 (`vector` va `pg_trgm` kengaytmalari bilan), tesseract, poppler-utils, LibreOffice, Liberation shriftlari.
Toʻliq roʻyxat: [docs/deploy.md](docs/deploy.md).

```bash
pnpm install
createdb talaba && psql talaba -c 'create extension if not exists vector; create extension if not exists pg_trgm;'

# API + worker bitta jarayonda; Mini App dev serveri /api ni 8080 ga proksilaydi
NODE_ENV=development DEV_AUTH_ENABLED=true DATABASE_URL=postgres://postgres@localhost:5432/talaba \
  npx tsx apps/server/src/all-in-one.ts
pnpm dev:miniapp        # http://localhost:5173/app/ — Telegram tashqarisida "dev" kirish tugmasi chiqadi
```

`DEV_AUTH_ENABLED` faqat lokal ish uchun; productionda server uni rad etadi.
Haqiqiy Telegram bilan ishlash uchun HTTPS domen va bot kerak: [docs/setup-telegram.md](docs/setup-telegram.md).

## Testlar

```bash
pnpm typecheck
pnpm --filter @talaba/server test      # PostgreSQL kerak (TEST_DATABASE_ADMIN_URL, standart postgres://postgres@localhost:5432/postgres)
pnpm --filter @talaba/shared test
pnpm --filter @talaba/miniapp test
pnpm build && (cd e2e && npx playwright test)   # toza "talaba_e2e" bazasini oʻzi yaratadi
```

## Production

- Build: `pnpm build` → `apps/server/dist/*.js` (esbuild) va `apps/miniapp/dist`.
- Oʻrnatish, systemd, Caddy (HTTPS), backup va restore: [docs/deploy.md](docs/deploy.md).
- Operator yoʻriqnomasi va monitoring: [docs/operations.md](docs/operations.md).
- Barcha sozlamalar: [.env.example](.env.example). Sirlar faqat server muhitida saqlanadi.

## Ishga tushirishdan oldin kerak boʻladigan tashqi sozlamalar

| Sozlama | Busiz nima boʻladi |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` + BotFather (Main Mini App) | Bot va Mini App Telegramda ochilmaydi |
| HTTPS `PUBLIC_BASE_URL` | Telegram webhook va Mini App ishlamaydi |
| `SIGNING_SECRET` (≥ 32 belgi) | Production server ishga tushmaydi |
| `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | AIʼsiz (extractive) rejim |
| `EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY` (ixtiyoriy) | Faqat leksik + trigram qidiruv |
| `PAYMENTS_ENABLED=true` + Stars narxlari | Toʻlov oʻchiq, bepul tarif ishlaydi |
| `ADMIN_TELEGRAM_IDS` | Admin paneli hech kimga ochilmaydi |

## Hujjatlar

| Hujjat | Mazmuni |
|---|---|
| [architecture.md](docs/architecture.md) | Jarayonlar, autentifikatsiya, ruxsatlar, joblar, AI oqimlari, maʼlumotlar modeli, ADR, masshtablash |
| [api-and-limits.md](docs/api-and-limits.md) | Telegram va AI cheklovlari, paket versiyalari |
| [design-system.md](docs/design-system.md) | Rang tokenlari, komponentlar, holatlar, ekranlar |
| [setup-telegram.md](docs/setup-telegram.md) | BotFather, webhook, Main Mini App, buyruqlar, guruh |
| [deploy.md](docs/deploy.md) · [operations.md](docs/operations.md) | Oʻrnatish, backup/restore, monitoring, admin |
| [cost-model.md](docs/cost-model.md) | Boshlangʻich xarajat modeli va taxminlar |
| [brand.md](docs/brand.md) · [demo-scenarios.md](docs/demo-scenarios.md) | Brend va 3 ta namoyish ssenariysi |
| [requirements-map.md](docs/requirements-map.md) · [acceptance-report.md](docs/acceptance-report.md) | Talablar xaritasi va qabul hisoboti |
