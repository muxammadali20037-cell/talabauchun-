# Telegram sozlamalari: BotFather, HTTPS webhook, Main Mini App, buyruqlar va guruh oqimi

Bu yoʻriqnoma TALABA AI botini Telegramga ulash uchun. Server oʻrnatish — [deploy.md](deploy.md).
Telegram imkoniyatlari va cheklovlari oʻzgarib turadi: ishga tushirishdan oldin rasmiy sahifalarni qayta tekshiring
(core.telegram.org/bots/api, /bots/webapps, /bots/payments-stars). Hujjat sanasi: 2026-10-15.

## 0. Kerakli narsalar

| Nima | Qayerdan | Qaysi sozlamaga yoziladi |
|---|---|---|
| Bot tokeni | @BotFather → `/newbot` | `TELEGRAM_BOT_TOKEN` |
| Bot username (`@` siz) | @BotFather | `TELEGRAM_BOT_USERNAME` |
| Webhook maxfiy kaliti | oʻzingiz yaratasiz: `openssl rand -hex 32` | `TELEGRAM_WEBHOOK_SECRET` |
| HTTPS domen | DNS + TLS (Caddy avtomatik oladi) | `PUBLIC_BASE_URL=https://…` |
| Admin Telegram ID(lar)i | @userinfobot yoki botga /start yuborib server logidan | `ADMIN_TELEGRAM_IDS` |

Token, secret va API kalitlari faqat serverdagi `/etc/talaba/talaba.env` faylida turadi (`chmod 600`).
Ular git, frontend, skrinshot va loglarga chiqmasligi kerak (server logida `authorization` va webhook secret sarlavhasi yashiriladi).

## 1. BotFather’da bot yaratish

1. @BotFather → `/newbot` → nom: `TALABA AI`, username: masalan `talaba_ai_bot`.
2. Tokenni `TELEGRAM_BOT_TOKEN` ga yozing. Token oshkor boʻlsa: `/revoke` → yangi token → serverni qayta ishga tushiring.
3. `/setjoingroups` → **Enable** (bot guruhga quiz yuborishi uchun).
4. `/setprivacy` → **Enable** (standart holat qoldiriladi). Bot guruhdagi oddiy xabarlarni oʻqishi shart emas:
   unga faqat `/start g<token>` buyrugʻi, oʻzi yuborgan quiz-soʻrovnomalarning `poll`/`poll_answer` hodisalari
   va `my_chat_member` kerak — bular privacy rejimida ham keladi.
5. Avatar va tavsif: avatar uchun dizayn brifi — [brand.md](brand.md). Tavsif, qisqa tavsif va buyruqlar
   roʻyxatini 4-qadamdagi skript oʻzi qoʻyadi (uz/ru/en).

## 2. Main Mini App

Mini App bot profilida “Open” tugmasi va `https://t.me/<bot>?startapp=<param>` havolalari orqali ochiladi
(xona taklifi `r<token>`, guruh loyihasi taklifi `w<token>`).

