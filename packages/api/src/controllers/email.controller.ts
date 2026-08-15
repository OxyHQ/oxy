/**
 * Email Controller
 *
 * Request handlers for all /email routes.
 * Delegates to emailService for business logic and smtpOutbound for sending.
 */

import type { Request, Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { emailService } from '../services/email.service';
import { smtpOutbound } from '../services/smtp.outbound';
import { assetService } from '../services/assetServiceSingleton';
import { resolveEmailAddress } from '../config/email.config';
import { getDb } from '../config/postgres';
import { messageRecipients } from '../db/schema/messageRecipients';
import { messages } from '../db/schema/messages';
import { users } from '../db/schema/users';
import type { MessageAttachment } from '../db/schema/messageAttachments';
import type { FileRecord } from '../types/file.types';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/error';
import { logger } from '../utils/logger';
import { resolveEmailFromName } from '../utils/displayName';
import type { RecipientInput, AttachmentInput } from '../schemas/email.schemas';

/**
 * Read an optional query-string param that MUST be a single string.
 * Express parses repeated keys / bracketed keys into arrays or objects, which
 * would otherwise let a caller smuggle a NoSQL operator object into a query.
 */
function getOptionalQueryString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new BadRequestError(`${name} must be a single string value`);
}

function parseSeenSearchOperator(query: string): { query: string; seen?: boolean } {
  let seen: boolean | undefined;
  const text = query
    .replace(/\bis:(read|unread)\b/gi, (_operator, value: string) => {
      const nextSeen = value.toLowerCase() === 'read';
      if (seen !== undefined && seen !== nextSeen) {
        throw new BadRequestError('Search cannot combine is:read and is:unread');
      }
      seen = nextSeen;
      return '';
    })
    .replace(/\s+/g, ' ')
    .trim();

  return { query: text, seen };
}

/**
 * Resolve user-supplied { fileId, contentId?, isInline? } references into the
 * canonical MessageAttachment shape persisted on Message. Each fileId MUST:
 *   - exist
 *   - be in status 'active' (not trash/deleted)
 *   - be owned by the requesting user
 *
 * The MessageAttachment is built from the FileRecord so the Message subdocument carries
 * a stable snapshot of name/contentType/size at send time, regardless of any
 * later changes to the underlying file's originalName.
 */
async function resolveAttachmentInputs(
  inputs: AttachmentInput[],
  userId: string
): Promise<{ resolved: MessageAttachment[]; files: FileRecord[] }> {
  const fileIds = inputs.map((a) => a.fileId);
  const files = await assetService.getFilesByIds(fileIds);
  const byId = new Map<string, FileRecord>();
  for (const f of files) {
    if (f.status === 'active') {
      byId.set(f.id, f);
    }
  }

  const resolved: MessageAttachment[] = [];
  const usedFiles: FileRecord[] = [];

  for (const input of inputs) {
    const file = byId.get(input.fileId);
    if (!file) {
      throw new BadRequestError(`Attachment file not found or not active: ${input.fileId}`);
    }
    // Strict ownership: only the file's owner may attach it to an outgoing
    // email. The broader `canUserAccessFile` (which also grants access via
    // shares / public visibility) is intentionally NOT used here — attaching a
    // merely-readable file would leak it into a Message subdocument the sender
    // does not own.
    // `owner_user_id` is nullable: a system-owned file (federation cache,
    // link-preview cache) has no owner, and `null !== userId` correctly
    // refuses it rather than letting a sender attach platform-internal media.
    if (file.ownerUserId !== userId) {
      throw new ForbiddenError(`Not authorized to attach file ${file.id}`);
    }
    resolved.push({
      fileId: file.id,
      name: file.originalName || file.id,
      contentType: file.mime,
      size: file.size,
      ...(input.contentId ? { contentId: input.contentId } : {}),
      isInline: input.isInline ?? false,
    });
    usedFiles.push(file);
  }

  return { resolved, files: usedFiles };
}

/**
 * Best-effort link of each File to the freshly-stored Message under the
 * oxy-mail app namespace. Failure is logged but never propagated — the email
 * has already been sent / scheduled; failing to record the link must not
 * surface as a send failure to the client.
 */
