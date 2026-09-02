/**
 * Email Service
 *
 * Core business logic for the Oxy email system. Handles mailbox provisioning,
 * message CRUD, quota enforcement, search, and user lifecycle.
 *
 * Email addresses are always derived: {username}@oxy.so — never stored independently.
 */

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { safeFetch, SsrfRejection } from '@oxyhq/core/server';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb, type Database } from '../config/postgres';
import { bundles } from '../db/schema/bundles';
import { contacts } from '../db/schema/contacts';
import { EMAIL_FILTER_ACTION_TYPES, emailFilterActions } from '../db/schema/emailFilterActions';
import {
  EMAIL_FILTER_CONDITION_FIELDS,
  EMAIL_FILTER_CONDITION_OPERATORS,
  emailFilterConditions,
} from '../db/schema/emailFilterConditions';
import { emailFilters, incompleteEmailFilters } from '../db/schema/emailFilters';
import { emailTemplates } from '../db/schema/emailTemplates';
import { labels as labelsTable } from '../db/schema/labels';
import { mailboxes } from '../db/schema/mailboxes';
import { messageAttachments, type MessageAttachment } from '../db/schema/messageAttachments';
import { messageRecipients } from '../db/schema/messageRecipients';
import { messages, type EmailAddress, type MessageHighlight } from '../db/schema/messages';
import { MESSAGES_PROTECTED_COLUMNS, PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { reminders } from '../db/schema/reminders';
import { billingSubscriptions } from '../db/schema/billingSubscriptions';
import { users } from '../db/schema/users';
import { SYSTEM_LABELS, isSystemLabel, isSystemLabelId } from '../constants/systemLabels';
import { getAvatarPathsBatch } from './senderAvatar.service';
import {
  DEFAULT_MAILBOXES,
  EMAIL_QUOTAS,
  EMAIL_DOMAIN,
  resolveEmailAddress,
  type SubscriptionTier,
} from '../config/email.config';
import { logger } from '../utils/logger';
import { ConflictError, NotFoundError, BadRequestError } from '../utils/error';
import userCache from '../utils/userCache';
import { resolveEmailFromName } from '../utils/displayName';
import { v4 as uuidv4 } from 'uuid';
import { aiLabelingService } from './aiLabeling.service';
import { cardExtractionService } from './cardExtraction.service';
import { smtpOutbound } from './smtp.outbound';
import { sendInboxEmailPush } from './emailPushDelivery.service';
import { assetService } from './assetServiceSingleton';
import { simpleParser } from 'mailparser';
import { idempotentMessageId } from './emailIdempotency';
import { emailSavedSearches, type SavedEmailSearchFilters } from '../db/schema/emailSavedSearches';
import { publishInboxMessageEvents } from '../capabilities/inbox.events';

const MAX_STRUCTURED_SEARCH_FILTER_LENGTH = 128;
/**
 * Mongo's `maxTimeMS` on the two search queries, as `statement_timeout`.
 *
 * It is a DoS guard on a user-supplied search, not an optimisation, so it
 * survives the port. `SET LOCAL` needs a transaction — which is why both the
 * page and the count run inside one.
 */
const EMAIL_SEARCH_MAX_TIME_MS = 5_000;

/** Rows loaded per page when sweeping every message of a user or mailbox. */
const ATTACHMENT_SWEEP_PAGE_SIZE = 500;

type EmailPageCursor =
  | { version: 1; kind: 'messages'; pinned: boolean; date: string; id: string }
  | { version: 1; kind: 'search'; rank: number; date: string; id: string };

function encodeEmailPageCursor(cursor: EmailPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeEmailPageCursor(value: string, kind: EmailPageCursor['kind']): EmailPageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('Invalid email pagination cursor');
  }

  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1 ||
      (parsed as { kind?: unknown }).kind !== kind) {
    throw new BadRequestError('Invalid email pagination cursor');
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.date !== 'string' || Number.isNaN(Date.parse(candidate.date)) ||
      typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new BadRequestError('Invalid email pagination cursor');
  }
  if (kind === 'messages') {
    if (typeof candidate.pinned !== 'boolean') throw new BadRequestError('Invalid email pagination cursor');
    return parsed as EmailPageCursor;
  }
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) {
    throw new BadRequestError('Invalid email pagination cursor');
  }
  return parsed as EmailPageCursor;
}

/**
 * Reject an overlong structured search filter (from/to/subject).
 *
 * The 400 is a documented contract, so the length check survives. The regex
 * escaping that used to live here does NOT: the ported query matches with
 * `strpos`, which has no metacharacter language at all, so there is nothing
 * left to neutralize and no escaping routine to get wrong.
 */
export function normalizeStructuredSearchFilter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > MAX_STRUCTURED_SEARCH_FILTER_LENGTH) {
    throw new BadRequestError(
      `Search filters must be ${MAX_STRUCTURED_SEARCH_FILTER_LENGTH} characters or fewer`,
    );
  }
  return value;
}

/**
 * Case-insensitive substring containment — the exact semantic of Mongo's
 * `{ $regex: <escaped literal>, $options: 'i' }`.
 *
 * `strpos` rather than `ilike`: a LIKE pattern would need its own escaping for
 * `%`, `_` and `\`, which is a second escaping routine to get wrong for no gain.
 * Neither form can use an index here, exactly as the regex could not.
 */
function containsInsensitive(column: SQLWrapper, needle: string): SQL {
  return sql`strpos(lower(${column}), lower(${needle})) > 0`;
}

/**
 * A `text[]` built from bound parameters.
 *
 * A raw JS array interpolated into `sql` renders as a ROW constructor —
 * `($1, $2, $3)`, not an array — so `= any(${ids}::text[])` fails with
 * `op ANY/ALL (array) requires array on right side` and `<> all(...)` the same
 * way. Each element is bound individually and wrapped in `array[…]`; an empty
 * list is the empty array rather than `array[]`, which Postgres cannot type.
 */
function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

// ─── Wire shapes ────────────────────────────────────────────────────
//
// Every response below carries BOTH `_id` and `id`, as strings.
//
// That is not indecision: the Mongo reads this replaces disagreed with each
// other. `.lean({virtuals:true})` returned `_id` AND the `id` virtual, a plain
// `.lean()` (bundles, the reminder list, bundled messages) returned only `_id`,
// and `.toJSON()` returned only `id`. The three shapes reached the same clients
// through different endpoints, so both keys are load-bearing somewhere —
// `SYSTEM_LABELS` even keys on `_id` alone and is merged into the same array as
// stored labels. Emitting both is the only shape that is a superset of all
// three: no consumer loses a field and no existing field changes value.
//
// `__v` does not travel. It was a Mongo version key, absent from every
// `toJSON` response already, and there is no column behind it.

/** One addressee, exactly as the wire has always carried it. */
export interface EmailAddressDto {
  /** Mongoose defaulted this to `''`; a header with no display name still sends `''`. */
  name: string;
  address: string;
}

/** One attached file, as stored on the message. */
export interface AttachmentDto {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
}

/** The six message flags, still nested exactly as Mongo nested them. */
export interface MessageFlagsDto {
  seen: boolean;
  starred: boolean;
  answered: boolean;
  forwarded: boolean;
  draft: boolean;
  pinned: boolean;
}

/** The flag names, as a value — so a loop over them needs no key assertion. */
const MESSAGE_FLAG_NAMES = [
  'seen',
  'starred',
  'answered',
  'forwarded',
  'draft',
  'pinned',
] as const satisfies ReadonlyArray<keyof MessageFlagsDto>;

/** Each flag's column. The `satisfies` keeps it exhaustive against the DTO. */
const MESSAGE_FLAG_COLUMNS = {
  seen: messages.seen,
  starred: messages.starred,
  answered: messages.answered,
  forwarded: messages.forwarded,
  draft: messages.draft,
  pinned: messages.pinned,
} satisfies Record<keyof MessageFlagsDto, unknown>;

/** The structured card the AI extractor emits, reassembled from its columns. */
export interface MessageCardDto {
  type: string;
  data: Record<string, unknown> | null;
  confidence: number | null;
  extractedAt: Date | null;
}

/** A stored message as every `/email` endpoint returns it. */
export interface MessageDto {
  _id: string;
  id: string;
  userId: string;
  mailboxId: string;
  messageId: string;
  from: EmailAddressDto;
  to: EmailAddressDto[];
  cc: EmailAddressDto[];
  bcc: EmailAddressDto[];
  replyTo?: EmailAddressDto;
  subject: string;
  attachments: AttachmentDto[];
  flags: MessageFlagsDto;
  labels: string[];
  card?: MessageCardDto;
  highlights: MessageHighlight[];
  encrypted: boolean;
  spamScore: number | null;
  spamAction: string | null;
  size: number;
  inReplyTo: string | null;
  references: string[];
  aliasTag: string | null;
  snoozedUntil: Date | null;
  snoozedFromMailbox: string | null;
  scheduledAt: Date | null;
  readReceiptRequested: boolean;
  readReceiptSent: boolean;
  date: Date;
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  draftRevision: number;
  /** Present only on the reads that explicitly asked for the protected bodies. */
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string>;
  /** Attached by {@link EmailService.enrichWithAvatars}. */
  senderAvatarPath?: string | null;
  /** Stable server-derived conversation identity. */
  threadId: string;
  /** Attached by the thread walk in {@link EmailService.listMessages}. */
  threadCount?: number;
  threadParticipants?: string[];
}

/** A mailbox as `GET /email/mailboxes` returns it, counters included. */
export interface MailboxDto {
  _id: string;
  id: string;
  userId: string;
  name: string;
  path: string;
  specialUse: string | null;
  retentionDays: number | null;
  /** Derived from `messages`; see `db/schema/mailboxes.ts`. */
  totalMessages: number;
  unseenMessages: number;
  size: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A user label. System labels are merged in from `constants/systemLabels`. */
export interface LabelDto {
  _id: string;
  id: string;
  userId: string;
  name: string;
  color: string;
  order: number;
  system: false;
  createdAt: Date;
  updatedAt: Date;
}

/** One condition of a mail rule. */
export interface FilterConditionDto {
  field: string;
  operator: string;
  value: string;
}

/** One action of a mail rule. `value` is absent for the actions that take none. */
export interface FilterActionDto {
  type: string;
  value?: string;
}

/** A mail rule with its ordered children. */
export interface FilterDto {
  _id: string;
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  matchAll: boolean;
  order: number;
  conditions: FilterConditionDto[];
  actions: FilterActionDto[];
  createdAt: Date;
  updatedAt: Date;
}

/** A collapsible grouping of labelled mail. */
export interface BundleDto {
  _id: string;
  id: string;
  userId: string;
  name: string;
  icon: string;
  color: string;
  matchLabels: string[];
  enabled: boolean;
  collapsed: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A follow-up note. */
export interface ReminderDto {
  _id: string;
  id: string;
  userId: string;
  text: string;
  remindAt: Date;
  completed: boolean;
  pinned: boolean;
  snoozedUntil: Date | null;
  relatedMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A saved compose template. */
export interface EmailTemplateDto {
  _id: string;
  id: string;
  userId: string;
  name: string;
  subject: string;
  body: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/** An address-book entry. */
export interface ContactDto {
  _id: string;
  id: string;
  userId: string;
  name: string;
  email: string;
  company: string | null;
  notes: string | null;
  starred: boolean;
  autoCollected: boolean;
  lastContactedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One sender in the subscriptions rollup. `_id` is the address, not a row id. */
export interface SubscriptionSenderDto {
  _id: string;
  name: string;
  messageCount: number;
  readCount: number;
  latestDate: Date;
  oldestDate: Date;
  latestMessageId: string;
  hasListUnsubscribe: boolean;
  type: 'list-unsubscribe' | 'pattern-match' | 'frequent';
  senderAvatarPath?: string | null;
}

// ─── Message reads ──────────────────────────────────────────────────

/**
 * Every `messages` column a client may see. The protected five (`text`, `html`,
 * `headers`, `encrypted_body`, `search_vector`) are absent AT THE TYPE LEVEL —
 * see `db/schema/protectedColumns.ts`.
 */
const PUBLIC_MESSAGE_COLUMNS = publicColumns(messages, PROTECTED_COLUMNS_BY_TABLE);

/**
 * The public columns plus the three bodies a single-message read legitimately
 * returns. Naming them is the sanctioned opt-in; it reads differently from an
 * ordinary select precisely so it can be found.
 */
const MESSAGE_COLUMNS_WITH_BODY = {
  ...PUBLIC_MESSAGE_COLUMNS,
  text: messages.text,
  html: messages.html,
  headers: messages.headers,
};

/** A message row as {@link PUBLIC_MESSAGE_COLUMNS} returns it. */
type MessageRow = Omit<typeof messages.$inferSelect, (typeof MESSAGES_PROTECTED_COLUMNS)[number]>;

/** The three bodies, present only on a read that named them. */
interface MessageBodies {
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
}

/** The `to` / `cc` / `bcc` of one message, already ordered. */
interface RecipientGroups {
  to: EmailAddressDto[];
  cc: EmailAddressDto[];
  bcc: EmailAddressDto[];
}

/** An empty recipient set — the shape a message with no addressees still has. */
function emptyRecipients(): RecipientGroups {
  return { to: [], cc: [], bcc: [] };
}

/**
 * Load `to` / `cc` / `bcc` for a set of messages, in header order.
 *
 * One query for the whole page rather than one per message: `ord` is a real
 * column precisely so the order survives, and grouping in JS after a single
 * ordered read is cheaper than a lateral join per row.
 */
async function loadRecipients(
  db: Database,
  messageIds: string[],
): Promise<Map<string, RecipientGroups>> {
  const grouped = new Map<string, RecipientGroups>();
  if (messageIds.length === 0) return grouped;

  const rows = await db
    .select({
      messageId: messageRecipients.messageId,
      kind: messageRecipients.kind,
      name: messageRecipients.name,
      address: messageRecipients.address,
    })
    .from(messageRecipients)
    .where(inArray(messageRecipients.messageId, messageIds))
    .orderBy(asc(messageRecipients.messageId), asc(messageRecipients.ord));

  for (const row of rows) {
    let entry = grouped.get(row.messageId);
    if (!entry) {
      entry = emptyRecipients();
      grouped.set(row.messageId, entry);
    }
    entry[row.kind].push({ name: row.name ?? '', address: row.address });
  }
  return grouped;
}

/** Load attachments for a set of messages, in MIME part order. */
async function loadAttachments(
  db: Database,
  messageIds: string[],
): Promise<Map<string, AttachmentDto[]>> {
  const grouped = new Map<string, AttachmentDto[]>();
  if (messageIds.length === 0) return grouped;

  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      fileId: messageAttachments.fileId,
      name: messageAttachments.name,
      contentType: messageAttachments.contentType,
      size: messageAttachments.size,
      contentId: messageAttachments.contentId,
      isInline: messageAttachments.isInline,
    })
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageIds))
    .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.ord));

  for (const row of rows) {
    const entry = grouped.get(row.messageId);
    const attachment: AttachmentDto = {
      fileId: row.fileId,
      name: row.name,
      contentType: row.contentType,
      size: row.size,
      contentId: row.contentId,
      isInline: row.isInline,
    };
    if (entry) entry.push(attachment);
    else grouped.set(row.messageId, [attachment]);
  }
  return grouped;
}

/**
 * Attachments in the shape the outbound transport takes.
 *
 * `MessageAttachment.contentId` is optional-undefined while the column is nullable,
 * so the two shapes are not assignable to each other — the conversion belongs
 * at the boundary, once, rather than as a `.map()` at every send site.
 */
async function loadOutboundAttachments(db: Database, messageId: string): Promise<MessageAttachment[]> {
  const rows = await db
    .select({
      fileId: messageAttachments.fileId,
      name: messageAttachments.name,
      contentType: messageAttachments.contentType,
      size: messageAttachments.size,
      contentId: messageAttachments.contentId,
      isInline: messageAttachments.isInline,
    })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .orderBy(asc(messageAttachments.ord));

  return rows.map((row) => ({
    fileId: row.fileId,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    ...(row.contentId === null ? {} : { contentId: row.contentId }),
    isInline: row.isInline,
  }));
}

/** Assemble one message row plus its children into the wire shape. */
function toMessageDto(
  row: MessageRow & Partial<MessageBodies>,
  recipients: RecipientGroups,
  attachments: AttachmentDto[],
): MessageDto {
  const dto: MessageDto = {
    _id: row.id,
    id: row.id,
    threadId: row.id,
    userId: row.userId,
    mailboxId: row.mailboxId,
    messageId: row.messageId,
    from: { name: row.fromName ?? '', address: row.fromAddress },
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject: row.subject,
    attachments,
    flags: {
      seen: row.seen,
      starred: row.starred,
      answered: row.answered,
      forwarded: row.forwarded,
      draft: row.draft,
      pinned: row.pinned,
    },
    labels: row.labels,
    highlights: row.highlights,
    encrypted: row.encrypted,
    spamScore: row.spamScore,
    spamAction: row.spamAction,
    size: row.size,
    inReplyTo: row.inReplyTo,
    references: row.references,
    aliasTag: row.aliasTag,
    snoozedUntil: row.snoozedUntil,
    snoozedFromMailbox: row.snoozedFromMailbox,
    scheduledAt: row.scheduledAt,
    draftRevision: row.draftRevision,
    readReceiptRequested: row.readReceiptRequested,
    readReceiptSent: row.readReceiptSent,
    date: row.date,
    receivedAt: row.receivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  // `replyTo` and `card` were whole sub-documents: absent, not null, when unset.
  // The CHECKs on `messages` are what make "the column is null" and "the
  // sub-document is missing" the same statement here.
  if (row.replyToAddress !== null) {
    dto.replyTo = { name: row.replyToName ?? '', address: row.replyToAddress };
  }
  if (row.cardType !== null) {
    dto.card = {
      type: row.cardType,
      data: row.cardData,
      confidence: row.cardConfidence,
      extractedAt: row.cardExtractedAt,
    };
  }
  if ('text' in row) dto.text = row.text ?? null;
  if ('html' in row) dto.html = row.html ?? null;
  if ('headers' in row) dto.headers = row.headers ?? {};

  return dto;
}

/** Assemble a page of message rows, loading both child tables once. */
async function toMessageDtos(
  db: Database,
  rows: Array<MessageRow & Partial<MessageBodies>>,
): Promise<MessageDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [recipients, attachments] = await Promise.all([
    loadRecipients(db, ids),
    loadAttachments(db, ids),
  ]);
  return rows.map((row) =>
    toMessageDto(row, recipients.get(row.id) ?? emptyRecipients(), attachments.get(row.id) ?? []),
  );
}

