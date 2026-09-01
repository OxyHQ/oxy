import type { Response } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  emailAgentContextSchema,
  type CapabilityTicketClaims,
  type EmailContextMessage,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { messages as messagesTable } from '../db/schema/messages';
import type { EmailCapabilityRequest } from '../middleware/emailCapabilityAuth';
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

export async function getEmailAgentContext(request: EmailCapabilityRequest, response: Response): Promise<void> {
  const accountId = request.user!.id;
  const ticket: CapabilityTicketClaims | undefined = request.capabilityTicket;
  const resourceMailboxId = ticket?.resource.resourceType === 'mailbox'
    ? ticket.resource.resourceId
    : typeof request.query.mailbox === 'string' ? request.query.mailbox : null;
  const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? '20'), 10) || 20, 1), 50);
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
  const context = emailAgentContextSchema.parse({
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
  response.json({ data: context });
}