async function linkAttachmentsToMessage(
  files: FileRecord[],
  messageId: string,
  userId: string
): Promise<void> {
  for (const file of files) {
    try {
      await assetService.linkFile(file.id, {
        app: 'oxy-mail',
        entityType: 'message',
        entityId: messageId,
        createdBy: userId,
      });
    } catch (err) {
      logger.warn('Failed to link attachment file to email message', {
        fileId: file.id,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}


/**
 * Find one of this user's own messages by its RFC 5322 `Message-ID`.
 *
 * `messages.message_id` is a HEADER value, not a row id, and it is not unique —
 * two accounts can hold copies of the same message — so the lookup is always
 * scoped to the owner. Served by `messages_user_id_message_id_idx`.
 */
async function findOwnMessageByRfcId(
  userId: string,
  rfcMessageId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.messageId, rfcMessageId)))
    .limit(1);
  return row;
}

interface AuthRequest extends Request {
  user?: { id: string };
}

// ─── Mailboxes ────────────────────────────────────────────────────

export async function listMailboxes(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  await emailService.ensureMailboxes(userId);
  const mailboxes = await emailService.listMailboxes(userId);
  res.json({ data: mailboxes });
}

export async function createMailbox(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { name, parentPath } = req.body;

  if (!name || typeof name !== 'string') {
    throw new BadRequestError('Mailbox name is required');
  }

  const mailbox = await emailService.createMailbox(userId, name.trim(), parentPath);
  res.status(201).json({ data: mailbox });
}

export async function deleteMailbox(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { mailboxId } = req.params;

  await emailService.deleteMailbox(userId, mailboxId);
  res.json({ data: { message: 'Mailbox deleted' } });
}

// ─── Messages ─────────────────────────────────────────────────────

export async function listMessages(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const mailboxId = req.query.mailbox as string | undefined;
  const starred = req.query.starred === 'true';
  const label = req.query.label as string | undefined;
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 50, 100);
  const offset = Number.parseInt(req.query.offset as string) || 0;
  const unseenOnly = req.query.unseen === 'true';

  // Must have at least one filter: mailbox, starred, or label
  if (!mailboxId && !starred && !label) {
    throw new BadRequestError('mailbox, starred, or label query parameter is required');
  }

  // Verify the mailbox belongs to this user (if provided)
  if (mailboxId) {
    const mailbox = await emailService.getMailboxById(userId, mailboxId);
    if (!mailbox) throw new NotFoundError('Mailbox not found');
  }

  const result = await emailService.listMessages(userId, mailboxId || null, {
    limit, offset, unseenOnly, starred, label,
  });
  res.json({
    data: result.data,
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.offset + result.limit < result.total,
    },
  });
}

export async function getMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;

  const message = await emailService.getMessage(userId, messageId);
  if (!message) throw new NotFoundError('Message not found');

  // GET is read-only: marking a message as seen is an explicit client action
  // performed via PUT /messages/:id/flags. No side effects here.
  res.json({ data: message });
}

export async function getThread(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;

  const thread = await emailService.getThread(userId, messageId);
  res.json({ data: thread });
}

export async function updateMessageFlags(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;
  const { flags } = req.body;

  if (!flags || typeof flags !== 'object') {
    throw new BadRequestError('flags object is required');
  }

  const allowed = ['seen', 'starred', 'answered', 'forwarded', 'draft', 'pinned'];
  const filtered: Record<string, boolean> = {};
  for (const key of allowed) {
    if (key in flags && typeof flags[key] === 'boolean') {
      filtered[key] = flags[key];
    }
  }

  const message = await emailService.updateMessageFlags(userId, messageId, filtered);
  res.json({ data: message });
}

export async function updateMessageLabels(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;
  const { add = [], remove = [] } = req.body;

  if (!Array.isArray(add) || !Array.isArray(remove)) {
    throw new BadRequestError('add and remove must be arrays');
  }

  const message = await emailService.updateMessageLabels(userId, messageId, add, remove);
  res.json({ data: message });
}

export async function moveMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;
  const { mailboxId } = req.body;

  if (!mailboxId) {
    throw new BadRequestError('mailboxId is required');
  }

  const message = await emailService.moveMessage(userId, messageId, mailboxId);
  res.json({ data: message });
}

