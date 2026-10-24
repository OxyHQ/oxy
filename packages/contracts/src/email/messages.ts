import { integerCheck } from '../numberChecks';
import { isoDateTime } from '../stringChecks';
/**
 * Wire contract for the Inbox read API (`/email/*` on oxy-api).
 *
 * These schemas describe what a client RECEIVES — the JSON-serialised DTOs of
 * `packages/api/src/services/email.service.ts` — so every timestamp is an ISO
 * string and every nullable column is `null`, never absent. oxy-api asserts at
 * the type level that its DTOs serialise to exactly these shapes, and a
 * database-backed test parses real responses with them; a client parses with
 * the same schemas. One declaration, two sides, no drift.
 *
 * Why this exists: the Inbox client used to declare its own copy, with
 * `contentId: z.string().optional()`. oxy-api sends `null` for an attachment
 * without a Content-ID, the client's parse failed, and the list silently
 * dropped the whole message — a verification-code mail that appeared for a
 * second (the realtime placeholder) and then vanished (the refetch).
 *
 * Unknown keys are stripped, not rejected, so the server may ADD a field
 * without breaking an older client. Removing or re-typing one is breaking.
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from '@oxy.so/zod4';

/** An ISO-8601 instant as `Date.prototype.toJSON` writes it. */
const isoInstant = z.string().check(isoDateTime());

// ─── Vocabularies ───────────────────────────────────────────────────

/** Structured data cards the AI extractor can emit. */
export const MESSAGE_CARD_TYPES = ['trip', 'purchase', 'event', 'bill', 'package'] as const;
export type MessageCardType = (typeof MESSAGE_CARD_TYPES)[number];

/** What a mail-rule condition looks at. */
export const EMAIL_FILTER_CONDITION_FIELDS = [
  'from',
  'to',
  'subject',
  'has-attachment',
  'size',
] as const;
export type EmailFilterConditionField = (typeof EMAIL_FILTER_CONDITION_FIELDS)[number];

/** How a mail-rule condition compares. */
export const EMAIL_FILTER_CONDITION_OPERATORS = [
  'contains',
  'equals',
  'not-contains',
  'starts-with',
  'ends-with',
  'greater-than',
  'less-than',
] as const;
export type EmailFilterConditionOperator = (typeof EMAIL_FILTER_CONDITION_OPERATORS)[number];

/** What a mail rule does. */
export const EMAIL_FILTER_ACTION_TYPES = [
  'move',
  'label',
  'star',
  'mark-read',
  'archive',
  'delete',
  'forward',
] as const;
export type EmailFilterActionType = (typeof EMAIL_FILTER_ACTION_TYPES)[number];

/** Lifecycle of a durable outbound delivery. */
export const EMAIL_OUTBOX_STATUSES = [
  'pending',
  'processing',
  'sent',
  'failed',
  'cancelled',
] as const;
export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number];

/**
 * Where a message the user sent stands, as its Sent copy reports it.
 *
 * A send is filed in Sent the moment the API accepts it and handed to the relay
 * afterwards, so being in Sent no longer means having left. `sent` means the
 * relay took it; `retrying` means an attempt failed and another is scheduled;
 * `failed` means nothing more will happen on its own.
 */
export const EMAIL_DELIVERY_STATES = ['sending', 'retrying', 'sent', 'failed'] as const;
export type EmailDeliveryState = (typeof EMAIL_DELIVERY_STATES)[number];

/**
 * Why a delivery is retrying or failed, in words a client can translate.
 *
 * - `relay_unavailable`: the relay did not answer or answered 4xx (transient).
 * - `relay_unconfigured`: this server has no relay; an operator must fix it.
 * - `relay_auth`: the relay rejected Oxy's credential; an operator must fix it.
 * - `rejected`: the relay refused this message with a 5xx.
 * - `retries_exhausted`: it stayed `relay_unavailable` for the whole budget.
 * - `bounced`: the relay took it, then a recipient's server refused it.
 * - `cancelled`: the sender stopped it.
 */
export const EMAIL_DELIVERY_ERROR_CODES = [
  'relay_unavailable',
  'relay_unconfigured',
  'relay_auth',
  'rejected',
  'retries_exhausted',
  'bounced',
  'cancelled',
] as const;
export type EmailDeliveryErrorCode = (typeof EMAIL_DELIVERY_ERROR_CODES)[number];

// ─── Messages ───────────────────────────────────────────────────────

/** One addressee. A header without a display name carries `name: ''`. */
export const emailMessageAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
});
export type EmailMessageAddressWire = z.infer<typeof emailMessageAddressSchema>;

