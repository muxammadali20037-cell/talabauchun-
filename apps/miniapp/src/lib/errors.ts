import type { MessageKey } from "@talaba/shared";
import { ApiError } from "./api";

/** Maps stable server error codes to user-facing messages (no stack traces / model ids ever shown). */
export function errorMessage(e: unknown, t: (k: MessageKey, v?: Record<string, string | number>) => string): string {
  if (!(e instanceof ApiError)) return t("common.error");
  const d = e.details ?? {};
  switch (e.code) {
    case "offline":
    case "network_error":
      return t("common.offline");
    case "forbidden":
      return t("common.forbidden");
    case "not_found":
      return t("common.notFound");
    case "credits_insufficient":
      return t("credits.notEnough", { need: Number(d.need ?? 0), balance: Number(d.balance ?? 0) });
    case "file_too_large":
      return t("library.tooLarge", { size: Number(d.sizeMb ?? "?"), max: Number(d.maxMb ?? 50) });
    case "file_unsupported":
    case "file_macro_not_allowed":
      return t("library.unsupported");
    case "questions_not_approved":
    case "questions_without_evidence":
      return t("quiz.cannotPublishUnverified");
    case "invite_invalid":
    case "room_closed":
      return t("room.expiredInvite");
    case "initdata_expired":
    case "initdata_invalid":
    case "unauthorized":
      return t("common.openInTelegramHint");
    case "quiz_too_many_questions":
      return t("errors.tooManyQuestions", { max: Number(d.max ?? 0) });
    case "daily_ai_limit":
      return t("errors.dailyAiLimit", { limit: Number(d.limit ?? 0) });
    case "file_too_large_for_plan":
      return t("errors.fileTooLargeForPlan", { max: Number(d.maxMb ?? 0) });
    case "ai_rate_limited":
    case "ai_timeout":
    case "ai_provider_error":
      return t("errors.aiBusy");
    case "rate_limited":
      return t("errors.rateLimited");
    default: {
      const known = ["admin_reauth_required", "ai_required", "ai_disabled", "payments_disabled", "plan_unavailable", "telegram_not_configured", "last_owner", "assignee_not_member",
        "already_submitted", "exam_date_in_past", "confirmation_required", "not_enough_values", "web_search_not_enabled", "payer_unknown", "job_not_failed", "link_expired", "not_enough_text"];
      return known.includes(e.code) ? t(`errors.${e.code}` as MessageKey) : t("common.error");
    }
  }
}
