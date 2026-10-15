# TALABA AI — UI dizayn tizimi

Hujjat sanasi: **2026-10-15**. Manbalar: `apps/miniapp/src/styles/app.css` (tokenlar va CSS komponentlar), `apps/miniapp/src/lib/telegram.ts` (Telegram integratsiyasi), `apps/miniapp/src/lib/contrast.ts` + `contrast.test.ts` (kontrast), `apps/miniapp/src/components/ui.tsx` (React komponentlar), `apps/miniapp/src/App.tsx`, `screens/decks/DeckRoutes.tsx`, `screens/admin/Admin.tsx` (marshrutlar).

## 1. Tamoyillar (kodda qanday amalga oshirilgan)

- **Mobile-first, Telegram ichida.** Asosiy kenglik telefon; `.main` maksimal kengligi 760 px, ≥ 1024 px da 960 px. `responsive.spec.ts` 21 ta asosiy marshrutni 320, 360, 390, 430, 1024, 1440 px kengliklarda, yorugʻ va qorongʻi mavzuda gorizontal aylantirish yoʻqligiga tekshiradi.
- **Bosish nishoni ≥ 44 px** (`--tap`): tugmalar, roʻyxat elementlari (≥ 56 px), toggle qatori, orqaga tugmasi.
- **Halol holatlar**: yuklanish skeleti, boʻsh holat, xato + qayta urinish, offline banner, haqiqiy job bosqichlari (oʻylab topilgan foiz yoʻq), ishga tushirishdan oldin kredit narxi.
- **Xato matni foydalanuvchiga faqat i18n orqali**: server barqaror `code` qaytaradi, mijoz uni `errorMessage()` (`lib/errors.ts`) bilan tarjima qiladi; stack trace yoki model nomi koʻrsatilmaydi.
- **Kirish imkoniyati**: `:focus-visible` (3 px kontur), `prefers-reduced-motion` da animatsiyalar oʻchadi, `.sr-only`, `aria-live`/`role` atributlari komponentlarda.
- **Til**: `uz` (lotin), `uz-Cyrl`, `ru`, `en` (`@talaba/shared/i18n`); `uz-Cyrl` lotindan transliteratsiya + qoʻlda tuzatishlar bilan olinadi.

## 2. Rang tokenlari

`:root` — yorugʻ mavzu, `:root[data-theme="dark"]` — qorongʻi mavzu.

| Token | Yorugʻ | Qorongʻi | Vazifasi |
|---|---|---|---|
| `--c-primary` | `#4f46e5` | `#818cf8` | Asosiy aksent: primary tugma, havola, faol navigatsiya, progress |
| `--c-primary-press` | `#4338ca` | `#a5b4fc` | Primary tugma hover/bosilgan |
| `--c-primary-soft` | `#eef2ff` | `#1e1b4b` | Yumshoq aksent foni: tanlangan variant, chip, badge, avatar |
| `--c-on-primary` | `#ffffff` | `#0b1120` | Primary fondagi matn (tugma, “mening” chat pufagi) |
| `--c-text` | `#0f172a` | `#f1f5f9` | Asosiy matn |
| `--c-text-2` | `#475569` | `#cbd5e1` | Ikkilamchi matn (`.muted`, yorliqlar) |
| `--c-text-3` | `#5b6577` | `#a3b0c2` | Uchinchi darajali matn (`.caption`, `.hint`, meta) |
| `--c-bg` | `#f8fafc` | `#0b1120` | Sahifa foni (Telegram header/background rangi ham shu) |
| `--c-surface` | `#ffffff` | `#111827` | Karta, roʻyxat, input, pastki navigatsiya |
| `--c-surface-2` | `#f1f5f9` | `#1f2937` | Ichki fon: segmented, skeleton, kod qutisi |
| `--c-border` | `#e2e8f0` | `#334155` | Chegaralar, ajratgichlar |
| `--c-success` | `#047857` | `#34d399` | Muvaffaqiyat matni, toʻgʻri javob chegarasi |
| `--c-success-accent` | `#10b981` | `#10b981` | Dalil (`.evidence`) chap chizigʻi |
| `--c-success-bg` | `#ecfdf5` | `#052e22` | Muvaffaqiyat foni |
| `--c-on-success` | `#ffffff` | `#022c22` | `--c-success` fonidagi belgi/matn (qadam nuqtasi, toʻgʻri javob belgisi); ikkala mavzuda ≥ 4,5:1 (`contrast.test.ts`) |
| `--c-warn` | `#a16207` | `#fbbf24` | Ogohlantirish matni |
| `--c-warn-bg` | `#fefce8` | `#2a2109` | Ogohlantirish foni, offline banner, past OCR sahifasi |
| `--c-danger` | `#b91c1c` | `#f87171` | Xato matni, xavfli tugma |
| `--c-danger-bg` | `#fef2f2` | `#2d0f12` | Xato foni |
| `--c-info-bg` | `#eff6ff` | `#0f1d33` | Maʼlumot banneri foni |
| `--c-overlay` | `rgba(15,23,42,.45)` | `rgba(0,0,0,.6)` | Sheet/dialog orqa fon |
| `--shadow-1` | ikki qatlamli yengil soya | `0 1px 2px rgba(0,0,0,.4)` | Karta, segmented tanlovi |
| `--shadow-2` | `0 8px 24px rgba(15,23,42,.12)` | `0 8px 24px rgba(0,0,0,.5)` | Sheet, toast |

