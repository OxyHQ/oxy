import { z } from "zod";
import { inferenceErrorSchema } from "./errors";
import { modelReferenceSchema, requestIdSchema } from "./identifiers";
import { usageQuantitySchema } from "./money";
import { routingPolicyReferenceSchema } from "./routingPolicy";
import { normalizedUsageReportSchema } from "./usage";

const probability = z.number().finite().min(0).max(1);
const text = z.string().min(1).max(65536);
const id = z.string().min(1).max(128);
const tolerance = 1e-6;
export const decisionEffortSchema = z.enum([
  "instant",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const common = { id, question: text, criteria: text.optional() };
export const decisionQuestionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...common,
      kind: z.literal("choice"),
      options: z.array(text).min(2).max(255),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("score"),
      levels: z.array(text).min(2).max(10),
    })
    .strict(),
  z.object({ ...common, kind: z.literal("noul") }).strict(),
]);
const payloadFields = {
  state: z.string().max(65536),
  instructions: text.optional(),
  questions: z.array(decisionQuestionSchema).min(1).max(255),
  effort: decisionEffortSchema.optional(),
};
/**
 * Conservative serialized input accounting, including escaping and structure.
 * Measures both the normalized payload and the provider's structured-question
 * representation. Common instructions repeat per question there. A 255-byte
 * model identity and 4096-byte gateway-policy allowance bound adapter metadata.
 * Kaana must also check its final serialized body before sending it.
 */
export function decisionInputBudget(payload: DecisionInput): {
  total: number;
  context: number;
  gateway: number;
} {
  const bytes = (value: unknown): number => new TextEncoder().encode(
    JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
  ).length;
  const model = "x".repeat(255);
  const measure = (questions: DecisionQuestion[]): number => {
    const wireQuestions = Object.fromEntries(questions.map((q) => [q.id, {
      type: q.kind,
      instructions: {
        question: q.question,
        ...(payload.instructions === undefined ? {} : { instructions: payload.instructions }),
        ...(q.criteria === undefined ? {} : { criteria: q.criteria }),
      },
      ...(q.kind === "choice" ? { criteria: Object.fromEntries(q.options.map((label) => [label, null])) } :
        q.kind === "score" ? { criteria: q.levels } : {}),
    }]));
    return Math.max(
      bytes({ ...payload, model, questions }),
      bytes({ model, state: payload.state, questions: wireQuestions, ...(payload.effort === undefined ? {} : { effort: payload.effort }) })
    );
  };
  const total = measure(payload.questions);
  return { total, context: Math.max(...payload.questions.map((q) => measure([q]))), gateway: total + 4096 };
}
/** OpenRouter's TOTAL limit is separate from direct state-plus-longest context. */
export function decisionFitsGateway(payload: DecisionInput): boolean {
  return decisionInputBudget(payload).gateway <= 32000;
}
function validateInput(payload: DecisionInput, ctx: z.RefinementCtx): void {
  if (
    new Set(payload.questions.map((q) => q.id)).size !==
    payload.questions.length
  )
    ctx.addIssue({
      code: "custom",
      path: ["questions"],
      message: "Question IDs must be unique.",
    });
  for (const [index, question] of payload.questions.entries()) {
    const labels =
      question.kind === "choice"
        ? question.options
        : question.kind === "score"
          ? question.levels
          : [];
    if (new Set(labels).size !== labels.length)
      ctx.addIssue({
        code: "custom",
        path: ["questions", index],
        message: "Options and levels must be unique.",
      });
  }
  const budget = decisionInputBudget(payload);
  if (budget.total > 64000 || budget.context > 32000)
    ctx.addIssue({
      code: "custom",
      path: ["state"],
      message:
        "Decisions exceed the serialized 64000-byte total or 32000-byte per-question context budget.",
    });
}
export const decisionInputSchema = z
  .object(payloadFields)
  .strict()
  .superRefine(validateInput);
export const decisionRequestSchema = z
  .object({
    model: modelReferenceSchema.refine(
      (model) => model.includes("@"),
      "Decisions require a revision-pinned model.",
    ),
    ...payloadFields,
  })
  .strict()
  .superRefine(validateInput);