/**
 * One attached file. `contentId` is `null` — present, not absent — when the
 * part had no Content-ID, which is most attachments.
 */
export const emailAttachmentSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  contentId: z.string().nullable(),
  isInline: z.boolean(),
});
export type EmailAttachmentWire = z.infer<typeof emailAttachmentSchema>;

export const emailMessageFlagsSchema = z.object({
  seen: z.boolean(),
  starred: z.boolean(),
  answered: z.boolean(),
  forwarded: z.boolean(),
  draft: z.boolean(),
  pinned: z.boolean(),
});
export type EmailMessageFlagsWire = z.infer<typeof emailMessageFlagsSchema>;

/** The AI-extracted card. Every field but `type` may be unknown. */
export const emailMessageCardSchema = z.object({
  type: z.enum(MESSAGE_CARD_TYPES),
  data: z.record(z.string(), z.unknown()).nullable(),
  confidence: z.number().nullable(),
  extractedAt: isoInstant.nullable(),
});
export type EmailMessageCardWire = z.infer<typeof emailMessageCardSchema>;

/** One extracted key/value rendered as a chip. */
export const emailMessageHighlightSchema = z.object({
  type: z.string(),
  value: z.string(),
  label: z.string(),
});
export type EmailMessageHighlightWire = z.infer<typeof emailMessageHighlightSchema>;

/**
 * The delivery of a message the user sent. `error` is the relay's own words;
 * `errorCode` is the same failure in the vocabulary above, and is `null` when
 * there is nothing to explain — or when a newer server names a reason this
 * client does not know yet, which then still reads as a delivery.
 * `nextAttemptAt` is set only while `retrying`.
 */
export const emailMessageDeliverySchema = z.object({
  state: z.enum(EMAIL_DELIVERY_STATES),
  attempts: z.number().check(integerCheck()),
  maxAttempts: z.number().check(integerCheck()),
  nextAttemptAt: isoInstant.nullable(),
  error: z.string().nullable(),
  errorCode: z.enum(EMAIL_DELIVERY_ERROR_CODES).nullable().catch(null),
  updatedAt: isoInstant,
});
export type EmailMessageDeliveryWire = z.infer<typeof emailMessageDeliverySchema>;

/**
 * A stored message as every `/email` read returns it.
 *
 * `_id` and `id` are the same row id (see the "Wire shapes" note in oxy-api's
 * email service). `messageId` is the RFC 5322 `Message-ID` header — NOT the row
 * id — and it is what `inReplyTo` / `references` of a reply must name.
 */
