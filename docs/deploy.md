# Serverga oʻrnatish (Ubuntu 24.04)

Bu tartib shu loyiha sinalgan muhitga mos: Ubuntu 24.04, Node 22, PostgreSQL 16 + pgvector 0.6, tesseract 4.1,
LibreOffice 24.2, poppler 24.02. `dist/` build va undan ishga tushirish shu muhitda tekshirilgan
([evidence/dist-smoke.txt](evidence/dist-smoke.txt)). Docker image bu muhitda yigʻilmagan (Docker daemon yoʻq edi),
shuning uchun bu yerda native oʻrnatish yozilgan.

## 1. Tizim paketlari

```bash
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-16-pgvector \
  tesseract-ocr tesseract-ocr-uzb tesseract-ocr-uzb-cyrl tesseract-ocr-rus tesseract-ocr-eng \
  poppler-utils libreoffice-core libreoffice-impress libreoffice-writer fonts-liberation fonts-liberation2 \
  caddy git curl
# Node 22 (NodeSource yoki nvm) va pnpm 10
corepack enable && corepack prepare pnpm@10.28.0 --activate
```

Nega kerak: `tesseract` — skanerlangan sahifalar OCR (oʻzbek lotin/kirill, rus, ingliz);
`pdftoppm` (poppler) — PDF sahifasini OCR uchun rasmga aylantirish; LibreOffice — prezentatsiyani PDF’ga
render qilish va eksportni tekshirish; Liberation shriftlari — slayd matnini oʻlchash va PPTX/PDF’da bir xil koʻrinish.

## 2. Maʼlumotlar bazasi

```bash
sudo -u postgres psql <<'SQL'
create user talaba with password 'CHANGE_ME';
create database talaba owner talaba;
\c talaba
create extension if not exists vector;
create extension if not exists pg_trgm;
SQL
```

Migratsiyalar (`apps/server/src/db/migrations/*.sql`) API ishga tushganda (`MIGRATE_ON_START=true`) yoki
`node dist/migrate-cli.js` bilan qoʻllanadi; bir vaqtda ikki jarayon ishga tushsa ham advisory lock bitta
qoʻllanishni kafolatlaydi. Kengaytmalarni yaratish uchun superuser kerak boʻlgani sabab ular yuqorida oldindan yaratiladi.

## 3. Kod va build

```bash
sudo useradd --system --home /opt/talaba --shell /usr/sbin/nologin talaba
sudo mkdir -p /opt/talaba /var/lib/talaba/storage /var/backups/talaba /etc/talaba
sudo chown -R talaba:talaba /opt/talaba /var/lib/talaba /var/backups/talaba
sudo -u talaba git clone <repo> /opt/talaba && cd /opt/talaba
sudo -u talaba pnpm install --frozen-lockfile
sudo -u talaba pnpm -r build        # apps/miniapp/dist (Mini App) + apps/server/dist (server, worker, CLI)
```

## 4. Sozlamalar

```bash
sudo cp .env.example /etc/talaba/talaba.env
sudo chown root:talaba /etc/talaba/talaba.env && sudo chmod 640 /etc/talaba/talaba.env
sudo editor /etc/talaba/talaba.env
```

Majburiy: `PUBLIC_BASE_URL` (https), `DATABASE_URL`, `STORAGE_DIR=/var/lib/talaba/storage`,
`SIGNING_SECRET`, Telegram uchta qiymati, `MINIAPP_DIST_DIR=/opt/talaba/apps/miniapp/dist`,
`DELETION_LOG_PATH=/var/lib/talaba/deletion-log.jsonl` (storage papkasidan TASHQARIDA).
Ixtiyoriy: `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (aks holda AI’siz matndan rejim),
`EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY`, `PAYMENTS_ENABLED`, `METRICS_TOKEN`, `SUPPORT_CHAT_ID`.

## 5. Xizmatlar

```bash
sudo cp ops/talaba-api.service ops/talaba-worker.service ops/talaba-backup.service ops/talaba-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now talaba-api talaba-worker talaba-backup.timer
curl -s http://127.0.0.1:8080/readyz     # {"ok":true}
```

- `talaba-api` — HTTP API, Telegram webhook, Mini App statik fayllari (`/app/`), xona WebSocket’lari (`/ws/rooms`).
- `talaba-worker` — fon ishlari (OCR, quiz, slayd, eksport, maʼlumot eksporti/oʻchirish), Telegram outbox,
  guruh quiz taymeri. Koʻproq worker kerak boʻlsa — `WORKER_CONCURRENCY` ni oshiring yoki boshqa hostda ham ishga
  tushiring: ishlar lease bilan olinadi, ikki marta bajarilmaydi; toʻxtatilgan ish checkpoint’dan davom etadi.
  Boshqa hostdagi worker uchun `STORAGE_DIR` umumiy boʻlishi shart (NFS yoki S3 adapter — hozir `LocalStorage`).

## 6. HTTPS va reverse proxy

```bash
sudo cp ops/Caddyfile /etc/caddy/Caddyfile   # domen nomini almashtiring
sudo systemctl reload caddy
```

Caddy sertifikatni avtomatik oladi. WebSocket (`/ws/rooms`) ham shu proksi orqali ishlaydi.
Telegram webhook HTTPS 443/80/88/8443 portlaridan birini talab qiladi — Caddy 443’da.

## 7. Telegram

[setup-telegram.md](setup-telegram.md) — BotFather, Main Mini App va `node dist/telegram-setup.js`.

## 8. Tekshirish

```bash
SMOKE_URL=https://<domen> TELEGRAM_BOT_TOKEN=<token> npx tsx apps/server/scripts/smoke.ts apps/server/test/fixtures/generated/iqtisodiyot.pdf
```

Kutiladigan natija (sinov muhitida oʻlchangan): hujjat ~1 s da oʻqiladi, quiz, 12 slayd, PPTX va PDF eksport — jami ~8 s.

## 9. Yangilash

```bash
cd /opt/talaba && sudo -u talaba git pull && sudo -u talaba pnpm install --frozen-lockfile && sudo -u talaba pnpm -r build
sudo systemctl restart talaba-api talaba-worker   # migratsiyalar API start’ida qoʻllanadi
```

Worker’ni qayta ishga tushirish xavfsiz: bajarilayotgan ish lease muddati tugagach boshqa worker tomonidan
checkpoint’dan davom ettiriladi ([evidence: test/resilience.test.ts](../apps/server/test/resilience.test.ts)).
Jonli xonalar API qayta ishga tushganda mijoz tomondan avtomatik qayta ulanadi va holat serverdan tiklanadi.

## 10. Kengaytirish

| Yuklama oshsa | Qadam |
|---|---|
| Fon ishlari navbati uzaysa (`talaba_jobs_oldest_queued_seconds`) | `WORKER_CONCURRENCY` ni oshiring yoki umumiy `STORAGE_DIR` bilan yangi worker host qoʻshing (LibreOffice va OCR CPU talab qiladi; taxminan 1 vCPU ga 1 parallel eksport yoki OCR — oʻlchanmagan taxmin) |
| API p95 oshsa | API jarayonini bir nechta hostda ishga tushiring; xona hodisalari Postgres `LISTEN/NOTIFY` orqali barcha nusxalarga tarqaladi |
| Fayllar koʻpaysa | `STORAGE_DIR` ni alohida diskka koʻchiring; koʻp hostli API uchun umumiy fayl tizimi yoki S3 adapter kerak (hozir `LocalStorage`) |
| Postgres | Avval vertikal (RAM/IOPS), keyin read-replica; `chunks` jadvali eng tez oʻsadi |
