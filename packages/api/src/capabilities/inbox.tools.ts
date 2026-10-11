import { rfcMessageIdSchema } from '@oxy.so/contracts';

import {
  saveDraftForUser,
  searchMessagesForUser,
  senderIdentityFor,
  sendMessageForUser,
  suggestContactsForUser,
  type SaveDraftCommand,
  type SendEmailCommand,
} from '../controllers/email.controller';
import { buildEmailAgentContext } from '../controllers/emailContext.controller';
import type { RecipientInput, AttachmentInput } from '../schemas/email.schemas';
import { messageBelongsToMailbox } from '../services/capabilityRuntimeStore.service';
import { emailService, type EmailAddressDto, type MessageDto } from '../services/email.service';
import { cancelEmailOutbox, listEmailOutbox } from '../services/emailOutbox.service';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/error';
import {
  INBOX_CAPABILITY_CATALOG,
  INBOX_DEFAULT_PAGE_SIZE,
  INBOX_MAX_PAGE_SIZE,
  INBOX_SPECIAL_MAILBOXES,
} from './inbox.catalog';

/**
 * The Inbox catalog tools, implemented ONCE for every transport.
 *
 * Alia reaches a tool over HTTP with a capability ticket
 * (`middleware/emailCapabilityAuth.ts`); an external MCP client reaches the
 * same tool through `inbox.handlers.ts`. Both authenticate, authorize and
 * reserve the idempotency key their own way, then call the function here —
 * which is why an Alia call and an MCP call with the same input return the
 * same body. Before this module the ticket path was served by the Inbox app's
 * REST controllers and MCP by its own handlers; they drifted, and
 * `getUnreadEmails` answered every Alia call with the REST route's 400.
 *
 * Mailbox scoping lives here and nowhere else. A ticket whose resource is ONE
 * mailbox sets `context.mailboxId`: listings are confined to it, and every
 * tool addressed to an email first proves the email is in it. The REST
 * controllers serve only the signed-in owner and know nothing of tickets.
 */

export interface InboxToolContext {
  /** The Oxy account whose email is read or changed. */
  readonly accountId: string;
  /**
   * Set when the caller's authority is a single mailbox of that account (a
   * `mailbox` resource ticket). Absent means the whole account.
   */
  readonly mailboxId?: string;
  /**
   * The transport's retry key for an effectful call — the `Idempotency-Key`
   * header, or MCP's `idempotencyKey` argument — already reserved by the
   * transport. It is the RAW key, not its hash: a send hands it to the
   * outbound pipeline, which derives the stable Message-ID and durable outbox
   * claim from it, so a retry that slips past the reservation still sends once.
   */
  readonly idempotencyKey?: string;
}

export type InboxToolInput = Readonly<Record<string, unknown>>;
export type InboxToolResult = Record<string, unknown>;
export type InboxTool = (
  input: InboxToolInput,
  context: InboxToolContext,
) => Promise<InboxToolResult>;

// ─── Input readers ──────────────────────────────────────────────────
//
// Both transports validate input against the catalog schema before a tool
// runs; these readers keep the functions safe to call directly and give
// TypeScript the types the schema already guarantees.

function optionalString(input: InboxToolInput, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestError(`${key} must be a string`);
  return value.length > 0 ? value : undefined;
}

function requiredString(input: InboxToolInput, key: string): string {
  const value = optionalString(input, key);
  if (value === undefined) throw new BadRequestError(`${key} is required`);
  return value;
}

function optionalBoolean(input: InboxToolInput, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestError(`${key} must be a boolean`);
  return value;
}

function stringList(input: InboxToolInput, key: string): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new BadRequestError(`${key} must be a list of names`);
  }
  return value as string[];
}

/** The page size, defaulting to the one the catalog advertises. */
function pageSize(input: InboxToolInput, maximum = INBOX_MAX_PAGE_SIZE): number {
  const value = input.limit;
  if (value === undefined || value === null) return Math.min(INBOX_DEFAULT_PAGE_SIZE, maximum);
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new BadRequestError('limit must be an integer');
  return Math.min(Math.max(value, 1), maximum);
}

function isoInstant(
  input: InboxToolInput,
  key: string,
  { future }: { future: boolean },
): string | undefined {
  const value = optionalString(input, key);
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new BadRequestError(`${key} must be an ISO 8601 date or date-time`);
  if (future && time <= Date.now()) throw new BadRequestError(`${key} must be in the future`);
  return value;
}