export async function deleteMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;
  const permanent = req.query.permanent === 'true';

  await emailService.deleteMessage(userId, messageId, permanent);
  res.json({ data: { message: 'Message deleted' } });
}

// ─── Bulk Operations ─────────────────────────────────────────────

export async function bulkUpdateFlags(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageIds, flags } = req.body;

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new BadRequestError('messageIds array is required');
  }
  if (messageIds.length > 100) {
    throw new BadRequestError('Maximum 100 messages per bulk operation');
  }
  if (!flags || typeof flags !== 'object') {
    throw new BadRequestError('flags object is required');
  }

  const allowed = ['seen', 'starred', 'answered', 'forwarded', 'draft', 'pinned'];
  const filtered: Record<string, boolean> = {};
  for (const key of allowed) {
    if (key in flags && typeof flags[key] === 'boolean') {
      filtered[key] = flags[key];
    }
  }

  const result = await emailService.bulkUpdateMessageFlags(userId, messageIds, filtered);

  res.json({ data: { matched: result.matchedCount, modified: result.modifiedCount } });
}

export async function bulkMoveMessages(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageIds, mailboxId } = req.body;

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new BadRequestError('messageIds array is required');
  }
  if (messageIds.length > 100) {
    throw new BadRequestError('Maximum 100 messages per bulk operation');
  }
  if (!mailboxId) {
    throw new BadRequestError('mailboxId is required');
  }

  const result = await emailService.bulkMoveMessages(userId, messageIds, mailboxId);

  res.json({ data: { matched: result.matchedCount, modified: result.modifiedCount } });
}

// ─── Snooze ──────────────────────────────────────────────────────

export async function snoozeMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;
  const { until } = req.body;

  if (!until || typeof until !== 'string') {
    throw new BadRequestError('until (ISO date string) is required');
  }

  const untilDate = new Date(until);
  if (isNaN(untilDate.getTime()) || untilDate.getTime() <= Date.now()) {
    throw new BadRequestError('until must be a valid future date');
  }

  const message = await emailService.snoozeMessage(userId, messageId, untilDate);
  res.json({ data: message });
}

export async function unsnoozeMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;

  const message = await emailService.unsnoozeMessage(userId, messageId);
  res.json({ data: message });
}

// ─── Labels ──────────────────────────────────────────────────────

export async function listLabels(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const labels = await emailService.listLabels(userId);
  res.json({ data: labels });
}

export async function createLabel(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { name, color } = req.body;

  if (!name || typeof name !== 'string') {
    throw new BadRequestError('Label name is required');
  }

  const label = await emailService.createLabel(userId, name.trim(), color || '#4285f4');
  res.status(201).json({ data: label });
}

export async function updateLabel(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { labelId } = req.params;
  const { name, color } = req.body;

  const updates: { name?: string; color?: string } = {};
  if (name) updates.name = name.trim();
  if (color) updates.color = color;

  const label = await emailService.updateLabel(userId, labelId, updates);
  res.json({ data: label });
}

export async function deleteLabel(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { labelId } = req.params;

  await emailService.deleteLabel(userId, labelId);
  res.json({ data: { message: 'Label deleted' } });
}

// ─── Compose & Send ─────────────────────────────────────────────