export const emailMessageSchema = z.object({
  _id: z.string(),
  id: z.string(),
  userId: z.string(),
  mailboxId: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  from: emailMessageAddressSchema,
  to: z.array(emailMessageAddressSchema),
  cc: z.array(emailMessageAddressSchema),
  bcc: z.array(emailMessageAddressSchema),
  replyTo: emailMessageAddressSchema.optional(),
  subject: z.string(),
  attachments: z.array(emailAttachmentSchema),
  flags: emailMessageFlagsSchema,
  labels: z.array(z.string()),
  card: emailMessageCardSchema.optional(),
  highlights: z.array(emailMessageHighlightSchema),
  encrypted: z.boolean(),
  spamScore: z.number().nullable(),
  spamAction: z.string().nullable(),
  size: z.number(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  aliasTag: z.string().nullable(),
  snoozedUntil: isoInstant.nullable(),
  snoozedFromMailbox: z.string().nullable(),
  scheduledAt: isoInstant.nullable(),
  readReceiptRequested: z.boolean(),
  readReceiptSent: z.boolean(),
  date: isoInstant,
  receivedAt: isoInstant,
  createdAt: isoInstant,
  updatedAt: isoInstant,
  draftRevision: z.number().check(integerCheck()).min(1),
  /** Present only on the reads that return bodies (single message, thread). */
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  senderAvatarPath: z.string().nullable().optional(),
  /** Present only on list reads that walked the thread. */
  threadCount: z.number().check(integerCheck()).optional(),
  threadParticipants: z.array(z.string()).optional(),
  /**
   * Present only on a message the user sent through Oxy since delivery was
   * tracked; absent on received mail. A delivery this client cannot read is
   * dropped rather than allowed to drop the message with it.
   */
  delivery: emailMessageDeliverySchema.optional().catch(undefined),
});
export type EmailMessageWire = z.infer<typeof emailMessageSchema>;

// ─── Mailboxes and labels ───────────────────────────────────────────

export const emailMailboxSchema = z.object({
  _id: z.string(),
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  path: z.string(),
  specialUse: z.string().nullable(),
  retentionDays: z.number().check(integerCheck()).nullable(),
  totalMessages: z.number().check(integerCheck()),
  unseenMessages: z.number().check(integerCheck()),
  size: z.number(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type EmailMailboxWire = z.infer<typeof emailMailboxSchema>;

/** A label the user made. */
export const emailUserLabelSchema = z.object({
  _id: z.string(),
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  color: z.string(),
  order: z.number().check(integerCheck()),
  system: z.literal(false),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type EmailUserLabelWire = z.infer<typeof emailUserLabelSchema>;

/** One of the product's built-in labels; `_id` is `system:<name>`. */
export const emailSystemLabelSchema = z.object({
  _id: z.string(),
  name: z.string(),
  color: z.string(),
  order: z.number().check(integerCheck()),
  system: z.literal(true),
});
export type EmailSystemLabelWire = z.infer<typeof emailSystemLabelSchema>;

export const emailLabelSchema = z.discriminatedUnion('system', [
  emailUserLabelSchema,
  emailSystemLabelSchema,
]);
export type EmailLabelWire = z.infer<typeof emailLabelSchema>;

// ─── Rules, bundles, contacts, outbox ───────────────────────────────

export const emailFilterConditionSchema = z.object({
  field: z.enum(EMAIL_FILTER_CONDITION_FIELDS),
  operator: z.enum(EMAIL_FILTER_CONDITION_OPERATORS),
  value: z.string(),
});
export type EmailFilterConditionWire = z.infer<typeof emailFilterConditionSchema>;

/** `value` is absent for the actions that take none. */
export const emailFilterActionSchema = z.object({
  type: z.enum(EMAIL_FILTER_ACTION_TYPES),
  value: z.string().optional(),
});
export type EmailFilterActionWire = z.infer<typeof emailFilterActionSchema>;

export const emailFilterSchema = z.object({
  _id: z.string(),
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  matchAll: z.boolean(),
  order: z.number().check(integerCheck()),
  conditions: z.array(emailFilterConditionSchema),
  actions: z.array(emailFilterActionSchema),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type EmailFilterWire = z.infer<typeof emailFilterSchema>;

export const emailBundleSchema = z.object({
  _id: z.string(),
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  icon: z.string(),
  color: z.string(),
  matchLabels: z.array(z.string()),
  enabled: z.boolean(),
  collapsed: z.boolean(),
  order: z.number().check(integerCheck()),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type EmailBundleWire = z.infer<typeof emailBundleSchema>;

/** `GET /email/messages?bundled=true` — the inbox split into primary and bundles. */
export const emailBundledInboxSchema = z.object({
  primary: z.array(emailMessageSchema),
  bundles: z.array(
    z.object({
      bundle: emailBundleSchema,
      messages: z.array(emailMessageSchema),
      unreadCount: z.number().check(integerCheck()),
    }),
  ),
  total: z.number().check(integerCheck()),
});
export type EmailBundledInboxWire = z.infer<typeof emailBundledInboxSchema>;

/** An address-book entry. `company` and `notes` are `null` when unset. */
export const emailContactSchema = z.object({
  _id: z.string(),
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  company: z.string().nullable(),
  notes: z.string().nullable(),
  starred: z.boolean(),
  autoCollected: z.boolean(),
  lastContactedAt: isoInstant.nullable(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type EmailContactWire = z.infer<typeof emailContactSchema>;

/**
 * One durable outbound delivery. `terminal` means no further attempt will
 * happen on its own — present that differently from "still trying".
 */
export const emailOutboxSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  status: z.enum(EMAIL_OUTBOX_STATUSES),
  attempts: z.number().check(integerCheck()),
  maxAttempts: z.number().check(integerCheck()),
  terminal: z.boolean(),
  nextAttemptAt: isoInstant,
  lastError: z.string().nullable(),
  sentAt: isoInstant.nullable(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
});
export type EmailOutboxWire = z.infer<typeof emailOutboxSchema>;

// ─── Replies ────────────────────────────────────────────────────────

/**
 * One RFC 5322 `msg-id`: `<left@right>`, no whitespace, no nested brackets.
 *
 * `In-Reply-To` and `References` carry these and nothing else. A reply that
 * names a database row id instead (`01a0…` or `<01a0…>`) breaks threading for
 * every recipient — it happened, which is why it is refused at the edge.
 */
export const RFC_MESSAGE_ID_PATTERN = /^<[^<>\s]+@[^<>\s]+>$/;

export const rfcMessageIdSchema = z
  .string()
  .trim()
  .regex(RFC_MESSAGE_ID_PATTERN, 'Must be an RFC 5322 Message-ID such as <id@host>');
