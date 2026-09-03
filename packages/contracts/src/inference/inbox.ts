import { z } from 'zod';
import { inferenceErrorSchema } from './errors';

const inboxTextSchema = z.string().trim().min(1).max(20_000);
const inboxMessageIdSchema = z.string().min(1).max(128);
const DAILY_BRIEF_MIN_WINDOW_MS = 23 * 60 * 60 * 1_000;
const DAILY_BRIEF_MAX_WINDOW_MS = 25 * 60 * 60 * 1_000;
const inboxUtcTimestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => value.endsWith('Z'), 'Timestamp must use the UTC Z suffix');

export const inboxComposeRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('draft'),
    prompt: inboxTextSchema,
    tone: z.enum(['professional', 'casual', 'friendly', 'formal']),
    stream: z.boolean().optional(),
  }).strict(),
  z.object({ operation: z.literal('polish'), text: inboxTextSchema }).strict(),
  z.object({
    operation: z.literal('change_tone'),
    text: inboxTextSchema,
    tone: z.enum(['professional', 'casual', 'friendly', 'formal']),
  }).strict(),
  z.object({
    operation: z.literal('adjust_length'),
    text: inboxTextSchema,
    direction: z.enum(['shorter', 'longer']),
  }).strict(),
  z.object({ operation: z.literal('suggest_subject'), body: inboxTextSchema }).strict(),
]);

/**
 * The client owns the user's timezone and therefore supplies the UTC instants
 * that bracket one local calendar day. The server treats this as [start, end):
 * requiring a 23-25 hour window admits both DST transitions but refuses an
 * arbitrary history export disguised as a brief.
 */
export const inboxDailyBriefRequestSchema = z.object({
  startAt: inboxUtcTimestampSchema,
  endAt: inboxUtcTimestampSchema,
  stream: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const durationMs = Date.parse(value.endAt) - Date.parse(value.startAt);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endAt'],
      message: 'endAt must be after startAt',
    });
    return;
  }
  if (durationMs < DAILY_BRIEF_MIN_WINDOW_MS || durationMs > DAILY_BRIEF_MAX_WINDOW_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endAt'],
      message: 'Daily brief window must be between 23 and 25 hours',
    });
  }
});
export const inboxNaturalSearchRequestSchema = z.object({ query: z.string().trim().min(1).max(512) }).strict();
export const inboxMessageInferenceParamsSchema = z.object({ messageId: inboxMessageIdSchema }).strict();

export const inboxInferenceTextResponseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1).max(128),
  generationId: z.string().min(1).max(128).optional(),
  text: z.string().max(40_000),
}).strict();

export const inboxNaturalSearchResponseSchema = z.object({
  query: z.object({
    q: z.string().max(512).optional(),
    from: z.string().max(320).optional(),
    to: z.string().max(320).optional(),
    subject: z.string().max(512).optional(),
    hasAttachment: z.boolean().optional(),
    starred: z.boolean().optional(),
    unread: z.boolean().optional(),
    after: z.string().date().optional(),
    before: z.string().date().optional(),
    mailbox: z.enum(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive']).optional(),
  }).strict(),
  interpretation: z.string().max(1000),
}).strict();

export const inboxSmartRepliesResponseSchema = z.object({
  replies: z.array(z.string().trim().min(1).max(500)).max(3),
}).strict();

export const inboxThreadSummaryResponseSchema = z.object({
  summary: z.string().max(4000),
  keyPoints: z.array(z.string().max(1000)).max(12),
  actionItems: z.array(z.object({
    text: z.string().max(1000),
    owner: z.string().max(320).nullable(),
    deadline: z.string().max(128).nullable(),
  }).strict()).max(12),
}).strict();

export const inboxInferenceStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string().min(1).max(16_384) }).strict(),
  z.object({
    type: z.literal('done'),
    requestId: z.string().min(1).max(128),
    generationId: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({ type: z.literal('error'), error: inferenceErrorSchema }).strict(),
]);

export type InboxComposeRequest = z.infer<typeof inboxComposeRequestSchema>;
export type InboxDailyBriefRequest = z.infer<typeof inboxDailyBriefRequestSchema>;
export type InboxInferenceTextResponse = z.infer<typeof inboxInferenceTextResponseSchema>;
export type InboxNaturalSearchResponse = z.infer<typeof inboxNaturalSearchResponseSchema>;
export type InboxSmartRepliesResponse = z.infer<typeof inboxSmartRepliesResponseSchema>;
export type InboxThreadSummaryResponse = z.infer<typeof inboxThreadSummaryResponseSchema>;
export type InboxInferenceStreamEvent = z.infer<typeof inboxInferenceStreamEventSchema>;
