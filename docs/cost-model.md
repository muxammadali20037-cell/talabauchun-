# Boshlangʻich xarajat modeli va tarif taklifi

> Bu hujjat **reja uchun hisob-kitob**, oʻlchangan haqiqiy xarajat emas. Har bir taxmin `T#` bilan belgilangan.
> Pilotdan keyin haqiqiy raqamlar admin panelda koʻrinadi (Admin → Bosh sahifa: AI xarajati, modellar boʻyicha
> chaqiruv; Mahsulot koʻrsatkichlari: “bitta muvaffaqiyatli ish xarajati”) — ular `usage_events` jadvalidan,
> har bir AI chaqiruvining haqiqiy token soni boʻyicha hisoblanadi. Tariflarni oʻsha raqamlar bilan qayta hisoblang.

## 1. Taxminlar

| # | Taxmin | Qiymat | Qanday tekshiriladi |
|---|---|---|---|
| T1 | AI narxlari (USD / 1M token, kirish/chiqish) | Opus 5.5: 4 / 20; Sonnet 5.5: 2 / 10; Haiku 5.5: 0.1 / 0.5 — `apps/server/src/ai/client.ts` dagi jadval | Anthropic’ning amaldagi narx sahifasi bilan ishga tushirishdan oldin solishtiring; farq boʻlsa jadvalni yangilang |
| T2 | Oʻzbek lotin matnida token zichligi | ~3 belgi = 1 token | Pilotda `usage_events.input_tokens` / yuborilgan belgi soni |
| T3 | Quiz generatsiyasi manba hajmi | ≤ 60 chunk × 1200 belgi (kod chegarasi: `quiz/pipeline.ts`, `ingest/chunker.ts`) | Kod chegarasi; haqiqiy oʻrtacha kamroq boʻladi |
| T4 | Chiqish tokenlari (fikrlash bilan) | 10 savol ≈ 5 500; tekshiruv ≈ 2 000 | `usage_events.output_tokens` |
| T5 | Telegram Stars’dan dasturchiga tushum | 1 Star ≈ 0.013 USD | Telegram’ning Stars shartlari / Fragment orqali yechib olish kursi, ishga tushirish kunidagi qiymat |
| T6 | Server | 4 vCPU / 8 GB VPS ≈ 40 USD/oy; obyekt ombori 0.023 USD/GB·oy | Tanlangan hosting narxi |
| T7 | Oʻrtacha foydalanuvchi hajmi | 50 MB fayl, oyiga 6 ta AI ish | Pilot statistikasi |
| T8 | Pullik tarifdan foydalanish darajasi | sotib olingan kreditlarning 40% ishlatiladi | `credit_ledger`: purchase vs reserve/capture |

## 2. Bitta ish narxi (T1–T4 boʻyicha)

### 10 savolli AI quiz (generatsiya + koʻr tekshiruv)

Kirish: ~25 000 token (60 chunk), chiqish: ~5 500; tekshiruv: kirish ~8 000, chiqish ~2 000.

| Model sozlamasi (admin panelda vazifa boʻyicha tanlanadi) | Generatsiya | Tekshiruv | Jami | 1 savol |
|---|---|---|---|---|
| Hammasi Opus 5.5 (standart `AI_MODEL_STRONG`) | 0.210 $ | 0.072 $ | **0.282 $** | 0.028 $ |
| Hammasi Sonnet 5.5 | 0.105 $ | 0.036 $ | **0.141 $** | 0.014 $ |
| Generatsiya Sonnet, tekshiruv Haiku | 0.105 $ | 0.002 $ | **0.107 $** | 0.011 $ |
| AI’siz (matndan rejim) | 0 | 0 | **0** (faqat CPU) | — |

### 12 slaydli AI prezentatsiya

Reja + yozish (kuchli model): kirish ~30 000, chiqish ~8 000; qoʻshimchalar (tez model): ~5 000 / 2 000.

| Sozlama | Narx |
|---|---|
| Opus 5.5 + Haiku 5.5 | ≈ 0.28 $ |
| Sonnet 5.5 + Haiku 5.5 | ≈ 0.14 $ |
| AI’siz | 0 |

### Boshqalar

