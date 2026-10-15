/**
 * Platform limits. Telegram values were checked against the Bot API type
 * definitions shipped in @grammyjs/types@5.0.0 (mirrors core.telegram.org,
 * Bot API 9.6+: `correct_option_ids`, 1-12 options, open_period 5-2628000).
 * Re-verify against https://core.telegram.org/bots/api before relying on them.
 */
export const TELEGRAM = {
  pollQuestionMax: 300,
  pollOptionMax: 100,
  pollOptionsMin: 1,
  pollOptionsMax: 12,
  pollExplanationMax: 200,
  pollExplanationMaxLineFeeds: 2,
  pollOpenPeriodMin: 5,
  pollOpenPeriodMax: 2_628_000,
  messageTextMax: 4096,
  captionMax: 1024,
  callbackDataMaxBytes: 64,
  /** getFile download limit for bots on the public Bot API server. */
  botFileDownloadMaxBytes: 20 * 1024 * 1024,
  /** startapp / start parameter: A-Z a-z 0-9 _ - ; keep <= 64 to be safe for both. */
  startParamMax: 64,
} as const;

export const QUIZ_DEFAULTS = {
  optionsPerQuestion: 4,
  questionCounts: [10, 20] as const,
  maxQuestionsFree: 30,
  timePerQuestionSec: 30,
  pointsCorrect: 100,
  speedBonusMax: 50,
} as const;

export const DECK_DEFAULTS = {
  slideCount: 12,
  minSlides: 4,
  maxSlides: 40,
  aspect: "16:9" as const,
} as const;

export const UPLOAD_LIMITS = {
  maxBytesDefault: 50 * 1024 * 1024,
  maxPdfPages: 800,
  maxTextChars: 2_000_000,
} as const;
