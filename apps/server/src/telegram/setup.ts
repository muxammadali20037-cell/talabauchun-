import type { Deps } from "../deps";

export const ALLOWED_UPDATES = ["message", "callback_query", "poll", "poll_answer", "my_chat_member", "pre_checkout_query"] as const;

const COMMANDS: Record<"uz" | "ru" | "en", [string, string][]> = {
  uz: [
    ["start", "Bosh menyu"], ["quiz", "Quizlar va mashq"], ["slides", "Prezentatsiyalar"], ["library", "Kutubxona"], ["progress", "Natijalarim"],
    ["settings", "Til va sozlamalar"], ["buy", "Tarif va kreditlar"], ["support", "Yordam soʻrash"], ["paysupport", "Toʻlov boʻyicha yordam"],
    ["help", "Qoʻllanma"], ["terms", "Foydalanish shartlari"], ["privacy", "Maxfiylik"],
  ],
  ru: [
    ["start", "Главное меню"], ["quiz", "Квизы и практика"], ["slides", "Презентации"], ["library", "Библиотека"], ["progress", "Мои результаты"],
    ["settings", "Язык и настройки"], ["buy", "Тариф и кредиты"], ["support", "Написать в поддержку"], ["paysupport", "Поддержка по оплате"],
    ["help", "Справка"], ["terms", "Условия использования"], ["privacy", "Конфиденциальность"],
  ],
  en: [
    ["start", "Main menu"], ["quiz", "Quizzes and practice"], ["slides", "Presentations"], ["library", "Library"], ["progress", "My results"],
    ["settings", "Language and settings"], ["buy", "Plan and credits"], ["support", "Contact support"], ["paysupport", "Payment support"],
    ["help", "Help"], ["terms", "Terms of use"], ["privacy", "Privacy"],
  ],
};

const DESCRIPTION = {
  uz: { short: "Kitob va maʼruzadan manbali quiz, prezentatsiya va guruh bellashuvi.", long: "TALABA AI — oʻqishni yengillashtir, bilimni mustahkamla.\n\nKitob, maʼruza yoki savollaringizni yuboring: manbasi koʻrsatilgan quiz, tahrirlanadigan PPTX/PDF prezentatsiya, kartochkalar va imtihon rejasi tayyorlang, guruhda birga yeching." },
  ru: { short: "Квизы с источниками, презентации и групповые соревнования из ваших учебников.", long: "TALABA AI — учиться легче, знания крепче.\n\nОтправьте учебник, лекцию или свои вопросы: квизы с источниками, редактируемые презентации PPTX/PDF, карточки и план к экзамену, решайте вместе с группой." },
  en: { short: "Sourced quizzes, presentations and group challenges from your study material.", long: "TALABA AI — make studying lighter, make knowledge stick.\n\nSend a textbook, lecture or your own questions: sourced quizzes, editable PPTX/PDF presentations, flashcards and an exam plan, and play together with your group." },
};

/**
 * Applies the bot settings that the Bot API can set: webhook (with secret and
 * the update types we handle), command menus per language, the chat menu
 * button that opens the Mini App, and descriptions. The Main Mini App itself
 * is configured once in @BotFather (see docs/setup-telegram.md).
 */
export async function configureTelegram(deps: Deps, opts: { webhook?: boolean } = {}) {
  if (!deps.tg) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const base = deps.cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (!base.startsWith("https://")) throw new Error(`PUBLIC_BASE_URL must be https (got ${base})`);
  const done: string[] = [];
  const me = await deps.tg.call<{ username: string }>("getMe");
  if (deps.cfg.TELEGRAM_BOT_USERNAME && me.username.toLowerCase() !== deps.cfg.TELEGRAM_BOT_USERNAME.replace(/^@/, "").toLowerCase()) {
    throw new Error(`TELEGRAM_BOT_USERNAME (${deps.cfg.TELEGRAM_BOT_USERNAME}) does not match the token's bot (@${me.username})`);
  }
  if (opts.webhook !== false) {
    if (!deps.cfg.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
    await deps.tg.call("setWebhook", { url: `${base}/telegram/webhook`, secret_token: deps.cfg.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ALLOWED_UPDATES, max_connections: 40, drop_pending_updates: false });
    done.push("setWebhook");
  }
  for (const lang of ["uz", "ru", "en"] as const) {
    const commands = COMMANDS[lang].map(([command, description]) => ({ command, description }));
    await deps.tg.call("setMyCommands", { commands, scope: { type: "all_private_chats" }, ...(lang === "uz" ? {} : { language_code: lang }) });
    await deps.tg.call("setMyDescription", { description: DESCRIPTION[lang].long, ...(lang === "uz" ? {} : { language_code: lang }) });
    await deps.tg.call("setMyShortDescription", { short_description: DESCRIPTION[lang].short, ...(lang === "uz" ? {} : { language_code: lang }) });
  }
  done.push("setMyCommands×3", "setMyDescription×3", "setMyShortDescription×3");
  // groups only need the start-a-quiz flow; everything else happens in private chat or the Mini App
  await deps.tg.call("setMyCommands", { commands: [{ command: "start", description: "TALABA AI" }], scope: { type: "all_group_chats" } });
  await deps.tg.call("setChatMenuButton", { menu_button: { type: "web_app", text: "TALABA AI", web_app: { url: `${base}/app/` } } });
  done.push("setMyCommands(groups)", "setChatMenuButton");
  const info = opts.webhook !== false ? await deps.tg.call<{ url: string; pending_update_count: number; last_error_message?: string }>("getWebhookInfo") : null;
  return { bot: me.username, done, webhook: info };
}