Komponentlarga qattiq yozilgan ranglar: `.switch` tutqichi `#fff`; `.step.done .dot` va `.opt-line.is-correct .tick` matni `#fff`; slayd koʻrish rejimi (`screens/decks/decks.css`) `#020617`, `#1e293b`, `#f8fafc`; jamoa ranglari `#4F46E5`, `#0E7490`, `#B45309`, `#BE185D` (serverda, `rooms/service.ts`).

## 3. Tipografiya

Shrift: tizim shrifti — `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif` (`--font`). Tashqi web-font yuklanmaydi. Monospace: `ui-monospace, SFMono-Regular, Menlo, monospace` (`.mono`, `.code-box`).

| Token | Oʻlcham | Ishlatilishi |
|---|---|---|
| `--fs-caption` | 13 px | `.caption`, `.hint`, meta, xato matni |
| `--fs-small` | 14 px | banner, segmented, `.small`, forma yorligʻi |
| `--fs-body` | 16 px | asosiy matn, input, select, textarea |
| `--fs-h3` | 17 px | `h3` (600) |
| `--fs-h2` | 20 px | `h2` (700) |
| `--fs-h1` | 26 px | `h1` (700); ekran sarlavhasi `.screen-head h1` — 22 px |

Qator balandligi: body 1,5; sarlavhalar 1,25. Maxsus: pastki navigatsiya yorligʻi 11 px, badge 12 px, tile sarlavhasi 15 px, taymer 20 px `tabular-nums`, xona kodi 28 px (`letter-spacing: .2em`). Uzun soʻzlar uchun `.break { overflow-wrap: anywhere }`.

## 4. Oraliqlar, radiuslar, oʻlchamlar

| Guruh | Tokenlar |
|---|---|
| Oraliq | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 (px) |
| Radius | `--r-s` 8 · `--r-m` 12 · `--r-l` 16 · `--r-xl` 24 (px); pill/badge/chip — 999 px |
| Oʻlcham | `--tap` 44 px (bosish nishoni), `--nav-h` 64 px (pastki navigatsiya) |
| Breakpoint | 720 px (`.grid-2.wide-4` 4 ustun, `.stat-grid` 4 ustun, sheet markazda), 1024 px (`.main` 960 px, yon padding 32 px) |

Layout yordamchilari: `.stack` (gap 12), `.stack-l` (gap 24), `.row`, `.row.wrap`, `.row.between`, `.grow`, `.grid-2`.

## 5. Safe area va klaviatura

```
--safe-top    = --tg-safe-area-inset-top + --tg-content-safe-area-inset-top
--safe-bottom = max(--tg-safe-area-inset-bottom, env(safe-area-inset-bottom))
--safe-left   = max(--tg-safe-area-inset-left,   env(safe-area-inset-left))
--safe-right  = max(--tg-safe-area-inset-right,  env(safe-area-inset-right))
```

- `--tg-*` oʻzgaruvchilarini `initTelegramChrome()` `WebApp.safeAreaInset` va `contentSafeAreaInset` dan oʻrnatadi va `safeAreaChanged`, `contentSafeAreaChanged`, `viewportChanged` hodisalarida yangilaydi. `index.html` da `viewport-fit=cover`.
- Qoʻllanilishi: `.app` (yuqori/chap/oʻng padding), `.main` pastki padding (`nav-h + safe-bottom + 24`), `.bottom-nav`, `.action-bar`, `.sheet`, slayd koʻrish rejimi.
- `#root` minimal balandligi `--tg-viewport-stable-height` (yoki `100dvh`).
- Klaviatura: matn maydoni fokusda boʻlsa `body.kb-open` qoʻshiladi va `.bottom-nav`, `.action-bar` yashiriladi.

