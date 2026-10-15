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
    default:
      return t("common.error");
  }
}