function recipientList(input: InboxToolInput, key: string): RecipientInput[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequestError(`${key} must be a list of recipients`);
  return value.map((entry: unknown) => {
    const record = entry as Record<string, unknown> | null;
    if (!record || typeof record.address !== 'string') {
      throw new BadRequestError(`${key} entries need an address`);
    }
    return {
      address: record.address,
      ...(typeof record.name === 'string' && record.name.length > 0 ? { name: record.name } : {}),
    };
  });
}

function attachmentList(input: InboxToolInput): AttachmentInput[] | undefined {
  const value = input.attachments;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequestError('attachments must be a list');
  return value.map((entry: unknown) => {
    const record = entry as Record<string, unknown> | null;
    if (!record || typeof record.fileId !== 'string')
      throw new BadRequestError('attachments need a fileId');
    return {
      fileId: record.fileId,
      ...(typeof record.contentId === 'string' ? { contentId: record.contentId } : {}),
      ...(typeof record.isInline === 'boolean' ? { isInline: record.isInline } : {}),
    };
  });
}

// ─── Mailboxes and scope ────────────────────────────────────────────

function specialUseFor(reference: string): string | undefined {
  const name = reference.toLowerCase();
  return Object.prototype.hasOwnProperty.call(INBOX_SPECIAL_MAILBOXES, name)
    ? INBOX_SPECIAL_MAILBOXES[name as keyof typeof INBOX_SPECIAL_MAILBOXES]
    : undefined;
}

/** A mailbox of THIS account, named (`archive`) or by id. */
async function resolveMailboxId(accountId: string, reference: string): Promise<string> {
  const specialUse = specialUseFor(reference);
  if (!specialUse) {
    const mailbox = await emailService.getMailboxById(accountId, reference);
    if (!mailbox) throw new NotFoundError(`Mailbox not found: ${reference}`);
    return mailbox.id;
  }
  let mailbox = await emailService.getMailboxBySpecialUse(accountId, specialUse);
  if (!mailbox) {
    // An account whose default folders were never provisioned (or that
    // predates one of them) gets them now — the same repair listMailboxes runs.
    await emailService.ensureMailboxes(accountId);
    mailbox = await emailService.getMailboxBySpecialUse(accountId, specialUse);
  }
  if (!mailbox) throw new NotFoundError(`The ${reference.toLowerCase()} mailbox does not exist`);
  return mailbox.id;
}

/**
 * The mailbox a listing reads. For a mailbox-scoped caller it is always that
 * mailbox, and naming a different one is refused rather than silently
 * answered from the scoped mailbox — the model should learn it asked for
 * something it cannot see, not read the wrong folder as the right one.
 */
async function readableMailbox(
  context: InboxToolContext,
  requested: string | undefined,
): Promise<string | undefined> {
  const resolved =
    requested === undefined ? undefined : await resolveMailboxId(context.accountId, requested);
  if (context.mailboxId === undefined) return resolved;
  if (resolved !== undefined && resolved !== context.mailboxId) {
    throw new ForbiddenError(
      'This authorization covers a single mailbox; other mailboxes cannot be read',
    );
  }
  return context.mailboxId;
}

/**
 * Prove an addressed email is visible to the caller before reading or changing
 * it. For the whole account every service call is already bound to
 * `accountId`, which answers 404 for anyone else's email. A mailbox-scoped
 * caller gets the same 404 for an email of its own account that lives in
 * another mailbox: existence outside the scope is not disclosed.
 */
async function assertEmailInScope(context: InboxToolContext, emailId: string): Promise<void> {
  if (context.mailboxId === undefined) return;
  if (!(await messageBelongsToMailbox(emailId, context.accountId, context.mailboxId))) {
    throw new NotFoundError('Email not found');
  }
}

async function scopedEmail(context: InboxToolContext, emailId: string): Promise<MessageDto> {
  await assertEmailInScope(context, emailId);
  const email = await emailService.getMessage(context.accountId, emailId);
  if (!email) throw new NotFoundError('Email not found');
  return email;
}

// ─── Result shapes ──────────────────────────────────────────────────

interface Page<T> {
  data: T[];
  total: number;
  limit: number;
  nextCursor?: string | null;
}

/**
 * Every list tool answers `{ data, pagination }`, and always in cursor mode —
 * a model continues with `pagination.nextCursor` and never computes offsets.
 */