1. @BotFather → `/mybots` → bot → **Bot Settings** → **Configure Mini App** → **Enable Mini App**.
2. URL: `https://<domen>/app/` (oxiridagi `/` bilan). Bu URL `PUBLIC_BASE_URL` bilan bir xil domenda boʻlishi shart.
3. Ixtiyoriy: shu boʻlimda Mini App uchun qisqa tavsif va skrinshotlar (docs/evidence/e2e/*.png dan tanlang).

Tekshirish: telefonda `https://t.me/<bot>?startapp=test` ni oching — Mini App ochilishi kerak.
Brauzerda `https://<domen>/app/` ni ochsangiz, “Telegram ichida oching” sahifasi chiqadi — bu toʻgʻri:
kirish faqat Telegram imzolagan `initData` orqali.

## 3. Server sozlamalari

`.env.example` dan nusxa olib to‘ldiring (toʻliq izohlar faylning oʻzida). Minimal ishlaydigan toʻplam:

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://talaba.example.uz
DATABASE_URL=postgres://talaba:…@127.0.0.1:5432/talaba
STORAGE_DIR=/var/lib/talaba/storage
SIGNING_SECRET=<openssl rand -hex 32>
TELEGRAM_BOT_TOKEN=<BotFather token>
TELEGRAM_BOT_USERNAME=talaba_ai_bot
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
ADMIN_TELEGRAM_IDS=123456789
DELETION_LOG_PATH=/var/lib/talaba/deletion-log.jsonl
```

Server production rejimida notoʻgʻri sozlamani rad etadi (qisqa `SIGNING_SECRET`, `http://` manzil,
webhook secret yoʻqligi, `DEV_AUTH_ENABLED=true`).

## 4. Webhook, buyruqlar, menyu tugmasi — bitta buyruq bilan

API ishga tushgandan keyin (deploy.md, 5-qadam):

```bash
cd /opt/talaba/apps/server
sudo -u talaba env $(cat /etc/talaba/talaba.env | xargs) node dist/telegram-setup.js
```

Skript (`src/telegram/setup.ts`) quyidagilarni bajaradi va natijani chiqaradi:

- `getMe` — token aynan `TELEGRAM_BOT_USERNAME` botiga tegishli ekanini tekshiradi;
- `setWebhook` — `https://<domen>/telegram/webhook`, `secret_token`, `allowed_updates` =
  `message, callback_query, poll, poll_answer, my_chat_member, pre_checkout_query`;
- `setMyCommands` — shaxsiy chat uchun uz (standart), ru, en roʻyxatlari; guruh uchun faqat `/start`;
- `setMyDescription`, `setMyShortDescription` — uz/ru/en;
- `setChatMenuButton` — “TALABA AI” tugmasi Mini App’ni ochadi;
- `getWebhookInfo` — `url`, `pending_update_count` va oxirgi xato (`last_error_message`) ni koʻrsatadi.

Webhook har bir soʻrovda `X-Telegram-Bot-Api-Secret-Token` sarlavhasini doimiy vaqtli taqqoslash bilan tekshiradi;
mos kelmasa 401 qaytaradi. Har bir `update_id` bir marta qayta ishlanadi (`processed_updates`).

### Lokal ishlab chiqish (HTTPS yoʻq)
`TELEGRAM_MODE=polling` bilan server webhookni oʻchirib, `getUpdates` orqali ishlaydi
(`node dist/telegram-setup.js` ni `TELEGRAM_MODE=polling` bilan ishga tushirsangiz, webhook qadamini oʻtkazib yuboradi).
Mini App baribir HTTPS talab qiladi — lokal sinov uchun HTTPS tunnel (masalan, Cloudflare Tunnel) kerak.

## 5. Guruh oqimi (native Telegram quiz)

1. Talaba/oʻqituvchi Mini App’da quizni nashr qiladi → **Oʻynash** → **Guruhga yuborish** → “Guruhni tanlash”.
2. Telegram `https://t.me/<bot>?startgroup=g<token>` orqali guruh tanlash oynasini ochadi; bot guruhga qoʻshiladi
   va `/start g<token>` bilan quiz shu guruhga bogʻlanadi. Havola faqat yaratgan foydalanuvchi uchun ishlaydi.
3. Botning guruhdagi xabarida **Boshlash** tugmasi — uni faqat quizni yuborgan odam bosa oladi.
4. Bot savollarni `sendPoll(type=quiz)` bilan yuboradi. Anonim boʻlmagan rejimda har bir javob `poll_answer`
   orqali keladi va natijalar hisoblanadi; anonim rejimda faqat umumiy sonlar (`poll` hodisasi) olinadi —
   individual natija toʻqib chiqarilmaydi.
5. Mini App’ga xos savollar (rasmli, koʻp toʻgʻri javobli yoki Telegram limitidan uzun) guruhga yuborilmaydi —
   bu oldindan “N ta savoldan M tasi guruhga yuboriladi” deb koʻrsatiladi.

Bot guruhga yoza olmasa (huquq yoʻq, bot chiqarilgan): bot shaxsiy chatda sababni tushuntiradi va
Mini App’dagi jonli xona havolasini taklif qiladi. Guruhda botga “Send messages” va “Send polls” ruxsatlari kerak.

## 6. Telegram Stars toʻlovlari

- Raqamli xizmatlar uchun faqat **Telegram Stars (XTR)** ishlatiladi; `provider_token` boʻsh. Click/Payme
  Telegram ichidagi raqamli xarid uchun ishlatilmaydi.
- Toʻlovni yoqishdan oldin: admin panelda (Mini App → Profil → Admin → Tariflar) narx va kreditlarni
  [cost-model.md](cost-model.md) boʻyicha belgilang, tarifni “Sotuvga chiqarish” qiling, soʻng `PAYMENTS_ENABLED=true`.
- Kredit faqat server `successful_payment` hodisasini olganda qoʻshiladi (takroriy hodisa `telegram_payment_charge_id`
  boʻyicha zararsiz). Qaytarish: admin panel → Toʻlovlar → Qaytarish (`refundStarPayment`), yoki Telegram yuborgan
  `refunded_payment` xabari — ikkalasi ham ledger’da bir martagina aks etadi.
- `/paysupport` va Mini App’dagi “Toʻlov boʻyicha yordam” majburiy foydalanuvchi yordami oqimi sifatida ishlaydi.

## 7. Ishga tushirishdan keyingi tekshiruv roʻyxati

| # | Amal | Kutiladigan natija |
|---|---|---|
| 1 | Botga `/start` | Salomlashuv, til tanlash, “Mini App’ni ochish” tugmasi |
| 2 | Menyu tugmasi “TALABA AI” | Mini App ochiladi, ism koʻrinadi, onboarding |
| 3 | Botga PDF yuborish | “Qabul qilindi”, keyin “tayyor” xabari; Mini App → Kutubxona’da koʻrinadi |
| 4 | Mini App’da quiz yaratish → nashr → “Oʻynash → Xona ochish” → ulashish | Ikkinchi akkaunt havoladan xonaga kiradi |
| 5 | “Guruhga yuborish” | Bot guruhga qoʻshiladi, Boshlash tugmasi faqat sizda ishlaydi |
| 6 | `getWebhookInfo` | `pending_update_count` kichik, `last_error_message` yoʻq |
| 7 | `curl https://<domen>/readyz` | `{"ok":true}` |
| 8 | Admin akkaunt: Profil → Admin | Koʻrsatkichlar paneli ochiladi |

Avtomatik tekshiruv: `SMOKE_URL=https://<domen> TELEGRAM_BOT_TOKEN=… npx tsx scripts/smoke.ts <fayl.pdf>`
(yuklash → quiz → 12 slaydli prezentatsiya → PPTX va PDF eksport). Ishlab chiqarish bazasida sinov foydalanuvchisi
(`777000111`) yaratadi — keyin uni admin panel orqali yoki maʼlumot oʻchirish soʻrovi bilan olib tashlang.
