import { isLang, LANG_LABELS, LANGS, TELEGRAM, type Lang } from "@talaba/shared";
import type { Deps } from "../deps";
import { getUserByTelegramId, upsertTelegramUser, type UserRow } from "../auth/users";
import { createDocumentFromFile, createDocumentFromText, createDocumentFromUrl } from "../ingest/documents";
import { createQuiz } from "../quiz/service";
import { activeAttempt, answerAttempt, attemptResults, attemptState, finishAttempt, startAttempt, startMistakesAttempt } from "../quiz/practice";
import { linkRunToChat, recordPollAnswer, recordPollState, startRun } from "../group/native-quiz";
import { getBalance } from "../billing/credits";
import { handlePreCheckout, handleSuccessfulPayment, sendPlanInvoice } from "../billing/stars";
import { AppError } from "../lib/errors";
import { TelegramError } from "./api";
import { appButton, escapeHtml, longId, mainMenu, shortId, t, type InlineButton } from "./ui";

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string; is_bot?: boolean };
type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
type TgMessage = {
  message_id: number; from?: TgUser; chat: TgChat; text?: string; caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  successful_payment?: Record<string, unknown>;
};
type TgCallback = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  poll_answer?: { poll_id: string; user?: TgUser; voter_chat?: TgChat; option_ids: number[] };
  poll?: { id: string; is_closed: boolean; total_voter_count: number; options: { voter_count: number }[] };
  my_chat_member?: { chat: TgChat; from: TgUser; new_chat_member: { status: string; user: TgUser } };
  pre_checkout_query?: { id: string; from: TgUser; currency: string; total_amount: number; invoice_payload: string };
};

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

export class Bot {
  constructor(private readonly deps: Deps) {}

  private get api() {
    if (!this.deps.tg) throw new Error("telegram not configured");
    return this.deps.tg;
  }

