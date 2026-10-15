import { z } from "zod";

export const SourceMode = z.enum(["sources_only", "sources_plus_web", "general"]);
export type SourceMode = z.infer<typeof SourceMode>;

export const QuestionType = z.enum(["single", "multiple", "true_false", "matching", "ordering", "fill_blank", "short_answer"]);
export type QuestionType = z.infer<typeof QuestionType>;

export const Difficulty = z.enum(["easy", "medium", "hard"]);
export const CognitiveLevel = z.enum(["recall", "understand", "apply", "analyze"]);
export const QuestionStatus = z.enum(["draft", "needs_review", "approved", "published", "archived"]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;
export const EvidenceStatus = z.enum(["verified", "unverified", "not_found", "general_knowledge"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

export const QuizSettings = z.object({
  language: z.string().default("uz"),
  subject: z.string().max(200).optional(),
  topic: z.string().max(300).optional(),
  count: z.number().int().min(1).max(100).default(10),
  difficultyMix: z
    .object({ easy: z.number().min(0).max(1), medium: z.number().min(0).max(1), hard: z.number().min(0).max(1) })
    .default({ easy: 0.3, medium: 0.5, hard: 0.2 }),
  timePerQuestionSec: z.number().int().min(5).max(600).default(30),
  shuffleQuestions: z.boolean().default(false),
  shuffleOptions: z.boolean().default(true),
  showExplanation: z.enum(["immediately", "after_question", "after_quiz", "never"]).default("immediately"),
  resultsVisibility: z.enum(["immediately", "after_close", "host_only"]).default("immediately"),
  allowMultipleCorrect: z.boolean().default(false),
  sourceMode: SourceMode.default("sources_only"),
});
export type QuizSettings = z.infer<typeof QuizSettings>;

/** Where in a source a piece of evidence lives. Only fields that really exist are set. */
export const Locator = z.object({
  pageIndex: z.number().int().optional(),
  pageLabel: z.string().optional(),
  slide: z.number().int().optional(),
  heading: z.string().optional(),
  paragraph: z.number().int().optional(),
  sheet: z.string().optional(),
  row: z.number().int().optional(),
  url: z.string().optional(),
});
export type Locator = z.infer<typeof Locator>;

export const OptionEdit = z.object({
  id: z.string().uuid().optional(),
  text: z.string().min(1).max(500),
  whyWrong: z.string().max(1000).optional().nullable(),
  correct: z.boolean(),
});

export const QuestionEdit = z.object({
  text: z.string().min(3).max(2000),
  type: QuestionType.default("single"),
  topic: z.string().max(300).optional().nullable(),
  difficulty: Difficulty.default("medium"),
  cognitiveLevel: CognitiveLevel.default("recall"),
  explanation: z.string().max(2000).optional().nullable(),
  options: z.array(OptionEdit).min(2).max(12),
});
export type QuestionEdit = z.infer<typeof QuestionEdit>;

export const CreateQuizRequest = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("from_source"),
    title: z.string().min(1).max(200).optional(),
    documentIds: z.array(z.string().uuid()).min(1).max(10),
    pageRanges: z.array(z.object({ documentId: z.string().uuid(), from: z.number().int().min(1), to: z.number().int().min(1) })).optional(),
    sectionIds: z.array(z.string().uuid()).optional(),
    settings: QuizSettings.partial().optional(),
    useAi: z.boolean().default(true),
    idempotencyKey: z.string().min(8).max(100),
  }),
  z.object({
    method: z.literal("from_questions"),
    title: z.string().min(1).max(200).optional(),
    documentIds: z.array(z.string().uuid()).min(1).max(10),
    questionsText: z.string().min(3).max(50_000),
    settings: QuizSettings.partial().optional(),
    useAi: z.boolean().default(true),
    idempotencyKey: z.string().min(8).max(100),
  }),
  z.object({
    method: z.literal("from_qa"),
    title: z.string().min(1).max(200).optional(),
    documentIds: z.array(z.string().uuid()).max(10).default([]),
    qaText: z.string().min(3).max(50_000),
    settings: QuizSettings.partial().optional(),
    useAi: z.boolean().default(true),
    idempotencyKey: z.string().min(8).max(100),
  }),
  z.object({
    method: z.literal("from_mistakes"),
    title: z.string().min(1).max(200).optional(),
    settings: QuizSettings.partial().optional(),
    idempotencyKey: z.string().min(8).max(100),
  }),
]);
export type CreateQuizRequest = z.infer<typeof CreateQuizRequest>;