## 6. Telegram mavzusi bilan integratsiya (`lib/telegram.ts`)

- **Mavzu**: `data-theme` Telegramʼning `colorScheme` (`light`/`dark`) qiymatidan olinadi; Telegram tashqarisida — `prefers-color-scheme`. `themeChanged` hodisasida qayta qoʻllanadi.
- **Palitra loyihaniki.** `themeParams` ranglari ishlatilmaydi. Aksincha, ilova Telegramʼga oʻz ranglarini beradi: `setHeaderColor` va `setBackgroundColor` ← `--c-bg` (`isVersionAtLeast("6.1")`, `try/catch` ichida), `setBottomBarColor` ← `--c-surface` (`7.10`+).
- **Ishga tushirish**: `ready()`, `expand()`, `disableVerticalSwipes()` (`7.7`+), `MainButton.hide()` (ilova oʻz tugmalaridan foydalanadi).
- **Orqaga**: `Screen` komponenti `BackButton` (`6.1`+) ni koʻrsatadi/yashiradi va `navigate(-1)` ga bogʻlaydi. Sahifa ichidagi “←” tugmasi faqat `initData` boʻlmaganda (Telegram tashqarisida) chiziladi.
- **Boshqa APIlar**: `HapticFeedback` (bor boʻlsa), `shareToTelegram()` → `t.me/share/url` (faqat foydalanuvchi bosganda), `downloadFile()` (`8.0`+, aks holda `<a download>`), `openInvoice()` (`6.1`+, aks holda `"unsupported"`; holat faqat UI uchun — kreditni server `successful_payment` dan keyin beradi).
- Rasmiy SDK `https://telegram.org/js/telegram-web-app.js` dan yuklanadi (`index.html`); CSP `script-src` shunga ruxsat beradi.

## 7. Kontrast tekshiruvi

`lib/contrast.ts` — WCAG 2.x nisbiy yorqinlik formulasi (`(L1+0.05)/(L2+0.05)`). `contrast.test.ts` `app.css` ni oʻqib, ikkala mavzu tokenlarini ajratadi va quyidagi chegaralarni tekshiradi (qiymatlar shu formula bilan hisoblangan):

| Juftlik | Chegara | Yorugʻ | Qorongʻi |
|---|---|---|---|
| `text` / `bg` | ≥ 7 | 17,06 | 17,19 |
| `text` / `surface` | ≥ 7 | 17,85 | 16,19 |
| `text-2` / `surface` | ≥ 4,5 | 7,58 | 11,95 |
| `text-3` / `surface` | ≥ 4,5 | 5,88 | 8,06 |
| `text-3` / `surface-2` | ≥ 4,5 | 5,37 | 6,67 |
| `on-primary` / `primary` | ≥ 4,5 | 6,29 | 6,31 |
| `primary` / `surface` | ≥ 4,5 | 6,29 | 5,95 |
| `primary` / `primary-soft` | ≥ 4,5 | 5,62 | 5,36 |
| `success` / `success-bg` | ≥ 4,5 | 5,21 | 7,69 |
| `warn` / `warn-bg` | ≥ 4,5 | 4,76 | 9,53 |
| `danger` / `danger-bg` | ≥ 4,5 | 5,91 | 6,39 |

**Test qamramaydigan joy:** `.step.done .dot` va `.opt-line.is-correct .tick` da `#fff` matn `--c-success` fonida. Yorugʻ mavzuda 5,48:1, qorongʻi mavzuda (`#34d399`) **1,92:1** — matn va grafik element uchun ham yetarli emas.

Slayd mavzulari (Academic Clean, Modern Data, Creative Seminar) uchun alohida tekshiruv: `apps/server/src/slides/themes.ts` (`themeContrastIssues`, matn juftliklari ≥ 4,5, chart belgilari ≥ 3) va `layout.test.ts`.

## 8. Komponentlar (`components/ui.tsx`)

