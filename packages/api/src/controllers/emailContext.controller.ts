import type { Response } from 'express';
import {
  emailAgentContextSchema,
  type CapabilityTicketClaims,
  type EmailContextMessage,
} from '@oxyhq/contracts';
import Mailbox from '../models/Mailbox';
import Message from '../models/Message';
import type { EmailCapabilityRequest } from '../middleware/emailCapabilityAuth';

function contextMessage(message: {
  _id: unknown;
  mailboxId: unknown;
  from: { name?: string; address: string };
  subject: string;
  receivedAt: Date;
  flags: { seen: boolean; answered: boolean };
}): EmailContextMessage {
  return {
    messageId: String(message._id),
    mailboxId: String(message.mailboxId),
    from: { ...(message.from.name ? { name: message.from.name } : {}), address: message.from.address },
    subject: message.subject,
    receivedAt: message.receivedAt.toISOString(),
    seen: message.flags.seen,
    answered: message.flags.answered,
  };
}

export async function getEmailAgentContext(request: EmailCapabilityRequest, response: Response): Promise<void> {
  const accountId = request.user!.id;
  const ticket: CapabilityTicketClaims | undefined = request.capabilityTicket;
  const resourceMailboxId = ticket?.resource.resourceType === 'mailbox'
    ? ticket.resource.resourceId
    : typeof request.query.mailbox === 'string' ? request.query.mailbox : null;
  const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? '20'), 10) || 20, 1), 50);
  const mailboxQuery: Record<string, unknown> = { userId: accountId };
  if (resourceMailboxId) mailboxQuery._id = resourceMailboxId;
  const mailboxes = await Mailbox.find(mailboxQuery).sort({ path: 1 }).lean();
  const mailboxIds = mailboxes.map((mailbox) => mailbox._id);
  const messages = mailboxIds.length === 0 ? [] : await Message.find({
    userId: accountId,
    mailboxId: { $in: mailboxIds },
    'flags.seen': false,
  }).select('mailboxId from subject receivedAt flags.seen flags.answered flags.draft').sort({ receivedAt: -1 }).limit(limit).lean();
  const recentUnread = messages.map(contextMessage);
  const context = emailAgentContextSchema.parse({
    accountId,
    resourceMailboxId,
    generatedAt: new Date().toISOString(),
    mailboxes: mailboxes.map((mailbox) => ({
      mailboxId: mailbox._id.toString(),
      name: mailbox.name,
      path: mailbox.path,
      totalMessages: mailbox.totalMessages,
      unseenMessages: mailbox.unseenMessages,
    })),
    recentUnread,
    needsResponse: messages.filter((message) => !message.flags.answered && !message.flags.draft).map(contextMessage),
  });
  response.json({ data: context });
}