export async function sendMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const {
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    inReplyTo,
    references,
    attachments,
    scheduledAt,
    requestReadReceipt,
  } = req.body as {
    to: RecipientInput[];
    cc?: RecipientInput[];
    bcc?: RecipientInput[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: AttachmentInput[];
    scheduledAt?: string;
    requestReadReceipt?: boolean;
  };

  // Schema validation already guarantees to.length >= 1 and recipient shape.

  await emailService.enforceSendLimit(userId);

  const [user] = await getDb()
    .select({ username: users.username, first: users.nameFirst, last: users.nameLast })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.username) {
    throw new BadRequestError('User must have a username to send email');
  }

  const fromAddress = resolveEmailAddress(user.username);
  const fromName = resolveEmailFromName({
    name: { first: user.first, last: user.last },
    username: user.username,
  });

  const allRecipients = [...to, ...(cc ?? []), ...(bcc ?? [])];

  // Resolve { fileId } references → canonical MessageAttachment[] for storage and
  // outbound transport. Throws 400/403 on missing / non-active / unauthorized
  // fileIds before any side effects.
  const { resolved: resolvedAttachments, files: attachedFiles } = attachments && attachments.length > 0
    ? await resolveAttachmentInputs(attachments, userId)
    : { resolved: [] as MessageAttachment[], files: [] as FileRecord[] };

  if (scheduledAt) {
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      throw new BadRequestError('scheduledAt must be a valid future date');
    }

    const scheduled = await emailService.scheduleMessage(userId, {
      from: { name: fromName, address: fromAddress },
      to,
      cc,
      bcc,
      subject: subject ?? '',
      text,
      html,
      inReplyTo,
      references,
      attachments: resolvedAttachments,
      scheduledAt: scheduledDate,
    });

    if (attachedFiles.length > 0) {
      await linkAttachmentsToMessage(attachedFiles, scheduled.id, userId);
    }

    if (inReplyTo) {
      const original = await findOwnMessageByRfcId(userId, inReplyTo);
      if (original) {
        await emailService.updateMessageFlags(userId, original.id, { answered: true });
      }
    }

    emailService.autoCollectContacts(userId, allRecipients).catch((err) => {
      logger.warn('autoCollectContacts failed', { userId, error: err instanceof Error ? err.message : String(err) });
    });

    res.status(202).json({
      data: {
        messageId: scheduled.messageId,
        scheduledAt: scheduledDate.toISOString(),
        message: 'Message scheduled for delivery',
      },
    });
    return;
  }

  const result = await smtpOutbound.send({
    userId,
    from: { name: fromName, address: fromAddress },
    to,
    cc,
    bcc,
    subject: subject ?? '',
    text,
    html,
    inReplyTo,
    references,
    attachments: resolvedAttachments,
    requestReadReceipt,
  });

  if (attachedFiles.length > 0) {
    await linkAttachmentsToMessage(attachedFiles, result.messageId, userId);
  }

  if (inReplyTo) {
    const original = await findOwnMessageByRfcId(userId, inReplyTo);
    if (original) {
      await emailService.updateMessageFlags(userId, original.id, { answered: true });
    }
  }

  emailService.autoCollectContacts(userId, allRecipients).catch((err) => {
    logger.warn('autoCollectContacts failed', { userId, error: err instanceof Error ? err.message : String(err) });
  });

  res.status(202).json({
    data: {
      messageId: result.messageId,
      queued: result.queued,
      message: result.queued ? 'Message queued for delivery' : 'Message sent',
    },
  });
}

export async function saveDraft(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { to, cc, bcc, subject, text, html, inReplyTo, references, existingDraftId } = req.body;

  const draft = await emailService.saveDraft(userId, {
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    inReplyTo,
    references,
    existingDraftId,
  });

  res.status(201).json({ data: draft });
}

// ─── Search ─────────────────────────────────────────────────────

export async function searchMessages(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const rawQuery = getOptionalQueryString(req.query.q, 'q');
  const { query: q, seen } = parseSeenSearchOperator(rawQuery || '');
  const mailboxId = getOptionalQueryString(req.query.mailbox, 'mailbox');
  const from = getOptionalQueryString(req.query.from, 'from');
  const to = getOptionalQueryString(req.query.to, 'to');
  const subject = getOptionalQueryString(req.query.subject, 'subject');
  const hasAttachment = req.query.hasAttachment === 'true';
  const dateAfter = getOptionalQueryString(req.query.dateAfter, 'dateAfter');
  const dateBefore = getOptionalQueryString(req.query.dateBefore, 'dateBefore');
  const starred = req.query.starred === 'true';
  const label = getOptionalQueryString(req.query.label, 'label');
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 50, 100);
  const offset = Number.parseInt(req.query.offset as string) || 0;

  // At least one search criterion required
  if (
    !q &&
    seen === undefined &&
    !mailboxId &&
    !from &&
    !to &&
    !subject &&
    !hasAttachment &&
    !dateAfter &&
    !dateBefore &&
    !starred &&
    !label
  ) {
    throw new BadRequestError('At least one search parameter is required');
  }

  const result = await emailService.searchMessages(userId, q, {
    limit, offset, mailboxId, from, to, subject,
    hasAttachment: hasAttachment || undefined,
    dateAfter, dateBefore,
    starred: starred || undefined,
    label,
    seen,
  });
  res.json({
    data: result.data,
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.offset + result.limit < result.total,
    },
  });
}

