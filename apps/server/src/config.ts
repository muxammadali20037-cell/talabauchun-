import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  DATABASE_URL: z.string().default("postgres://postgres@localhost:5432/talaba"),
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  STORAGE_DIR: z.string().default("./.data/storage"),
  /** HMAC key for signed download links and invite tokens. >= 32 chars in production. */
  SIGNING_SECRET: z.string().default("dev-only-signing-secret-change-me-please-0000"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_API_BASE: z.string().url().default("https://api.telegram.org"),
  /** Max age of Mini App initData accepted for sign-in. */
  TELEGRAM_INITDATA_MAX_AGE_SEC: z.coerce.number().int().default(3600),
  SESSION_TTL_HOURS: z.coerce.number().int().default(12),
  /** Comma-separated Telegram user ids that are platform admins (server-side assignment). */
  ADMIN_TELEGRAM_IDS: z.string().default(""),
  /** admin mutations need a session created within this many minutes (re-open the Mini App to refresh) */
  ADMIN_FRESH_SESSION_MIN: z.coerce.number().int().min(1).max(240).default(15),
  /** bearer token for GET /metrics (Prometheus); empty = admins only */
  METRICS_TOKEN: z.string().default(""),
  SUPPORT_CHAT_ID: z.string().optional(),
  TERMS_URL: z.string().optional(),
  PRIVACY_URL: z.string().optional(),

  AI_PROVIDER: z.enum(["anthropic", "none"]).default("none"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Optional base URL (e.g. an Anthropic-compatible gateway). */
  AI_BASE_URL: z.string().url().optional(),
  AI_MODEL_STRONG: z.string().default("claude-opus-5-5"),
  AI_MODEL_FAST: z.string().default("claude-haiku-5-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().default(120_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  EMBEDDINGS_PROVIDER: z.enum(["none", "voyage"]).default("none"),
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default("voyage-3.5"),

  OCR_LANGS: z.string().default("uzb+uzb_cyrl+rus+eng"),
  TESSERACT_BIN: z.string().default("tesseract"),
  PDFTOPPM_BIN: z.string().default("pdftoppm"),
  LIBREOFFICE_BIN: z.string().default("soffice"),
  MAX_UPLOAD_MB: z.coerce.number().int().default(50),
  MAX_PDF_PAGES: z.coerce.number().int().default(800),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  WORKER_LEASE_SEC: z.coerce.number().int().default(120),
  PAYMENTS_ENABLED: bool,
  /** Development-only sign-in bypass for local UI work; refused in production. */
  DEV_AUTH_ENABLED: bool,
  MINIAPP_DIST_DIR: z.string().default("../miniapp/dist"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof EnvSchema> & {
  adminTelegramIds: Set<string>;
  aiEnabled: boolean;
  telegramEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  if (parsed.NODE_ENV === "production") {
    const problems: string[] = [];
    if (parsed.SIGNING_SECRET.length < 32 || parsed.SIGNING_SECRET.startsWith("dev-only")) problems.push("SIGNING_SECRET must be a random value of 32+ chars");
    if (parsed.DEV_AUTH_ENABLED) problems.push("DEV_AUTH_ENABLED must be false in production");
    if (parsed.TELEGRAM_BOT_TOKEN && !parsed.TELEGRAM_WEBHOOK_SECRET) problems.push("TELEGRAM_WEBHOOK_SECRET is required when the bot is enabled");
    if (!parsed.PUBLIC_BASE_URL.startsWith("https://")) problems.push("PUBLIC_BASE_URL must be https in production");
    if (problems.length) throw new Error(`Invalid production configuration:\n- ${problems.join("\n- ")}`);
  }
  return {
    ...parsed,
    adminTelegramIds: new Set(parsed.ADMIN_TELEGRAM_IDS.split(",").map((s) => s.trim()).filter(Boolean)),
    aiEnabled: parsed.AI_PROVIDER === "anthropic" && !!parsed.ANTHROPIC_API_KEY,
    telegramEnabled: !!parsed.TELEGRAM_BOT_TOKEN,
  };
}

/** Human-readable list of integrations that still need external configuration. */
export function integrationStatus(cfg: Config) {
  return {
    telegramBot: cfg.telegramEnabled ? "configured" : "missing TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_USERNAME / TELEGRAM_WEBHOOK_SECRET",
    ai: cfg.aiEnabled ? `configured (${cfg.AI_MODEL_STRONG}, ${cfg.AI_MODEL_FAST})` : "missing AI_PROVIDER=anthropic + ANTHROPIC_API_KEY — extractive (no-AI) mode is used",
    embeddings: cfg.EMBEDDINGS_PROVIDER === "voyage" && cfg.VOYAGE_API_KEY ? `configured (${cfg.EMBEDDINGS_MODEL})` : "not configured — lexical + trigram search only",
    payments: cfg.PAYMENTS_ENABLED ? "enabled (Telegram Stars)" : "disabled",
    publicUrl: cfg.PUBLIC_BASE_URL.startsWith("https://") ? cfg.PUBLIC_BASE_URL : `not https (${cfg.PUBLIC_BASE_URL}) — Telegram webhook and Mini App require HTTPS`,
  };
}