/**
 * The set of RFC Message-ID tokens that identify a message's place in a thread:
 * its own `Message-ID`, its `In-Reply-To`, and every entry of `References`.
 *
 * Two messages are in the same thread exactly when these sets intersect — which
 * is, term for term, the sibling test the Mongo pipeline finished in JS
 * (`m.messageId ∈ myIds ∨ m.inReplyTo ∈ myIds ∨ m.references ∩ myIds ≠ ∅`,
 * where `myIds` was this same set). Stating it as one symmetric relation is
 * what lets the walk be transitive instead of one hop.
 */
function threadKeys(alias: string): SQL {
  // `references` is a RESERVED word; drizzle quotes every identifier it emits
  // and hand-written SQL has to do the same.
  const table = sql.raw(alias);
  return sql`(${table}."references"
    || case when ${table}.in_reply_to is null then '{}'::text[] else array[${table}.in_reply_to] end
    || array[${table}.message_id])`;
}

/**
 * The adjacency predicate, decomposed so each arm can use an index:
 * `messages_user_id_message_id_idx`, `messages_user_id_in_reply_to_idx` and the
 * GIN `messages_references_idx` respectively. Written as one array overlap it
 * would be a sequential scan of every message the user owns.
 */
function threadAdjacency(alias: string, keys: SQL): SQL {
  const table = sql.raw(alias);
  return sql`(${table}.message_id = any(${keys})
    or ${table}.in_reply_to = any(${keys})
    or ${table}.references && ${keys})`;
}

/**
 * Either the pool handle or an open transaction. Both answer the same query
 * API, and a helper that writes children has to work inside the transaction
 * that also wrote their parent.
 */
type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Exactly what a filter condition can look at.
 *
 * Only the five fields the condition vocabulary names, so the evaluator cannot
 * silently start depending on a sixth. `attachmentCount` replaces the embedded
 * `attachments` array the evaluator only ever measured the length of — the
 * attachments are a child table now, and counting them is one aggregate rather
 * than a load of every row.
 */
interface FilterEvaluationMessage {
  from: EmailAddressDto;
  to: EmailAddressDto[];
  subject: string;
  size: number;
  attachmentCount: number;
}

/** One condition as a validated request carries it. */
export interface FilterConditionInput {
  field: (typeof EMAIL_FILTER_CONDITION_FIELDS)[number];
  operator: (typeof EMAIL_FILTER_CONDITION_OPERATORS)[number];
  value: string;
}

/** One action as a validated request carries it. */
export interface FilterActionInput {
  type: (typeof EMAIL_FILTER_ACTION_TYPES)[number];
  value?: string;
}

/** Insert a rule's ordered children. Absent lists are left untouched. */
async function writeFilterChildren(
  tx: DbOrTx,
  filterId: string,
  conditions: FilterConditionInput[] | undefined,
  actions: FilterActionInput[] | undefined,
): Promise<void> {
  if (conditions && conditions.length > 0) {
    await tx.insert(emailFilterConditions).values(
      conditions.map((condition, ord) => ({
        filterId,
        ord,
        field: condition.field,
        operator: condition.operator,
        value: condition.value,
      })),
    );
  }
  if (actions && actions.length > 0) {
    await tx.insert(emailFilterActions).values(
      actions.map((action, ord) => ({
        filterId,
        ord,
        type: action.type,
        value: action.value ?? null,
      })),
    );
  }
}

/**
 * Refuse a rule with no conditions or no actions — Mongoose's two
 * `length > 0` validators, enforced where Postgres can enforce them.
 *
 * The scoping is what the outer parentheses in `incompleteEmailFilters()` exist
 * for: without them this `and` would render as `(id = $1 and …) or …` and
 * reject on ANY broken rule in the table.
 */
async function assertFilterComplete(tx: DbOrTx, filterId: string): Promise<void> {
  const broken = await tx
    .select({ id: emailFilters.id })
    .from(emailFilters)
    .where(and(eq(emailFilters.id, filterId), incompleteEmailFilters()))
    .limit(1);
  if (broken.length > 0) {
    throw new BadRequestError('A filter needs at least one condition and one action');
  }
}

/** Read one rule's own row, scoped to its owner. */
async function readFilterRow(
  db: Database,
  userId: string,
  filterId: string,
): Promise<typeof emailFilters.$inferSelect> {
  const [row] = await db
    .select()
    .from(emailFilters)
    .where(and(eq(emailFilters.id, filterId), eq(emailFilters.userId, userId)))
    .limit(1);
  if (!row) throw new NotFoundError('Filter not found');
  return row;
}