// ─── Quota ──────────────────────────────────────────────────────

export async function getQuota(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const quota = await emailService.getQuotaUsage(userId);
  res.json({ data: quota });
}

// ─── Settings ───────────────────────────────────────────────────

export async function getEmailSettings(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const settings = await emailService.getEmailSettings(userId);
  res.json({ data: settings });
}

export async function updateEmailSettings(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { signature, autoReply, autoForwardTo, autoForwardKeepCopy } = req.body;

  await emailService.updateEmailSettings(userId, { signature, autoReply, autoForwardTo, autoForwardKeepCopy });
  res.json({ data: { message: 'Settings updated' } });
}

// ─── Subscriptions ──────────────────────────────────────────────

export async function listSubscriptions(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 50, 100);
  const offset = Number.parseInt(req.query.offset as string) || 0;

  const result = await emailService.getSubscriptions(userId, { limit, offset });
  res.json({
    data: result.data,
    pagination: {
      total: result.total,
      limit,
      offset,
      hasMore: offset + limit < result.total,
    },
  });
}

export async function unsubscribe(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { senderAddress, method } = req.body;

  if (!senderAddress || typeof senderAddress !== 'string') {
    throw new BadRequestError('senderAddress is required');
  }

  const allowedMethods = ['list-unsubscribe', 'block'];
  if (method && !allowedMethods.includes(method)) {
    throw new BadRequestError('method must be "list-unsubscribe" or "block"');
  }

  const result = await emailService.unsubscribe(userId, senderAddress, method || 'list-unsubscribe');
  res.json({ data: result });
}

// ─── Bundles ──────────────────────────────────────────────────────

export async function listBundles(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const bundles = await emailService.listBundles(userId);
  res.json({ data: bundles });
}

export async function updateBundle(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { bundleId } = req.params;
  const { enabled, collapsed, matchLabels, order } = req.body;

  const updates: Record<string, boolean | string[] | number> = {};
  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof collapsed === 'boolean') updates.collapsed = collapsed;
  if (Array.isArray(matchLabels)) updates.matchLabels = matchLabels;
  if (typeof order === 'number') updates.order = order;

  const bundle = await emailService.updateBundle(userId, bundleId, updates);
  res.json({ data: bundle });
}

export async function listBundledMessages(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const mailboxId = req.query.mailbox as string | undefined;
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 50, 100);
  const offset = Number.parseInt(req.query.offset as string) || 0;

  const result = await emailService.listBundledMessages(userId, mailboxId || null, { limit, offset });
  res.json({
    data: {
      primary: result.primary,
      bundles: result.bundles,
    },
    pagination: {
      total: result.total,
      limit,
      offset,
      hasMore: offset + limit < result.total,
    },
  });
}

// ─── Reminders ──────────────────────────────────────────────────

export async function createReminder(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { text, remindAt, relatedMessageId } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new BadRequestError('Reminder text is required');
  }
  if (!remindAt) {
    throw new BadRequestError('remindAt is required');
  }
  const remindDate = new Date(remindAt);
  if (isNaN(remindDate.getTime()) || remindDate <= new Date()) {
    throw new BadRequestError('remindAt must be a valid future date');
  }

  const reminder = await emailService.createReminder(userId, {
    text: text.trim(),
    remindAt,
    relatedMessageId,
  });
  res.status(201).json({ data: reminder });
}

export async function listReminders(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const includeCompleted = req.query.completed === 'true';
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 50, 100);
  const offset = Number.parseInt(req.query.offset as string) || 0;

  const result = await emailService.listReminders(userId, { includeCompleted, limit, offset });
  res.json({ data: result.data, pagination: result.pagination });
}

