import type { Request, Response } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  emailAgentContextSchema,
  type EmailAgentContext,
  type EmailContextMessage,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { messages as messagesTable } from '../db/schema/messages';
import { emailService } from '../services/email.service';

function contextMessage(message: {
  id: string;
  mailboxId: string;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  seen: boolean;
  answered: boolean;
}): EmailContextMessage {
  return {
    messageId: message.id,
    mailboxId: message.mailboxId,
    from: { ...(message.fromName ? { name: message.fromName } : {}), address: message.fromAddress },
    subject: message.subject,
    receivedAt: message.receivedAt.toISOString(),
    seen: message.seen,
    answered: message.answered,
  };
}

/**
 * The planning snapshot behind `GET /email/ai-context` and the catalog's
 * `getEmailContext`: the account's mailboxes (or just `mailboxId`) with their
 * counters, the newest unread messages, and those among them nobody has
 * answered yet. The capability tool passes the ticket's mailbox; the REST route
 * passes the `mailbox` query parameter of the signed-in owner.
 */
export async function buildEmailAgentContext(
  accountId: string,
  options: { mailboxId?: string | null; limit?: number } = {},
): Promise<EmailAgentContext> {
  const resourceMailboxId = options.mailboxId ?? null;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const accountMailboxes = await emailService.listMailboxes(accountId);
  const selectedMailboxes = resourceMailboxId
    ? accountMailboxes.filter((mailbox) => mailbox.id === resourceMailboxId)
    : accountMailboxes;
  const mailboxIds = selectedMailboxes.map((mailbox) => mailbox.id);
  const unreadMessages = mailboxIds.length === 0 ? [] : await getDb()
    .select({
      id: messagesTable.id,
      mailboxId: messagesTable.mailboxId,
      fromName: messagesTable.fromName,
      fromAddress: messagesTable.fromAddress,
      subject: messagesTable.subject,
      receivedAt: messagesTable.receivedAt,
      seen: messagesTable.seen,
      answered: messagesTable.answered,
      draft: messagesTable.draft,
    })
    .from(messagesTable)
    .where(and(
      eq(messagesTable.userId, accountId),
      inArray(messagesTable.mailboxId, mailboxIds),
      eq(messagesTable.seen, false),
    ))
    .orderBy(desc(messagesTable.receivedAt))
    .limit(limit);
  const recentUnread = unreadMessages.map(contextMessage);
  return emailAgentContextSchema.parse({
    accountId,
    resourceMailboxId,
    generatedAt: new Date().toISOString(),
    mailboxes: selectedMailboxes.map((mailbox) => ({
      mailboxId: mailbox.id,
      name: mailbox.name,
      path: mailbox.path,
      totalMessages: mailbox.totalMessages,
      unseenMessages: mailbox.unseenMessages,
    })),
    recentUnread,
    needsResponse: unreadMessages.filter((message) => !message.answered && !message.draft).map(contextMessage),
  });
}

export async function getEmailAgentContext(
  request: Request & { user?: { id: string } },
  response: Response,
): Promise<void> {
  const context = await buildEmailAgentContext(request.user!.id, {
    mailboxId: typeof request.query.mailbox === 'string' ? request.query.mailbox : null,
    limit: Number.parseInt(String(request.query.limit ?? '20'), 10) || 20,
  });
  response.json({ data: context });
}