/** Attach the ordered conditions and actions to a set of rule rows. */
async function loadFilterChildren(
  db: Database,
  rows: Array<typeof emailFilters.$inferSelect>,
): Promise<FilterDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [conditionRows, actionRows] = await Promise.all([
    db
      .select()
      .from(emailFilterConditions)
      .where(inArray(emailFilterConditions.filterId, ids))
      .orderBy(asc(emailFilterConditions.filterId), asc(emailFilterConditions.ord)),
    db
      .select()
      .from(emailFilterActions)
      .where(inArray(emailFilterActions.filterId, ids))
      .orderBy(asc(emailFilterActions.filterId), asc(emailFilterActions.ord)),
  ]);

  const conditionsById = new Map<string, FilterConditionDto[]>();
  for (const row of conditionRows) {
    const entry = conditionsById.get(row.filterId) ?? [];
    entry.push({ field: row.field, operator: row.operator, value: row.value });
    conditionsById.set(row.filterId, entry);
  }

  const actionsById = new Map<string, FilterActionDto[]>();
  for (const row of actionRows) {
    const entry = actionsById.get(row.filterId) ?? [];
    // Mongoose omitted `value` when unset rather than storing null.
    entry.push(row.value === null ? { type: row.type } : { type: row.type, value: row.value });
    actionsById.set(row.filterId, entry);
  }

  return rows.map((row) => ({
    _id: row.id,
    id: row.id,
    userId: row.userId,
    name: row.name,
    enabled: row.enabled,
    matchAll: row.matchAll,
    order: row.order,
    conditions: conditionsById.get(row.id) ?? [],
    actions: actionsById.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/** One stored label in the wire shape. `system` is always false — see `listLabels`. */
function toLabelDto(row: typeof labelsTable.$inferSelect): LabelDto {
  return {
    _id: row.id,
    id: row.id,
    userId: row.userId,
    name: row.name,
    color: row.color,
    order: row.order,
    system: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toBundleDto(row: typeof bundles.$inferSelect): BundleDto {
  return {
    _id: row.id,
    id: row.id,
    userId: row.userId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    matchLabels: row.matchLabels,
    enabled: row.enabled,
    collapsed: row.collapsed,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReminderDto(row: typeof reminders.$inferSelect): ReminderDto {
  return {
    _id: row.id,
    id: row.id,
    userId: row.userId,
    text: row.text,
    remindAt: row.remindAt,
    completed: row.completed,
    pinned: row.pinned,
    snoozedUntil: row.snoozedUntil,
    relatedMessageId: row.relatedMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTemplateDto(row: typeof emailTemplates.$inferSelect): EmailTemplateDto {
  return {
    _id: row.id,
    id: row.id,
    userId: row.userId,
    name: row.name,
    subject: row.subject,
    body: row.body,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toContactDto(row: typeof contacts.$inferSelect): ContactDto {
  return {
    _id: row.id,
    id: row.id,
    userId: row.userId,
    name: row.name,
    email: row.email,
    company: row.company,
    notes: row.notes,
    starred: row.starred,
    autoCollected: row.autoCollected,
    lastContactedAt: row.lastContactedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The two things every outbound path needs about the sending account: the
 * username the address is derived from, and the name parts
 * `resolveEmailFromName` composes a display name out of.
 *
 * Shaped as `DisplayNameSource` so it feeds that helper directly. `name.full`
 * and `name.displayName` were Mongoose VIRTUALS with no column behind them —
 * they stay derived, so there is nothing else to select.
 */
async function loadSenderIdentity(
  db: Database,
  userId: string,
): Promise<{ username: string | null; name: { first: string | null; last: string | null } } | undefined> {
  const [row] = await db
    .select({ username: users.username, first: users.nameFirst, last: users.nameLast })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return undefined;
  return { username: row.username, name: { first: row.first, last: row.last } };
}

/**
 * Insert a message and its two child tables in one transaction.
 *
 * The recipients and attachments are the message — a crash between the parent
 * insert and the children would leave stored mail claiming addressees it does
 * not have, which is exactly what Mongo's single-document write made
 * impossible and what a naive three-statement port would reintroduce.
 *
 * Addresses are lower-cased and trimmed HERE, the call-site obligation
 * `db/schema/messages.ts` records: Mongoose applied it with a setter that
 * Postgres has no counterpart for, and skipping it turns address matching
 * silently case-sensitive.
 */
async function insertMessageWithChildren(
  db: Database,
  values: typeof messages.$inferInsert,
  recipients: { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] },
  attachments: MessageAttachment[],
): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(messages).values(values).returning({ id: messages.id });

    const recipientRows = (['to', 'cc', 'bcc'] as const).flatMap((kind) =>
      (recipients[kind] ?? []).map((address, ord) => ({
        messageId: row.id,
        kind,
        ord,
        name: address.name?.trim() ? address.name.trim() : null,
        address: address.address.trim().toLowerCase(),
      })),
    );
    if (recipientRows.length > 0) {
      await tx.insert(messageRecipients).values(recipientRows);
    }

    if (attachments.length > 0) {
      await tx.insert(messageAttachments).values(
        attachments.map((attachment, ord) => ({
          messageId: row.id,
          ord,
          fileId: attachment.fileId,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          contentId: attachment.contentId ?? null,
          isInline: attachment.isInline,
        })),
      );
    }

    return row.id;
  });
}

/** Read one message back in full, for the paths that return what they wrote. */
async function readMessageDto(db: Database, messageId: string): Promise<MessageDto> {
  const [row] = await db
    .select(PUBLIC_MESSAGE_COLUMNS)
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) throw new NotFoundError('Message not found');
  const [dto] = await toMessageDtos(db, [row]);
  return dto;
}

class EmailService {
  /**
   * Compute the storage footprint of a message: UTF-8 body bytes plus the
   * declared size of every attachment. Used so attachment bytes count toward
   * the per-user storage quota on the send path (not just the body).
   */
  calculateMessageStorageSize(message: {
    text?: string;
    html?: string;
    attachments?: Array<{ size: number }>;
  }): number {
    const bodySize = Buffer.byteLength((message.text || '') + (message.html || ''), 'utf8');
    const attachmentSize = (message.attachments ?? []).reduce(
      (sum, attachment) => sum + (attachment.size || 0),
      0,
    );
    return bodySize + attachmentSize;
  }

  // ─── Mailbox Management ───────────────────────────────────────────

  /**
   * Provision default mailboxes for a user.
   * Called lazily on first email access or explicitly after signup.
   */
  async provisionMailboxes(userId: string): Promise<MailboxDto[]> {
    const db = getDb();
    const [existing] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.userId, userId))
      .limit(1);
    if (existing) {
      return this.listMailboxes(userId);
    }

    await db.insert(mailboxes).values(
      DEFAULT_MAILBOXES.map((mb) => ({
        userId,
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse,
        retentionDays: 'retentionDays' in mb ? mb.retentionDays : null,
      })),
    );
    logger.info('Email mailboxes provisioned', { userId });

    // Create welcome email in the Inbox (don't fail provisioning if this fails)
    try {
      const inbox = await this.getMailboxBySpecialUse(userId, '\\Inbox');
      if (inbox) {
        await this.createWelcomeEmail(userId, inbox.id);
      }
    } catch (err) {
      logger.error('Failed to create welcome email', err instanceof Error ? err : new Error(String(err)), {
        component: 'EmailService',
        method: 'provisionMailboxes',
        userId,
      });
    }

    return this.listMailboxes(userId);
  }

  /**
   * Ensure mailboxes exist for a user, provisioning if needed.
   * Also syncs any missing default mailboxes for existing users.
   */
  // ─── Default Labels ──────────────────────────────────────────────

  private static readonly DEFAULT_BUNDLES = [
    { name: 'Promotions', icon: 'tag-outline', color: '#34A853', matchLabels: ['Shopping'], order: 0 },
    { name: 'Social', icon: 'account-group-outline', color: '#E8710A', matchLabels: ['Social'], order: 1 },
    { name: 'Updates', icon: 'bell-outline', color: '#607D8B', matchLabels: ['Updates'], order: 2 },
    { name: 'Forums', icon: 'forum-outline', color: '#795548', matchLabels: ['Forums'], order: 3 },
  ];

  async ensureMailboxes(userId: string): Promise<void> {
    const db = getDb();
    const existing = await db
      .select({ specialUse: mailboxes.specialUse })
      .from(mailboxes)
      .where(eq(mailboxes.userId, userId));
    if (existing.length === 0) {
      await this.provisionMailboxes(userId);
      return;
    }

    // Sync missing default mailboxes (e.g., Archive added after user created)
    const existingSpecialUse = new Set(existing.map((m) => m.specialUse).filter(Boolean));
    const missing = DEFAULT_MAILBOXES.filter((mb) => mb.specialUse && !existingSpecialUse.has(mb.specialUse));

    if (missing.length > 0) {
      await db.insert(mailboxes).values(
        missing.map((mb) => ({
          userId,
          name: mb.name,
          path: mb.path,
          specialUse: mb.specialUse,
          retentionDays: 'retentionDays' in mb ? mb.retentionDays : null,
        })),
      );
      logger.info('Synced missing default mailboxes', { userId, count: missing.length });
    }
  }

  /**
   * Create a welcome email in the user's Inbox.
   * Called once during initial mailbox provisioning.
   */
  private async createWelcomeEmail(userId: string, inboxMailboxId: string): Promise<void> {
    const db = getDb();
    const user = await loadSenderIdentity(db, userId);
    if (!user) return;

    const emailName = resolveEmailFromName(user);
    const displayName = emailName || 'there';
    const recipientName = emailName;
    const recipientAddress = user.username ? resolveEmailAddress(user.username) : `${userId}@${EMAIL_DOMAIN}`;

    const subject = 'Welcome to Inbox by Oxy';
    const text = [
      `Hi ${displayName},`,
      '',
      'Welcome to Inbox by Oxy — your new email, built for clarity.',
      '',
      'A few things to get you started:',
      '',
      `- Your address: ${recipientAddress}`,
      '- Smart labels sort your mail automatically',
      '- Bundles group newsletters, social updates, and promos',
      '- Snooze messages to deal with them later',
      '- Pin important emails so they stay at the top',
      '',
      'We are glad to have you here. Just reply to this email if you ever need help.',
      '',
      'The Oxy Team',
    ].join('\n');

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" style="color-scheme: light; supported-color-schemes: light;" xml:lang="en">
  <body>
    <div style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">Your new email is ready &mdash; here&#39;s what you can do&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>
    <title>Inbox by Oxy</title>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <!--[if gte mso 9]><xml>
    <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
    </xml><![endif]-->
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f4f4;">
      <tr>
        <td align="center" valign="top" width="100%">
          <table align="center" border="0" cellspacing="0" cellpadding="0">
            <tr>
              <td>
                <table width="550" border="0" cellspacing="0" cellpadding="0" role="presentation" style="width: 550px; background-color: #ffffff; font-family: Helvetica, Arial, sans-serif;">
                  <tr>
                    <td>
                      <!-- Logo -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr>
                          <td align="center" style="padding: 32px 24px 16px;">
                            <span style="font-size: 24px; font-weight: 700; color: #000000; letter-spacing: -0.5px;">Inbox by Oxy</span>
                          </td>
                        </tr>
                      </table>
                      <!-- Greeting bar -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr>
                          <td style="padding: 0 24px;">
                            <table width="100%" cellspacing="0" cellpadding="0" border="0" role="presentation">
                              <tr>
                                <td style="border-radius: 8px; padding: 18px 24px; background-color: #000000;">
                                  <table width="100%" cellspacing="0" cellpadding="0" border="0" role="presentation">
                                    <tr>
                                      <td valign="middle" style="color: #ffffff; font-family: Helvetica, Arial, sans-serif; font-size: 16px; line-height: 20px; font-weight: bold;">
                                        Hi, ${displayName}
                                      </td>
                                      <td align="right" style="font-family: Helvetica, Arial, sans-serif; font-size: 13px; line-height: 16px; color: #999999;">
                                        ${recipientAddress}
                                      </td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      <!-- Spacer -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr><td style="line-height: 0; padding-bottom: 24px;"></td></tr>
                      </table>
                      <!-- Hero -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr>
                          <td style="padding: 0 24px;">
                            <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation" style="border-radius: 12px; overflow: hidden; background-color: #f0f0f0;">
                              <tr>
                                <td style="padding: 48px 32px; text-align: center;">
                                  <p style="font-size: 32px; font-weight: 700; color: #000000; margin: 0 0 8px; line-height: 1.2; letter-spacing: -0.5px;">Welcome aboard</p>
                                  <p style="font-size: 16px; color: #666666; margin: 0; line-height: 1.5;">Your email, built for clarity.</p>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      <!-- Spacer -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr><td style="line-height: 0; padding-bottom: 24px;"></td></tr>
                      </table>
                      <!-- Features list -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr>
                          <td style="padding: 0 24px;">
                            <p style="font-size: 18px; font-weight: 700; color: #000000; margin: 0 0 20px; line-height: 1.3;">Here&#39;s what you can do now:</p>
                            <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
                                  <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                                    <tr>
                                      <td width="32" valign="top" style="font-size: 18px; padding-right: 12px;">&#9993;</td>
                                      <td style="font-size: 15px; line-height: 1.5; color: #333333;"><strong>Your address is ready</strong><br/><span style="color: #666666;">${recipientAddress}</span></td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
                                  <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                                    <tr>
                                      <td width="32" valign="top" style="font-size: 18px; padding-right: 12px;">&#127991;</td>
                                      <td style="font-size: 15px; line-height: 1.5; color: #333333;"><strong>Smart labels</strong><br/><span style="color: #666666;">Your mail gets sorted automatically</span></td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
                                  <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                                    <tr>
                                      <td width="32" valign="top" style="font-size: 18px; padding-right: 12px;">&#128230;</td>
                                      <td style="font-size: 15px; line-height: 1.5; color: #333333;"><strong>Bundles</strong><br/><span style="color: #666666;">Newsletters, social updates, and promos grouped together</span></td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
                                  <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                                    <tr>
                                      <td width="32" valign="top" style="font-size: 18px; padding-right: 12px;">&#9200;</td>
                                      <td style="font-size: 15px; line-height: 1.5; color: #333333;"><strong>Snooze</strong><br/><span style="color: #666666;">Hide messages and bring them back when you&#39;re ready</span></td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 12px 0;">
                                  <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                                    <tr>
                                      <td width="32" valign="top" style="font-size: 18px; padding-right: 12px;">&#128204;</td>
                                      <td style="font-size: 15px; line-height: 1.5; color: #333333;"><strong>Pin</strong><br/><span style="color: #666666;">Keep important emails at the top</span></td>
                                    </tr>
                                  </table>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      <!-- Spacer -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                        <tr><td style="line-height: 0; padding-bottom: 32px;"></td></tr>
                      </table>
                      <!-- Footer -->
                      <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation" bgcolor="#ffffff">
                        <tr>
                          <td style="padding: 32px 24px; border-top: 1px solid #f0f0f0;">
                            <table width="100%" border="0" cellspacing="0" cellpadding="0" role="presentation">
                              <tr>
                                <td align="left">
                                  <span style="font-size: 16px; font-weight: 700; color: #000000; letter-spacing: -0.3px;">Inbox by Oxy</span>
                                </td>
                              </tr>
                              <tr>
                                <td align="left" style="padding-top: 12px; color: #999999; font-family: Helvetica, Arial, sans-serif; font-size: 12px; line-height: 18px;">
                                  This is an automated welcome message. You can reply to this email if you ever need help.
                                </td>
                              </tr>
                              <tr>
                                <td align="left" style="padding-top: 12px; color: #999999; font-family: Helvetica, Arial, sans-serif; font-size: 12px; line-height: 18px;">
                                  &copy; ${new Date().getFullYear()} Oxy. All rights reserved.
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const now = new Date();
    const size = Buffer.byteLength(text, 'utf8');

    await insertMessageWithChildren(
      db,
      {
        userId,
        mailboxId: inboxMailboxId,
        messageId: `<welcome-${userId}-${uuidv4()}@${EMAIL_DOMAIN}>`,
        fromName: 'Inbox by Oxy',
        fromAddress: `hello@${EMAIL_DOMAIN}`,
        subject,
        text,
        html,
        size,
        date: now,
        receivedAt: now,
      },
      { to: [{ name: recipientName, address: recipientAddress }] },
      [],
    );

    logger.info('Welcome email created', { userId });
  }

  /**
   * A user's folders with the three counters Mongo cached on the row.
   *
   * `total_messages`, `unseen_messages` and `size` are derived here — the
   * numbers are the same numbers, and the eighteen hand-maintained `$inc` sites
   * that kept them approximately current are gone. See `db/schema/mailboxes.ts`.
   */
  async listMailboxes(userId: string): Promise<MailboxDto[]> {
    const stats = getDb()
      .select({
        mailboxId: messages.mailboxId,
        total: sql<number>`count(*)::int`.as('total'),
        unseen: sql<number>`count(*) filter (where not ${messages.seen})::int`.as('unseen'),
        bytes: sql<number>`coalesce(sum(${messages.size}), 0)::bigint`.as('bytes'),
      })
      .from(messages)
      .where(eq(messages.userId, userId))
      .groupBy(messages.mailboxId)
      .as('stats');

    const rows = await getDb()
      .select({
        mailbox: mailboxes,
        total: stats.total,
        unseen: stats.unseen,
        bytes: stats.bytes,
      })
      .from(mailboxes)
      .leftJoin(stats, eq(stats.mailboxId, mailboxes.id))
      .where(eq(mailboxes.userId, userId))
      .orderBy(asc(mailboxes.path));

    return rows.map((row) => ({
      _id: row.mailbox.id,
      id: row.mailbox.id,
      userId: row.mailbox.userId,
      name: row.mailbox.name,
      path: row.mailbox.path,
      specialUse: row.mailbox.specialUse,
      retentionDays: row.mailbox.retentionDays,
      totalMessages: row.total ?? 0,
      unseenMessages: row.unseen ?? 0,
      // `sum()` is `numeric`, which postgres.js hands back as a string.
      size: Number(row.bytes ?? 0),
      createdAt: row.mailbox.createdAt,
      updatedAt: row.mailbox.updatedAt,
    }));
  }

  /**
   * Find a folder by its IMAP special-use attribute.
   *
   * Returns the stored row WITHOUT the derived counters: every caller uses it
   * to resolve an id for a write, and none of them serializes the result — so
   * paying for the aggregate on the inbound-mail path would buy nothing.
   */
  async getMailboxBySpecialUse(
    userId: string,
    specialUse: string,
  ): Promise<typeof mailboxes.$inferSelect | undefined> {
    const [row] = await getDb()
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.specialUse, specialUse)))
      .limit(1);
    return row;
  }

  /** As {@link getMailboxBySpecialUse}, by id. Used to authorize, not to render. */
  async getMailboxById(
    userId: string,
    mailboxId: string,
  ): Promise<typeof mailboxes.$inferSelect | undefined> {
    const [row] = await getDb()
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, userId)))
      .limit(1);
    return row;
  }

  async createMailbox(userId: string, name: string, parentPath?: string): Promise<MailboxDto> {
    const path = parentPath ? `${parentPath}/${name}` : name;
    const db = getDb();

    const [existing] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, userId), eq(mailboxes.path, path)))
      .limit(1);
    if (existing) {
      throw new BadRequestError(`Mailbox "${path}" already exists`);
    }

    const [row] = await db.insert(mailboxes).values({ userId, name, path }).returning();

    return {
      _id: row.id,
      id: row.id,
      userId: row.userId,
      name: row.name,
      path: row.path,
      specialUse: row.specialUse,
      retentionDays: row.retentionDays,
      // A folder created this instant holds nothing.
      totalMessages: 0,
      unseenMessages: 0,
      size: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async deleteMailbox(userId: string, mailboxId: string): Promise<void> {
    const mailbox = await this.getMailboxById(userId, mailboxId);
    if (!mailbox) {
      throw new NotFoundError('Mailbox not found');
    }
    if (mailbox.specialUse) {
      throw new BadRequestError('Cannot delete a system mailbox');
    }

    // Unlink the attachments first — the file manager owns blob lifecycle and
    // has to be told. Deleting the mailbox then takes its messages with it:
    // `messages.mailbox_id` CASCADEs, which is the same two-step this method
    // used to perform by hand, except Postgres cannot forget the second half.
    await this.deleteAttachmentsForMailbox(userId, mailboxId);
    await getDb().delete(mailboxes).where(eq(mailboxes.id, mailboxId));
  }

  // ─── Messages ─────────────────────────────────────────────────────

  async listMessages(
    userId: string,
    mailboxId: string | null,
    options: { limit?: number; offset?: number; cursor?: string; unseenOnly?: boolean; starred?: boolean; label?: string } = {}
  ): Promise<{ data: MessageDto[]; total: number; limit: number; offset: number; nextCursor?: string | null }> {
    const { limit = 50, offset = 0, cursor: cursorToken, unseenOnly = false, starred = false, label } = options;
    const db = getDb();
    const cursorMode = cursorToken !== undefined;
    const cursor = cursorToken
      ? decodeEmailPageCursor(cursorToken, 'messages') as Extract<EmailPageCursor, { kind: 'messages' }>
      : null;

    const baseWhere = and(
      eq(messages.userId, userId),
      ...(mailboxId ? [eq(messages.mailboxId, mailboxId)] : []),
      ...(starred ? [eq(messages.starred, true)] : []),
      ...(unseenOnly ? [eq(messages.seen, false)] : []),
      ...(label ? [sql`${messages.labels} @> array[${label}]::text[]`] : []),
    );
    const where = and(
      baseWhere,
      ...(cursor
        ? [or(
            lt(messages.pinned, cursor.pinned),
            and(
              eq(messages.pinned, cursor.pinned),
              or(
                lt(messages.date, new Date(cursor.date)),
                and(eq(messages.date, new Date(cursor.date)), lt(messages.id, cursor.id)),
              ),
            ),
          )]
        : []),
    );

    const [fetchedRows, [countRow]] = await Promise.all([
      db
        .select(PUBLIC_MESSAGE_COLUMNS)
        .from(messages)
        .where(where)
        .orderBy(desc(messages.pinned), desc(messages.date), desc(messages.id))
        .limit(cursorMode ? limit + 1 : limit)
        .offset(cursorMode ? 0 : offset),
      db.select({ total: sql<number>`count(*)::int` }).from(messages).where(baseWhere),
    ]);

    const hasMore = cursorMode ? fetchedRows.length > limit : offset + limit < (countRow?.total ?? 0);
    const rows = cursorMode ? fetchedRows.slice(0, limit) : fetchedRows;
    const data = await toMessageDtos(db, rows);
    await this.attachThreadMetadata(userId, data);
    await EmailService.enrichWithAvatars(data);

    const last = rows.at(-1);
    return {
      data,
      total: countRow?.total ?? 0,
      limit,
      offset: cursorMode ? 0 : offset,
      ...(cursorMode
        ? {
            nextCursor: hasMore && last
              ? encodeEmailPageCursor({
                  version: 1,
                  kind: 'messages',
                  pinned: last.pinned,
                  date: last.date.toISOString(),
                  id: last.id,
                })
              : null,
          }
        : {}),
    };
  }

  /**
   * Attach `threadCount` / `threadParticipants` to every page message that has
   * any threading header.
   *
   * ## What changed, deliberately
   *
   * Mongo fetched every message adjacent to the union of the page's Message-ID
   * tokens, then resolved siblings per page message IN JS — ONE hop. A message
   * two replies removed that had dropped the shared reference was simply not
   * counted. Postgres walks the same adjacency TRANSITIVELY (`WITH RECURSIVE`),
   * so the numbers are the whole thread rather than its immediate neighbourhood.
   * In practice they usually agree, because `References` accumulates the whole
   * ancestor chain — but where they differ, the old answer was wrong.
   *
   * `root_id` rides along so each page message keeps its OWN component: without
   * it the walk would return one merged set and every page message would report
   * the union of every thread on the page.
   *
   * The `union` (not `union all`) is the cycle guard: a row already in the
   * result is not re-expanded, so a `References` loop terminates instead of
   * recursing forever.
   */
  private async attachThreadMetadata(userId: string, page: MessageDto[]): Promise<void> {
    const seeds = page.filter((m) => m.inReplyTo !== null || m.references.length > 0);
    if (seeds.length === 0) return;

    const seedIds = seeds.map((m) => m.id);
    const rows = await getDb().execute<{
      rootId: string;
      threadId: string;
      threadCount: number;
      participants: string[];
    }>(sql`
      with recursive walk(root_id, id, ks) as (
          select seed.id, seed.id, ${threadKeys('seed')}
          from messages seed
          where seed.user_id = ${userId} and seed.id = any(${textArray(seedIds)})
        union
          select walk.root_id, linked.id, ${threadKeys('linked')}
          from walk
          join messages linked
            on linked.user_id = ${userId}
           and ${threadAdjacency('linked', sql.raw('walk.ks'))}
      )
      select walk.root_id as "rootId",
             min(walk.id) as "threadId",
             count(distinct walk.id)::int as "threadCount",
             array_agg(distinct member.from_address) as participants
      from walk
      join messages member on member.id = walk.id
      group by walk.root_id
    `);

    const byRoot = new Map(rows.map((row) => [row.rootId, row]));
    for (const message of page) {
      const thread = byRoot.get(message.id);
      // A message is always in its own component, so a count of one means it
      // has headers but no counterpart stored here — same rule Mongo applied.
      if (!thread) continue;
      message.threadId = thread.threadId;
      if (thread.threadCount <= 1) continue;
      message.threadCount = thread.threadCount;
      message.threadParticipants = thread.participants;
    }
  }

  async getMessage(userId: string, messageId: string): Promise<MessageDto | undefined> {
    const db = getDb();
    const [row] = await db
      .select(MESSAGE_COLUMNS_WITH_BODY)
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!row) return undefined;

    const [dto] = await toMessageDtos(db, [row]);
    await this.attachThreadMetadata(userId, [dto]);
    await EmailService.enrichWithAvatars([dto]);
    return dto;
  }

  /** Read an idempotent outbound message by its RFC Message-ID. */
  async findMessageByRfcMessageId(userId: string, rfcMessageId: string): Promise<MessageDto | null> {
    const [row] = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.messageId, rfcMessageId)))
      .limit(1);
    return row ? readMessageDto(getDb(), row.id) : null;
  }

  /**
   * Set some subset of the six flags.
   *
   * The mailbox `unseenMessages` write that used to follow is GONE: the count
   * is derived from `messages.seen`, so flipping the flag IS the update.
   */
  async updateMessageFlags(
    userId: string,
    messageId: string,
    flags: Partial<MessageFlagsDto>
  ): Promise<MessageDto> {
    const db = getDb();
    const owned = and(eq(messages.id, messageId), eq(messages.userId, userId));

    // An empty flag set is a no-op read, not an error. Drizzle refuses a `set`
    // with no columns, and Mongo refused an empty `$set` too.
    const [updated] = Object.keys(flags).length === 0
      ? await db.select({ id: messages.id }).from(messages).where(owned).limit(1)
      : await db.update(messages).set(flags).where(owned).returning({ id: messages.id });

    if (!updated) {
      throw new NotFoundError('Message not found');
    }

    return readMessageDto(db, updated.id);
  }

  async moveMessage(userId: string, messageId: string, targetMailboxId: string): Promise<MessageDto> {
    const db = getDb();
    const targetMailbox = await this.getMailboxById(userId, targetMailboxId);
    if (!targetMailbox) throw new NotFoundError('Target mailbox not found');

    const [moved] = await db
      .update(messages)
      .set({ mailboxId: targetMailbox.id })
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .returning({ id: messages.id });

    if (!moved) throw new NotFoundError('Message not found');

    return readMessageDto(db, moved.id);
  }

  /**
   * Apply the same flag change to up to a hundred messages.
   *
   * `matchedCount` and `modifiedCount` are still reported separately because
   * the wire contract does: the first is how many of the requested ids the
   * caller owns, the second how many the write actually changed.
   */
  async bulkUpdateMessageFlags(
    userId: string,
    messageIds: string[],
    flags: Partial<MessageFlagsDto>
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    if (messageIds.length === 0) return { matchedCount: 0, modifiedCount: 0 };
    const db = getDb();
    const owned = and(inArray(messages.id, messageIds), eq(messages.userId, userId));

    // "Already in the requested state" is what separates matched from modified:
    // Mongo's `modifiedCount` skipped documents the write would not change. The
    // predicate is stated as the DISJUNCTION of the differing flags rather than
    // the negation of their conjunction — the same set by De Morgan, and it
    // composes with `and(...)` without a nullable operand in the middle.
    const differs = MESSAGE_FLAG_NAMES.flatMap((name) => {
      const value = flags[name];
      return value === undefined ? [] : [ne(MESSAGE_FLAG_COLUMNS[name], value)];
    });

    const [matchedRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(owned);
    const matchedCount = matchedRow?.count ?? 0;

    if (differs.length === 0) {
      return { matchedCount, modifiedCount: 0 };
    }

    const modified = await db
      .update(messages)
      .set(flags)
      .where(and(owned, or(...differs)))
      .returning({ id: messages.id });

    return { matchedCount, modifiedCount: modified.length };
  }

  async bulkMoveMessages(
    userId: string,
    messageIds: string[],
    targetMailboxId: string
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const targetMailbox = await this.getMailboxById(userId, targetMailboxId);
    if (!targetMailbox) throw new NotFoundError('Target mailbox not found');
    if (messageIds.length === 0) return { matchedCount: 0, modifiedCount: 0 };

    const db = getDb();
    const owned = and(inArray(messages.id, messageIds), eq(messages.userId, userId));

    const [[matchedRow], modified] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(messages).where(owned),
      db
        .update(messages)
        .set({ mailboxId: targetMailbox.id })
        .where(and(owned, not(eq(messages.mailboxId, targetMailbox.id))))
        .returning({ id: messages.id }),
    ]);

    return { matchedCount: matchedRow?.count ?? 0, modifiedCount: modified.length };
  }

  async deleteMessage(userId: string, messageId: string, permanent = false): Promise<void> {
    const db = getDb();
    const [message] = await db
      .select({ id: messages.id, messageId: messages.messageId })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!message) throw new NotFoundError('Message not found');

    if (permanent) {
      // Unlink the attachments in the file manager first — it owns blob
      // lifecycle. The `message_attachments` rows themselves CASCADE.
      await this.deleteMessageAttachments(message);
      await db.delete(messages).where(eq(messages.id, messageId));
    } else {
      // Move to Trash
      const trash = await this.getMailboxBySpecialUse(userId, '\\Trash');
      if (!trash) throw new NotFoundError('Trash mailbox not found');
      await this.moveMessage(userId, messageId, trash.id);
    }
  }

  // ─── Storing an incoming message (from SMTP inbound) ──────────────

  async storeIncomingMessage(params: {
    recipientUsername: string;
    from: EmailAddress;
    to: EmailAddress[];
    cc?: EmailAddress[];
    subject: string;
    text?: string;
    html?: string;
    messageId: string;
    inReplyTo?: string;
    references?: string[];
    date: Date;
    headers: Record<string, string>;
    attachments?: Array<{
      filename: string;
      contentType: string;
      content: Buffer;
      contentId?: string;
      isInline?: boolean;
    }>;
    spamScore?: number;
    spamAction?: string;
    aliasTag?: string;
    rawSize: number;
  }): Promise<MessageDto> {
    const db = getDb();
    // Resolve the recipient user. `lower(btrim(username))` matches
    // `users_lower_username_key`; a plain equality would not use it.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(btrim(${users.username})) = lower(btrim(${params.recipientUsername}))`)
      .limit(1);
    if (!user) throw new NotFoundError('Recipient user not found');

    const userId = user.id;
    await this.ensureMailboxes(userId);

    // Check quota
    await this.enforceQuota(userId, params.rawSize);

    // Determine target mailbox (Spam or Inbox)
    const isSpam = (params.spamScore ?? 0) >= 5;
    const targetSpecialUse = isSpam ? '\\Junk' : '\\Inbox';
    const mailbox = await this.getMailboxBySpecialUse(userId, targetSpecialUse);
    if (!mailbox) throw new NotFoundError('Target mailbox not found');

    // Upload attachments to the Oxy file manager (canonical asset storage).
    // The message persists a reference {fileId, name, contentType, size, ...};
    // the actual blob lives in the File model + S3 via assetService.
    const storedAttachments: MessageAttachment[] = [];
    const uploadedFiles: Array<{ fileId: string }> = [];
    if (params.attachments && params.attachments.length > 0) {
      for (const att of params.attachments) {
        const file = await assetService.uploadFileDirect(
          userId,
          att.content,
          att.contentType,
          att.filename,
          'private',
          { source: 'email-inbound' }
        );
        storedAttachments.push({
          fileId: file.id,
          name: file.originalName || att.filename,
          contentType: file.mime,
          size: file.size,
          ...(att.contentId ? { contentId: att.contentId } : {}),
          isInline: att.isInline ?? false,
        });
        uploadedFiles.push({ fileId: file.id });
      }
    }

    const totalSize =
      params.rawSize +
      storedAttachments.reduce((sum, a) => sum + a.size, 0);

    const receivedAt = new Date();
    const storedMessageId = await insertMessageWithChildren(
      db,
      {
        userId,
        mailboxId: mailbox.id,
        messageId: params.messageId,
        fromName: params.from.name?.trim() ? params.from.name.trim() : null,
        fromAddress: params.from.address.trim().toLowerCase(),
        subject: params.subject,
        text: params.text,
        html: params.html,
        headers: params.headers,
        spamScore: params.spamScore,
        spamAction: params.spamAction,
        size: totalSize,
        inReplyTo: params.inReplyTo,
        references: params.references ?? [],
        aliasTag: params.aliasTag,
        readReceiptRequested: Boolean(params.headers['disposition-notification-to']),
        date: params.date,
        receivedAt,
      },
      { to: params.to, cc: params.cc ?? [] },
      storedAttachments,
    );

    // Link each uploaded file to the newly-stored Message under the oxy-mail
    // app namespace. Best-effort: if linking fails the message is already
    // persisted and the file is owned by the recipient, so the inbound path
    // must not fail.
    if (uploadedFiles.length > 0) {
      const msgIdForLink = storedMessageId;
      for (const { fileId } of uploadedFiles) {
        try {
          await assetService.linkFile(fileId, {
            app: 'oxy-mail',
            entityType: 'message',
            entityId: msgIdForLink,
            createdBy: userId,
          });
        } catch (err) {
          logger.warn('Failed to link inbound attachment to message', {
            fileId,
            messageId: msgIdForLink,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    logger.info('Incoming email stored', {
      userId,
      from: params.from.address,
      subject: params.subject,
      mailbox: mailbox.name,
    });

    // Capability events carry identifiers and routing metadata only; agents
    // fetch message content later with a live, mailbox-scoped ticket.
    publishInboxMessageEvents({
      ownerAccountId: userId,
      mailboxId: mailbox.id,
      messageId: storedMessageId,
      senderAddress: params.from.address,
      subject: params.subject,
      headers: params.headers,
      receivedAt,
    }).catch((err) => {
      logger.warn('Inbox capability event fan-out failed', {
        messageId: storedMessageId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Fire-and-forget AI processing (non-blocking, only for non-spam)
    if (!isSpam) {
      aiLabelingService.enqueueClassification(userId, storedMessageId);
      cardExtractionService.extractAndUpdate(userId, storedMessageId).catch((err) => {
        logger.warn('Card extraction failed', { msgId: storedMessageId, error: String(err) });
      });
    }

    // Fire-and-forget filter application (non-blocking)
    this.applyFilters(userId, storedMessageId).catch((err) => {
      logger.warn('Email filter application failed', { messageId: storedMessageId, error: String(err) });
    });

    // Fire-and-forget global auto-forwarding (non-blocking, only for non-spam)
    if (!isSpam) {
      this.applyGlobalAutoForward(userId, storedMessageId).catch((err) => {
        logger.warn('Global auto-forward failed', { userId, error: String(err) });
      });
    }

    // Fire-and-forget push notification (non-blocking, only for non-spam)
    if (!isSpam) {
      const senderName = params.from.name || params.from.address;
      const pushBody = params.subject || '(no subject)';
      void sendInboxEmailPush({
        userId,
        title: senderName,
        body: pushBody,
        messageId: storedMessageId,
        mailboxId: mailbox.id,
      });
    }

    return readMessageDto(db, storedMessageId);
  }

  // ─── Read Receipt (MDN) ────────────────────────────────────────────

  /**
   * Send an MDN (Message Disposition Notification) for a message that requested one.
   * RFC 3798 compliant: multipart/report with human-readable and machine-readable parts.
   */
  async sendReadReceipt(userId: string, messageId: string): Promise<void> {
    const db = getDb();
    // `headers` is PROTECTED: naming it is the sanctioned opt-in, and this is a
    // server-only path that needs exactly one header out of it.
    const [message] = await db
      .select({
        messageId: messages.messageId,
        subject: messages.subject,
        readReceiptRequested: messages.readReceiptRequested,
        readReceiptSent: messages.readReceiptSent,
        headers: messages.headers,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!message) throw new NotFoundError('Message not found');

    if (!message.readReceiptRequested) {
      throw new BadRequestError('This message did not request a read receipt');
    }
    if (message.readReceiptSent) {
      throw new BadRequestError('Read receipt has already been sent');
    }

    // Get the Disposition-Notification-To address from headers
    const dntAddress = message.headers['disposition-notification-to'];
    if (!dntAddress) {
      throw new BadRequestError('Missing Disposition-Notification-To header');
    }

    // Parse the notification address (may be "Name <email>" or just "email")
    const emailMatch = dntAddress.match(/<([^>]+)>/) || dntAddress.match(/([^\s,]+@[^\s,]+)/);
    const notifyEmail = emailMatch ? emailMatch[1] : dntAddress.trim();

    // Get user info for the From address
    const user = await loadSenderIdentity(db, userId);
    if (!user?.username) throw new BadRequestError('User must have a username');

    const fromAddress = resolveEmailAddress(user.username);
    const fromName = resolveEmailFromName(user);

    await smtpOutbound.sendMdn({
      from: { name: fromName, address: fromAddress },
      to: notifyEmail,
      originalRecipient: fromAddress,
      originalMessageId: message.messageId,
      originalSubject: message.subject,
    });

    // Mark receipt as sent
    await db
      .update(messages)
      .set({ readReceiptSent: true })
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)));

    logger.info('Read receipt (MDN) sent', { userId, messageId, to: notifyEmail });
  }

  // ─── Compose & save draft / send ──────────────────────────────────

  async saveDraft(
    userId: string,
    draft: {
      to?: EmailAddress[];
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      subject?: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: MessageAttachment[];
      existingDraftId?: string;
      expectedRevision?: number;
    }
  ): Promise<MessageDto> {
    await this.ensureMailboxes(userId);
    const db = getDb();
    const draftsMailbox = await this.getMailboxBySpecialUse(userId, '\\Drafts');
    if (!draftsMailbox) throw new NotFoundError('Drafts mailbox not found');

    const user = await loadSenderIdentity(db, userId);
    if (!user?.username) throw new BadRequestError('User must have a username to send email');

    const fromAddress = resolveEmailAddress(user.username);
    const size = this.calculateMessageStorageSize(draft);

    if (draft.existingDraftId) {
      // Update an existing draft, recipients included. The three headers are a
      // child table now, so "replace the arrays" is a delete plus an insert —
      // in the SAME transaction as the parent update, or a crash between them
      // leaves the draft addressed to a mixture of two edits.
      // Bound outside the closure so the narrowing survives into it.
      const existingDraftId = draft.existingDraftId;
      const replaced = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(messages)
          .set({
            subject: draft.subject ?? '',
            text: draft.text,
            html: draft.html,
            inReplyTo: draft.inReplyTo,
            references: draft.references ?? [],
            size,
            date: new Date(),
            draftRevision: sql`${messages.draftRevision} + 1`,
          })
          .where(
            and(
              eq(messages.id, existingDraftId),
              eq(messages.userId, userId),
              eq(messages.draft, true),
              ...(draft.expectedRevision === undefined ? [] : [eq(messages.draftRevision, draft.expectedRevision)]),
            ),
          )
          .returning({ id: messages.id });
        if (!updated) return undefined;

        await tx.delete(messageRecipients).where(eq(messageRecipients.messageId, updated.id));
        const recipientRows = (['to', 'cc', 'bcc'] as const).flatMap((kind) =>
          (draft[kind] ?? []).map((address, ord) => ({
            messageId: updated.id,
            kind,
            ord,
            name: address.name?.trim() ? address.name.trim() : null,
            address: address.address.trim().toLowerCase(),
          })),
        );
        if (recipientRows.length > 0) {
          await tx.insert(messageRecipients).values(recipientRows);
        }
        await tx.delete(messageAttachments).where(eq(messageAttachments.messageId, updated.id));
        if (draft.attachments && draft.attachments.length > 0) {
          await tx.insert(messageAttachments).values(
            draft.attachments.map((attachment, ord) => ({
              messageId: updated.id,
              ord,
              fileId: attachment.fileId,
              name: attachment.name,
              contentType: attachment.contentType,
              size: attachment.size,
              contentId: attachment.contentId ?? null,
              isInline: attachment.isInline,
            })),
          );
        }
        return updated.id;
      });

      if (replaced) return readMessageDto(db, replaced);
      if (draft.expectedRevision !== undefined) {
        const [current] = await db
          .select({ draftRevision: messages.draftRevision })
          .from(messages)
          .where(and(eq(messages.id, existingDraftId), eq(messages.userId, userId), eq(messages.draft, true)))
          .limit(1);
        if (current) {
          throw new ConflictError('Draft changed on another device', {
            draftId: existingDraftId,
            currentRevision: current.draftRevision,
          });
        }
      }
    }

    // Create new draft
    const now = new Date();
    const created = await insertMessageWithChildren(
      db,
      {
        userId,
        mailboxId: draftsMailbox.id,
        messageId: `<${uuidv4()}@${EMAIL_DOMAIN}>`,
        fromName: resolveEmailFromName(user) || null,
        fromAddress,
        subject: draft.subject ?? '',
        text: draft.text,
        html: draft.html,
        seen: true,
        draft: true,
        size,
        inReplyTo: draft.inReplyTo,
        references: draft.references ?? [],
        date: now,
        receivedAt: now,
      },
      { to: draft.to, cc: draft.cc, bcc: draft.bcc },
      draft.attachments ?? [],
    );

    return readMessageDto(db, created);
  }

  /**
   * Move a sent message to the Sent mailbox after it has been dispatched.
   */
  async storeSentMessage(
    userId: string,
    messageData: {
      messageId: string;
      from: EmailAddress;
      to: EmailAddress[];
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      subject: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: MessageAttachment[];
      size: number;
    }
  ): Promise<MessageDto> {
    await this.ensureMailboxes(userId);
    const db = getDb();
    const sentMailbox = await this.getMailboxBySpecialUse(userId, '\\Sent');
    if (!sentMailbox) throw new NotFoundError('Sent mailbox not found');

    // Count body + attachment bytes toward the storage quota on the send path.
    const size = this.calculateMessageStorageSize(messageData);
    await this.enforceQuota(userId, size);

    const now = new Date();
    const created = await insertMessageWithChildren(
      db,
      {
        userId,
        mailboxId: sentMailbox.id,
        messageId: messageData.messageId,
        fromName: messageData.from.name?.trim() ? messageData.from.name.trim() : null,
        fromAddress: messageData.from.address.trim().toLowerCase(),
        subject: messageData.subject,
        text: messageData.text,
        html: messageData.html,
        seen: true,
        size,
        inReplyTo: messageData.inReplyTo,
        references: messageData.references ?? [],
        date: now,
        receivedAt: now,
      },
      { to: messageData.to, cc: messageData.cc, bcc: messageData.bcc },
      messageData.attachments ?? [],
    );

    return readMessageDto(db, created);
  }

  // ─── Snooze ──────────────────────────────────────────────────────────

  async snoozeMessage(userId: string, messageId: string, until: Date): Promise<MessageDto> {
    const db = getDb();
    const [message] = await db
      .select({ id: messages.id, mailboxId: messages.mailboxId, snoozedUntil: messages.snoozedUntil })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!message) throw new NotFoundError('Message not found');

    const snoozedMailbox = await this.getMailboxBySpecialUse(userId, '\\Snoozed');
    if (!snoozedMailbox) throw new NotFoundError('Snoozed mailbox not found');

    // Already snoozed — just update the time; the message is already in the
    // Snoozed folder and `snoozed_from_mailbox` still holds where it came from.
    const update = message.snoozedUntil
      ? { snoozedUntil: until }
      : {
          snoozedUntil: until,
          snoozedFromMailbox: message.mailboxId,
          mailboxId: snoozedMailbox.id,
        };
    await db.update(messages).set(update).where(eq(messages.id, message.id));

    logger.info('Message snoozed', { userId, messageId, until: until.toISOString() });
    return readMessageDto(db, message.id);
  }

  async unsnoozeMessage(userId: string, messageId: string): Promise<MessageDto> {
    const db = getDb();
    const [message] = await db
      .select({
        id: messages.id,
        snoozedUntil: messages.snoozedUntil,
        snoozedFromMailbox: messages.snoozedFromMailbox,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!message) throw new NotFoundError('Message not found');
    if (!message.snoozedUntil || !message.snoozedFromMailbox) {
      throw new BadRequestError('Message is not snoozed');
    }

    await db
      .update(messages)
      .set({
        mailboxId: message.snoozedFromMailbox,
        snoozedUntil: null,
        snoozedFromMailbox: null,
        // Mark as unseen so it stands out when it reappears
        seen: false,
      })
      .where(eq(messages.id, message.id));

    logger.info('Message unsnoozed', { userId, messageId });
    return readMessageDto(db, message.id);
  }

  /**
   * Process all snoozed messages whose snooze time has passed.
   * Called by the snooze cron job every minute.
   */
  async processSnoozedMessages(): Promise<number> {
    const now = new Date();
    const due = await getDb()
      .select({ id: messages.id, userId: messages.userId })
      .from(messages)
      .where(
        and(
          lte(messages.snoozedUntil, now),
          isNotNull(messages.snoozedUntil),
          isNotNull(messages.snoozedFromMailbox),
        ),
      );

    let count = 0;
    for (const msg of due) {
      try {
        await this.unsnoozeMessage(msg.userId, msg.id);
        count++;
      } catch (err) {
        logger.error('Failed to unsnooze message', err instanceof Error ? err : new Error(String(err)), {
          messageId: msg.id,
        });
      }
    }

    if (count > 0) {
      logger.info('Snooze cron processed', { count });
    }
    return count;
  }

  // ─── Schedule Send ──────────────────────────────────────────────────

  /**
   * Store a message in the Sent mailbox as a scheduled message (not yet dispatched).
   * The cron job will send it when `scheduledAt` arrives.
   */
  async scheduleMessage(
    userId: string,
    params: {
      from: EmailAddress;
      to: EmailAddress[];
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      subject: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: MessageAttachment[];
      idempotencyKey?: string;
      scheduledAt: Date;
    }
  ): Promise<MessageDto> {
    await this.ensureMailboxes(userId);
    const db = getDb();
    const sentMailbox = await this.getMailboxBySpecialUse(userId, '\\Sent');
    if (!sentMailbox) throw new NotFoundError('Sent mailbox not found');

    const messageId = params.idempotencyKey
      ? idempotentMessageId(userId, params.idempotencyKey)
      : `<${uuidv4()}@${EMAIL_DOMAIN}>`;
    if (params.idempotencyKey) {
      const existing = await this.findMessageByRfcMessageId(userId, messageId);
      if (existing) return existing;
    }

    // Count body + attachment bytes toward the storage quota.
    const size = this.calculateMessageStorageSize(params);
    await this.enforceQuota(userId, size);

    const now = new Date();
    const created = await insertMessageWithChildren(
      db,
      {
        userId,
        mailboxId: sentMailbox.id,
        messageId,
        fromName: params.from.name?.trim() ? params.from.name.trim() : null,
        fromAddress: params.from.address.trim().toLowerCase(),
        subject: params.subject,
        text: params.text,
        html: params.html,
        seen: true,
        size,
        inReplyTo: params.inReplyTo,
        references: params.references ?? [],
        scheduledAt: params.scheduledAt,
        date: now,
        receivedAt: now,
      },
      { to: params.to, cc: params.cc, bcc: params.bcc },
      params.attachments ?? [],
    );

    const dto = await readMessageDto(db, created);

    logger.info('Message scheduled', {
      userId,
      messageId: dto.messageId,
      scheduledAt: params.scheduledAt.toISOString(),
    });

    return dto;
  }

  /**
   * Process all scheduled messages whose send time has passed.
   * Called by the scheduled send cron job every minute.
   */
  async processScheduledMessages(): Promise<number> {
    const db = getDb();
    const now = new Date();
    // `text` and `html` are PROTECTED; the outbound transport needs both, so
    // this names them — the sanctioned opt-in.
    const due = await db
      .select({
        id: messages.id,
        messageId: messages.messageId,
        userId: messages.userId,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        subject: messages.subject,
        text: messages.text,
        html: messages.html,
        inReplyTo: messages.inReplyTo,
        references: messages.references,
      })
      .from(messages)
      .where(and(lte(messages.scheduledAt, now), isNotNull(messages.scheduledAt)));

    let count = 0;
    for (const msg of due) {
      try {
        const recipients = await loadRecipients(db, [msg.id]);
        const group = recipients.get(msg.id) ?? emptyRecipients();
        const attachments = await loadOutboundAttachments(db, msg.id);

        await smtpOutbound.sendRaw({
          userId: msg.userId,
          messageId: msg.messageId,
          from: { name: msg.fromName ?? '', address: msg.fromAddress },
          to: group.to,
          cc: group.cc.length ? group.cc : undefined,
          bcc: group.bcc.length ? group.bcc : undefined,
          subject: msg.subject,
          text: msg.text ?? undefined,
          html: msg.html ?? undefined,
          inReplyTo: msg.inReplyTo ?? undefined,
          references: msg.references.length ? msg.references : undefined,
          attachments: attachments.length ? attachments : undefined,
        });

        // Clear scheduledAt to mark as sent
        await db.update(messages).set({ scheduledAt: null }).where(eq(messages.id, msg.id));
        count++;
      } catch (err) {
        logger.error('Failed to send scheduled message', err instanceof Error ? err : new Error(String(err)), {
          messageId: msg.id,
        });
      }
    }

    if (count > 0) {
      logger.info('Scheduled send cron processed', { count });
    }
    return count;
  }

  // ─── Thread / Conversation ─────────────────────────────────────────

  /**
   * Every message in the anchor's thread, oldest first.
   *
   * The same `WITH RECURSIVE` walk `attachThreadMetadata` counts with — one
   * definition of "same thread", so a list that says `threadCount: 5` can never
   * open onto a thread view showing three. Mongo ran the two independently, and
   * both one hop: this one built a `$or` of five clauses over the anchor's own
   * tokens and stopped there.
   *
   * The anchor is always in its own component, so no separate dedup-and-append
   * step is needed — the walk returns it whether or not it has any counterpart.
   */
  async getThread(userId: string, messageId: string): Promise<MessageDto[]> {
    const db = getDb();
    const [anchor] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!anchor) throw new NotFoundError('Message not found');

    const memberRows = await db.execute<{ id: string }>(sql`
      with recursive walk(id, ks) as (
          select seed.id, ${threadKeys('seed')}
          from messages seed
          where seed.user_id = ${userId} and seed.id = ${anchor.id}
        union
          select linked.id, ${threadKeys('linked')}
          from walk
          join messages linked
            on linked.user_id = ${userId}
           and ${threadAdjacency('linked', sql.raw('walk.ks'))}
      )
      select id from walk
    `);

    const rows = await db
      .select(MESSAGE_COLUMNS_WITH_BODY)
      .from(messages)
      .where(inArray(messages.id, memberRows.map((row) => row.id)))
      .orderBy(asc(messages.date), asc(messages.id));

    const thread = await toMessageDtos(db, rows);
    const stableThreadId = memberRows
      .map((row) => row.id)
      .sort()[0];
    if (stableThreadId) {
      for (const message of thread) message.threadId = stableThreadId;
    }
    await EmailService.enrichWithAvatars(thread);

    return thread;
  }

  // ─── Labels ──────────────────────────────────────────────────────────

  async listLabels(userId: string): Promise<Array<LabelDto | (typeof SYSTEM_LABELS)[number]>> {
    const custom = await getDb()
      .select()
      .from(labelsTable)
      .where(eq(labelsTable.userId, userId))
      .orderBy(asc(labelsTable.order), asc(labelsTable.name));

    // A row left over from when the system labels were seeded per user is
    // shadowed by its constant, so the list never shows the same name twice.
    const own = custom
      .filter((label) => !isSystemLabel(label.name))
      .map((label) => toLabelDto(label));
    return [...SYSTEM_LABELS, ...own];
  }

  async createLabel(userId: string, name: string, color: string): Promise<LabelDto> {
    if (isSystemLabel(name)) throw new BadRequestError(`Label "${name.trim()}" already exists`);
    const db = getDb();

    // `lower(name)`, matching `labels_user_id_lower_name_key`. A plain equality
    // is correct-looking, case-SENSITIVE, and will not use the index — which is
    // the whole difference between this and Mongo's `strength: 2` collation.
    const [existing] = await db
      .select({ id: labelsTable.id })
      .from(labelsTable)
      .where(and(eq(labelsTable.userId, userId), sql`lower(${labelsTable.name}) = lower(${name})`))
      .limit(1);
    if (existing) throw new BadRequestError(`Label "${name}" already exists`);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(labelsTable)
      .where(eq(labelsTable.userId, userId));

    const [label] = await db
      .insert(labelsTable)
      .values({ userId, name: name.trim(), color, order: countRow?.count ?? 0 })
      .returning();
    return toLabelDto(label);
  }

  async updateLabel(userId: string, labelId: string, updates: { name?: string; color?: string }): Promise<LabelDto> {
    if (isSystemLabelId(labelId)) throw new BadRequestError('System labels cannot be edited');
    if (updates.name && isSystemLabel(updates.name)) {
      throw new BadRequestError(`Label "${updates.name.trim()}" already exists`);
    }
    if (Object.keys(updates).length === 0) {
      const [current] = await getDb()
        .select()
        .from(labelsTable)
        .where(and(eq(labelsTable.id, labelId), eq(labelsTable.userId, userId)))
        .limit(1);
      if (!current) throw new NotFoundError('Label not found');
      return toLabelDto(current);
    }

    const [label] = await getDb()
      .update(labelsTable)
      .set(updates)
      .where(and(eq(labelsTable.id, labelId), eq(labelsTable.userId, userId)))
      .returning();
    if (!label) throw new NotFoundError('Label not found');
    return toLabelDto(label);
  }

  async deleteLabel(userId: string, labelId: string): Promise<void> {
    if (isSystemLabelId(labelId)) throw new BadRequestError('System labels cannot be deleted');
    const db = getDb();

    const [label] = await db
      .select({ id: labelsTable.id, name: labelsTable.name })
      .from(labelsTable)
      .where(and(eq(labelsTable.id, labelId), eq(labelsTable.userId, userId)))
      .limit(1);
    if (!label) throw new NotFoundError('Label not found');

    // Detaching the name from every message and deleting the row are one
    // change: a crash between them leaves messages carrying a label the user
    // can no longer see or remove.
    await db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ labels: sql`array_remove(${messages.labels}, ${label.name})` })
        .where(
          and(
            eq(messages.userId, userId),
            sql`${messages.labels} @> array[${label.name}]::text[]`,
          ),
        );
      await tx.delete(labelsTable).where(eq(labelsTable.id, labelId));
    });
  }

  /**
   * Add and remove labels on one message.
   *
   * Mongo could not `$addToSet` and `$pull` the same field in one operation, so
   * this ran TWO `updateOne` calls with a window between them where the message
   * held the added labels but not yet the removals. Postgres rewrites the array
   * once, and the expression states the same precedence Mongo's ordering did:
   * add first, then remove, so a name in BOTH lists ends up removed.
   *
   * The order of the surviving entries is preserved — kept ones in place,
   * genuinely new ones appended — which is what `$addToSet` did.
   */
  async updateMessageLabels(
    userId: string,
    messageId: string,
    add: string[],
    remove: string[],
  ): Promise<MessageDto> {
    const db = getDb();

    // Validate that labels being added actually exist for this user. A system
    // label is valid without a row behind it — that is the whole point of it
    // being a constant — so only the rest are looked up.
    const unknown = add.filter((name) => !isSystemLabel(name));
    if (unknown.length > 0) {
      const existingLabels = await db
        .select({ name: labelsTable.name })
        .from(labelsTable)
        .where(and(eq(labelsTable.userId, userId), inArray(labelsTable.name, unknown)));
      const existingNames = new Set(existingLabels.map((l) => l.name));
      const missing = unknown.filter((name) => !existingNames.has(name));
      if (missing.length > 0) {
        throw new BadRequestError(`Labels not found: ${missing.join(', ')}`);
      }
    }

    const owned = and(eq(messages.id, messageId), eq(messages.userId, userId));
    // `$addToSet` adds each distinct value once; duplicates within the request
    // must not become duplicates in the column.
    const additions = [...new Set(add)];

    const [updated] = await db
      .update(messages)
      .set({
        labels: sql`(
          select coalesce(array_agg(entry.label order by entry.bucket, entry.idx), '{}'::text[])
          from (
              select kept.label, 0 as bucket, kept.idx
              from unnest(${messages.labels}) with ordinality as kept(label, idx)
              where kept.label <> all(${textArray(remove)})
            union all
              select added.label, 1 as bucket, added.idx
              from unnest(${textArray(additions)}) with ordinality as added(label, idx)
              where added.label <> all(${messages.labels})
                and added.label <> all(${textArray(remove)})
          ) as entry
        )`,
      })
      .where(owned)
      .returning({ id: messages.id });

    if (!updated) throw new NotFoundError('Message not found');

    return readMessageDto(db, updated.id);
  }

  // ─── Filters ─────────────────────────────────────────────────────────

  async listFilters(userId: string): Promise<FilterDto[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(emailFilters)
      .where(eq(emailFilters.userId, userId))
      .orderBy(asc(emailFilters.order), asc(emailFilters.createdAt));
    return loadFilterChildren(db, rows);
  }

  /**
   * Create a rule and its ordered children.
   *
   * One transaction, and the "at least one condition, at least one action"
   * invariant is asserted inside it via {@link incompleteEmailFilters}: Postgres
   * cannot express "this row must have a child" as a CHECK, so the write path
   * owns it and a violation rolls the whole rule back rather than leaving a rule
   * that silently matches everything or does nothing.
   */
  async createFilter(userId: string, data: {
    name: string;
    enabled: boolean;
    conditions: FilterConditionInput[];
    matchAll: boolean;
    actions: FilterActionInput[];
    order: number;
  }): Promise<FilterDto> {
    const db = getDb();
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailFilters)
      .where(eq(emailFilters.userId, userId));

    const filterId = await db.transaction(async (tx) => {
      const [filter] = await tx
        .insert(emailFilters)
        .values({
          userId,
          name: data.name,
          enabled: data.enabled,
          matchAll: data.matchAll,
          order: data.order ?? countRow?.count ?? 0,
        })
        .returning({ id: emailFilters.id });

      await writeFilterChildren(tx, filter.id, data.conditions, data.actions);
      await assertFilterComplete(tx, filter.id);
      return filter.id;
    });

    const [dto] = await loadFilterChildren(db, [
      await readFilterRow(db, userId, filterId),
    ]);
    return dto;
  }

  async updateFilter(
    userId: string,
    filterId: string,
    updates: {
      name?: string;
      enabled?: boolean;
      matchAll?: boolean;
      order?: number;
      conditions?: FilterConditionInput[];
      actions?: FilterActionInput[];
    },
  ): Promise<FilterDto> {
    const db = getDb();
    const { conditions, actions, ...columns } = updates;

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: emailFilters.id })
        .from(emailFilters)
        .where(and(eq(emailFilters.id, filterId), eq(emailFilters.userId, userId)))
        .limit(1);
      if (!existing) throw new NotFoundError('Filter not found');

      if (Object.keys(columns).length > 0) {
        await tx.update(emailFilters).set(columns).where(eq(emailFilters.id, filterId));
      }

      // A child list is REPLACED, never merged — the request carries the whole
      // ordered list, exactly as Mongo's `$set` of the array did.
      if (conditions) {
        await tx
          .delete(emailFilterConditions)
          .where(eq(emailFilterConditions.filterId, filterId));
      }
      if (actions) {
        await tx.delete(emailFilterActions).where(eq(emailFilterActions.filterId, filterId));
      }
      await writeFilterChildren(tx, filterId, conditions, actions);
      await assertFilterComplete(tx, filterId);
    });

    const [dto] = await loadFilterChildren(db, [await readFilterRow(db, userId, filterId)]);
    return dto;
  }

  async deleteFilter(userId: string, filterId: string): Promise<void> {
    // The conditions and actions CASCADE, so this is one statement and not the
    // hand-ordered pair Mongo needed.
    const deleted = await getDb()
      .delete(emailFilters)
      .where(and(eq(emailFilters.id, filterId), eq(emailFilters.userId, userId)))
      .returning({ id: emailFilters.id });
    if (deleted.length === 0) throw new NotFoundError('Filter not found');
  }

  /**
   * Apply user's enabled email filters to an incoming message.
   * Called after the message is stored in storeIncomingMessage().
   * Batch-loads all enabled filters once, then evaluates each.
   */
  async applyFilters(userId: string, messageId: string): Promise<void> {
    const db = getDb();
    const filterRows = await db
      .select()
      .from(emailFilters)
      .where(and(eq(emailFilters.userId, userId), eq(emailFilters.enabled, true)))
      .orderBy(asc(emailFilters.order));

    if (filterRows.length === 0) return;

    const filters = await loadFilterChildren(db, filterRows);

    const [row] = await db
      .select({
        id: messages.id,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        subject: messages.subject,
        size: messages.size,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!row) return;

    const recipients = (await loadRecipients(db, [row.id])).get(row.id) ?? emptyRecipients();
    const [attachmentCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, row.id));

    const message: FilterEvaluationMessage = {
      from: { name: row.fromName ?? '', address: row.fromAddress },
      to: recipients.to,
      subject: row.subject,
      size: row.size,
      attachmentCount: attachmentCountRow?.count ?? 0,
    };

    for (const filter of filters) {
      const matches = this.evaluateFilterConditions(message, filter.conditions, filter.matchAll);
      if (!matches) continue;

      await this.executeFilterActions(userId, messageId, filter.actions);
      // Continue to next filter — multiple filters may apply
    }
  }

  /**
   * Evaluate filter conditions against a message.
   */
  private evaluateFilterConditions(
    message: FilterEvaluationMessage,
    conditions: FilterConditionDto[],
    matchAll: boolean,
  ): boolean {
    const results = conditions.map((cond) => this.evaluateCondition(message, cond));
    return matchAll ? results.every(Boolean) : results.some(Boolean);
  }

  /**
   * Evaluate a single filter condition against a message.
   */
  private evaluateCondition(
    message: FilterEvaluationMessage,
    condition: FilterConditionDto,
  ): boolean {
    const { field, operator, value } = condition;

    let fieldValue: string;

    switch (field) {
      case 'from':
        fieldValue = `${message.from.name} ${message.from.address}`.toLowerCase();
        break;
      case 'to': {
        const toAddrs = message.to.map(
          (a) => `${a.name} ${a.address}`.toLowerCase()
        );
        fieldValue = toAddrs.join(' ');
        break;
      }
      case 'subject':
        fieldValue = message.subject.toLowerCase();
        break;
      case 'has-attachment':
        // For has-attachment, operator is 'equals' and value is 'true' or 'false'
        return value === 'true'
          ? message.attachmentCount > 0
          : message.attachmentCount === 0;
      case 'size':
        return this.evaluateNumericCondition(message.size, operator, value);
      default:
        return false;
    }

    const lowerValue = value.toLowerCase();

    switch (operator) {
      case 'contains':
        return fieldValue.includes(lowerValue);
      case 'equals':
        return fieldValue.trim() === lowerValue;
      case 'not-contains':
        return !fieldValue.includes(lowerValue);
      case 'starts-with':
        return fieldValue.startsWith(lowerValue);
      case 'ends-with':
        return fieldValue.endsWith(lowerValue);
      default:
        return false;
    }
  }

  /**
   * Evaluate a numeric condition (for size field).
   */
  private evaluateNumericCondition(actual: number, operator: string, value: string): boolean {
    const target = Number(value);
    if (Number.isNaN(target)) return false;

    switch (operator) {
      case 'greater-than':
        return actual > target;
      case 'less-than':
        return actual < target;
      case 'equals':
        return actual === target;
      default:
        return false;
    }
  }

  /**
   * Execute filter actions on a message.
   */
  private async executeFilterActions(
    userId: string,
    messageId: string,
    actions: FilterActionDto[],
  ): Promise<void> {
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'move':
            if (action.value) {
              await this.moveMessage(userId, messageId, action.value);
            }
            break;
          case 'label':
            if (action.value) {
              await this.updateMessageLabels(userId, messageId, [action.value], []);
            }
            break;
          case 'star':
            await this.updateMessageFlags(userId, messageId, { starred: true });
            break;
          case 'mark-read':
            await this.updateMessageFlags(userId, messageId, { seen: true });
            break;
          case 'archive': {
            const archive = await this.getMailboxBySpecialUse(userId, '\\Archive');
            if (archive) {
              await this.moveMessage(userId, messageId, archive.id);
            }
            break;
          }
          case 'delete': {
            await this.deleteMessage(userId, messageId, false);
            break;
          }
          case 'forward':
            // Forward is best-effort — fire-and-forget, log and continue on failure
            if (action.value) {
              this.forwardMessage(userId, messageId, action.value).catch((err) => {
                logger.warn('Filter forward action failed', {
                  userId,
                  messageId,
                  forwardTo: action.value,
                  error: String(err),
                });
              });
            }
            break;
        }
      } catch (err) {
        logger.warn('Filter action failed', {
          userId,
          messageId,
          action: action.type,
          error: String(err),
        });
      }
    }
  }

  /**
   * Forward a message to a target email address.
   * Used by filter forward actions and global auto-forwarding.
   * Preserves original headers and includes a "Forwarded by Oxy" indicator.
   * Fire-and-forget — errors are logged but not thrown to callers.
   */
  async forwardMessage(userId: string, messageId: string, forwardTo: string): Promise<void> {
    // Validate the forwarding address
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(forwardTo)) {
      logger.warn('Invalid forwarding address', { userId, messageId, forwardTo });
      return;
    }

    const db = getDb();
    // `text` and `html` are PROTECTED; a forward is exactly the path that
    // legitimately needs both, so it names them.
    const [message] = await db
      .select({
        id: messages.id,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        subject: messages.subject,
        text: messages.text,
        html: messages.html,
        references: messages.references,
        date: messages.date,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!message) {
      logger.warn('Message not found for forwarding', { userId, messageId });
      return;
    }

    // Resolve the sender (the user whose account is forwarding)
    const user = await loadSenderIdentity(db, userId);
    if (!user?.username) {
      logger.warn('User not found for forwarding', { userId });
      return;
    }

    const fromAddress = resolveEmailAddress(user.username);
    const fromName = resolveEmailFromName(user);

    const recipients = (await loadRecipients(db, [message.id])).get(message.id) ?? emptyRecipients();
    const attachments = await loadOutboundAttachments(db, message.id);

    // Build forwarded subject
    const subject = message.subject.startsWith('Fwd:')
      ? message.subject
      : `Fwd: ${message.subject || '(no subject)'}`;

    // Build forwarded body with original message attribution
    const originalFrom = message.fromName
      ? `${message.fromName} <${message.fromAddress}>`
      : message.fromAddress;
    const originalTo = recipients.to
      .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
      .join(', ');
    const originalDate = message.date.toUTCString();

    const forwardHeader = [
      '---------- Forwarded message ----------',
      `From: ${originalFrom}`,
      `Date: ${originalDate}`,
      `Subject: ${message.subject || '(no subject)'}`,
      `To: ${originalTo}`,
      '',
    ].join('\n');

    const text = message.text
      ? `${forwardHeader}\n${message.text}\n\n-- Forwarded by Oxy`
      : `${forwardHeader}\n\n-- Forwarded by Oxy`;

    const html = message.html
      ? `<div style="margin-bottom:16px;padding:12px;border-left:2px solid #ccc;color:#555;font-size:13px;">
          <strong>---------- Forwarded message ----------</strong><br/>
          From: ${originalFrom}<br/>
          Date: ${originalDate}<br/>
          Subject: ${message.subject || '(no subject)'}<br/>
          To: ${originalTo}
        </div>
        ${message.html}
        <p style="color:#999;font-size:12px;margin-top:16px;">-- Forwarded by Oxy</p>`
      : undefined;

    await smtpOutbound.sendRaw({
      userId,
      from: { name: fromName, address: fromAddress },
      to: [{ name: '', address: forwardTo }],
      subject,
      text,
      html,
      references: message.references.length ? message.references : undefined,
      attachments: attachments.length ? attachments : undefined,
    });

    logger.info('Message forwarded', {
      userId,
      messageId,
      forwardTo,
      subject: message.subject,
    });
  }

  /**
   * Apply global auto-forwarding for a user.
   * Checks if the user has autoForwardTo configured and forwards the message.
   * If autoForwardKeepCopy is false, moves the message to Trash after forwarding.
   */
  private async applyGlobalAutoForward(userId: string, messageId: string): Promise<void> {
    // `auto_forward_to` and `auto_forward_keep_copy` are PROTECTED — naming
    // them is the sanctioned opt-in for a server-only path like this one.
    const [user] = await getDb()
      .select({
        autoForwardTo: users.autoForwardTo,
        autoForwardKeepCopy: users.autoForwardKeepCopy,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user?.autoForwardTo) return;

    const forwardTo = user.autoForwardTo.trim();
    if (!forwardTo) return;

    // Forward the message
    await this.forwardMessage(userId, messageId, forwardTo);

    // If keep copy is disabled, move to trash
    if (user.autoForwardKeepCopy === false) {
      try {
        await this.deleteMessage(userId, messageId, false); // Move to Trash
      } catch (err) {
        logger.warn('Failed to move auto-forwarded message to trash', {
          userId,
          messageId,
          error: String(err),
        });
      }
    }
  }

  // ─── Export / Import ──────────────────────────────────────────────

  /**
   * Export a single message as RFC 5322 .eml format.
   * Reconstructs headers and multipart body from stored message data.
   */
  async exportMessage(userId: string, messageId: string): Promise<string> {
    const db = getDb();
    // An `.eml` export IS the body, so `text` and `html` are named explicitly.
    const [msg] = await db
      .select({
        id: messages.id,
        messageId: messages.messageId,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        subject: messages.subject,
        text: messages.text,
        html: messages.html,
        inReplyTo: messages.inReplyTo,
        references: messages.references,
        date: messages.date,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.userId, userId)))
      .limit(1);
    if (!msg) throw new NotFoundError('Message not found');

    const recipients = (await loadRecipients(db, [msg.id])).get(msg.id) ?? emptyRecipients();

    const formatAddr = (a: EmailAddressDto) =>
      a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address;

    const lines: string[] = [];
    lines.push(`From: ${formatAddr({ name: msg.fromName ?? '', address: msg.fromAddress })}`);
    if (recipients.to.length) lines.push(`To: ${recipients.to.map(formatAddr).join(', ')}`);
    if (recipients.cc.length) lines.push(`Cc: ${recipients.cc.map(formatAddr).join(', ')}`);
    lines.push(`Subject: ${msg.subject}`);
    lines.push(`Date: ${msg.date.toUTCString()}`);
    lines.push(`Message-ID: ${msg.messageId}`);
    if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);
    if (msg.references.length) lines.push(`References: ${msg.references.join(' ')}`);
    lines.push(`MIME-Version: 1.0`);

    const text = msg.text;
    const html = msg.html;

    if (text && html) {
      const boundary = `----=_Part_${uuidv4().replace(/-/g, '')}`;
      lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      lines.push('');
      lines.push(`--${boundary}`);
      lines.push('Content-Type: text/plain; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(text);
      lines.push(`--${boundary}`);
      lines.push('Content-Type: text/html; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(html);
      lines.push(`--${boundary}--`);
    } else if (html) {
      lines.push('Content-Type: text/html; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(html);
    } else {
      lines.push('Content-Type: text/plain; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(text || '');
    }

    return lines.join('\r\n');
  }

  /**
   * Import .eml files by parsing them with mailparser and storing as incoming messages.
   * Returns the number of successfully imported messages.
   */
  async importMessages(
    userId: string,
    files: Array<{ buffer: Buffer; originalname: string }>,
  ): Promise<number> {
    const db = getDb();
    const user = await loadSenderIdentity(db, userId);
    if (!user?.username) throw new BadRequestError('User must have a username');

    await this.ensureMailboxes(userId);
    await this.enforceQuota(
      userId,
      files.reduce((total, file) => total + file.buffer.length, 0),
    );

    const inbox = await this.getMailboxBySpecialUse(userId, '\\Inbox');
    if (!inbox) throw new NotFoundError('Inbox not found');

    const tier = await this.getUserTier(userId);
    const maxAttachmentSize = EMAIL_QUOTAS[tier].maxAttachmentSize;
    let imported = 0;

    for (const file of files) {
      try {
        const parsed = await simpleParser(file.buffer);

        const from: EmailAddress = parsed.from?.value?.[0]
          ? { name: parsed.from.value[0].name || '', address: parsed.from.value[0].address || '' }
          : { name: '', address: 'unknown@unknown' };

        const mapAddresses = (addrs: typeof parsed.to): EmailAddress[] => {
          if (!addrs) return [];
          const addrArray = Array.isArray(addrs) ? addrs : [addrs];
          return addrArray.flatMap((group) =>
            (group.value || []).map((a) => ({
              name: a.name || '',
              address: a.address || '',
            })),
          );
        };

        const to = mapAddresses(parsed.to);
        const cc = mapAddresses(parsed.cc);

        const rawSize = file.buffer.length;

        // Upload attachments to the Oxy file manager
        const storedAttachments: MessageAttachment[] = [];
        const importedFileIds: string[] = [];
        const parsedAttachments = parsed.attachments || [];
        const attachmentBytes = parsedAttachments.reduce(
          (sum, att) => sum + (att.size || att.content.length),
          0,
        );
        for (const att of parsedAttachments) {
          const attachmentSize = att.size || att.content.length;
          if (attachmentSize > maxAttachmentSize) {
            throw new BadRequestError(
              `Attachment ${att.filename || 'attachment'} exceeds the ${maxAttachmentSize} byte limit for your plan.`,
            );
          }
        }

        const totalSize = rawSize + attachmentBytes;
        await this.enforceQuota(userId, totalSize);

        if (parsed.attachments?.length) {
          for (const att of parsedAttachments) {
            const uploadedFile = await assetService.uploadFileDirect(
              userId,
              att.content,
              att.contentType || 'application/octet-stream',
              att.filename || 'attachment',
              'private',
              { source: 'email-import' }
            );
            storedAttachments.push({
              fileId: uploadedFile.id,
              name: uploadedFile.originalName || att.filename || 'attachment',
              contentType: uploadedFile.mime,
              size: uploadedFile.size,
              ...(att.contentId ? { contentId: att.contentId } : {}),
              isInline: att.related ?? false,
            });
            importedFileIds.push(uploadedFile.id);
          }
        }

        const msgId = await insertMessageWithChildren(
          db,
          {
            userId,
            mailboxId: inbox.id,
            messageId: parsed.messageId || `<imported-${uuidv4()}@${EMAIL_DOMAIN}>`,
            fromName: from.name?.trim() ? from.name.trim() : null,
            fromAddress: from.address.trim().toLowerCase(),
            subject: parsed.subject || '(no subject)',
            text: parsed.text || undefined,
            html: parsed.html || undefined,
            seen: true,
            size: totalSize,
            inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : undefined,
            references: Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : [],
            date: parsed.date || new Date(),
            receivedAt: new Date(),
          },
          { to, cc },
          storedAttachments,
        );

        // Best-effort link of imported attachments to the new message
        for (const importedFileId of importedFileIds) {
          try {
            await assetService.linkFile(importedFileId, {
              app: 'oxy-mail',
              entityType: 'message',
              entityId: msgId,
              createdBy: userId,
            });
          } catch (linkErr) {
            logger.warn('Failed to link imported attachment to message', {
              fileId: importedFileId,
              messageId: msgId,
              error: linkErr instanceof Error ? linkErr.message : String(linkErr),
            });
          }
        }

        // Fire-and-forget AI processing
        aiLabelingService.enqueueClassification(userId, msgId);
        cardExtractionService.extractAndUpdate(userId, msgId).catch((err) => {
          logger.warn('Card extraction failed for imported message', { msgId, error: String(err) });
        });

        imported++;
      } catch (err) {
        if (err instanceof BadRequestError) {
          throw err;
        }
        logger.warn('Failed to import .eml file', {
          filename: file.originalname,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Email import completed', { userId, imported, total: files.length });
    return imported;
  }

  // ─── Search ───────────────────────────────────────────────────────

  async searchMessages(
    userId: string,
    query: string,
    options: {
      limit?: number;
      offset?: number;
      mailboxId?: string;
      from?: string;
      to?: string;
      subject?: string;
      hasAttachment?: boolean;
      dateAfter?: string;
      dateBefore?: string;
      starred?: boolean;
      label?: string;
      seen?: boolean;
      cursor?: string;
    } = {}
  ): Promise<{ data: MessageDto[]; total: number; limit: number; offset: number; nextCursor?: string | null }> {
    const { limit = 50, offset = 0, cursor: cursorToken, mailboxId, from, to, subject, hasAttachment, dateAfter, dateBefore, starred, label, seen } = options;
    const cursorMode = cursorToken !== undefined;
    const cursor = cursorToken ? decodeEmailPageCursor(cursorToken, 'search') as Extract<EmailPageCursor, { kind: 'search' }> : null;

    const fromFilter = normalizeStructuredSearchFilter(from);
    const toFilter = normalizeStructuredSearchFilter(to);
    const subjectFilter = normalizeStructuredSearchFilter(subject);

    // Mongo's `$text` becomes a `tsvector` match against the GENERATED column;
    // the RANK has to be spelled out. `ts_rank` defaults to `{0.1, 0.2, 0.4, 1.0}`
    // for D/C/B/A, which is exactly the 10:1 subject-to-body ratio Mongo's
    // `weights: {subject: 10, text: 1}` declared — but it is passed explicitly,
    // because a default is a thing that can change underneath a search and
    // silently reorder every result.
    const tsQuery = query ? sql`websearch_to_tsquery('english', ${query})` : undefined;

    const rankExpression = tsQuery
      ? sql`ts_rank('{0.1, 0.2, 0.4, 1.0}'::float4[], ${messages.searchVector}, ${tsQuery})`
      : null;

    const baseWhere = and(
      eq(messages.userId, userId),
      ...(tsQuery ? [sql`${messages.searchVector} @@ ${tsQuery}`] : []),
      ...(mailboxId ? [eq(messages.mailboxId, mailboxId)] : []),
      ...(fromFilter ? [containsInsensitive(messages.fromAddress, fromFilter)] : []),
      // CORRELATED, so the outer reference is spelled out in full rather than
      // interpolated: a drizzle Column renders BARE when its table is not in
      // the statement's own FROM, and `where message_id = id` would compare two
      // columns of the SUBQUERY's table and match nothing — silently, with no
      // error. See `db/schema/CONVENTIONS.md`.
      ...(toFilter
        ? [
            sql`exists (
              select 1 from message_recipients r
              where r.message_id = messages.id
                and strpos(lower(r.address), lower(${toFilter})) > 0
            )`,
          ]
        : []),
      ...(subjectFilter ? [containsInsensitive(messages.subject, subjectFilter)] : []),
      ...(hasAttachment
        ? [
            sql`exists (
              select 1 from message_attachments a where a.message_id = messages.id
            )`,
          ]
        : []),
      ...(starred ? [eq(messages.starred, true)] : []),
      ...(seen !== undefined ? [eq(messages.seen, seen)] : []),
      ...(label ? [sql`${messages.labels} @> array[${label}]::text[]`] : []),
      ...(dateAfter ? [gte(messages.date, new Date(dateAfter))] : []),
      ...(dateBefore ? [lte(messages.date, new Date(dateBefore))] : []),
    );
    const where = and(
      baseWhere,
      ...(cursor
        ? [tsQuery && rankExpression
            ? or(
                sql`${rankExpression} < ${cursor.rank}`,
                and(
                  sql`${rankExpression} = ${cursor.rank}`,
                  or(
                    lt(messages.date, new Date(cursor.date)),
                    and(eq(messages.date, new Date(cursor.date)), lt(messages.id, cursor.id)),
                  ),
                ),
              )
            : or(
                lt(messages.date, new Date(cursor.date)),
                and(eq(messages.date, new Date(cursor.date)), lt(messages.id, cursor.id)),
              )]
        : []),
    );

    // `statement_timeout` is Mongo's `maxTimeMS`, and `SET LOCAL` needs a
    // transaction — so the page and the count share one.
    const { rows, total } = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`set local statement_timeout = ${sql.raw(String(EMAIL_SEARCH_MAX_TIME_MS))}`,
      );

      const pageQuery = rankExpression
        ? tx.select({ ...PUBLIC_MESSAGE_COLUMNS, searchRank: rankExpression.as('search_rank') })
        : tx.select(PUBLIC_MESSAGE_COLUMNS);
      const page = await pageQuery
        .from(messages)
        .where(where)
        .orderBy(
          ...(rankExpression
            ? [
                desc(
                  rankExpression,
                ),
                // A total order: equal ranks must not shuffle between pages.
                desc(messages.date),
                desc(messages.id),
              ]
            : [desc(messages.date), desc(messages.id)]),
        )
        .limit(cursorMode ? limit + 1 : limit)
        .offset(cursorMode ? 0 : offset);

      const [countRow] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(messages)
        .where(baseWhere);

      return { rows: page, total: countRow?.total ?? 0 };
    });

    const hasMore = cursorMode ? rows.length > limit : offset + limit < total;
    const pageRows = cursorMode ? rows.slice(0, limit) : rows;
    const data = await toMessageDtos(getDb(), pageRows);
    const last = pageRows.at(-1) as (typeof pageRows)[number] & { searchRank?: number } | undefined;
    return {
      data,
      total,
      limit,
      offset: cursorMode ? 0 : offset,
      ...(cursorMode
        ? {
            nextCursor: hasMore && last
              ? encodeEmailPageCursor({
                  version: 1,
                  kind: 'search',
                  rank: Number(last.searchRank ?? 0),
                  date: last.date.toISOString(),
                  id: last.id,
                })
              : null,
          }
        : {}),
    };
  }

  // ─── Saved searches ─────────────────────────────────────────────

  async listSavedSearches(userId: string) {
    return getDb()
      .select({
        id: emailSavedSearches.id,
        name: emailSavedSearches.name,
        query: emailSavedSearches.query,
        filters: emailSavedSearches.filters,
        order: emailSavedSearches.order,
        createdAt: emailSavedSearches.createdAt,
        updatedAt: emailSavedSearches.updatedAt,
      })
      .from(emailSavedSearches)
      .where(eq(emailSavedSearches.userId, userId))
      .orderBy(asc(emailSavedSearches.order), asc(emailSavedSearches.createdAt));
  }

  async createSavedSearch(userId: string, input: {
    name: string;
    query: string;
    filters: SavedEmailSearchFilters;
    order?: number;
  }) {
    const [created] = await getDb()
      .insert(emailSavedSearches)
      .values({
        userId,
        name: input.name.trim(),
        query: input.query.trim(),
        filters: input.filters,
        order: input.order ?? 0,
      })
      .returning({
        id: emailSavedSearches.id,
        name: emailSavedSearches.name,
        query: emailSavedSearches.query,
        filters: emailSavedSearches.filters,
        order: emailSavedSearches.order,
        createdAt: emailSavedSearches.createdAt,
        updatedAt: emailSavedSearches.updatedAt,
      });
    return created;
  }

  async deleteSavedSearch(userId: string, id: string): Promise<void> {
    const deleted = await getDb()
      .delete(emailSavedSearches)
      .where(and(eq(emailSavedSearches.id, id), eq(emailSavedSearches.userId, userId)))
      .returning({ id: emailSavedSearches.id });
    if (deleted.length === 0) throw new NotFoundError('Saved search not found');
  }

  // ─── Quota ────────────────────────────────────────────────────────

  /**
   * Bytes stored, against the tier's allowance.
   *
   * Mongo summed the cached `size` counter across the user's mailboxes; the
   * counter is gone, so this sums the messages themselves. Same number by
   * definition — every message belongs to exactly one of that user's mailboxes
   * — and it cannot drift from what is actually stored, which the counter could.
   */
  async getQuotaUsage(userId: string): Promise<{ used: number; limit: number; percentage: number }> {
    const [row] = await getDb()
      .select({ used: sql<string>`coalesce(sum(${messages.size}), 0)::bigint` })
      .from(messages)
      .where(eq(messages.userId, userId));
    // `sum()` is `numeric`; postgres.js hands a bigint back as a string.
    const used = Number(row?.used ?? 0);
    const tier = await this.getUserTier(userId);
    const limit = EMAIL_QUOTAS[tier].storage;
    return { used, limit, percentage: limit > 0 ? (used / limit) * 100 : 0 };
  }

  async enforceQuota(userId: string, additionalBytes: number): Promise<void> {
    const { used, limit } = await this.getQuotaUsage(userId);
    if (used + additionalBytes > limit) {
      throw new BadRequestError('Email storage quota exceeded');
    }
  }

  async getDailySendCount(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const sentMailbox = await this.getMailboxBySpecialUse(userId, '\\Sent');
    if (!sentMailbox) return 0;

    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.userId, userId),
          eq(messages.mailboxId, sentMailbox.id),
          gte(messages.receivedAt, startOfDay),
        ),
      );
    return row?.count ?? 0;
  }

  async enforceSendLimit(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    const limit = EMAIL_QUOTAS[tier].dailySendLimit;
    const count = await this.getDailySendCount(userId);
    if (count >= limit) {
      throw new BadRequestError('Daily send limit reached');
    }
  }

  // ─── User lifecycle ───────────────────────────────────────────────

  /**
   * Delete all email data for a user (mailboxes, messages, S3 attachments).
   * Called when the Oxy account is deleted.
   */
  async deleteAllUserData(userId: string): Promise<void> {
    const db = getDb();
    // Unlink the attachment files first — the file manager owns blob lifecycle
    // and has to be told before the rows pointing at them go.
    await this.deleteAttachmentsForUser(userId);

    // Deleting the mailboxes takes their messages with them
    // (`messages.mailbox_id` CASCADEs), but a message could in principle
    // outlive its folder, so both are stated.
    await db.delete(messages).where(eq(messages.userId, userId));
    await db.delete(mailboxes).where(eq(mailboxes.userId, userId));

    logger.info('All email data deleted for user', { userId });
  }

  // `resolveRecipient` is DELETED rather than ported: nothing in `src/` called
  // it. The inbound webhook resolves its own recipients (`emailInbound.ts`) and
  // `storeIncomingMessage` resolves the username it is handed, so this was a
  // third copy of that lookup with no caller — exactly the kind of thing the
  // migration contract refuses to carry across.

  // ─── Email settings ───────────────────────────────────────────────

  async getEmailSettings(userId: string): Promise<{
    signature?: string;
    autoReply?: { enabled: boolean; subject?: string; body?: string; startDate?: Date; endDate?: Date };
    autoForwardTo?: string;
    autoForwardKeepCopy?: boolean;
    address: string;
  }> {
    // `email_signature`, `auto_forward_to` and `auto_forward_keep_copy` are
    // PROTECTED. This endpoint serves them to their OWNER and nobody else, so
    // it names them explicitly — the sanctioned opt-in.
    const [user] = await getDb()
      .select({
        username: users.username,
        emailSignature: users.emailSignature,
        autoReplyEnabled: users.autoReplyEnabled,
        autoReplySubject: users.autoReplySubject,
        autoReplyBody: users.autoReplyBody,
        autoReplyStartDate: users.autoReplyStartDate,
        autoReplyEndDate: users.autoReplyEndDate,
        autoForwardTo: users.autoForwardTo,
        autoForwardKeepCopy: users.autoForwardKeepCopy,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundError('User not found');

    // The auto-reply sub-document is five columns now; it is reassembled here
    // so the wire keeps the nested object, and each optional part is omitted
    // when NULL exactly as an unset Mongo sub-field was.
    const autoReply: { enabled: boolean; subject?: string; body?: string; startDate?: Date; endDate?: Date } = {
      enabled: user.autoReplyEnabled,
    };
    if (user.autoReplySubject !== null) autoReply.subject = user.autoReplySubject;
    if (user.autoReplyBody !== null) autoReply.body = user.autoReplyBody;
    if (user.autoReplyStartDate !== null) autoReply.startDate = user.autoReplyStartDate;
    if (user.autoReplyEndDate !== null) autoReply.endDate = user.autoReplyEndDate;

    return {
      signature: user.emailSignature ?? '',
      autoReply,
      autoForwardTo: user.autoForwardTo ?? '',
      autoForwardKeepCopy: user.autoForwardKeepCopy,
      address: user.username ? resolveEmailAddress(user.username) : '',
    };
  }

  async updateEmailSettings(
    userId: string,
    settings: {
      signature?: string;
      autoReply?: { enabled: boolean; subject?: string; body?: string; startDate?: Date; endDate?: Date };
      autoForwardTo?: string;
      autoForwardKeepCopy?: boolean;
    }
  ): Promise<void> {
    const update: Partial<typeof users.$inferInsert> = {};
    if (settings.signature !== undefined) update.emailSignature = settings.signature;
    if (settings.autoReply !== undefined) {
      // Replacing the sub-document replaced every field in it, so the flattened
      // form has to write all five — otherwise a cleared subject would survive.
      update.autoReplyEnabled = settings.autoReply.enabled;
      update.autoReplySubject = settings.autoReply.subject ?? null;
      update.autoReplyBody = settings.autoReply.body ?? null;
      update.autoReplyStartDate = settings.autoReply.startDate ?? null;
      update.autoReplyEndDate = settings.autoReply.endDate ?? null;
    }
    if (settings.autoForwardTo !== undefined) update.autoForwardTo = settings.autoForwardTo;
    if (settings.autoForwardKeepCopy !== undefined) update.autoForwardKeepCopy = settings.autoForwardKeepCopy;

    if (Object.keys(update).length > 0) {
      await getDb().update(users).set(update).where(eq(users.id, userId));
    }
    userCache.invalidate(userId);
  }

  // ─── Subscriptions ──────────────────────────────────────────────

  /**
   * Attach `senderAvatarPath` to each message based on sender email.
   * Uses the shared SenderAvatar cache (resolved server-side, 7-day TTL).
   */
  private static async enrichWithAvatars(
    page: Array<{ from: EmailAddressDto; senderAvatarPath?: string | null }>,
  ): Promise<void> {
    if (page.length === 0) return;
    const emails = page.map((m) => m.from.address).filter(Boolean);
    if (emails.length === 0) return;
    try {
      const avatarMap = await getAvatarPathsBatch(emails);
      for (const msg of page) {
        const addr = msg.from.address.trim().toLowerCase();
        if (addr && avatarMap.has(addr)) {
          msg.senderAvatarPath = avatarMap.get(addr) ?? null;
        }
      }
    } catch {
      // Avatar enrichment is non-critical — don't fail message fetch
    }
  }

  /**
   * Newsletter / subscription detection patterns.
   * Matches common automated sender addresses.
   */
  private static readonly NEWSLETTER_PATTERNS = [
    /noreply/i,
    /no-reply/i,
    /donotreply/i,
    /do-not-reply/i,
    /newsletter/i,
    /marketing/i,
    /promo/i,
    /updates@/i,
    /digest@/i,
    /notification/i,
    /mailer/i,
    /news@/i,
    /info@/i,
    /announcements@/i,
    /hello@/i,
    /team@/i,
    /support@/i,
  ];

  /**
   * Aggregate subscription senders: group messages by sender address,
   * detect newsletter characteristics, and return paginated results.
   */
  async getSubscriptions(
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ data: SubscriptionSenderDto[]; total: number }> {
    const { limit = 50, offset = 0 } = options;
    const db = getDb();

    // Only aggregate from Inbox and Archive (received mail, not sent/drafts/trash)
    const receivedMailboxes = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.userId, userId),
          inArray(mailboxes.specialUse, ['\\Inbox', '\\Archive']),
        ),
      );
    const mailboxIds = receivedMailboxes.map((m) => m.id);

    if (mailboxIds.length === 0) {
      return { data: [], total: 0 };
    }

    // The `$group` + `$match` half, defined ONCE and used by both the page and
    // the count. `$facet` computed them together; two statements sharing one
    // fragment is the honest equivalent — a window `count(*) over ()` would
    // return no rows at all for a page past the end, losing the total exactly
    // when the caller still needs it.
    // The two dates come back as EPOCH MILLISECONDS, not as timestamps.
    //
    // `db.execute` runs raw SQL past drizzle's column mappers, and postgres.js
    // hands a `timestamptz` back as the string `2026-07-31 20:36:11.044179+00`
    // in that path — measured, not assumed. Returning it unconverted would put
    // that string on the wire where an ISO-8601 one has always been, silently,
    // because `res.json` serializes a string as happily as a Date. An integer
    // has no format to get wrong.
    const grouped = sql`
      select m.from_address as address,
             count(*)::int as message_count,
             count(*) filter (where m.seen)::int as read_count,
             (extract(epoch from max(m.date)) * 1000)::bigint as latest_date_ms,
             (extract(epoch from min(m.date)) * 1000)::bigint as oldest_date_ms,
             (array_agg(m.from_name order by m.date desc, m.id desc))[1] as name,
             (array_agg(m.id order by m.date desc, m.id desc))[1] as latest_message_id
      from messages m
      where m.user_id = ${userId} and m.mailbox_id = any(${textArray(mailboxIds)})
      group by m.from_address
      having count(*) >= 3
    `;

    // The `address asc` tiebreak below is LOAD-BEARING. Ordering on
    // `message_count` alone leaves equal-count senders in an arbitrary order
    // that can differ between two offset pages, so the same sender comes back
    // twice while another is skipped entirely. The address is the group key,
    // which makes the pair a STRICT TOTAL order and the pagination stable.
    const [senders, [totalRow]] = await Promise.all([
      db.execute<{
        address: string;
        message_count: number;
        read_count: number;
        /** Epoch milliseconds as a `bigint`, which postgres.js returns as a string. */
        latest_date_ms: string;
        oldest_date_ms: string;
        name: string | null;
        latest_message_id: string;
      }>(sql`
        with grouped as (${grouped})
        select * from grouped
        order by message_count desc, address asc
        limit ${limit} offset ${offset}
      `),
      db.execute<{ total: number }>(sql`
        with grouped as (${grouped})
        select count(*)::int as total from grouped
      `),
    ]);

    const total = totalRow?.total ?? 0;
    if (senders.length === 0) {
      return { data: [], total };
    }

    // Phase 2: fetch List-Unsubscribe headers for each sender's latest message.
    // `headers` is PROTECTED and named explicitly; the header names are already
    // stored lower-cased by the inbound parser, but a `.eml` import writes none
    // at all, so the lookup still normalizes.
    const latestMessages = await db
      .select({ id: messages.id, headers: messages.headers })
      .from(messages)
      .where(inArray(messages.id, senders.map((s) => s.latest_message_id)));

    const headerMap = new Map<string, Record<string, string>>();
    for (const msg of latestMessages) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(msg.headers)) {
        headers[key.toLowerCase()] = value;
      }
      headerMap.set(msg.id, headers);
    }

    // Enrich senders with unsubscribe info and type detection
    const enriched: SubscriptionSenderDto[] = senders.map((sender) => {
      const headers = headerMap.get(sender.latest_message_id) ?? {};
      const listUnsub = headers['list-unsubscribe'] || null;

      let type: SubscriptionSenderDto['type'] = 'frequent';
      if (listUnsub) {
        type = 'list-unsubscribe';
      } else if (EmailService.NEWSLETTER_PATTERNS.some((p) => p.test(sender.address))) {
        type = 'pattern-match';
      }

      return {
        _id: sender.address,
        name: sender.name || sender.address.split('@')[0],
        messageCount: sender.message_count,
        readCount: sender.read_count,
        latestDate: new Date(Number(sender.latest_date_ms)),
        oldestDate: new Date(Number(sender.oldest_date_ms)),
        latestMessageId: sender.latest_message_id,
        hasListUnsubscribe: Boolean(listUnsub),
        type,
      };
    });

    // Enrich subscriptions with sender avatars
    try {
      const avatarMap = await getAvatarPathsBatch(enriched.map((s) => s._id));
      for (const sub of enriched) {
        sub.senderAvatarPath = avatarMap.get(sub._id.trim().toLowerCase()) ?? null;
      }
    } catch {
      // Non-critical
    }

    return { data: enriched, total };
  }

  /**
   * Unsubscribe from a sender via List-Unsubscribe header or by blocking.
   */
  async unsubscribe(
    userId: string,
    senderAddress: string,
    method: 'list-unsubscribe' | 'block' = 'list-unsubscribe',
  ): Promise<{ success: boolean; method: string }> {
    const db = getDb();
    const normalizedSender = senderAddress.trim().toLowerCase();

    if (method === 'list-unsubscribe') {
      // Find the latest message from this sender. `headers` is PROTECTED and
      // named explicitly — the List-Unsubscribe header is the whole point here.
      const [latestMsg] = await db
        .select({ headers: messages.headers })
        .from(messages)
        .where(and(eq(messages.userId, userId), eq(messages.fromAddress, normalizedSender)))
        .orderBy(desc(messages.date), desc(messages.id))
        .limit(1);

      if (latestMsg) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(latestMsg.headers)) {
          headers[key.toLowerCase()] = value;
        }

        const listUnsub = headers['list-unsubscribe'];
        const listUnsubPost = headers['list-unsubscribe-post'];

        if (listUnsub) {
          const httpMatch = listUnsub.match(/<(https:\/\/[^>]+)>/);
          const mailtoMatch = listUnsub.match(/<mailto:([^>]+)>/);

          // RFC 8058 One-Click Unsubscribe
          if (httpMatch && listUnsubPost) {
            try {
              await this.fetchUnsubscribeUrl(httpMatch[1], {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'List-Unsubscribe': 'One-Click-Unsubscribe',
                },
              });
              return { success: true, method: 'one-click' };
            } catch (err) {
              logger.warn('One-click unsubscribe failed, trying fallback', {
                sender: senderAddress,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // HTTP GET fallback
          if (httpMatch) {
            try {
              await this.fetchUnsubscribeUrl(httpMatch[1], { method: 'GET' });
              return { success: true, method: 'http' };
            } catch (err) {
              logger.warn('HTTP unsubscribe failed, trying mailto', {
                sender: senderAddress,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Mailto fallback
          if (mailtoMatch) {
            try {
              const [address, queryString] = mailtoMatch[1].split('?');
              const params = new URLSearchParams(queryString || '');

              const user = await loadSenderIdentity(db, userId);
              if (user?.username) {
                await smtpOutbound.send({
                  userId,
                  from: {
                    name: resolveEmailFromName(user),
                    address: resolveEmailAddress(user.username),
                  },
                  to: [{ address, name: '' }],
                  subject: params.get('subject') || 'Unsubscribe',
                  text: params.get('body') || 'Unsubscribe',
                });
                return { success: true, method: 'mailto' };
              }
            } catch (err) {
              logger.warn('Mailto unsubscribe failed', {
                sender: senderAddress,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }

      // Fall through to block if List-Unsubscribe methods fail
      logger.info('No List-Unsubscribe available, falling back to block', { sender: senderAddress });
    }

    // Block sender: move all messages from this sender to Spam.
    //
    // The whole read-group-write dance this used to be existed ONLY to keep the
    // per-mailbox counters right — twenty lines of bookkeeping around one
    // `updateMany`. The counters are derived now, so the move IS the operation.
    const spamMailbox = await this.getMailboxBySpecialUse(userId, '\\Junk');
    if (spamMailbox) {
      await db
        .update(messages)
        .set({ mailboxId: spamMailbox.id })
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.fromAddress, normalizedSender),
            not(eq(messages.mailboxId, spamMailbox.id)),
          ),
        );
    }

    return { success: true, method: 'blocked' };
  }

  /**
   * Fetch an unsubscribe URL through the SSRF-safe primitive.
   *
   * `safeFetch` (from `@oxyhq/core/server`) performs a DNS-pinned lookup that
   * closes the DNS-rebind TOCTOU window the prior hand-rolled
   * `lookup()` + `fetch()` check left open, denies private/metadata IP ranges,
   * and re-validates every redirect hop. Redirects are disallowed here
   * (`maxRedirects: 0`) so a 3xx is treated as a failure rather than followed.
   * Restricted to https only — unsubscribe endpoints must be https.
   *
   * Throws on a non-https URL, an SSRF-blocked target, a network/timeout error,
   * or a non-2xx response, so the caller can fall through to the next method.
   */
  private async fetchUnsubscribeUrl(
    url: string,
    options: { method: 'GET' | 'POST'; headers?: Record<string, string> },
  ): Promise<void> {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error('Malformed unsubscribe URL');
    }
    if (protocol !== 'https:') {
      throw new Error('Only HTTPS unsubscribe URLs are allowed');
    }

    let result;
    try {
      result = await safeFetch(url, {
        method: options.method,
        headers: options.headers,
        maxRedirects: 0,
        headersTimeoutMs: 10_000,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (err instanceof SsrfRejection) {
        throw new Error(`Private network URLs are not allowed: ${err.message}`);
      }
      throw err;
    }

    // The caller does not consume the unsubscribe response body — destroy it so
    // a large body cannot be streamed into the process.
    result.response.destroy();

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Unsubscribe request failed with status ${result.status}`);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /**
   * The subscription tier the quota and send limits are read from.
   *
   * The `mongoose.model('BillingSubscription')` lookup this replaced existed to
   * avoid an import cycle and swallowed "model not registered" alongside every
   * real database error. There is no registry to miss now, so the read is
   * direct — and a failure is logged rather than silently downgrading a paying
   * account to the free quota.
   */
  private async getUserTier(userId: string): Promise<SubscriptionTier> {
    try {
      const [subscription] = await getDb()
        .select({ planName: billingSubscriptions.planName })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.userId, userId),
            inArray(billingSubscriptions.status, ['active', 'trialing']),
          ),
        )
        .limit(1);

      const planName = subscription?.planName.toLowerCase();
      if (planName === 'business') return 'business';
      if (planName === 'pro') return 'pro';
      return 'free';
    } catch (err) {
      logger.warn('Failed to resolve subscription tier; defaulting to free', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'free';
    }
  }

  /**
   * Unlink every attachment's File from this message in the Oxy file manager.
   * AssetService moves a file to trash automatically when its last link is
   * removed; the blob itself is never deleted here — the file manager owns
   * blob lifecycle.
   *
   * Links are recorded under two entityId conventions: outbound sends link by
   * the RFC Message-ID (the Mongo _id of the Sent copy is created later inside
   * storeSentMessage), while inbound/import link by the Mongo _id. Unlinking
   * is a no-op when a link doesn't exist, so we clear both.
   */
  private async deleteMessageAttachments(message: { id: string; messageId: string }): Promise<void> {
    const fileIds = await getDb()
      .select({ fileId: messageAttachments.fileId })
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, message.id));
    if (fileIds.length === 0) return;

    const entityIds = [message.id];
    if (message.messageId && !entityIds.includes(message.messageId)) {
      entityIds.push(message.messageId);
    }

    for (const { fileId } of fileIds) {
      for (const entityId of entityIds) {
        try {
          await assetService.unlinkFile(fileId, 'oxy-mail', 'message', entityId);
        } catch (error) {
          logger.error('Failed to unlink attachment file from message', error instanceof Error ? error : new Error(String(error)), {
            fileId,
            entityId,
          });
        }
      }
    }
  }

  /**
   * Unlink every attachment of every message matching `scope`.
   *
   * Mongo streamed a cursor; this pages by primary key instead. A cursor holds
   * a snapshot open for the whole sweep, which for a large mailbox means a long
   * transaction the vacuum cannot get past — and the sweep is issuing S3-bound
   * unlink calls the whole time.
   */
  private async unlinkAttachmentsMatching(scope: SQL | undefined): Promise<void> {
    const db = getDb();
    let after: string | undefined;

    for (;;) {
      const page = await db
        .select({ id: messages.id, messageId: messages.messageId })
        .from(messages)
        .where(after === undefined ? scope : and(scope, sql`${messages.id} > ${after}`))
        .orderBy(asc(messages.id))
        .limit(ATTACHMENT_SWEEP_PAGE_SIZE);

      if (page.length === 0) return;

      for (const message of page) {
        await this.deleteMessageAttachments(message);
      }

      after = page[page.length - 1].id;
      if (page.length < ATTACHMENT_SWEEP_PAGE_SIZE) return;
    }
  }

  private async deleteAttachmentsForMailbox(userId: string, mailboxId: string): Promise<void> {
    await this.unlinkAttachmentsMatching(
      and(eq(messages.userId, userId), eq(messages.mailboxId, mailboxId)),
    );
  }

  private async deleteAttachmentsForUser(userId: string): Promise<void> {
    await this.unlinkAttachmentsMatching(eq(messages.userId, userId));
  }

  // ─── Bundles ─────────────────────────────────────────────────────

  /**
   * Seed the four default bundles, once per user.
   *
   * `onConflictDoNothing` replaces the `insertMany({ordered: false})` plus
   * duplicate-key rescue: two concurrent first loads race here, and the whole
   * point of that rescue was to let the loser proceed. Note the uniqueness is
   * now case-INSENSITIVE (`bundles_user_id_lower_name_key`) where Mongo's was
   * not — see `db/schema/bundles.ts`.
   */
  async ensureDefaultBundles(userId: string): Promise<void> {
    const db = getDb();
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bundles)
      .where(eq(bundles.userId, userId));
    if ((countRow?.count ?? 0) > 0) return;

    await db
      .insert(bundles)
      .values(
        EmailService.DEFAULT_BUNDLES.map((b) => ({
          userId,
          name: b.name,
          icon: b.icon,
          color: b.color,
          matchLabels: [...b.matchLabels],
          order: b.order,
          enabled: true,
          collapsed: true,
        })),
      )
      .onConflictDoNothing();
    logger.info('Default bundles seeded', { userId });
  }

  async listBundles(userId: string): Promise<BundleDto[]> {
    await this.ensureDefaultBundles(userId);
    const rows = await getDb()
      .select()
      .from(bundles)
      .where(eq(bundles.userId, userId))
      .orderBy(asc(bundles.order));
    return rows.map(toBundleDto);
  }

  async updateBundle(
    userId: string,
    bundleId: string,
    updates: { enabled?: boolean; collapsed?: boolean; matchLabels?: string[]; order?: number },
  ): Promise<BundleDto> {
    const db = getDb();
    const owned = and(eq(bundles.id, bundleId), eq(bundles.userId, userId));

    const [bundle] = Object.keys(updates).length === 0
      ? await db.select().from(bundles).where(owned).limit(1)
      : await db.update(bundles).set(updates).where(owned).returning();
    if (!bundle) throw new NotFoundError('Bundle not found');
    return toBundleDto(bundle);
  }

  async listBundledMessages(
    userId: string,
    mailboxId: string | null,
    options: { limit: number; offset: number },
  ): Promise<{
    primary: MessageDto[];
    bundles: Array<{ bundle: BundleDto; messages: MessageDto[]; unreadCount: number }>;
    total: number;
  }> {
    const db = getDb();

    // Get enabled bundles
    await this.ensureDefaultBundles(userId);
    const bundleRows = await db
      .select()
      .from(bundles)
      .where(and(eq(bundles.userId, userId), eq(bundles.enabled, true)))
      .orderBy(asc(bundles.order));
    const enabledBundles = bundleRows.map(toBundleDto);

    // Query all messages for this mailbox
    const where = and(
      eq(messages.userId, userId),
      ...(mailboxId ? [eq(messages.mailboxId, mailboxId)] : []),
    );

    const [rows, [countRow]] = await Promise.all([
      db
        .select(PUBLIC_MESSAGE_COLUMNS)
        .from(messages)
        .where(where)
        .orderBy(desc(messages.pinned), desc(messages.date))
        .limit(options.limit)
        .offset(options.offset),
      db.select({ total: sql<number>`count(*)::int` }).from(messages).where(where),
    ]);

    const allMessages = await toMessageDtos(db, rows);

    // Partition into primary vs bundled
    const primary: MessageDto[] = [];
    const bundleMap = new Map<string, MessageDto[]>(
      enabledBundles.map((bundle) => [bundle.id, []]),
    );

    for (const msg of allMessages) {
      const matched = enabledBundles.find((bundle) =>
        bundle.matchLabels.some((label) => msg.labels.includes(label)),
      );
      // First matching bundle wins.
      const bucket = matched ? bundleMap.get(matched.id) : undefined;
      if (bucket) bucket.push(msg);
      else primary.push(msg);
    }

    const bundleResults = enabledBundles
      .map((bundle) => {
        const bundleMessages = bundleMap.get(bundle.id) ?? [];
        return {
          bundle,
          messages: bundleMessages,
          unreadCount: bundleMessages.filter((m) => !m.flags.seen).length,
        };
      })
      .filter((br) => br.messages.length > 0);

    return { primary, bundles: bundleResults, total: countRow?.total ?? 0 };
  }

  // ─── Reminders ──────────────────────────────────────────────────

  async createReminder(
    userId: string,
    data: { text: string; remindAt: string; relatedMessageId?: string },
  ): Promise<ReminderDto> {
    const [reminder] = await getDb()
      .insert(reminders)
      .values({
        userId,
        text: data.text,
        remindAt: new Date(data.remindAt),
        relatedMessageId: data.relatedMessageId || null,
      })
      .returning();
    return toReminderDto(reminder);
  }

  async listReminders(
    userId: string,
    options: { includeCompleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{
    data: ReminderDto[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  }> {
    const db = getDb();
    const where = and(
      eq(reminders.userId, userId),
      ...(options.includeCompleted ? [] : [eq(reminders.completed, false)]),
    );

    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const [[countRow], rows] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(reminders).where(where),
      db
        .select()
        .from(reminders)
        .where(where)
        .orderBy(desc(reminders.pinned), asc(reminders.remindAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = countRow?.total ?? 0;
    return {
      data: rows.map(toReminderDto),
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
  }

  async getReminder(userId: string, reminderId: string): Promise<ReminderDto> {
    const [reminder] = await getDb()
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)))
      .limit(1);
    if (!reminder) throw new NotFoundError('Reminder not found');
    return toReminderDto(reminder);
  }

  async updateReminder(
    userId: string,
    reminderId: string,
    updates: { text?: string; remindAt?: string; completed?: boolean; pinned?: boolean; snoozedUntil?: string | null },
  ): Promise<ReminderDto> {
    const db = getDb();
    const updateData: Partial<typeof reminders.$inferInsert> = {};
    if (updates.text !== undefined) updateData.text = updates.text;
    if (updates.remindAt !== undefined) updateData.remindAt = new Date(updates.remindAt);
    if (updates.completed !== undefined) updateData.completed = updates.completed;
    if (updates.pinned !== undefined) updateData.pinned = updates.pinned;
    if (updates.snoozedUntil !== undefined) {
      updateData.snoozedUntil = updates.snoozedUntil ? new Date(updates.snoozedUntil) : null;
    }

    const owned = and(eq(reminders.id, reminderId), eq(reminders.userId, userId));
    const [reminder] = Object.keys(updateData).length === 0
      ? await db.select().from(reminders).where(owned).limit(1)
      : await db.update(reminders).set(updateData).where(owned).returning();
    if (!reminder) throw new NotFoundError('Reminder not found');
    return toReminderDto(reminder);
  }

  async deleteReminder(userId: string, reminderId: string): Promise<void> {
    const deleted = await getDb()
      .delete(reminders)
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)))
      .returning({ id: reminders.id });
    if (deleted.length === 0) throw new NotFoundError('Reminder not found');
  }

  /**
   * Clear the snooze on every reminder that is due.
   *
   * One statement instead of a read followed by a write per row: the update's
   * own `where` selects exactly the rows the loop used to re-test, and
   * `returning` is what the count was for.
   */
  async processDueReminders(): Promise<number> {
    const db = getDb();
    const now = new Date();
    const due = and(
      eq(reminders.completed, false),
      lte(reminders.remindAt, now),
      or(sql`${reminders.snoozedUntil} is null`, lte(reminders.snoozedUntil, now)),
    );

    const [[countRow], cleared] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(reminders).where(due),
      db
        .update(reminders)
        .set({ snoozedUntil: null })
        .where(and(due, isNotNull(reminders.snoozedUntil)))
        .returning({ id: reminders.id }),
    ]);

    logger.debug('Due reminders processed', { due: countRow?.total ?? 0, cleared: cleared.length });
    return countRow?.total ?? 0;
  }

  // ─── Templates ──────────────────────────────────────────────────

  async listTemplates(userId: string): Promise<EmailTemplateDto[]> {
    const rows = await getDb()
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.userId, userId))
      .orderBy(asc(emailTemplates.order), asc(emailTemplates.name));
    return rows.map(toTemplateDto);
  }

  async createTemplate(userId: string, data: { name: string; subject?: string; body: string }): Promise<EmailTemplateDto> {
    const db = getDb();
    // `lower(name)`, matching `email_templates_user_id_lower_name_key` — the
    // Postgres form of Mongo's `strength: 2` collation.
    const [existing] = await db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.userId, userId),
          sql`lower(${emailTemplates.name}) = lower(${data.name})`,
        ),
      )
      .limit(1);
    if (existing) throw new BadRequestError(`Template "${data.name}" already exists`);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailTemplates)
      .where(eq(emailTemplates.userId, userId));

    const [template] = await db
      .insert(emailTemplates)
      .values({
        userId,
        name: data.name.trim(),
        subject: data.subject || '',
        body: data.body,
        order: countRow?.count ?? 0,
      })
      .returning();
    return toTemplateDto(template);
  }

  async updateTemplate(userId: string, templateId: string, updates: { name?: string; subject?: string; body?: string }): Promise<EmailTemplateDto> {
    const db = getDb();
    const cleanUpdates: Partial<typeof emailTemplates.$inferInsert> = {};
    if (updates.name !== undefined) cleanUpdates.name = updates.name.trim();
    if (updates.subject !== undefined) cleanUpdates.subject = updates.subject;
    if (updates.body !== undefined) cleanUpdates.body = updates.body;

    const owned = and(eq(emailTemplates.id, templateId), eq(emailTemplates.userId, userId));
    const [template] = Object.keys(cleanUpdates).length === 0
      ? await db.select().from(emailTemplates).where(owned).limit(1)
      : await db.update(emailTemplates).set(cleanUpdates).where(owned).returning();
    if (!template) throw new NotFoundError('Template not found');
    return toTemplateDto(template);
  }

  async deleteTemplate(userId: string, templateId: string): Promise<void> {
    const deleted = await getDb()
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.id, templateId), eq(emailTemplates.userId, userId)))
      .returning({ id: emailTemplates.id });
    if (deleted.length === 0) throw new NotFoundError('Template not found');
  }

  // ─── Contacts ──────────────────────────────────────────────────────

  /**
   * The user's address book, optionally filtered by a free-text query.
   *
   * ## Why this does NOT use `contacts_search_vector_idx`
   *
   * The Mongo query was three unanchored case-insensitive REGEXES over `name`,
   * `email` AND `company` — which no Mongo text index could serve either, so
   * contact search has always been a scan. The `tsvector` on `contacts` is a
   * port of that DEAD index: it covers `name` and `email` only, and it does
   * prefix matching, not infix. Using it here would silently drop `company`
   * from the search and stop matching mid-word.
   *
   * `pg_trgm` WOULD reproduce the current semantics with an index, and it is
   * available — but adopting an extension is a schema decision with a
   * migration-ordering cost in every environment, not something a call-site
   * port gets to make. So the semantics are preserved exactly and the scan
   * stays: it is bounded by `user_id`, i.e. one person's contacts.
   */
  async listContacts(
    userId: string,
    options: { q?: string; starred?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ data: ContactDto[]; total: number }> {
    const { q, starred, limit = 50, offset = 0 } = options;
    const db = getDb();
    const needle = q?.trim();

    const where = and(
      eq(contacts.userId, userId),
      ...(starred ? [eq(contacts.starred, true)] : []),
      ...(needle
        ? [
            or(
              containsInsensitive(contacts.name, needle),
              containsInsensitive(contacts.email, needle),
              containsInsensitive(sql`coalesce(${contacts.company}, '')`, needle),
            ),
          ]
        : []),
    );

    const [rows, [countRow]] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.starred), asc(contacts.name))
        .limit(limit)
        .offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(where),
    ]);

    return { data: rows.map(toContactDto), total: countRow?.total ?? 0 };
  }

  async createContact(
    userId: string,
    data: { name: string; email: string; company?: string; notes?: string; starred?: boolean },
  ): Promise<ContactDto> {
    const db = getDb();
    // CALL-SITE OBLIGATION (`db/schema/contacts.ts`): Mongoose lower-cased and
    // trimmed `email` with a setter. Postgres has none, so it happens here — or
    // the user gets two address-book entries for one correspondent.
    const email = data.email.trim().toLowerCase();

    const [existing] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), eq(contacts.email, email)))
      .limit(1);

    if (existing) {
      throw new BadRequestError('A contact with this email already exists');
    }

    const [contact] = await db
      .insert(contacts)
      .values({
        userId,
        name: data.name.trim(),
        email,
        company: data.company?.trim() || null,
        notes: data.notes?.trim() || null,
        starred: data.starred ?? false,
        autoCollected: false,
      })
      .returning();

    return toContactDto(contact);
  }

  async updateContact(
    userId: string,
    contactId: string,
    updates: { name?: string; email?: string; company?: string; notes?: string; starred?: boolean },
  ): Promise<ContactDto> {
    const db = getDb();
    const updateData: Partial<typeof contacts.$inferInsert> = {};
    if (updates.name !== undefined) updateData.name = updates.name.trim();
    if (updates.email !== undefined) updateData.email = updates.email.trim().toLowerCase();
    if (updates.company !== undefined) updateData.company = updates.company.trim() || null;
    if (updates.notes !== undefined) updateData.notes = updates.notes.trim() || null;
    if (updates.starred !== undefined) updateData.starred = updates.starred;

    const owned = and(eq(contacts.id, contactId), eq(contacts.userId, userId));
    const [contact] = Object.keys(updateData).length === 0
      ? await db.select().from(contacts).where(owned).limit(1)
      : await db.update(contacts).set(updateData).where(owned).returning();
    if (!contact) throw new NotFoundError('Contact not found');
    return toContactDto(contact);
  }

  async deleteContact(userId: string, contactId: string): Promise<void> {
    const deleted = await getDb()
      .delete(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
      .returning({ id: contacts.id });
    if (deleted.length === 0) throw new NotFoundError('Contact not found');
  }

  /**
   * Auto-collect contacts from email addresses.
   * Creates contacts with autoCollected: true for addresses that don't exist yet.
   * Fire-and-forget — errors are logged but not thrown.
   */
  async autoCollectContacts(
    userId: string,
    addresses: Array<{ name?: string; address: string }>,
  ): Promise<void> {
    const db = getDb();

    for (const addr of addresses) {
      if (!addr.address) continue;
      const email = addr.address.trim().toLowerCase();
      if (!email) continue;

      try {
        // `on conflict do update` is the `$setOnInsert` + `$set` pair: the
        // insert-only fields are simply absent from the update, so an existing
        // contact keeps the name the user gave it and only its last-contacted
        // stamp moves. One statement, so the race the upsert existed for
        // cannot happen at all.
        await db
          .insert(contacts)
          .values({
            userId,
            name: addr.name?.trim() || email.split('@')[0],
            email,
            autoCollected: true,
            starred: false,
            lastContactedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [contacts.userId, contacts.email],
            set: { lastContactedAt: new Date() },
          });
      } catch (err: unknown) {
        logger.warn('Failed to auto-collect contact', {
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Search contacts for autocomplete suggestions.
   * Returns contacts matching the query, ordered by relevance.
   *
   * Same substring semantics — and the same reason for not using the
   * `tsvector` — as {@link listContacts}.
   */
  async searchContacts(
    userId: string,
    query: string,
    limit = 10,
  ): Promise<Array<{ name: string; address: string }>> {
    const needle = query?.trim();
    if (!needle || needle.length < 2) return [];

    const rows = await getDb()
      .select({ name: contacts.name, email: contacts.email })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(
            containsInsensitive(contacts.name, needle),
            containsInsensitive(contacts.email, needle),
          ),
        ),
      )
      .orderBy(
        desc(contacts.starred),
        sql`${contacts.lastContactedAt} desc nulls last`,
        asc(contacts.name),
      )
      .limit(limit);

    return rows.map((c) => ({ name: c.name, address: c.email }));
  }
}

export const emailService = new EmailService();
export default emailService;