export async function getReminder(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const reminder = await emailService.getReminder(userId, req.params.reminderId);
  res.json({ data: reminder });
}

export async function updateReminder(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { reminderId } = req.params;
  const { text, remindAt, completed, pinned, snoozedUntil } = req.body;

  const updates: Record<string, any> = {};
  if (text !== undefined) updates.text = text;
  if (remindAt !== undefined) updates.remindAt = remindAt;
  if (completed !== undefined) updates.completed = completed;
  if (pinned !== undefined) updates.pinned = pinned;
  if (snoozedUntil !== undefined) updates.snoozedUntil = snoozedUntil;

  const reminder = await emailService.updateReminder(userId, reminderId, updates);
  res.json({ data: reminder });
}

export async function deleteReminder(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  await emailService.deleteReminder(userId, req.params.reminderId);
  res.status(204).send();
}

// ─── Contacts ──────────────────────────────────────────────────────

export async function suggestContacts(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const q = (req.query.q as string || '').trim().toLowerCase();

  if (!q || q.length < 2) {
    res.json({ data: [] });
    return;
  }

  // Search both the address book and message history in parallel.
  //
  // Mongo's `$concatArrays` of `from`, `to` and `cc` followed by `$unwind`
  // existed only because all three lived on one document. `to` and `cc` are a
  // child table now, so the concat IS the union — and the `$regex` becomes
  // `strpos`, which has no metacharacter language, so the escaping the old
  // query needed to neutralize ReDoS has nothing left to escape.
  //
  // `$first` after no `$sort` picked an arbitrary spelling of the name; this
  // picks the most recently used one, which is at least a decision.
  const [contactResults, messageResults] = await Promise.all([
    emailService.searchContacts(userId, q, 10),
    getDb().execute<{ name: string | null; address: string }>(sql`
      with candidates as (
          select lower(m.from_address) as key,
                 m.from_name as name,
                 m.from_address as address,
                 m.date
          from ${messages} m
          where m.user_id = ${userId}
        union all
          select lower(r.address), r.name, r.address, m.date
          from ${messageRecipients} r
          join ${messages} m on m.id = r.message_id
          where m.user_id = ${userId} and r.kind in ('to', 'cc')
      )
      select (array_agg(name order by date desc nulls last))[1] as name,
             (array_agg(address order by date desc nulls last))[1] as address,
             count(*) as occurrences
      from candidates
      where strpos(key, ${q}) > 0
         or strpos(lower(coalesce(name, '')), ${q}) > 0
      group by key
      order by occurrences desc, key asc
      limit 10
    `),
  ]);

  // Merge results: contacts from address book first, then message history
  // Deduplicate by email address (lowercase)
  const seen = new Set<string>();
  const merged: Array<{ name: string | null; address: string }> = [];

  for (const c of contactResults) {
    const key = c.address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }

  for (const m of messageResults) {
    const key = (m.address || '').toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      // Mongoose defaulted an absent display name to `''`, not null.
      merged.push({ name: m.name ?? '', address: m.address });
    }
  }

  res.json({ data: merged.slice(0, 15) });
}

export async function listContacts(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const q = req.query.q as string | undefined;
  const starred = req.query.starred === 'true';
  const limit = Math.min(Number.parseInt(req.query.limit as string) || 50, 100);
  const offset = Number.parseInt(req.query.offset as string) || 0;

  const result = await emailService.listContacts(userId, { q, starred: starred || undefined, limit, offset });
  res.json({
    data: result.data,
    pagination: {
      total: result.total,
      limit,
      offset,
      hasMore: offset + limit < result.total,
    },
  });
}

export async function createContact(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { name, email, company, notes, starred } = req.body;

  if (!name || typeof name !== 'string') {
    throw new BadRequestError('Contact name is required');
  }
  if (!email || typeof email !== 'string') {
    throw new BadRequestError('Contact email is required');
  }

  const contact = await emailService.createContact(userId, {
    name: name.trim(),
    email: email.trim(),
    company,
    notes,
    starred,
  });
  res.status(201).json({ data: contact });
}

