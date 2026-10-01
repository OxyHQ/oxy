import { z } from "zod";
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
/** UTF-8 bytes conservatively bound tokens without a provider tokenizer in the SDK. */
export function decisionInputBudget(payload: DecisionInput): {
  total: number;
  gateway: number;
} {
  const bytes = (value: string): number =>
    new TextEncoder().encode(value).length;
  const state = bytes(payload.state) + bytes(payload.instructions ?? "");
  const questions = payload.questions.map(
    (q) =>
      bytes(q.id) +
      bytes(q.question) +
      bytes(q.criteria ?? "") +
      (q.kind === "choice"
        ? q.options
        : q.kind === "score"
          ? q.levels
          : []
      ).reduce((sum, label) => sum + bytes(label), 0),
  );
  return {
    total: state + questions.reduce((sum, size) => sum + size, 0),
    gateway: state + Math.max(...questions),
  };
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
  if (budget.total > 65536 || budget.gateway > 32768)
    ctx.addIssue({
      code: "custom",
      path: ["state"],
      message:
        "Decisions exceed the 64KiB total or 32KiB state plus longest question budget.",
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
        probabilities: z.array(probability).min(2).max(255),
      })
      .strict(),
    z
      .object({
        id,
        kind: z.literal("score"),
        mean: z.number().finite().min(0).max(9),
        distribution: z.array(probability).min(2).max(10),
      })
      .strict(),
    z.object({ id, kind: z.literal("noul"), probability }).strict(),
  ])
  .superRefine((answer, ctx) => {
    if (answer.kind === "noul") return;
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
    if (question.kind === "choice" && answer.kind === "choice")
      return question.options.length === answer.probabilities.length;
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
