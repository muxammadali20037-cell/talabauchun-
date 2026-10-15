# Operator va administrator yoʻriqnomasi

## 1. Kirish va huquqlar

- Platforma administratorlari serverda `ADMIN_TELEGRAM_IDS` bilan belgilanadi (Telegram raqamli ID).
  Mini App’dagi “oʻqituvchi” profili administrator huquqini **bermaydi**.
- Admin panel: Mini App → Profil → **Admin** (`/app/#/admin`). Boshqa foydalanuvchilarga 403.
- Har bir oʻzgartirish (tarif, model, flag, moderatsiya, javob, kredit, refund, ish qayta ishga tushirish)
  **yaqinda Telegramda ochilgan Mini App**ni talab qiladi: Telegram imzolagan kirish vaqti (`auth_date`)
  `ADMIN_FRESH_SESSION_MIN` (standart 15 daqiqa) dan eski boʻlmasligi kerak. Amal
  `audit_events` ga bajaruvchi, vaqt va IP bilan yoziladi. “Qayta kirish kerak” xabari chiqsa, Mini App’ni yopib,
  Telegramda qayta oching (avtomatik qayta kirish bu cheklovni chetlab oʻtmaydi).
- Analitika agregat: admin talabalarning shaxsiy fayllari va javoblarini koʻrmaydi. Moderatsiyada faqat
  shikoyat qilingan savol matni koʻrinadi.

## 2. Admin panel boʻlimlari

| Boʻlim | Nima koʻrsatadi / nima qiladi |
|---|---|
| Bosh sahifa | Foydalanuvchilar (jami, bugun/7 kunda faol), guruhlar; 24 soatlik ishlar: muvaffaqiyat %, navbat, eng uzoq kutish, turlar boʻyicha kutish/bajarish p95; koʻp uchragan xatolar; AI xarajati (24 soat/30 kun), modellar boʻyicha chaqiruv/xato/p95; kreditlar; Stars toʻlovlari; ochiq murojaat va shikoyatlar; yuborilmagan bot xabarlari |
| Mahsulot koʻrsatkichlari | Birinchi foydali natijagacha vaqt (mediana/p75), nashr qilingan quizlar, tugatilgan mashqlar, PPTX/PDF eksport muvaffaqiyati, guruhda qayta ishlatish, D1/D7/D30 qaytish, bitta muvaffaqiyatli ish xarajati. **Maqsadlar** (`targets` flag) alohida koʻrsatiladi — oʻlchangan qiymat bilan aralashtirilmaydi |
| Ishlar | Holat boʻyicha roʻyxat, oxirgi xato kodi; muvaffaqiyatsiz ishni checkpoint’dan **qayta ishga tushirish** (talabadan qayta kredit olinmaydi) |
| Tariflar | Narx (Stars), kredit, muddat, limitlar, sotuvda/yoʻq. Har oʻzgarish `version` ni oshiradi: eski invoice’lar pre-checkout’da rad etiladi, sotib olingan tariflar oʻz nusxasi (snapshot) bilan qoladi |
| AI modellari | Har vazifa (quiz_generate, quiz_validate, slide_plan, tutor …) uchun model/effort; **Oʻchirish** (AI chaqirilmaydi — matndan rejim ishlaydi yoki aniq xato koʻrsatiladi) va **Orqaga qaytarish** (oldingi sozlama saqlanadi) |
| Sozlamalar (flag) | `pricing` (kredit narxlari), `targets` (maqsadlar), `ai_generation`, `web_search`, `public_templates`, `signup_open` |
| Shikoyatlar | Savol boʻyicha shikoyat; hal qilish, rad etish, quizni ommaviy koʻrinishdan olish (havolalar bekor qilinadi) |
| Yordam | Bot `/support`, `/paysupport` va Mini App murojaatlari; javob foydalanuvchiga bot orqali yuboriladi |
| Foydalanuvchilar | Qidiruv (ism, @username, ID), balans, tarif, hujjat/quiz soni; kreditni tuzatish (sabab majburiy, takroriy bosish bir marta) |
| Toʻlovlar | Holatlar; **Qaytarish** → `refundStarPayment`, keyin kredit va tarif bekor qilinadi (bir martagina) |
| Audit | Barcha admin amallari va tizim hodisalari (masalan, `account.deleted`) |

