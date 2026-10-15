# Brend: matn va vizual tizim, bot avatari brifi

## Asosiy

- Nomi: **TALABA AI** (har doim katta harf bilan, tarjima qilinmaydi).
- Shior (ishchi): **“Oʻqishni yengillashtir. Bilimni mustahkamla.”** (ru: «Учиться легче — знания крепче.», en: “Make studying lighter. Make knowledge stick.”)
- Ohang: hurmatli, qisqa, aniq; talabaga “siz” bilan. Vaʼda bermaymiz: baho, tezlik yoki “xatosiz AI” kafolati yoʻq.
  Har bir xatoda keyingi qadam aytiladi (master prompt, 24-boʻlim — ilovadagi xato matnlari shunga qurilgan).
- Tillar: oʻzbek (lotin — asosiy, kirill — avtomatik transliteratsiya, brend soʻzlari saqlanadi), rus, ingliz.
  Oʻzbek imlosi: oʻ/gʻ uchun ʻ (U+02BB), tutuq belgisi ʼ (U+02BC).

## Rang va shakl (Mini App tokenlari bilan bir xil)

| Token | Yorugʻ | Qorongʻi | Qayerda |
|---|---|---|---|
| `--c-primary` | `#4F46E5` (indigo) | `#818CF8` | asosiy tugmalar, aktiv holat |
| `--c-bg` | `#F8FAFC` | `#0B1120` | fon |
| `--c-text` | `#0F172A` | `#F1F5F9` | matn |

Kontrast WCAG AA (`apps/miniapp/src/lib/contrast.test.ts` va e2e qorongʻi rejim testi tekshiradi).
Prezentatsiya mavzulari: Academic Clean, Modern Data, Creative Seminar (`apps/server/src/slides/themes.ts`).
Toʻliq tokenlar va komponentlar: [design-system.md](design-system.md).

## Bot avatari uchun dizayn brifi

- **Format:** kvadrat 640×640 px PNG, Telegram uni doiraga qirqadi — muhim element markaziy 70% doirada.
- **Gʻoya:** ochiq kitob + yulduzcha/uchqun (AI) yoki “T” harfi kitob sahifalaridan; ortiqcha detal yoʻq,
  32 px da ham tanilsin.
- **Ranglar:** fon `#4F46E5` → `#6366F1` yengil gradient, belgi oq (`#FFFFFF`); qorongʻi va yorugʻ Telegram mavzusida ham koʻrinsin.
- **Taqiqlar:** matn (kichik oʻlchamda oʻqilmaydi), boshqa brendlar logotipi, universitet gerblari, odam yuzi.
- **Topshiriladi:** avatar 640×640 PNG; Mini App uchun 512×512 ikonka; BotFather “description picture” 640×360;
  3 ta promo karta (1080×1350): “Kitobdan manbali quiz”, “Materialdan prezentatsiya”, “Guruh bilan bellashuv”
  — haqiqiy ilova skrinshotlaridan (docs/evidence/e2e) foydalaning, oʻlchanmagan raqam yozmang.

## Onboarding matni (ilovada mavjud)

1. Bot `/start`: “Assalomu alaykum, {ism}! 👋 TALABA AI — materialni yuklang, tushuning, tayyorlang va birga oʻrganing. Nimadan boshlaymiz?” + til tanlash.
2. Mini App onboarding (uch qisqa, oʻtkazib yuborsa boʻladigan qadam): til → maqsad (prezentatsiya / quiz / kitobni oʻrganish / savolga javob) → ixtiyoriy taʼlim profili (talaba/oʻqituvchi — administrator huquqi bermaydi).
3. Bosh sahifa: oxirgi ish, tezkor amallar, “Oʻqish” (kartochkalar, xatolar daftari, imtihon rejasi, tushuntiruvchi), muddatlar.

## Tarqalish qoidalari

- Asosiy yoʻl — foydali natijani ulashish: jonli xona yoki guruh quizi havolasi; qatnashuvchi bir bosishda kiradi.
- Ulashish majburiy emas; hech kimga avtomatik reklama yoki taklif xabari yuborilmaydi.
- Referal mukofoti hozir yoʻq. Qoʻshilsa — taklif qilingan odam haqiqiy foydali amal (masalan, birinchi tasdiqlangan quiz) bajargandan keyin.