| Ish | Narx | Izoh |
|---|---|---|
| Tutor javobi (tez model) | ≈ 0.0007 $ | kirish ~4 000, chiqish ~600 |
| OCR, 1 sahifa | ≈ 0.00003 $ | 1–3 s CPU (T6 narxida); asosan navbat/CPU cheklovi uchun narxlanadi |
| PPTX/PDF render | ≈ 0.0001 $ | LibreOffice ~3 s (smoke testda 12 slayd PPTX ~3 s, PDF ~3 s) |
| Saqlash | ≈ 0.001 $/oy/foydalanuvchi | T7 |

## 3. Kredit narxi bilan solishtirish

Hozirgi kredit jadvali (`billing/credits.ts`, admin `pricing` flag bilan oʻzgartiriladi):
AI quiz — 1 kredit = 2 savol; AI’siz quiz — 1 kredit = 5 savol; AI slayd — 1 kredit/slayd; OCR — 1 kredit = 10 sahifa.

| Ish | Kredit | Xarajat (Opus) | 1 kredit xarajati (Opus) | Sonnet+Haiku | 1 kredit (Sonnet+Haiku) |
|---|---|---|---|---|---|
| 10 savolli AI quiz | 5 | 0.282 $ | **0.056 $** | 0.107 $ | **0.021 $** |
| 12 slaydli AI prezentatsiya | 12 | 0.28 $ | 0.023 $ | 0.14 $ | 0.012 $ |

Eng qimmat holat — AI quiz. Shuning uchun kredit narxi quiz boʻyicha hisoblanadi.

## 4. Bepul tarif

Hozir: oyiga 60 kredit. Eng yomon holat (hammasi Opus’dagi AI quiz): 60 × 0.056 = **3.4 $/oy** bitta faol foydalanuvchiga —
bepul tarif uchun juda qimmat. Tavsiyalar:

1. Bepul foydalanuvchilar uchun quiz generatsiyasini Sonnet’ga, tekshiruvni Haiku’ga oʻtkazish
   (Admin → AI modellari) → 60 × 0.021 = **1.3 $/oy** eng yomon holatda.
2. Yoki bepul kreditni 30 ga tushirish → 0.6 $/oy (Sonnet+Haiku).
3. AI’siz rejim (matndan quiz, kartochka, konspekt, statistika) deyarli tekin — bepul tarifda cheklanmasin.

Faol bepul foydalanuvchilar ulushi va ularning haqiqiy sarfi pilotda oʻlchanmaguncha, “cheksiz AI” vaʼda qilinmaydi.

## 5. Pullik tarif narxini hisoblash formulasi

```
narx_stars = ceil( kreditlar × foydalanish_darajasi × 1_kredit_xarajati / (1 − maqsadli_marja) / star_tushumi )
```

Misol (T5 = 0.013 $, T8 = 40%, Sonnet+Haiku → 0.021 $/kredit, maqsadli marja 60%):

| Tarif | Kreditlar | Hisob | Narx |
|---|---|---|---|
| Student Plus | 200 / 30 kun | 200 × 0.4 × 0.021 / 0.4 / 0.013 | **≈ 325 Stars** |
| Student Plus | 400 / 30 kun | shu formula | ≈ 650 Stars |
| Guruh / Oʻqituvchi | 1 000 / 30 kun | shu formula | ≈ 1 620 Stars |

Opus bilan (0.056 $/kredit) xuddi shu tariflar ~2.7 baravar qimmatga tushadi. Server xarajati (T6) 1 000 faol
foydalanuvchida ~0.04 $/foydalanuvchi — AI’ga nisbatan kichik.

**Qaror talab qiladi (mahsulot egasi):** qaysi model sozlamasi, maqsadli marja va bepul limit. Admin panelda narx
qoʻyilmaguncha pullik tariflar sotuvga chiqmaydi (`active=false`, narx 0) — bu ataylab qilingan.

## 6. Yuklama oʻsganda

| Faol foydalanuvchi/oy | Infratuzilma (taxmin) | Oylik server xarajati (T6) |
|---|---|---|
| 1 000 | 1 VPS (API + 1 worker) + Postgres shu yerda | ~40 $ |
| 10 000 | API ×2, worker ×2–3 (OCR/LibreOffice CPU), alohida Postgres, obyekt ombori | ~250–400 $ |
| 50 000+ | API ×4+, worker pool avtomatik kengayish, Postgres replica, CDN Mini App statikasi uchun | ~1 500 $+ |

AI xarajati foydalanuvchi soniga chiziqli bogʻliq va kredit tizimi bilan cheklanadi; asosiy xavf — bepul tarifdagi AI.