  private send(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
    return this.api.callWithRetry<{ message_id: number }>("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  }

  /** Processes one update exactly once (update_id dedupe). Heavy work is queued as jobs. */
  async handle(update: TgUpdate) {
    const [fresh] = await this.deps.sql<{ update_id: string }[]>`insert into processed_updates (update_id) values (${update.update_id}) on conflict do nothing returning update_id`;
    if (!fresh) return;
    try {
      if (update.message) await this.onMessage(update.message);
      else if (update.callback_query) await this.onCallback(update.callback_query);
      else if (update.poll_answer) await recordPollAnswer(this.deps, update.poll_answer);
      else if (update.poll) await recordPollState(this.deps, update.poll);
      else if (update.my_chat_member) await this.onMyChatMember(update.my_chat_member);
      else if (update.pre_checkout_query) await handlePreCheckout(this.deps, update.pre_checkout_query);
    } catch (e) {
      this.deps.log.error({ err: e instanceof Error ? e.message : String(e), updateId: update.update_id }, "bot update failed");
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      if (chatId && update.message?.chat.type !== "group" && update.message?.chat.type !== "supergroup") {
        const lang = await this.langOf(update.message?.from ?? update.callback_query?.from);
        await this.send(chatId, t(lang, "bot.errorGeneric")).catch(() => {});
      }
    }
  }

  private async langOf(u?: TgUser): Promise<Lang> {
    if (!u) return "uz";
    const user = await getUserByTelegramId(this.deps.sql, u.id);
    return user?.language ?? "uz";
  }

  private async user(from: TgUser, privateChat: boolean): Promise<UserRow> {
    return upsertTelegramUser(this.deps.sql, this.deps.cfg, from, { privateChat });
  }

  // ───────────── messages ─────────────
  private async onMessage(m: TgMessage) {
    if (!m.from || m.from.is_bot) return;
    if (m.chat.type === "group" || m.chat.type === "supergroup") return this.onGroupMessage(m);
    if (m.chat.type !== "private") return;
    const user = await this.user(m.from, true);
    const lang = user.language;
    if (m.successful_payment) return handleSuccessfulPayment(this.deps, user, m.successful_payment as never);
    const text = (m.text ?? "").trim();
    if (text.startsWith("/")) return this.onCommand(user, m, text);

    if (m.document || m.photo) return this.onFile(user, m);

    const [state] = await this.deps.sql<{ state: string; data: Record<string, unknown> }[]>`select state, data from bot_states where user_id = ${user.id}`;
    if (state?.state === "awaiting_support" || state?.state === "awaiting_paysupport") {
      const [ticket] = await this.deps.sql<{ id: string }[]>`
        insert into support_tickets (user_id, kind, body) values (${user.id}, ${state.state === "awaiting_paysupport" ? "paysupport" : "support"}, ${text.slice(0, 4000)}) returning id::text`;
      await this.deps.sql`delete from bot_states where user_id = ${user.id}`;
      if (this.deps.cfg.SUPPORT_CHAT_ID) {
        await this.send(this.deps.cfg.SUPPORT_CHAT_ID, `#${ticket!.id} (${state.state})\n${escapeHtml(text.slice(0, 3000))}`).catch(() => {});
      }
      return this.send(m.chat.id, t(lang, "bot.supportReceived", { id: ticket!.id }));
    }
    if (/^https?:\/\/\S+$/i.test(text)) {
      await createDocumentFromUrl(this.deps, { user, url: text, via: "bot", notifyChatId: m.chat.id });
      return this.send(m.chat.id, t(lang, "bot.fileReceived", { title: escapeHtml(text.slice(0, 80)) }));
    }
    if (text.length >= 300) {
      // Long pasted text becomes a text source in the library.
      const title = text.split("\n")[0]!.slice(0, 60);
      await createDocumentFromText(this.deps, { user, title, text, via: "bot", notifyChatId: m.chat.id });
      return this.send(m.chat.id, t(lang, "bot.fileReceived", { title: escapeHtml(title) }));
    }
    return this.send(m.chat.id, t(lang, "bot.unknown"), { reply_markup: mainMenu(this.deps.cfg, lang) });
  }

  private async onFile(user: UserRow, m: TgMessage) {
    const lang = user.language;
    const doc = m.document;
    const photo = m.photo ? m.photo[m.photo.length - 1] : undefined;
    const fileId = doc?.file_id ?? photo?.file_id;
    const size = doc?.file_size ?? photo?.file_size ?? 0;
    const max = Math.min(TELEGRAM.botFileDownloadMaxBytes, this.deps.cfg.MAX_UPLOAD_MB * 1024 * 1024);
    if (!fileId) return;
    if (size > max) {
      return this.send(m.chat.id, t(lang, "bot.fileTooBigForBot", { max: Math.floor(max / 1048576) }), { reply_markup: { inline_keyboard: [appButton(this.deps.cfg, lang, "/library/upload", "library.upload")].filter((r) => r.length) } });
    }
    const filename = doc?.file_name ?? `rasm-${m.message_id}.jpg`;
    let data: Buffer;
    try {
      data = (await this.api.downloadFile(fileId, max)).data;
    } catch (e) {
      if (e instanceof TelegramError && e.code === 413) return this.send(m.chat.id, t(lang, "bot.fileTooBigForBot", { max: Math.floor(max / 1048576) }));
      throw e;
    }
    try {
      const r = await createDocumentFromFile(this.deps, { user, filename, data, via: "bot", notifyChatId: m.chat.id, title: m.caption?.slice(0, 200) || undefined });
      await this.send(m.chat.id, t(lang, "bot.fileReceived", { title: escapeHtml(m.caption || filename) }), {
        reply_markup: { inline_keyboard: [appButton(this.deps.cfg, lang, `/library/${r.documentId}`)].filter((x) => x.length) },
      });
    } catch (e) {
      if (e instanceof AppError) {
        const key = e.code === "file_unsupported" || e.code === "file_macro_not_allowed" ? "library.unsupported" : e.code === "file_too_large" ? "library.tooLarge" : "bot.errorGeneric";
        return this.send(m.chat.id, t(lang, key as never, { size: Math.ceil(data.length / 1048576), max: this.deps.cfg.MAX_UPLOAD_MB }));
      }
      throw e;
    }
  }

  private async onCommand(user: UserRow, m: TgMessage, text: string) {
    const lang = user.language;
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw!.split("@")[0]!.toLowerCase();
    const chatId = m.chat.id;
    switch (cmd) {
      case "/start": {
        const param = args[0] ?? "";
        if (param.startsWith("r") && param.length > 10) {
          // room invite opened via the bot: hand over to the Mini App with the same start parameter
          const btn = appButton(this.deps.cfg, lang, `/join/${param.slice(1)}`, "room.join");
          return this.send(chatId, t(lang, "room.title"), { reply_markup: { inline_keyboard: btn.length ? [btn] : [] } });
        }
        if (!user.language_confirmed) {
          await this.send(chatId, t(lang, "bot.welcome", { name: escapeHtml(user.first_name || "") }), { reply_markup: mainMenu(this.deps.cfg, lang) });
          return this.sendLanguagePicker(chatId, lang);
        }
        return this.send(chatId, t(lang, "bot.welcome", { name: escapeHtml(user.first_name || "") }), { reply_markup: mainMenu(this.deps.cfg, lang) });
      }
      case "/help":
        return this.send(chatId, t(lang, "bot.help"), { reply_markup: mainMenu(this.deps.cfg, lang) });
      case "/quiz":
        return this.showQuizzes(user, chatId);
      case "/slides":
        return this.showDecks(user, chatId);
      case "/library":
        return this.showLibrary(user, chatId);
      case "/progress":
        return this.showProgress(user, chatId);
      case "/settings":
        return this.sendLanguagePicker(chatId, lang);
      case "/support":
        await this.deps.sql`insert into bot_states (user_id, state) values (${user.id}, 'awaiting_support') on conflict (user_id) do update set state = excluded.state, updated_at = now()`;
        return this.send(chatId, t(lang, "bot.support"));
      case "/paysupport":
        await this.deps.sql`insert into bot_states (user_id, state) values (${user.id}, 'awaiting_paysupport') on conflict (user_id) do update set state = excluded.state, updated_at = now()`;
        return this.send(chatId, t(lang, "bot.paysupport"));
      case "/terms":
        return this.send(chatId, t(lang, "bot.terms", { url: this.deps.cfg.TERMS_URL ?? `${this.deps.cfg.PUBLIC_BASE_URL}/app/#/terms` }));
      case "/privacy":
        return this.send(chatId, t(lang, "bot.privacy", { url: this.deps.cfg.PRIVACY_URL ?? `${this.deps.cfg.PUBLIC_BASE_URL}/app/#/privacy` }));
      case "/buy":
        return sendPlanInvoice(this.deps, user, chatId, args[0] ?? "student_plus");
      case "/cancel":
        await this.deps.sql`delete from bot_states where user_id = ${user.id}`;
        return this.send(chatId, t(lang, "bot.cancelled"), { reply_markup: mainMenu(this.deps.cfg, lang) });
      default:
        return this.send(chatId, t(lang, "bot.unknown"), { reply_markup: mainMenu(this.deps.cfg, lang) });
    }
  }

  private sendLanguagePicker(chatId: number, lang: Lang) {
    return this.send(chatId, t(lang, "bot.chooseLanguage"), {
      reply_markup: { inline_keyboard: LANGS.map((l) => [{ text: LANG_LABELS[l], callback_data: `lang:${l}` }]) },
    });
  }

  private async showLibrary(user: UserRow, chatId: number) {
    const lang = user.language;
    const docs = await this.deps.sql<{ id: string; title: string; status: string | null; pages_ok: number; page_count: number | null }[]>`
      select d.id, d.title, v.status, v.pages_ok, v.page_count from documents d
      left join lateral (select * from document_versions x where x.document_id = d.id order by version_no desc limit 1) v on true
      where d.owner_id = ${user.id} and d.deleted_at is null order by d.created_at desc limit 10`;
    if (!docs.length) return this.send(chatId, t(lang, "library.empty") + "\n\n" + t(lang, "bot.sendBookHint"));
    const lines = docs.map((d) => `• ${escapeHtml(d.title)} — ${statusLabel(lang, d.status)}${d.page_count ? ` (${d.pages_ok}/${d.page_count})` : ""}`);
    return this.send(chatId, `<b>${t(lang, "library.title")}</b>\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: [appButton(this.deps.cfg, lang, "/library")].filter((r) => r.length) } });
  }

  private async showDecks(user: UserRow, chatId: number) {
    const lang = user.language;
    const decks = await this.deps.sql<{ id: string; title: string; status: string }[]>`select id, title, status from decks where owner_id = ${user.id} and deleted_at is null order by updated_at desc limit 8`;
    const rows: InlineButton[][] = decks.map((d) => appButton(this.deps.cfg, lang, `/decks/${d.id}`).map((b) => ({ ...b, text: `📊 ${d.title.slice(0, 40)}` }))).filter((r) => r.length);
    const create = appButton(this.deps.cfg, lang, "/decks/new", "deck.create");
    if (create.length) rows.unshift(create);
    return this.send(chatId, `<b>${t(lang, "deck.title")}</b>`, { reply_markup: { inline_keyboard: rows } });
  }

  private async showProgress(user: UserRow, chatId: number) {
    const lang = user.language;
    const [s] = await this.deps.sql<{ attempts: number; avg: number | null; mistakes: number }[]>`
      select count(*) filter (where status = 'finished')::int as attempts,
        round(avg(case when status = 'finished' and max_score > 0 then score * 100.0 / max_score end))::int as avg,
        (select count(distinct aa.question_id)::int from attempt_answers aa join attempts a2 on a2.id = aa.attempt_id where a2.user_id = ${user.id} and not aa.is_correct) as mistakes
      from attempts where user_id = ${user.id}`;
    return this.send(chatId, t(lang, "bot.progress", { attempts: s?.attempts ?? 0, avg: s?.avg ?? 0, mistakes: s?.mistakes ?? 0 }));
  }

  private async showQuizzes(user: UserRow, chatId: number) {
    const lang = user.language;
    const active = await activeAttempt(this.deps, user, "bot_practice");
    if (active) {
      const st = await attemptState(this.deps, user, active);
      if (st.question) {
        await this.send(chatId, t(lang, "bot.practiceResumeAsk", { title: escapeHtml(st.title), i: st.index + 1, n: st.total }), {
          reply_markup: { inline_keyboard: [[{ text: t(lang, "common.continue"), callback_data: `pn:${shortId(active)}` }, { text: t(lang, "common.cancel"), callback_data: `ps:${shortId(active)}` }]] },
        });
      }
    }
    const quizzes = await this.deps.sql<{ id: string; title: string; published: boolean }[]>`
      select q.id, q.title, q.published_version_id is not null as published from quizzes q
      where q.deleted_at is null and q.workspace_id in (select workspace_id from memberships where user_id = ${user.id})
      order by q.updated_at desc limit 8`;
    const rows: InlineButton[][] = quizzes.map((q) => [{ text: `${q.published ? "▶️" : "📝"} ${q.title.slice(0, 50)}`, callback_data: `qp:${q.id}` }]);
    rows.push([{ text: "➕ " + t(lang, "quiz.create"), callback_data: "qw:start" }]);
    return this.send(chatId, quizzes.length ? t(lang, "bot.quizList") : t(lang, "bot.noQuizzes"), { reply_markup: { inline_keyboard: rows } });
  }

  // ───────────── callbacks ─────────────
  private async onCallback(cb: TgCallback) {
    const data = cb.data ?? "";
    const chat = cb.message?.chat;
    if (chat && (chat.type === "group" || chat.type === "supergroup")) return this.onGroupCallback(cb);
    const user = await this.user(cb.from, true);
    const lang = user.language;
    const chatId = chat?.id ?? cb.from.id;
    const ack = (text?: string, alert = false) => this.api.call("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text: text.slice(0, 200), show_alert: alert } : {}) }).catch(() => {});

    if (data.startsWith("lang:")) {
      const l = data.slice(5);
      if (!isLang(l)) return ack();
      await this.deps.sql`update users set language = ${l}, language_confirmed = true, updated_at = now() where id = ${user.id}`;
      await ack(t(l, "bot.languageSaved", { lang: LANG_LABELS[l] }));
      return this.send(chatId, t(l, "bot.welcome", { name: escapeHtml(user.first_name || "") }), { reply_markup: mainMenu(this.deps.cfg, l) });
    }
    if (data.startsWith("m:")) {
      await ack();
      switch (data) {
        case "m:quiz":
          return this.showQuizzes(user, chatId);
        case "m:slides":
          return this.showDecks(user, chatId);
        case "m:book":
          return this.send(chatId, t(lang, "bot.sendBookHint"));
        case "m:ask":
          return this.send(chatId, t(lang, "bot.askHint"), { reply_markup: { inline_keyboard: [appButton(this.deps.cfg, lang, "/tutor")].filter((r) => r.length) } });
        case "m:lang":
          return this.sendLanguagePicker(chatId, lang);
        case "m:work": {
          const [c] = await this.deps.sql<{ docs: number; quizzes: number; decks: number }[]>`
            select (select count(*)::int from documents where owner_id = ${user.id} and deleted_at is null) as docs,
                   (select count(*)::int from quizzes where owner_id = ${user.id} and deleted_at is null) as quizzes,
                   (select count(*)::int from decks where owner_id = ${user.id} and deleted_at is null) as decks`;
          const bal = await getBalance(this.deps.sql, user.id);
          return this.send(chatId, t(lang, "bot.myWork", { docs: c!.docs, quizzes: c!.quizzes, decks: c!.decks }) + "\n" + t(lang, "profile.balance", { n: bal }), {
            reply_markup: { inline_keyboard: [appButton(this.deps.cfg, lang, "/")].filter((r) => r.length) },
          });
        }
      }
      return;
    }
    // quiz wizard
    if (data === "qw:start") {
      await ack();
      const docs = await this.deps.sql<{ id: string; title: string }[]>`
        select d.id, d.title from documents d join document_versions v on v.id = d.current_version_id
        where d.owner_id = ${user.id} and d.deleted_at is null and v.status in ('ready','partial') order by d.created_at desc limit 8`;
      if (!docs.length) return this.send(chatId, t(lang, "quiz.noSources") + "\n\n" + t(lang, "bot.sendBookHint"));
      return this.send(chatId, t(lang, "bot.quizWizardSource"), { reply_markup: { inline_keyboard: docs.map((d) => [{ text: `📚 ${d.title.slice(0, 50)}`, callback_data: `qw:d:${d.id}` }]) } });
    }
    if (data.startsWith("qw:d:")) {
      await ack();
      const docId = data.slice(5);
      return this.send(chatId, t(lang, "bot.quizWizardCount"), {
        reply_markup: { inline_keyboard: [[10, 20].map((n) => ({ text: String(n), callback_data: `qw:n:${docId}:${n}` }))] },
      });
    }
    if (data.startsWith("qw:n:")) {
      const [, , docId, n] = data.split(":");
      try {
        await createQuiz(this.deps, user, { method: "from_source", documentIds: [docId], settings: { count: Number(n) }, idempotencyKey: `bot:${cb.id}` }, { notifyChatId: chatId });
        await ack();
        return this.send(chatId, t(lang, "bot.quizWizardStarted"));
      } catch (e) {
        if (e instanceof AppError && e.code === "credits_insufficient") {
          const d = e.details as { need: number; balance: number };
          await ack(t(lang, "credits.notEnough", { need: d.need, balance: d.balance }), true);
          return;
        }
        throw e;
      }
    }
    // practice
    if (data.startsWith("qp:")) {
      const quizId = data.slice(3);
      try {
        const r = await startAttempt(this.deps, user, quizId, "bot_practice");
        await ack();
        await this.send(chatId, t(lang, "bot.practiceStart", { title: escapeHtml(r.title), n: r.total }) + (r.isDraft ? `\n<i>${t(lang, "quiz.draft")}</i>` : ""));
        return this.sendPracticeQuestion(user, chatId, r.attemptId);
      } catch (e) {
        if (e instanceof AppError) return ack(t(lang, e.code === "quiz_empty" || e.code === "quiz_not_published" ? "quiz.needsReview" : "bot.errorGeneric"), true);
        throw e;
      }
    }
    if (data.startsWith("pa:")) {
      const [, sid, qIdx, optPos] = data.split(":");
      const attemptId = longId(sid!);
      const st = await attemptState(this.deps, user, attemptId);
      const qid = (await this.deps.sql<{ question_ids: string[]; option_orders: Record<string, string[]> }[]>`select question_ids, option_orders from attempts where id = ${attemptId} and user_id = ${user.id}`)[0];
      if (!qid) return ack();
      const questionId = qid.question_ids[Number(qIdx)];
      const optionId = questionId ? qid.option_orders[questionId]?.[Number(optPos)] : undefined;
      if (!questionId || !optionId) return ack();
      const r = await answerAttempt(this.deps, user, attemptId, questionId, [optionId], lang);
      await ack(r.isCorrect ? t(lang, "bot.practiceCorrect") : t(lang, "bot.practiceWrong", { answer: r.correctTexts.join(", ") }).replace(/<\/?b>/g, ""));
      const lines = [r.isCorrect ? t(lang, "bot.practiceCorrect") : t(lang, "bot.practiceWrong", { answer: escapeHtml(r.correctTexts.join(", ")) })];
      if (r.explanation) lines.push(t(lang, "bot.practiceExplanation", { text: escapeHtml(r.explanation) }));
      if (r.source) lines.push(t(lang, "bot.practiceSource", { where: escapeHtml(`${r.source.documentTitle ?? ""}, ${r.source.where}`) }));
      const original = cb.message?.text ? escapeHtml(cb.message.text) : "";
      const kb: InlineButton[][] = r.finished
        ? [[{ text: t(lang, "practice.finished"), callback_data: `ps:${sid}` }]]
        : [[{ text: t(lang, "bot.practiceNextBtn"), callback_data: `pn:${sid}` }, { text: t(lang, "bot.practiceStopBtn"), callback_data: `ps:${sid}` }]];
      if (cb.message) {
        await this.api
          .callWithRetry("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: `${original}\n\n${lines.join("\n")}`.slice(0, TELEGRAM.messageTextMax), parse_mode: "HTML", reply_markup: { inline_keyboard: kb } })
          .catch(() => this.send(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: kb } }));
      }
      if (r.finished) return this.sendPracticeResults(user, chatId, attemptId);
      void st;
      return;
    }
    if (data.startsWith("pn:")) {
      await ack();
      return this.sendPracticeQuestion(user, chatId, longId(data.slice(3)));
    }
    if (data.startsWith("ps:")) {
      await ack();
      await finishAttempt(this.deps, user, longId(data.slice(3)));
      return this.sendPracticeResults(user, chatId, longId(data.slice(3)));
    }
    if (data.startsWith("pm:")) {
      await ack();
      const r = await startMistakesAttempt(this.deps, user, longId(data.slice(3)));
      return this.sendPracticeQuestion(user, chatId, r.attemptId);
    }
    return ack();
  }

  private async sendPracticeQuestion(user: UserRow, chatId: number, attemptId: string) {
    const lang = user.language;
    const st = await attemptState(this.deps, user, attemptId);
    if (!st.question) return this.sendPracticeResults(user, chatId, attemptId);
    const q = st.question;
    const body = [t(lang, "bot.practiceQuestion", { i: st.index + 1, n: st.total, text: escapeHtml(q.text) }), "", ...q.options.map((o, i) => `${LETTERS[i]}) ${escapeHtml(o.text)}`)].join("\n");
    const sid = shortId(attemptId);
    const buttons = q.options.map((_, i) => ({ text: LETTERS[i]!, callback_data: `pa:${sid}:${st.index}:${i}` }));
    return this.send(chatId, body.slice(0, TELEGRAM.messageTextMax), { reply_markup: { inline_keyboard: [buttons, [{ text: t(lang, "bot.practiceStopBtn"), callback_data: `ps:${sid}` }]] } });
  }

  private async sendPracticeResults(user: UserRow, chatId: number, attemptId: string) {
    const lang = user.language;
    const r = await attemptResults(this.deps, user, attemptId);
    const kb: InlineButton[][] = r.mistakes.length ? [[{ text: t(lang, "bot.practiceMistakesBtn"), callback_data: `pm:${shortId(attemptId)}` }]] : [];
    return this.send(chatId, t(lang, "bot.practiceDone", { score: r.correct, max: r.total }) + (r.mistakes.length ? "" : `\n${t(lang, "practice.noMistakes")}`), { reply_markup: { inline_keyboard: kb } });
  }

  // ───────────── groups ─────────────
  private async onGroupMessage(m: TgMessage) {
    const text = (m.text ?? "").trim();
    if (!text.startsWith("/start")) return; // privacy mode: the bot only reacts to its own commands
    const param = text.split(/\s+/)[1] ?? "";
    if (!param.startsWith("g") || !m.from) return;
    const res = await linkRunToChat(this.deps, { token: param.slice(1), fromTelegramId: String(m.from.id), chatId: String(m.chat.id), chatTitle: m.chat.title ?? "" });
    if (!res.ok) return;
    try {
      await this.send(m.chat.id, t(res.lang, "bot.groupLinked", { chat: escapeHtml(m.chat.title ?? ""), title: escapeHtml(res.title), n: res.n, sec: res.openPeriod }), {
        reply_markup: { inline_keyboard: [[{ text: t(res.lang, "bot.groupStartBtn"), callback_data: `gs:${res.runId}` }]] },
      });
    } catch (e) {
      if (e instanceof TelegramError && (e.code === 403 || e.code === 400)) {
        await this.deps.sql`update group_quiz_runs set status = 'failed', error = ${e.description.slice(0, 300)} where id = ${res.runId}`;
        await this.send(m.from.id, t(res.lang, "bot.groupNoPermission")).catch(() => {});
        return;
      }
      throw e;
    }
  }

  private async onGroupCallback(cb: TgCallback) {
    const data = cb.data ?? "";
    const lang = await this.langOf(cb.from);
    if (data.startsWith("gs:")) {
      const ok = await startRun(this.deps, data.slice(3), String(cb.from.id));
      await this.api.call("answerCallbackQuery", { callback_query_id: cb.id, ...(ok ? {} : { text: t(lang, "bot.groupOnlyHost"), show_alert: true }) }).catch(() => {});
      if (ok && cb.message) await this.api.call("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    await this.api.call("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
  }

  private async onMyChatMember(u: NonNullable<TgUpdate["my_chat_member"]>) {
    if (u.chat.type === "private") {
      const blocked = u.new_chat_member.status === "kicked";
      await this.deps.sql`update users set bot_chat_open = ${!blocked}, bot_blocked_at = ${blocked ? new Date() : null} where telegram_id = ${String(u.chat.id)}`;
    }
  }
}

function statusLabel(lang: Lang, status: string | null) {
  const map: Record<string, Parameters<typeof t>[1]> = {
    queued: "library.statusQueued", uploaded: "library.statusQueued", extracting: "library.statusExtracting", indexing: "library.statusIndexing",
    ready: "library.statusReady", partial: "library.statusPartial", failed: "library.statusFailed",
  };
  return t(lang, map[status ?? "queued"] ?? "library.statusQueued");
}