export const decisionAnswerSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        id,
        kind: z.literal("choice"),
        /** Actual provider-selected option. Never reconstructed from probabilities. */
        reply: text,
        /** Provider-returned confidence, not a correctness probability. */
        confidence: probability,
        probabilities: z.array(probability).min(2).max(255),
      })
      .strict(),
    z
      .object({
        id,
        kind: z.literal("score"),
        /** Actual provider score. Kept separate from the validated expected index. */
        reply: z.number().finite().min(0).max(9),
        confidence: probability,
        mean: z.number().finite().min(0).max(9),
        distribution: z.array(probability).min(2).max(10),
      })
      .strict(),
    z.object({ id, kind: z.literal("noul"), probability }).strict(),
  ])
  .superRefine((answer, ctx) => {
    if (answer.kind === "noul") return;
    if (answer.kind === "score" && Math.abs(answer.reply - answer.mean) > tolerance) {
      ctx.addIssue({ code: "custom", path: ["reply"], message: "Provider score must match the expected level index." });
    }
    const distribution =
      answer.kind === "choice" ? answer.probabilities : answer.distribution;
    if (
      Math.abs(distribution.reduce((sum, value) => sum + value, 0) - 1) >
      tolerance
    )
      ctx.addIssue({
        code: "custom",
        message: "Probabilities must sum to one.",
      });
    if (
      answer.kind === "score" &&
      Math.abs(
        distribution.reduce((sum, value, index) => sum + index * value, 0) -
          answer.mean,
      ) > tolerance
    )
      ctx.addIssue({
        code: "custom",
        path: ["mean"],
        message: "Mean must equal the expected zero-based level index.",
      });
  });
const resultFields = {
  schemaVersion: z.literal(1),
  requestId: requestIdSchema,
  model: modelReferenceSchema.refine(
    (model) => model.includes("@"),
    "Decisions require an immutable model revision.",
  ),
  data: z.array(decisionAnswerSchema).min(1).max(255),
};
function uniqueAnswers(
  result: { data: DecisionAnswer[] },
  ctx: z.RefinementCtx,
): void {
  if (
    new Set(result.data.map((answer) => answer.id)).size !== result.data.length
  )
    ctx.addIssue({
      code: "custom",
      path: ["data"],
      message: "Answer IDs must be unique.",
    });
}
export const decisionResultSchema = z
  .object({ ...resultFields, usage: normalizedUsageReportSchema })
  .strict()
  .superRefine(uniqueAnswers)
  .superRefine((result, ctx) => {
    if (
      result.usage.requestId !== result.requestId ||
      result.usage.resolvedModelReference !== result.model ||
      result.usage.outcome !== "completed"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["usage"],
        message:
          "Decision usage must describe this completed request and immutable model.",
      });
    }
  });
/**
 * Kaana's typed decisions failure. `usage` is present only when the provider
 * measured something before failing; its absence means nothing was measured,
 * never that the cost was zero. A failure carrying usage did execute.
 */
export const decisionFailureSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    error: inferenceErrorSchema,
    usage: normalizedUsageReportSchema.optional(),
  })
  .strict()
  .superRefine((failure, ctx) => {
    if (failure.error.requestId !== failure.requestId) {
      ctx.addIssue({ code: "custom", path: ["error", "requestId"], message: "The error must answer this request." });
    }
    if (failure.usage !== undefined &&
        (failure.usage.requestId !== failure.requestId || failure.usage.outcome === "completed")) {
      ctx.addIssue({ code: "custom", path: ["usage"], message: "Failure usage must describe this request and an incomplete outcome." });
    }
  });
export const decisionSuccessSchema = z
  .object({
    ...resultFields,
    usage: z.array(usageQuantitySchema),
    routingPolicy: routingPolicyReferenceSchema,
  })
  .strict()
  .superRefine(uniqueAnswers);
/** Bind output to the exact request. Provider order is not semantic. */
export function decisionAnswersMatch(
  input: DecisionInput,
  answers: readonly DecisionAnswer[],
): boolean {
  if (
    answers.length !== input.questions.length ||
    new Set(answers.map((a) => a.id)).size !== answers.length
  )
    return false;
  return input.questions.every((question) => {
    const answer = answers.find((candidate) => candidate.id === question.id);
    if (
      !answer ||
      !decisionAnswerSchema.safeParse(answer).success ||
      answer.kind !== question.kind
    )
      return false;
    if (question.kind === "choice" && answer.kind === "choice") {
      const index = question.options.indexOf(answer.reply);
      return question.options.length === answer.probabilities.length && index >= 0 &&
        answer.probabilities[index] + tolerance >= Math.max(...answer.probabilities);
    }
    if (question.kind === "score" && answer.kind === "score")
      return question.levels.length === answer.distribution.length;
    return question.kind === "noul";
  });
}
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;
export type DecisionInput = {
  state: string;
  instructions?: string;
  questions: DecisionQuestion[];
  effort?: z.infer<typeof decisionEffortSchema>;
};
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;
export type DecisionResult = z.infer<typeof decisionResultSchema>;
export type DecisionSuccess = z.infer<typeof decisionSuccessSchema>;
export type DecisionFailure = z.infer<typeof decisionFailureSchema>;