| Komponent | Vazifasi |
|---|---|
| `Screen` | Ekran sarlavhasi (`h1`), ixtiyoriy amallar, Telegram `BackButton` boshqaruvi |
| `Loading` | Skeleton qatorlari (`aria-busy`, sr-only “yuklanmoqda”) |
| `Empty` | Boʻsh holat: ikonka, matn, ixtiyoriy harakat tugmasi |
| `ErrorState` | Xato: 403/404 da 🔒 va “ruxsat yoʻq / topilmadi” (qayta urinishsiz); boshqa xatolarda tarjima qilingan xabar + “Qayta urinish” |
| `Banner` | `info` / `warn` / `danger` / `success` xabar (`danger` → `role="alert"`) |
| `Badge` | Holat belgisi: `neutral`, `primary`, `success`, `warn`, `danger` |
| `Field` | Yorliq + input (render-prop orqali `id`), maslahat va xato matni |
| `Toggle` | `role="switch"` checkbox, yorliq va maslahat bilan |
| `Segmented` | Bir nechta variantdan biri (`aria-pressed`) |
| `Sheet` | Pastdan chiquvchi dialog (≥ 720 px da markazda): fokusni ushlaydi, Escape bilan yopiladi, fokusni qaytaradi |
| `ActionBar` | Pastki qotirilgan amal paneli (safe area ustida; `overNav` — navigatsiya ustida) |
| `SaveState` | Avtosaqlash holati: saqlanmoqda / saqlandi / saqlanmadi (`aria-live`) |
| `toast()` + `ToastHost` | 3,2 s lik qisqa xabar |
| `JobProgress` | Job holati: bosqich nomi (`jobs.<status>`), “bosqich N/M”, progress bar (`role="progressbar"`), “ilovani yopsangiz ham ish davom etadi” matni, ixtiyoriy bekor qilish |

Boshqa umumiy qismlar: `Shell` (pastki navigatsiya — Bosh sahifa, Yaratish, Guruhlar, Kutubxona, Profil; `room/attempt/join/onboarding` ekranlarida yashiriladi; offline banner; `ToastHost`), `ReportButton` (savol boʻyicha xato haqida bildirish, sabablar: `wrong_key`, `ambiguous`, `bad_source`, `typo`, `other`). Presentation Studio: `CostBanner`, `ThemePicker`, `SlidePreview` (server layout modelini `cqw` birliklarida chizadi), `SlideViewer` (toʻliq ekran; portret telefonda slayd buriladi), `SlideEditor`, `ExportPanel`.

CSS naqshlari: `.card` (`.flat`, `.accent`), `.tile`, `.list`/`.list-item`, `.choice` (`.correct`, `.wrong`, `aria-pressed`), `.chip`, `.bubble`/`.bubble-me`, `.evidence` (`.missing`), `.page-cell` (`ok`, `low_confidence`, `failed`, `empty`), `.steps`, `.timer`/`.timer-bar`, `.code-box`, `.lb-row`, `.data-table`, `.bars`, `.cost-list`, `.stat-grid`, `.slide-frame`.

## 9. Har bir ekran qamrab oladigan holatlar

| Holat | Qanday amalga oshirilgan | Misol |
|---|---|---|
| Yuklanish | `Loading` skeleti; lazy marshrutlar uchun `Suspense fallback`; kirish paytida toʻliq ekran skeleti | `DeckList`, `App.tsx` |
| Boʻsh | `Empty` + keyingi qadam tugmasi | Kutubxona (“Yuklash”), decklar, xonalar |
| Xato + qayta urinish | `ErrorState onRetry={() => q.refetch()}`; TanStack Query 4xx ni qayta urinmaydi, boshqalarni ≤ 2 marta | `Library`, `DeckNew`, `DeckList` |
| Offline | `useOnline()` → `Shell` dagi sticky `.offline-banner`; offline holatda GET boʻlmagan soʻrovlar mijozda `offline` kodi bilan toʻxtatiladi; oxirgi maʼlumot 30 daqiqa keshda (`gcTime`) | barcha ekranlar |
| Job jarayoni | `useJob()` har 1,5 s `GET /api/jobs/:id`; `JobProgress` haqiqiy `stagesDone/stagesTotal`; xatoda sabab + “kredit qaytariladi” | `QuizNew`, decklar, kutubxona |
| Kredit narxi oldindan | `POST /api/quizzes/estimate` → banner (balans yetmasa `warn`); `POST /api/decks/estimate` → `CostBanner`; bitta slaydni qayta yaratish narxi alohida | `QuizNew`, `DeckNew`, `DeckScreen` |
| AI sozlanmagan | `me.features.ai=false` → `Banner info` (`quiz.aiNotConfigured`, `deck.aiOff`), AI toggle koʻrsatilmaydi | `Home`, `QuizNew`, `DeckNew` |
| Ruxsat yoʻq | `ErrorState` 403/404 → 🔒; admin boʻlmagan foydalanuvchi `/admin/*` dan `/` ga yoʻnaltiriladi; `initData` yoʻq yoki rad etilgan — `OutsideTelegram` ekrani | `Admin.tsx`, `OutsideTelegram.tsx` |
| Saqlash | `SaveState` | `Profile` |

