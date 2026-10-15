import { createHmac } from "node:crypto";
import { safeEqual } from "../lib/crypto";
import { AppError } from "../lib/errors";

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
};

export type ValidatedInitData = {
  user: TelegramWebAppUser;
  authDate: Date;
  startParam: string | null;
  chatType: string | null;
  chatInstance: string | null;
  hash: string;
};

/**
 * Validates Telegram Mini App initData exactly as documented
 * (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   data_check_string = all received fields except `hash`, sorted by key, "key=value" joined by "\n"
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   valid             = hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash
 * `signature` (Ed25519, for third parties) stays inside the data-check-string.
 * initDataUnsafe from the client is never trusted.
 */
export function validateInitData(raw: string, botToken: string, maxAgeSec: number, now = new Date()): ValidatedInitData {
  if (!raw || raw.length > 8192) throw new AppError("initdata_invalid", 401);
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new AppError("initdata_invalid", 401, "missing hash");

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== "hash") pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!safeEqual(expected, hash)) throw new AppError("initdata_invalid", 401, "bad signature");

  const authDateSec = Number(params.get("auth_date"));
  if (!Number.isFinite(authDateSec) || authDateSec <= 0) throw new AppError("initdata_invalid", 401, "bad auth_date");
  const ageSec = now.getTime() / 1000 - authDateSec;
  if (ageSec > maxAgeSec) throw new AppError("initdata_expired", 401, "initData is too old");
  if (ageSec < -300) throw new AppError("initdata_invalid", 401, "auth_date in the future");

  const userRaw = params.get("user");
  if (!userRaw) throw new AppError("initdata_invalid", 401, "missing user");
  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userRaw) as TelegramWebAppUser;
  } catch {
    throw new AppError("initdata_invalid", 401, "bad user json");
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new AppError("initdata_invalid", 401, "bad user id");

  return {
    user,
    authDate: new Date(authDateSec * 1000),
    startParam: params.get("start_param"),
    chatType: params.get("chat_type"),
    chatInstance: params.get("chat_instance"),
    hash,
  };
}

/** Test/dev helper: builds initData signed with the given bot token (same algorithm as Telegram). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}