function paged<T>(page: Page<T>): InboxToolResult {
  const nextCursor = page.nextCursor ?? null;
  return {
    data: page.data,
    pagination: { total: page.total, limit: page.limit, hasMore: nextCursor !== null, nextCursor },
  };
}

// ─── Replies ────────────────────────────────────────────────────────

export interface ReplyEnvelope {
  to: RecipientInput[];
  cc: RecipientInput[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
}

function asRecipient(address: EmailAddressDto): RecipientInput {
  return address.name
    ? { name: address.name, address: address.address }
    : { address: address.address };
}

function withoutDuplicates(
  list: readonly RecipientInput[],
  exclude: ReadonlySet<string>,
): RecipientInput[] {
  const seen = new Set(exclude);
  return list.filter((recipient) => {
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Who a reply goes to, its subject and its threading headers, from the email
 * being answered — what a mail client fills in when the owner presses Reply.
 *
 * Answering mail the owner SENT continues to the same recipients rather than
 * to themselves. Reply-all adds everyone else on the email; the owner's own
 * address is never a recipient. `References` follows RFC 5322 §3.6.4 (the
 * parent's References, or failing that its In-Reply-To, then its Message-ID);
 * `sendMessageForUser` re-derives the same chain from the stored parent, so a
 * draft and a sent reply thread identically. A Message-ID that is not a valid
 * msg-id (legacy imports) is left out rather than sent broken.
 */
export function replyEnvelope(
  original: MessageDto,
  ownAddress: string,
  replyAll: boolean,
): ReplyEnvelope {
  const own = ownAddress.toLowerCase();
  const sentByOwner = original.from.address.toLowerCase() === own;
  const primary = sentByOwner
    ? original.to.map(asRecipient)
    : [asRecipient(original.replyTo ?? original.from)];
  const to = withoutDuplicates(primary, new Set([own]));
  const others = replyAll
    ? [...(sentByOwner ? [] : original.to), ...original.cc].map(asRecipient)
    : [];
  const cc = withoutDuplicates(
    others,
    new Set([own, ...to.map((recipient) => recipient.address.toLowerCase())]),
  );
  if (to.length === 0 && cc.length === 0) {
    throw new BadRequestError('This email has no recipient to reply to');
  }

  const subject = original.subject.trim();
  const valid = (id: string | null | undefined): id is string =>
    typeof id === 'string' && rfcMessageIdSchema.safeParse(id).success;
  const ancestry =
    original.references.length > 0
      ? original.references
      : original.inReplyTo
        ? [original.inReplyTo]
        : [];
  const references = [...new Set([...ancestry, original.messageId])].filter(valid);
  return {
    // With no primary recipient left (the owner wrote only to themselves and
    // others were cc'd), the cc list is who the reply is for.
    to: to.length > 0 ? to : cc,
    cc: to.length > 0 ? cc : [],
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`,
    ...(valid(original.messageId) ? { inReplyTo: original.messageId } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

async function envelopeFor(
  context: InboxToolContext,
  emailId: string,
  replyAll: boolean,
): Promise<ReplyEnvelope> {
  const original = await scopedEmail(context, emailId);
  const sender = await senderIdentityFor(context.accountId);
  return replyEnvelope(original, sender.address, replyAll);
}

// ─── Tools ──────────────────────────────────────────────────────────

const ORGANIZE_FLAGS = ['seen', 'starred', 'pinned'] as const;

async function moveInto(
  context: InboxToolContext,
  emailId: string,
  mailbox: string,
): Promise<InboxToolResult> {
  await assertEmailInScope(context, emailId);
  const target = await resolveMailboxId(context.accountId, mailbox);
  return { data: await emailService.moveMessage(context.accountId, emailId, target) };
}

const tools: Record<string, InboxTool> = {
  async listEmails(input, context) {
    const starred = optionalBoolean(input, 'starred') === true;
    const label = optionalString(input, 'label');
    let mailboxId = await readableMailbox(context, optionalString(input, 'mailbox'));
    // Opening Inbox with no folder shows the inbox; a star or label filter
    // without a folder is a cross-folder view, as it is in the app.
    if (mailboxId === undefined && !starred && !label) {
      mailboxId = await resolveMailboxId(context.accountId, 'inbox');
    }
    return paged(
      await emailService.listMessages(context.accountId, mailboxId ?? null, {
        limit: pageSize(input),
        // An empty cursor is the service's "first page, in cursor mode".
        cursor: optionalString(input, 'cursor') ?? '',
        unseenOnly: optionalBoolean(input, 'unreadOnly') === true,
        starred,
        ...(label ? { label } : {}),
      }),
    );
  },

  async getUnreadEmails(input, context) {
    const mailboxId = await readableMailbox(context, optionalString(input, 'mailbox'));
    return paged(
      await emailService.listMessages(context.accountId, mailboxId ?? null, {
        limit: pageSize(input),
        cursor: optionalString(input, 'cursor') ?? '',
        unseenOnly: true,
      }),
    );
  },

  async searchEmails(input, context) {
    const mailboxId = await readableMailbox(context, optionalString(input, 'mailbox'));
    const result = await searchMessagesForUser(context.accountId, {
      q: optionalString(input, 'q'),
      from: optionalString(input, 'from'),
      to: optionalString(input, 'to'),
      subject: optionalString(input, 'subject'),
      hasAttachment: optionalBoolean(input, 'hasAttachment'),
      dateAfter: isoInstant(input, 'dateAfter', { future: false }),
      dateBefore: isoInstant(input, 'dateBefore', { future: false }),
      starred: optionalBoolean(input, 'starred'),
      unread: optionalBoolean(input, 'unread'),
      label: optionalString(input, 'label'),
      mailboxId,
      limit: pageSize(input),
      cursor: optionalString(input, 'cursor') ?? '',
    });
    // The search domain function answers the REST route too, whose pagination
    // also carries `offset`; the tool reshapes it to the one list shape.
    const { data, pagination } = result as {
      data: MessageDto[];
      pagination: { total: number; limit: number; nextCursor?: string | null };
    };
    return paged({
      data,
      total: pagination.total,
      limit: pagination.limit,
      nextCursor: pagination.nextCursor,
    });
  },

  async readEmail(input, context) {
    return { data: await scopedEmail(context, requiredString(input, 'emailId')) };
  },

  async getEmailThread(input, context) {
    const emailId = requiredString(input, 'emailId');
    await assertEmailInScope(context, emailId);
    const thread = await emailService.getThread(context.accountId, emailId);
    return {
      data:
        context.mailboxId === undefined
          ? thread
          : thread.filter((email) => email.mailboxId === context.mailboxId),
    };
  },

  async listMailboxes(_input, context) {
    await emailService.ensureMailboxes(context.accountId);
    return { data: await emailService.listMailboxes(context.accountId) };
  },

  async listLabels(_input, context) {
    return { data: await emailService.listLabels(context.accountId) };
  },

  async suggestContacts(input, context) {
    return { data: await suggestContactsForUser(context.accountId, requiredString(input, 'q')) };
  },

  async getEmailQuota(_input, context) {
    return { data: await emailService.getQuotaUsage(context.accountId) };
  },

  async listOutboundEmails(input, context) {
    return { data: await listEmailOutbox(context.accountId, pageSize(input)) };
  },

  async getEmailContext(input, context) {
    return {
      data: await buildEmailAgentContext(context.accountId, {
        mailboxId: context.mailboxId ?? null,
        limit: pageSize(input, 50),
      }),
    };
  },

  async sendEmail(input, context) {
    const to = recipientList(input, 'to');
    if (!to || to.length === 0) throw new BadRequestError('to needs at least one recipient');
    const command: SendEmailCommand = {
      to,
      cc: recipientList(input, 'cc'),
      bcc: recipientList(input, 'bcc'),
      subject: optionalString(input, 'subject'),
      text: optionalString(input, 'text'),
      html: optionalString(input, 'html'),
      inReplyTo: optionalString(input, 'inReplyTo'),
      references: input.references === undefined ? undefined : stringList(input, 'references'),
      attachments: attachmentList(input),
      scheduledAt: isoInstant(input, 'scheduledAt', { future: true }),
      requestReadReceipt: optionalBoolean(input, 'requestReadReceipt'),
    };
    const sent = await sendMessageForUser(context.accountId, command, context.idempotencyKey);
    return { data: sent.data };
  },

  async replyToEmail(input, context) {
    const text = optionalString(input, 'text');
    const html = optionalString(input, 'html');
    if (text === undefined && html === undefined)
      throw new BadRequestError('A reply needs text or html');
    const envelope = await envelopeFor(
      context,
      requiredString(input, 'emailId'),
      optionalBoolean(input, 'replyAll') === true,
    );
    const extraCc = recipientList(input, 'cc') ?? [];
    const sent = await sendMessageForUser(
      context.accountId,
      {
        to: envelope.to,
        cc: withoutDuplicates(
          [...envelope.cc, ...extraCc],
          new Set(envelope.to.map((r) => r.address.toLowerCase())),
        ),
        bcc: recipientList(input, 'bcc'),
        subject: envelope.subject,
        text,
        html,
        inReplyTo: envelope.inReplyTo,
        references: envelope.references,
        attachments: attachmentList(input),
        scheduledAt: isoInstant(input, 'scheduledAt', { future: true }),
      },
      context.idempotencyKey,
    );
    return { data: sent.data };
  },

  async createDraft(input, context) {
    const replyTo = optionalString(input, 'replyToEmailId');
    const envelope =
      replyTo === undefined
        ? undefined
        : await envelopeFor(context, replyTo, optionalBoolean(input, 'replyAll') === true);
    const command: SaveDraftCommand = {
      to: recipientList(input, 'to') ?? envelope?.to,
      cc: recipientList(input, 'cc') ?? envelope?.cc,
      bcc: recipientList(input, 'bcc'),
      subject: optionalString(input, 'subject') ?? envelope?.subject,
      text: optionalString(input, 'text'),
      html: optionalString(input, 'html'),
      inReplyTo: envelope?.inReplyTo,
      references: envelope?.references,
      attachments: attachmentList(input),
    };
    if (!command.to?.length && !command.subject && !command.text && !command.html) {
      throw new BadRequestError('A draft needs recipients, a subject or a body');
    }
    return { data: await saveDraftForUser(context.accountId, command) };
  },

  async cancelOutboundEmail(input, context) {
    return { data: await cancelEmailOutbox(context.accountId, requiredString(input, 'outboxId')) };
  },

  async archiveEmail(input, context) {
    return moveInto(context, requiredString(input, 'emailId'), 'archive');
  },

  async trashEmail(input, context) {
    return moveInto(context, requiredString(input, 'emailId'), 'trash');
  },

  async moveEmail(input, context) {
    return moveInto(context, requiredString(input, 'emailId'), requiredString(input, 'mailbox'));
  },

  async updateEmailFlags(input, context) {
    const emailId = requiredString(input, 'emailId');
    const raw = input.flags;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BadRequestError('flags object is required');
    const flags: Partial<Record<(typeof ORGANIZE_FLAGS)[number], boolean>> = {};
    for (const flag of ORGANIZE_FLAGS) {
      const value = (raw as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') flags[flag] = value;
    }
    if (Object.keys(flags).length === 0) {
      throw new BadRequestError(`flags must set at least one of ${ORGANIZE_FLAGS.join(', ')}`);
    }
    await assertEmailInScope(context, emailId);
    return { data: await emailService.updateMessageFlags(context.accountId, emailId, flags) };
  },

  async setEmailLabels(input, context) {
    const emailId = requiredString(input, 'emailId');
    const add = stringList(input, 'add');
    const remove = stringList(input, 'remove');
    if (add.length === 0 && remove.length === 0)
      throw new BadRequestError('Give labels to add or remove');
    await assertEmailInScope(context, emailId);
    return {
      data: await emailService.updateMessageLabels(context.accountId, emailId, add, remove),
    };
  },

  async snoozeEmail(input, context) {
    const emailId = requiredString(input, 'emailId');
    const until = isoInstant(input, 'until', { future: true });
    if (until === undefined) throw new BadRequestError('until is required');
    await assertEmailInScope(context, emailId);
    return { data: await emailService.snoozeMessage(context.accountId, emailId, new Date(until)) };
  },
};

// A census, not a convention: every catalog tool has exactly one
// implementation and nothing else is registered, checked when the module loads.
const catalogToolNames = INBOX_CAPABILITY_CATALOG.tools.map(({ name }) => name);
const missingTools = catalogToolNames.filter(
  (name) => !Object.prototype.hasOwnProperty.call(tools, name),
);
const extraTools = Object.keys(tools).filter((name) => !catalogToolNames.includes(name));
if (missingTools.length > 0 || extraTools.length > 0) {
  throw new Error(
    `Inbox tool mismatch: missing=${missingTools.join(',')} extra=${extraTools.join(',')}`,
  );
}

export const INBOX_TOOLS: Readonly<Record<string, InboxTool>> = Object.freeze(tools);
