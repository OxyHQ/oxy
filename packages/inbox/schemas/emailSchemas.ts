/**
 * Zod schemas + inferred types for the Oxy email domain.
 *
 * Single source of truth for the runtime shape of every email entity returned
 * by `api.oxy.so`. Extracted from `services/emailApi.ts` so the validation
 * layer is decoupled from the HTTP client: schemas can be imported by tests,
 * cache helpers, and UI without pulling in the API constructor.
 *
 * `services/emailApi.ts` re-exports everything here, so existing
 * `@/services/emailApi` imports keep working unchanged.
 */

import { z } from 'zod';

// ─── Schemas ───────────────────────────────────────────────────────

export const EmailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

export const AttachmentSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  contentId: z.string().optional(),
  isInline: z.boolean().optional(),
});

export const MessageFlagsSchema = z.object({
  seen: z.boolean().optional().default(false),
  starred: z.boolean().optional().default(false),
  answered: z.boolean().optional().default(false),
  forwarded: z.boolean().optional().default(false),
  draft: z.boolean().optional().default(false),
  pinned: z.boolean().optional().default(false),
});

export const CardTypeSchema = z.enum(['trip', 'purchase', 'event', 'bill', 'package']);

/**
 * Loosely-structured payload extracted from a message for a smart card.
 *
 * Fields are the superset of every card variant (trip/purchase/event/bill/
 * package); all are optional because extraction is best-effort. `.passthrough()`
 * preserves any additional keys the backend extractor emits so cards are never
 * dropped on a schema mismatch — it only adds typing for the keys the UI reads.
 */
export const CardDataSchema = z
  .object({
    // Trip
    airline: z.string().optional(),
    flightNumber: z.string().optional(),
    departure: z.string().optional(),
    arrival: z.string().optional(),
    departureTime: z.string().optional(),
    arrivalTime: z.string().optional(),
    confirmationCode: z.string().optional(),
    hotel: z.string().optional(),
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    // Purchase
    merchant: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    orderNumber: z.string().optional(),
    items: z.array(z.string()).optional(),
    // Event
    title: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    organizer: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    // Bill
    biller: z.string().optional(),
    dueDate: z.string().optional(),
    accountNumber: z.string().optional(),
    // Package
    carrier: z.string().optional(),
    estimatedDelivery: z.string().optional(),
    status: z.string().optional(),
    trackingNumber: z.string().optional(),
  })
  .passthrough();

export const MessageCardSchema = z.object({
  type: CardTypeSchema,
  data: CardDataSchema,
  confidence: z.number(),
  extractedAt: z.string(),
});

export const HighlightSchema = z.object({
  type: z.string(),
  value: z.string(),
  label: z.string(),
});

export const MessageSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  mailboxId: z.string(),
  messageId: z.string(),
  from: EmailAddressSchema,
  to: z.array(EmailAddressSchema).default([]),
  cc: z.array(EmailAddressSchema).optional(),
  bcc: z.array(EmailAddressSchema).optional(),
  subject: z.string().default(''),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  attachments: z.array(AttachmentSchema).default([]),
  flags: MessageFlagsSchema.default({}),
  labels: z.array(z.string()).default([]),
  card: MessageCardSchema.nullable().optional().catch(null),
  highlights: z.array(HighlightSchema).optional(),
  spamScore: z.number().nullable().optional(),
  size: z.number().default(0),
  inReplyTo: z.string().nullable().optional(),
  references: z.array(z.string()).optional(),
  aliasTag: z.string().nullable().optional(),
  snoozedUntil: z.string().nullable().optional(),
  scheduledAt: z.string().nullable().optional(),
  threadCount: z.number().optional(),
  threadParticipants: z.array(z.string()).optional(),
  senderAvatarPath: z.string().nullable().optional(),
  date: z.string(),
  receivedAt: z.string(),
});

export const MailboxSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  name: z.string(),
  path: z.string(),
  specialUse: z.string().nullable().optional(),
  totalMessages: z.number(),
  unseenMessages: z.number(),
  size: z.number(),
});

export const LabelSchema = z.object({
  _id: z.string(),
  /** Absent on system labels, which are constants rather than stored rows. */
  userId: z.string().optional(),
  name: z.string(),
  color: z.string(),
  order: z.number(),
  /** Part of the product; cannot be renamed, recoloured or deleted. */
  system: z.boolean().default(false),
});