## 3. Monitoring

`GET /metrics` (Prometheus matn formati). Kirish: `Authorization: Bearer $METRICS_TOKEN` yoki admin sessiyasi.

| Metrika | Maʼnosi | Ogohlantirish (taklif) |
|---|---|---|
| `talaba_http_request_duration_seconds` (histogram, route/method/status) | API kechikishi | Asosiy API p95 > 1 s 10 daqiqa; `5xx` ulushi > 1% |
| `talaba_jobs_open{kind,status}` | Tugamagan ishlar | `queued` > 50 |
| `talaba_jobs_oldest_queued_seconds` | Eng uzoq navbat | > 300 s |
| `talaba_jobs_finished_5m{status}` | Soʻnggi 5 daqiqada tugaganlar | `failed` / jami > 20% |
| `talaba_ai_calls_5m`, `talaba_ai_errors_5m`, `talaba_ai_cost_usd_5m` | AI chaqiruvlari, xatolar, xarajat | xato > 10%; xarajat kunlik byudjetdan tez oʻsishi |
| `talaba_outbox_pending`, `talaba_outbox_dead_1h` | Yuborilmagan bot xabarlari | pending > 500; dead > 0 |
| `talaba_ws_connections` | Ochiq xona WebSocket’lari | sigʻim rejasi uchun |
| `talaba_process_resident_bytes` | API xotirasi | > 1.5 GB |

Qoʻshimcha: `GET /readyz` (DB bilan), `GET /healthz` (jarayon), Telegram `getWebhookInfo` (`pending_update_count`, `last_error_message`).
Loglar JSON (pino); `authorization` va webhook secret sarlavhalari yashiriladi; foydalanuvchi fayl matni va toʻliq promptlar logga yozilmaydi
(AI ishidagi ichki xato tafsiloti faqat `job_events` ga, qisqartirilgan holda).

## 4. Zaxira nusxa (backup) va tiklash

**Siyosat** (oʻzgartirish mumkin, lekin foydalanuvchilarga eʼlon qilingani bilan bir xil boʻlsin):

| Parametr | Qiymat |
|---|---|
| Nima | PostgreSQL (`pg_dump -Fc`) + `STORAGE_DIR` (yuklangan fayllar, eksportlar) + checksum’lar |
| Qachon | Har kecha 03:15 (`talaba-backup.timer`) |
| Saqlash muddati | 14 kun (`BACKUP_RETENTION_DAYS`), keyin avtomatik oʻchiriladi |
| RPO (yoʻqotilishi mumkin boʻlgan maʼlumot) | 24 soatgacha. Kamroq kerak boʻlsa — WAL arxivlash (pgBackRest/wal-g) qoʻshing |
| RTO (tiklash vaqti) | Sinovdagi oʻlchov: backup 0.2 s, restore 0.8 s ([evidence/restore-drill.json](evidence/restore-drill.json)) — kichik baza uchun. Ishlab chiqarishda har chorakda mashq qilib, haqiqiy vaqtni yozing |
| Joylashuv | Backup boshqa disk/hostga yoki obyekt omboriga nusxalanishi kerak (`/var/backups/talaba` → offsite) |

**Tiklash tartibi** (mashq testda avtomatik bajariladi — `apps/server/test/ops.test.ts`):

```bash
# 1) yangi, boʻsh baza va boʻsh storage papka
sudo -u postgres createdb -O talaba talaba_restore
# 2) tiklash: checksum tekshiriladi, boʻsh boʻlmagan maqsad rad etiladi, migratsiyalar roʻyxati solishtiriladi
ops/restore.sh /var/backups/talaba/talaba-YYYYMMDDTHHMMSSZ postgres://talaba:…@127.0.0.1/talaba_restore /var/lib/talaba/storage-restore
# 3) backup’dan keyin bajarilgan hisob oʻchirishlarini qayta qoʻllash (log backup’dan tashqarida saqlanadi)
DATABASE_URL=…/talaba_restore STORAGE_DIR=/var/lib/talaba/storage-restore node apps/server/dist/reapply-deletions.js
# 4) sozlamalarda DATABASE_URL/STORAGE_DIR ni yangilang, xizmatlarni qayta ishga tushiring, /readyz va smoke test
```