export async function updateContact(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { contactId } = req.params;
  const { name, email, company, notes, starred } = req.body;

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (company !== undefined) updates.company = company;
  if (notes !== undefined) updates.notes = notes;
  if (starred !== undefined) updates.starred = starred;

  const contact = await emailService.updateContact(userId, contactId, updates);
  res.json({ data: contact });
}

export async function deleteContact(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { contactId } = req.params;

  await emailService.deleteContact(userId, contactId);
  res.json({ data: { message: 'Contact deleted' } });
}

// ─── Filters ──────────────────────────────────────────────────────

export async function listFilters(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const filters = await emailService.listFilters(userId);
  res.json({ data: filters });
}

export async function createFilter(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { name, enabled, conditions, matchAll, actions, order } = req.body;

  if (!name || typeof name !== 'string') {
    throw new BadRequestError('Filter name is required');
  }
  if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
    throw new BadRequestError('At least one condition is required');
  }
  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    throw new BadRequestError('At least one action is required');
  }

  const filter = await emailService.createFilter(userId, {
    name: name.trim(),
    enabled: enabled ?? true,
    conditions,
    matchAll: matchAll ?? true,
    actions,
    order: order ?? 0,
  });
  res.status(201).json({ data: filter });
}

export async function updateFilter(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { filterId } = req.params;
  const { name, enabled, conditions, matchAll, actions, order } = req.body;

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name.trim();
  if (enabled !== undefined) updates.enabled = enabled;
  if (conditions !== undefined) updates.conditions = conditions;
  if (matchAll !== undefined) updates.matchAll = matchAll;
  if (actions !== undefined) updates.actions = actions;
  if (order !== undefined) updates.order = order;

  const filter = await emailService.updateFilter(userId, filterId, updates);
  res.json({ data: filter });
}

export async function deleteFilter(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { filterId } = req.params;

  await emailService.deleteFilter(userId, filterId);
  res.json({ data: { message: 'Filter deleted' } });
}

// ─── Templates ──────────────────────────────────────────────────

export async function listTemplates(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const templates = await emailService.listTemplates(userId);
  res.json({ data: templates });
}

export async function createTemplate(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { name, subject, body } = req.body;

  if (!name || typeof name !== 'string') {
    throw new BadRequestError('Template name is required');
  }
  if (!body || typeof body !== 'string') {
    throw new BadRequestError('Template body is required');
  }

  const template = await emailService.createTemplate(userId, {
    name: name.trim(),
    subject: subject || '',
    body,
  });
  res.status(201).json({ data: template });
}

export async function updateTemplate(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { templateId } = req.params;
  const { name, subject, body } = req.body;

  const updates: { name?: string; subject?: string; body?: string } = {};
  if (name !== undefined) updates.name = name.trim();
  if (subject !== undefined) updates.subject = subject;
  if (body !== undefined) updates.body = body;

  const template = await emailService.updateTemplate(userId, templateId, updates);
  res.json({ data: template });
}

export async function deleteTemplate(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { templateId } = req.params;

  await emailService.deleteTemplate(userId, templateId);
  res.json({ data: { message: 'Template deleted' } });
}

// ─── Export / Import ────────────────────────────────────────────

export async function exportMessage(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { messageId } = req.params;

  const eml = await emailService.exportMessage(userId, messageId);

  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', 'attachment; filename="message.eml"');
  res.send(eml);
}

export async function importMessages(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  // multer's `.array()` middleware assigns an array here, but `req.files` is
  // typed — and, under `.fields()`/`.any()`, populated — as a field-keyed
  // record. Narrowing on the real runtime shape keeps that arm from being cast
  // away: `.length` on a record is `undefined`, which would slip past the
  // emptiness guard below and then iterate nothing.
  const files: Express.Multer.File[] = Array.isArray(req.files) ? req.files : [];

  if (files.length === 0) {
    throw new BadRequestError('At least one .eml file is required');
  }

  // Validate that all files are .eml
  for (const file of files) {
    if (!file.originalname.toLowerCase().endsWith('.eml')) {
      throw new BadRequestError(`Invalid file type: ${file.originalname}. Only .eml files are accepted.`);
    }
  }

  const imported = await emailService.importMessages(
    userId,
    files.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
  );

  res.json({ data: { imported, total: files.length } });
}