export const PaginationSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

export const QuotaUsageSchema = z.object({
  used: z.number(),
  limit: z.number(),
  percentage: z.number(),
});

export const EmailSettingsSchema = z.object({
  signature: z.string(),
  autoReply: z.object({
    enabled: z.boolean(),
    subject: z.string().optional(),
    body: z.string().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
  }),
  autoForwardTo: z.string().optional(),
  autoForwardKeepCopy: z.boolean().optional(),
  address: z.string().optional(),
});

export const SubscriptionSchema = z.object({
  _id: z.string(),
  name: z.string(),
  messageCount: z.number(),
  /** How many of those messages were opened. Defaults to 0 on older APIs. */
  readCount: z.number().default(0),
  latestDate: z.string(),
  oldestDate: z.string(),
  latestMessageId: z.string(),
  hasListUnsubscribe: z.boolean(),
  type: z.enum(['list-unsubscribe', 'pattern-match', 'frequent']),
  senderAvatarPath: z.string().nullable().optional(),
});

export const UnsubscribeResultSchema = z.object({
  success: z.boolean(),
  method: z.string(),
});

export const BundleSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  name: z.string(),
  icon: z.string(),
  color: z.string(),
  matchLabels: z.array(z.string()),
  enabled: z.boolean(),
  collapsed: z.boolean(),
  order: z.number(),
});

export const ReminderSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  text: z.string(),
  remindAt: z.string(),
  completed: z.boolean(),
  pinned: z.boolean(),
  snoozedUntil: z.string().nullable().optional(),
  relatedMessageId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ContactSuggestionSchema = z.object({
  name: z.string().nullable().optional(),
  address: z.string(),
});

export const ContactSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  company: z.string().optional(),
  notes: z.string().optional(),
  starred: z.boolean(),
  autoCollected: z.boolean(),
  lastContactedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const EmailFilterConditionSchema = z.object({
  field: z.enum(['from', 'to', 'subject', 'has-attachment', 'size']),
  operator: z.enum(['contains', 'equals', 'not-contains', 'starts-with', 'ends-with', 'greater-than', 'less-than']),
  value: z.string(),
});

export const EmailFilterActionSchema = z.object({
  type: z.enum(['move', 'label', 'star', 'mark-read', 'archive', 'delete', 'forward']),
  value: z.string().optional(),
});

export const EmailFilterSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  conditions: z.array(EmailFilterConditionSchema),
  matchAll: z.boolean(),
  actions: z.array(EmailFilterActionSchema),
  order: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const EmailTemplateSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  order: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Compose input validation ──────────────────────────────────────

/** A single recipient email address, validated with Zod's email rule. */
export const RecipientEmailSchema = z.string().trim().email();

/** Whether a raw string is a valid recipient email address. */
export function isValidRecipientEmail(value: string): boolean {
  return RecipientEmailSchema.safeParse(value).success;
}

/**
 * Parse a comma-separated recipient string into `{ address }` objects, keeping
 * only the syntactically-valid addresses. Single chokepoint for To/Cc/Bcc
 * parsing in the composer.
 */
export function parseRecipientList(input: string): { address: string }[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isValidRecipientEmail)
    .map((address) => ({ address }));
}

// ─── Inferred Types ────────────────────────────────────────────────

export type EmailAddress = z.infer<typeof EmailAddressSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type MessageFlags = z.infer<typeof MessageFlagsSchema>;
export type CardType = z.infer<typeof CardTypeSchema>;
export type CardData = z.infer<typeof CardDataSchema>;
export type MessageCard = z.infer<typeof MessageCardSchema>;
export type Highlight = z.infer<typeof HighlightSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Mailbox = z.infer<typeof MailboxSchema>;
export type Label = z.infer<typeof LabelSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type UnsubscribeResult = z.infer<typeof UnsubscribeResultSchema>;
export type Bundle = z.infer<typeof BundleSchema>;
export type Reminder = z.infer<typeof ReminderSchema>;
export type ContactSuggestion = z.infer<typeof ContactSuggestionSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type EmailFilter = z.infer<typeof EmailFilterSchema>;
export type EmailFilterCondition = z.infer<typeof EmailFilterConditionSchema>;
export type EmailFilterAction = z.infer<typeof EmailFilterActionSchema>;
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>;
