import { z } from 'zod';

const textSchema = z.string().trim().min(1).max(100_000);
const toneSchema = z.enum(['professional', 'casual', 'friendly', 'formal']);

const composeDraftSchema = z
  .object({
    feature: z.literal('compose-draft'),
    prompt: textSchema,
    tone: toneSchema,
  })
  .strict();

const composePolishSchema = z
  .object({
    feature: z.literal('compose-polish'),
    text: textSchema,
  })
  .strict();

const composeChangeToneSchema = z
  .object({
    feature: z.literal('compose-change-tone'),
    text: textSchema,
    tone: toneSchema,
  })
  .strict();

const composeAdjustLengthSchema = z
  .object({
    feature: z.literal('compose-adjust-length'),
    text: textSchema,
    direction: z.enum(['shorter', 'longer']),
  })
  .strict();

const composeSubjectSchema = z
  .object({
    feature: z.literal('compose-subject'),
    body: textSchema,
  })
  .strict();

const dailyBriefSchema = z
  .object({
    feature: z.literal('daily-brief'),
    counts: z
      .object({
        total: z.number().int().nonnegative().safe().max(1_000_000),
        unread: z.number().int().nonnegative().safe().max(1_000_000),
        starred: z.number().int().nonnegative().safe().max(1_000_000),
        withAttachments: z.number().int().nonnegative().safe().max(1_000_000),
      })
      .strict(),
  })
  .strict();

const naturalLanguageSearchSchema = z
  .object({
    feature: z.literal('natural-language-search'),
    query: z.string().trim().min(1).max(2_000),
  })
  .strict();

const smartRepliesSchema = z
  .object({
    feature: z.literal('smart-replies'),
    message: z
      .object({
        sender: z.string().trim().min(1).max(512),
        subject: z.string().trim().max(2_000),
        body: textSchema,
      })
      .strict(),
  })
  .strict();

const threadMessageSchema = z
  .object({
    sender: z.string().trim().min(1).max(512),
    sentAt: z.string().datetime().optional(),
    body: textSchema,
  })
  .strict();

const threadSummarySchema = z
  .object({
    feature: z.literal('thread-summary'),
    messages: z.array(threadMessageSchema).min(1).max(50),
  })
  .strict();

/**
 * The product BFF contract. It deliberately contains no user id, prompt
 * instructions, model, routing profile, labels, sampling controls or token
 * ceiling: those are server-owned policy, not client input.
 */
export const inboxInferenceRequestSchema = z
  .discriminatedUnion('feature', [
    composeDraftSchema,
    composePolishSchema,
    composeChangeToneSchema,
    composeAdjustLengthSchema,
    composeSubjectSchema,
    dailyBriefSchema,
    naturalLanguageSearchSchema,
    smartRepliesSchema,
    threadSummarySchema,
  ])
  .superRefine((request, context) => {
    if (
      request.feature === 'daily-brief' &&
      (request.counts.unread > request.counts.total ||
        request.counts.starred > request.counts.total ||
        request.counts.withAttachments > request.counts.total)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts'],
        message: 'derived counts cannot exceed total',
      });
    }
    if (
      request.feature === 'thread-summary' &&
      request.messages.reduce((characters, message) => characters + message.body.length, 0) > 200_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages'],
        message: 'thread content is limited to 200000 characters',
      });
    }
  });

export const inboxInferenceResponseSchema = z
  .object({
    text: z.string(),
    requestId: z.string().min(1).max(128),
  })
  .strict();

export const inboxInferenceResponseEnvelopeSchema = z
  .object({ data: inboxInferenceResponseSchema })
  .strict();

/** OpenAPI transport description; each SSE `data` line is contract-validated at runtime. */
export const inboxInferenceStreamResponseSchema = z.string();

export type InboxInferenceRequest = z.infer<typeof inboxInferenceRequestSchema>;
export type InboxInferenceResponse = z.infer<typeof inboxInferenceResponseSchema>;