Mashq natijasi (2026-10-15): satrlar soni, har bir faylning sha256, migratsiyalar mos; tiklangan bazada kirish,
hujjatlar roʻyxati, sahifa matni va qidiruv ishladi; backup’dan keyin oʻchirilgan hisob qayta oʻchirildi.

## 5. Maʼlumot hayoti va oʻchirish siyosati

| Hodisa | Nima boʻladi |
|---|---|
| Hujjatni oʻchirish | Fayl (barcha versiyalar), sahifa matni, chunk’lar va embedding’lar darhol oʻchiriladi. Undan yaratilgan quizlar faqat oʻz dalil parchasini (citation snapshot) saqlaydi |
| Taklif havolasini bekor qilish | Kelajakdagi kirishni toʻxtatadi. Ilgari yuklab olingan nusxalarni masofadan oʻchirib boʻlmaydi — bunday vaʼda berilmaydi |
| Maʼlumot eksporti | Profil → Maʼlumotlarim. ZIP (JSON + asl fayllar) 7 kun yuklab olish uchun; havola 10 daqiqalik imzoli |
| Hisobni oʻchirish | “DELETE” deb yozib tasdiqlanadi. Oʻchiriladi: yuklamalar, matn, indeks, shaxsiy quiz/prezentatsiya/kartochka/reja/natijalar, izohlar, profil, sessiyalar, Telegram bogʻlanishi. Saqlanadi (shaxssiz): toʻlov va kredit yozuvlari (toʻlovchi Telegram ID’si qaytarish imkoni uchun toʻlov yozuvida qoladi), agregat metrikalar, boshqalarning natijasidagi savol matni, guruhga berilgan materiallar (guruhga tegishli) |
| Backup’dagi nusxa | 14 kundan keyin rotatsiya bilan yoʻqoladi. Tiklashda `reapply-deletions` oʻchirishni qayta qoʻllaydi |

## 6. Hodisalarda nima qilish kerak

| Belgisi | Tekshirish | Harakat |
|---|---|---|
| AI ishlar `ai_rate_limited` / `ai_timeout` bilan yiqilmoqda | Admin → Bosh sahifa → modellar xatosi; `job_events` | Ishlar avtomatik cheklangan qayta urinishda (SDK 2 marta + ish 3 urinish, orada kutish). Davom etsa: Admin → AI modellari → shu vazifani boshqa modelga oʻtkazish yoki **Oʻchirish**; keyin muvaffaqiyatsiz ishlarni **Qayta ishga tushirish** (kredit qayta olinmaydi) |
| Yangi model sifatsiz natija bermoqda (shikoyatlar koʻpaydi) | Shikoyatlar, `quiz_validate` ogohlantirishlari | Admin → AI modellari → **Orqaga qaytarish** |
| Navbat uzaymoqda | `talaba_jobs_oldest_queued_seconds`, Admin → Ishlar | Worker sonini oshirish; osilib qolgan ish (`worker_lost`) — avtomatik yiqitiladi va kredit qaytadi |
| Bot javob bermayapti | `getWebhookInfo`, `talaba_outbox_pending` | Webhook URL/secret (setup skriptini qayta ishga tushiring); 429 boʻlsa outbox `retry_after` ni kutadi |
| Toʻlov “toʻlandi” deydi, kredit yoʻq | Admin → Toʻlovlar (holat), `/paysupport` murojaati | Kredit faqat `successful_payment` dan keyin; holat `pending` boʻlsa Telegram hodisasi kelmagan — `getWebhookInfo` ni tekshiring. Kerak boʻlsa qaytaring yoki kreditni sabab bilan tuzating |
| Eksport (PPTX/PDF) yiqilmoqda | Admin → Ishlar (`renderer_missing`, `render_timeout`, `export_checks_failed`) | LibreOffice va shriftlar oʻrnatilganini tekshiring; kontent saqlanadi, foydalanuvchi qayta urinadi |
| Disk toʻlmoqda | `df`, `STORAGE_DIR` hajmi | Worker har soatda tozalaydi: maʼlumot eksportlari 7 kundan, deckning oxirgisi boʻlmagan eksportlari 30 kundan keyin oʻchadi (`src/ops/retention.ts`). Worker ishlayotganini tekshiring; kerak boʻlsa diskni kengaytiring |