## 10. Ekranlar inventari

Mini App `HashRouter` ishlatadi: URL shakli `/app/#/<marshrut>`. Skrinshotlar `docs/evidence/e2e/` da; nom `NN-nom-<kenglik>.png`. Ular Playwright Chromiumʼda Telegram WebApp mock (`e2e/tests/telegram-mock.ts`, `version: "9.1"`) bilan olingan — haqiqiy Telegram mijozida emas.

| Marshrut | Komponent | Vazifasi | Skrinshot |
|---|---|---|---|
| `/` | `Home` | Salomlashish, oxirgi ish, tezkor harakatlar, oʻqish plitkalari, yaqin muddatlar | `20-home-light-320.png`, `20-home-dark-320.png`, `20-home-light-1440.png`, `20-home-dark-1440.png` |
| `/onboarding` | `Onboarding` | 3 ta oʻtkazib yuboriladigan qadam: til → maqsad → profil | `01-onboarding-390.png` |
| `/create` | `Create` | Prezentatsiya, quiz, yozma ishlar yordamchisi va quizlarim sahifasiga kirish | — |
| `/writing` | `Writing` | Yozma ishlar yordamchisi: reja, annotatsiya, adabiyotlar roʻyxati (GOST/APA), matnni ravonlashtirish, mezonga solishtirish; AI talab qiladigan rejimlarda sabab koʻrsatiladi | `54-writing-bibliography-390.png` |
| `/library`, `/library/upload` | `Library` | Hujjatlar roʻyxati, yuklash (fayl/matn/URL), qidiruv | — |
| `/library/:id` | `DocumentDetail` | Hujjat holati, sahifalar toʻri (OCR holati bilan), boʻlimlar, versiyalar, “Manba maʼlumotlari” (nom, muallif, nashr, URL) | `02-document-390.png` |
| `/library/:id/page/:n` | `PageView` | Bitta sahifa matni | — |
| `/library/:id/summary` | `Summary` | Konspekt: boʻlimlar boʻyicha iqtibosli asosiy fikrlar | `10-summary-390.png` |
| `/library/:id/stats` | `Stats` | Jadvaldan manbali faktlar, grafik, hisob, quiz | `15-stats-360.png` |
| `/quizzes` | `QuizList` | Quizlar roʻyxati | — |
| `/quiz/new` | `QuizNew` | Usul, manba, sozlamalar (jumladan Toʻgʻri/Notoʻgʻri savollar), narx, job jarayoni | `03-quiz-create-390.png` |
| `/quiz/:id/edit` | `QuizEditor` | Savollar, dalil, tekshiruvlar, tasdiqlash, nashr | `04-quiz-editor-390.png` |
| `/attempt/:id` | `Practice` | Mashq: javob → izoh va manba → natija, xatolarni qayta yechish. Topshiriqda: “Javob qabul qilindi”, toʻgʻriligi muddatgacha yashirin | `05-practice-feedback-390.png`, `06-practice-result-390.png`, `51-assignment-submitted-360.png`, `53-assignment-results-360.png` |
| `/join/:token` | `Join` | Taklif sahifasi: ism tanlash va xonaga yoki topshiriqqa kirish | — |
| `/assignment/:id` | `Assignment` | Mustaqil vaqtdagi topshiriq: muddat, qoidalar, boshlash/davom ettirish; oʻqituvchi uchun taklif, kim topshirgani, “Hozir yakunlash”; yopilgach ball va reyting | `50-assignment-student-360.png`, `52-assignment-closed-teacher-390.png` |
| `/room/:id` | `Room` | Jonli xona (host va ishtirokchi), jamoalar, host uchun co-host tayinlash | `07-room-lobby-host-390.png`, `08-room-answer-360.png`, `09-room-results-360.png`, `55-room-cohost-390.png` |
| `/groups` | `Groups` | Guruh workspaceʼlari, xonalar, Telegram guruhidagi quizlar | — |
| `/workspaces/new`, `/workspaces/join/:token`, `/workspaces/:id` | `WorkspaceNew`, `WorkspaceJoin`, `WorkspaceDetail` | Guruh loyihasi: aʼzolar, materiallar, vazifalar, faoliyat | `16-workspace-task-360.png`, `17-workspace-activity-390.png` |
| `/cards` | `Cards` | Kartochkalarni takrorlash (SM-2) | `11-flashcard-390.png` |
| `/mistakes` | `Mistakes` | Xatolar daftari | — |
| `/plans`, `/plans/new`, `/plans/:id` | `Plans`, `PlanNew`, `PlanDetail` | Imtihon rejasi va kunlik vazifalar | `14-plan-390.png` |
| `/tutor` | `Tutor` | Manbalar asosidagi yordamchi (iqtibos va joylashuv bilan) | `12-tutor-390.png` |
| `/games/matching` | `Matching` | Atama ↔ taʼrif oʻyini | `13-matching-390.png` |
| `/profile` | `Profile` | Profil, til, bildirishnomalar | — |
| `/profile/data` | `MyData` | Maʼlumotlarni eksport qilish, hisobni oʻchirish | `42-my-data-390.png` |
| `/billing` | `Billing` | Tariflar, amallar narxi, balans, tarix, Stars bilan sotib olish | `40-billing-390.png` |
| `/support` | `Support` | Yordam soʻrovlari | — |
| `/terms`, `/privacy`, `/help` | `InfoPage` | Shartlar, maxfiylik (AIʼga nima ketishi), yordam | — |
| `/decks` | `DeckList` | Prezentatsiyalar roʻyxati | `30-deck-list-1024.png` |
| `/decks/new` | `DeckNew` | Yangi prezentatsiya sozlamalari, mavzu, narx | `30-deck-new-390.png`, `30-deck-new-1024.png` |
| `/decks/:id` | `DeckScreen` | Rejani koʻrib chiqish, preview, tahrir, qayta yaratish, eksport | `30-deck-plan-390.png`, `30-deck-ready-390.png`, `30-deck-ready-1024.png`, `30-deck-ready-dark-390.png`, `30-deck-viewer-390.png`, `30-deck-editor-390.png`, `30-deck-conflict-390.png`, `30-deck-regenerate-390.png`, `30-deck-exports-390.png` |
| `/admin` | `AdminHome` | Operator koʻrinishi: foydalanuvchilar, navbat, xatolar, AI xarajati, toʻlovlar | `41-admin-overview-1024.png` |
| `/admin/jobs` | `Jobs` | Joblar roʻyxati va qayta ishga tushirish | — |
| `/admin/plans` | `Plans` | Tariflarni tahrirlash | — |
| `/admin/models` | `Models` | Task boʻyicha model, effort, kill switch, rollback | — |
| `/admin/flags` | `Flags` | Feature flagʼlar (masalan, `pricing`) | — |
| `/admin/reports` | `Reports` | Savollar boʻyicha shikoyatlar | — |
| `/admin/tickets` | `Tickets` | Yordam soʻrovlariga javob | — |
| `/admin/users` | `Users` | Foydalanuvchi qidirish, kredit tuzatish | — |
| `/admin/payments` | `Payments` | Toʻlovlar va qaytarish | — |
| `/admin/audit` | `Audit` | Audit jurnali | — |
| `*` | `Navigate` | `/` ga yoʻnaltirish | — |
| (marshrut emas) | `OutsideTelegram` | Telegram tashqarisida yoki `initData` rad etilganda koʻrsatma | — |

Start parametri: `r<token>` → `/join/<token>` (topshiriq boʻlsa qoʻshilgach `/assignment/:id`), `w<token>` → `/workspaces/join/<token>`; aks holda onboarding tugallanmagan boʻlsa `/onboarding` (`App.tsx`). Bitta Telegram sessiyasida taklif ekrani bir marta ochiladi — sahifa qayta yuklansa foydalanuvchi oʻz ekranida qoladi.

## 11. Maʼlum boʻshliqlar

- Ikonkalar emoji bilan berilgan; ularning platformalararo koʻrinishi tekshirilmagan.
- Skrinshotlar va responsive testlar haqiqiy Telegram mijozida (iOS/Android/Desktop/Web) takrorlanmagan.
