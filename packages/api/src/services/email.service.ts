/**
 * Email Service
 *
 * Core business logic for the Oxy email system. Handles mailbox provisioning,
 * message CRUD, quota enforcement, search, and user lifecycle.
 *
 * Email addresses are always derived: {username}@oxy.so — never stored independently.
 */

import mongoose, { type SortOrder } from 'mongoose';
import { safeFetch, SsrfRejection } from '@oxyhq/core/server';
import { Mailbox, type IMailbox } from '../models/Mailbox';
import { Message, type IMessage, type IEmailAddress, type IAttachment } from '../models/Message';
import { Label } from '../models/Label';
import { SYSTEM_LABELS, isSystemLabel, isSystemLabelId } from '../constants/systemLabels';
import { Bundle } from '../models/Bundle';
import User, { type IUser } from '../models/User';
import { getAvatarPathsBatch } from './senderAvatar.service';
import {
  DEFAULT_MAILBOXES,
  EMAIL_QUOTAS,
  EMAIL_DOMAIN,
  resolveEmailAddress,
  extractUsername,
  extractAliasTag,
  type SubscriptionTier,
} from '../config/email.config';
import { logger } from '../utils/logger';
import { publishInboxMessageEvents } from '../capabilities/inbox.events';
import { NotFoundError, BadRequestError } from '../utils/error';
import userCache from '../utils/userCache';
import { v4 as uuidv4 } from 'uuid';
import { Reminder } from '../models/Reminder';
import { Contact } from '../models/Contact';
import { EmailTemplate } from '../models/EmailTemplate';
import { EmailFilter } from '../models/EmailFilter';
import { aiLabelingService } from './aiLabeling.service';
import { cardExtractionService } from './cardExtraction.service';
import { smtpOutbound } from './smtp.outbound';
import { pushService } from './push.service';
import { assetService } from './assetServiceSingleton';
import { simpleParser } from 'mailparser';

const MAX_STRUCTURED_SEARCH_FILTER_LENGTH = 128;
const EMAIL_SEARCH_MAX_TIME_MS = 5_000;

/** Escape a user-supplied string so it is treated as a literal in a MongoDB $regex. */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a structured search filter (from/to/subject):
 *   - rejects overlong inputs before they ever reach MongoDB
 *   - escapes regex metacharacters to neutralize ReDoS
 */
export function normalizeStructuredSearchFilter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > MAX_STRUCTURED_SEARCH_FILTER_LENGTH) {
    throw new BadRequestError(
      `Search filters must be ${MAX_STRUCTURED_SEARCH_FILTER_LENGTH} characters or fewer`,
    );
  }
  return escapeRegexLiteral(value);
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
  async provisionMailboxes(userId: string): Promise<IMailbox[]> {
    const existing = await Mailbox.findOne({ userId });
    if (existing) {
      return this.listMailboxes(userId);
    }

    const docs = DEFAULT_MAILBOXES.map((mb) => ({
      userId: new mongoose.Types.ObjectId(userId),
      name: mb.name,
      path: mb.path,
      specialUse: mb.specialUse,
      retentionDays: 'retentionDays' in mb ? mb.retentionDays : null,
    }));

    await Mailbox.insertMany(docs);
    logger.info('Email mailboxes provisioned', { userId });

    // Create welcome email in the Inbox (don't fail provisioning if this fails)
    try {
      const inbox = await Mailbox.findOne({ userId, specialUse: '\\Inbox' });
      if (inbox) {
        await this.createWelcomeEmail(userId, inbox);
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
    const existing = await Mailbox.find({ userId });
    if (existing.length === 0) {
      await this.provisionMailboxes(userId);
      return;
    }

    // Sync missing default mailboxes (e.g., Archive added after user created)
    const existingSpecialUse = new Set(existing.map((m) => m.specialUse).filter(Boolean));
    const missing = DEFAULT_MAILBOXES.filter((mb) => mb.specialUse && !existingSpecialUse.has(mb.specialUse));

    if (missing.length > 0) {
      const docs = missing.map((mb) => ({
        userId: new mongoose.Types.ObjectId(userId),
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse,
        retentionDays: 'retentionDays' in mb ? mb.retentionDays : null,
      }));
      await Mailbox.insertMany(docs);
      logger.info('Synced missing default mailboxes', { userId, count: missing.length });
    }
  }

  /**
   * Create a welcome email in the user's Inbox.
   * Called once during initial mailbox provisioning.
   */
  private async createWelcomeEmail(userId: string, inboxMailbox: IMailbox): Promise<void> {
    const user = await User.findById(userId);
    if (!user) return;

    const displayName = user.name?.first || user.username || 'there';
    const recipientName = [user.name?.first, user.name?.last].filter(Boolean).join(' ') || user.username || '';
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

    await Message.create({
      userId: new mongoose.Types.ObjectId(userId),
      mailboxId: inboxMailbox._id,
      messageId: `<welcome-${userId}-${uuidv4()}@${EMAIL_DOMAIN}>`,
      from: { name: 'Inbox by Oxy', address: `hello@${EMAIL_DOMAIN}` },
      to: [{ name: recipientName, address: recipientAddress }],
      cc: [],
      bcc: [],
      subject,
      text,
      html,
      headers: {},
      attachments: [],
      flags: { seen: false, starred: false, answered: false, forwarded: false, draft: false, pinned: false },
      encrypted: false,
      size,
      references: [],
      date: now,
      receivedAt: now,
    });

    await Mailbox.findByIdAndUpdate(inboxMailbox._id, {
      $inc: { totalMessages: 1, unseenMessages: 1, size },
    });

    logger.info('Welcome email created', { userId });
  }

  async listMailboxes(userId: string): Promise<any[]> {
    return Mailbox.find({ userId }).sort({ path: 1 }).lean({ virtuals: true });
  }

  async getMailboxBySpecialUse(userId: string, specialUse: string): Promise<any> {
    return Mailbox.findOne({ userId, specialUse }).lean({ virtuals: true });
  }

  async getMailboxById(userId: string, mailboxId: string): Promise<any> {
    return Mailbox.findOne({ _id: mailboxId, userId }).lean({ virtuals: true });
  }

  async createMailbox(userId: string, name: string, parentPath?: string): Promise<IMailbox> {
    const path = parentPath ? `${parentPath}/${name}` : name;

    const existing = await Mailbox.findOne({ userId, path });
    if (existing) {
      throw new BadRequestError(`Mailbox "${path}" already exists`);
    }

    const mailbox = await Mailbox.create({
      userId: new mongoose.Types.ObjectId(userId),
      name,
      path,
    });

    return mailbox.toJSON() as unknown as IMailbox;
  }

  async deleteMailbox(userId: string, mailboxId: string): Promise<void> {
    const mailbox = await Mailbox.findOne({ _id: mailboxId, userId });
    if (!mailbox) {
      throw new NotFoundError('Mailbox not found');
    }
    if (mailbox.specialUse) {
      throw new BadRequestError('Cannot delete a system mailbox');
    }

    // Delete all messages in the mailbox
    await this.deleteAttachmentsForMailbox(userId, mailboxId);
    await Message.deleteMany({ userId, mailboxId });
    await Mailbox.findByIdAndDelete(mailboxId);
  }

  // ─── Messages ─────────────────────────────────────────────────────

  async listMessages(
    userId: string,
    mailboxId: string | null,
    options: { limit?: number; offset?: number; unseenOnly?: boolean; starred?: boolean; label?: string } = {}
  ): Promise<{ data: any[]; total: number; limit: number; offset: number }> {
    const { limit = 50, offset = 0, unseenOnly = false, starred = false, label } = options;

    const filter: Record<string, unknown> = { userId };
    if (mailboxId) {
      filter.mailboxId = mailboxId;
    }
    if (starred) {
      filter['flags.starred'] = true;
    }
    if (unseenOnly) {
      filter['flags.seen'] = false;
    }
    if (label) {
      filter.labels = label;
    }

    const [data, total] = await Promise.all([
      Message.find(filter)
        .sort({ 'flags.pinned': -1, date: -1 })
        .skip(offset)
        .limit(limit)
        .lean({ virtuals: true }),
      Message.countDocuments(filter),
    ]);

    // Enrich with thread metadata (count + participants)
    const threaded = data.filter((m: any) => m.inReplyTo || (m.references && m.references.length > 0));
    if (threaded.length > 0) {
      // Collect all thread-related message IDs
      const threadIdSet = new Set<string>();
      for (const m of threaded) {
        if (m.messageId) threadIdSet.add(m.messageId);
        if (m.inReplyTo) threadIdSet.add(m.inReplyTo);
        if (m.references) m.references.forEach((r: string) => threadIdSet.add(r));
      }
      const allThreadIds = [...threadIdSet];

      const threadAgg = await Message.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(userId),
            $or: [
              { messageId: { $in: allThreadIds } },
              { inReplyTo: { $in: allThreadIds } },
              { references: { $elemMatch: { $in: allThreadIds } } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            messageIds: { $addToSet: '$messageId' },
            allMessages: {
              $push: {
                messageId: '$messageId',
                inReplyTo: '$inReplyTo',
                references: '$references',
                fromAddress: '$from.address',
              },
            },
          },
        },
      ]);

      if (threadAgg.length > 0) {
        const allMessages = threadAgg[0].allMessages;
        // Build a lookup: for each message in our page, find its thread siblings
        for (const msg of data) {
          if (!msg.inReplyTo && (!msg.references || msg.references.length === 0)) continue;

          const myIds = new Set<string>();
          if (msg.messageId) myIds.add(msg.messageId);
          if (msg.inReplyTo) myIds.add(msg.inReplyTo);
          if (msg.references) msg.references.forEach((r: string) => myIds.add(r));

          const siblings = allMessages.filter((m: any) => {
            if (myIds.has(m.messageId)) return true;
            if (m.inReplyTo && myIds.has(m.inReplyTo)) return true;
            if (m.references) return m.references.some((r: string) => myIds.has(r));
            return false;
          });

          if (siblings.length > 1) {
            msg.threadCount = siblings.length;
            msg.threadParticipants = [...new Set<string>(siblings.map((s: any) => s.fromAddress))];
          }
        }
      }
    }

    await EmailService.enrichWithAvatars(data);

    return { data, total, limit, offset };
  }

  async getMessage(userId: string, messageId: string): Promise<any> {
    const msg = await Message.findOne({ _id: messageId, userId })
      .select('+text +html +headers +encryptedBody')
      .lean({ virtuals: true });
    if (msg) await EmailService.enrichWithAvatars([msg]);
    return msg;
  }

  async updateMessageFlags(
    userId: string,
    messageId: string,
    flags: Partial<IMessage['flags']>
  ): Promise<any> {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flags)) {
      update[`flags.${key}`] = value;
    }

    const message = await Message.findOneAndUpdate(
      { _id: messageId, userId },
      { $set: update },
      { new: true }
    ).lean({ virtuals: true });

    if (!message) {
      throw new NotFoundError('Message not found');
    }

    // Update unseen count on mailbox when seen flag changes
    if ('seen' in flags) {
      const inc = flags.seen ? -1 : 1;
      await Mailbox.findByIdAndUpdate(message.mailboxId, {
        $inc: { unseenMessages: inc },
      });
    }

    return message;
  }

  async moveMessage(userId: string, messageId: string, targetMailboxId: string): Promise<any> {
    const [message, targetMailbox] = await Promise.all([
      Message.findOne({ _id: messageId, userId }),
      Mailbox.findOne({ _id: targetMailboxId, userId }),
    ]);

    if (!message) throw new NotFoundError('Message not found');
    if (!targetMailbox) throw new NotFoundError('Target mailbox not found');

    const sourceMailboxId = message.mailboxId;

    message.mailboxId = targetMailbox._id;
    await message.save();

    // Update counters on both mailboxes
    const unseenDelta = message.flags.seen ? 0 : 1;
    await Promise.all([
      Mailbox.findByIdAndUpdate(sourceMailboxId, {
        $inc: { totalMessages: -1, unseenMessages: -unseenDelta, size: -message.size },
      }),
      Mailbox.findByIdAndUpdate(targetMailboxId, {
        $inc: { totalMessages: 1, unseenMessages: unseenDelta, size: message.size },
      }),
    ]);

    return message.toJSON();
  }

  async bulkUpdateMessageFlags(
    userId: string,
    messageIds: string[],
    flags: Partial<IMessage['flags']>
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flags)) {
      update[`flags.${key}`] = value;
    }

    const messages = await Message.find({ _id: { $in: messageIds }, userId })
      .select('mailboxId flags.seen')
      .lean();

    const unseenDeltas = new Map<string, number>();
    if ('seen' in flags) {
      for (const message of messages) {
        if (message.flags.seen === flags.seen) {
          continue;
        }
        const mailboxId = message.mailboxId.toString();
        const delta = flags.seen ? -1 : 1;
        unseenDeltas.set(mailboxId, (unseenDeltas.get(mailboxId) ?? 0) + delta);
      }
    }

    const result = await Message.updateMany(
      { _id: { $in: messageIds }, userId },
      { $set: update }
    );

    if (unseenDeltas.size > 0) {
      await Mailbox.bulkWrite(
        Array.from(unseenDeltas.entries()).map(([mailboxId, unseenMessages]) => ({
          updateOne: {
            filter: { _id: mailboxId, userId },
            update: { $inc: { unseenMessages } },
          },
        }))
      );
    }

    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async bulkMoveMessages(
    userId: string,
    messageIds: string[],
    targetMailboxId: string
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const [messages, targetMailbox] = await Promise.all([
      Message.find({ _id: { $in: messageIds }, userId })
        .select('mailboxId flags.seen size')
        .lean(),
      Mailbox.findOne({ _id: targetMailboxId, userId }),
    ]);

    if (!targetMailbox) throw new NotFoundError('Target mailbox not found');

    const mailboxDeltas = new Map<
      string,
      { totalMessages: number; unseenMessages: number; size: number }
    >();

    const addDelta = (
      mailboxId: string,
      totalMessages: number,
      unseenMessages: number,
      size: number
    ) => {
      const current = mailboxDeltas.get(mailboxId) ?? {
        totalMessages: 0,
        unseenMessages: 0,
        size: 0,
      };
      current.totalMessages += totalMessages;
      current.unseenMessages += unseenMessages;
      current.size += size;
      mailboxDeltas.set(mailboxId, current);
    };

    const targetId = targetMailbox._id.toString();
    for (const message of messages) {
      const sourceId = message.mailboxId.toString();
      if (sourceId === targetId) {
        continue;
      }

      const unseenDelta = message.flags.seen ? 0 : 1;
      addDelta(sourceId, -1, -unseenDelta, -message.size);
      addDelta(targetId, 1, unseenDelta, message.size);
    }

    const result = await Message.updateMany(
      { _id: { $in: messageIds }, userId },
      { $set: { mailboxId: targetMailbox._id } }
    );

    if (mailboxDeltas.size > 0) {
      await Mailbox.bulkWrite(
        Array.from(mailboxDeltas.entries()).map(([mailboxId, delta]) => ({
          updateOne: {
            filter: { _id: mailboxId, userId },
            update: { $inc: delta },
          },
        }))
      );
    }

    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async deleteMessage(userId: string, messageId: string, permanent = false): Promise<void> {
    const message = await Message.findOne({ _id: messageId, userId });
    if (!message) throw new NotFoundError('Message not found');

    if (permanent) {
      // Delete attachments from S3
      await this.deleteMessageAttachments(message);
      await Message.findByIdAndDelete(messageId);
      await Mailbox.findByIdAndUpdate(message.mailboxId, {
        $inc: {
          totalMessages: -1,
          unseenMessages: message.flags.seen ? 0 : -1,
          size: -message.size,
        },
      });
    } else {
      // Move to Trash
      const trash = await this.getMailboxBySpecialUse(userId, '\\Trash');
      if (!trash) throw new NotFoundError('Trash mailbox not found');
      await this.moveMessage(userId, messageId, trash._id.toString());
    }
  }

  // ─── Storing an incoming message (from SMTP inbound) ──────────────

  async storeIncomingMessage(params: {
    recipientUsername: string;
    from: IEmailAddress;
    to: IEmailAddress[];
    cc?: IEmailAddress[];
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
  }): Promise<any> {
    // Resolve the recipient user
    const user = await User.findOne({ username: params.recipientUsername });
    if (!user) throw new NotFoundError('Recipient user not found');

    const userId = user._id.toString();
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
    const storedAttachments: IAttachment[] = [];
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
          fileId: file._id.toString(),
          name: file.originalName || att.filename,
          contentType: file.mime,
          size: file.size,
          ...(att.contentId ? { contentId: att.contentId } : {}),
          isInline: att.isInline ?? false,
        });
        uploadedFiles.push({ fileId: file._id.toString() });
      }
    }

    const totalSize =
      params.rawSize +
      storedAttachments.reduce((sum, a) => sum + a.size, 0);

    const receivedAt = new Date();
    const message = await Message.create({
      userId: user._id,
      mailboxId: mailbox._id,
      messageId: params.messageId,
      from: params.from,
      to: params.to,
      cc: params.cc ?? [],
      bcc: [],
      subject: params.subject,
      text: params.text,
      html: params.html,
      headers: params.headers,
      attachments: storedAttachments,
      flags: { seen: false, starred: false, answered: false, forwarded: false, draft: false },
      encrypted: false,
      spamScore: params.spamScore,
      spamAction: params.spamAction,
      size: totalSize,
      inReplyTo: params.inReplyTo,
      references: params.references ?? [],
      aliasTag: params.aliasTag,
      readReceiptRequested: !!params.headers['disposition-notification-to'],
      date: params.date,
      receivedAt,
    });

    // Update mailbox counters
    await Mailbox.findByIdAndUpdate(mailbox._id, {
      $inc: { totalMessages: 1, unseenMessages: 1, size: totalSize },
    });

    // Link each uploaded file to the newly-stored Message under the oxy-mail
    // app namespace. Best-effort: if linking fails the message is already
    // persisted and the file is owned by the recipient, so the inbound path
    // must not fail.
    if (uploadedFiles.length > 0) {
      const msgIdForLink = message._id.toString();
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
      mailboxId: mailbox._id.toString(),
      messageId: message._id.toString(),
      senderAddress: params.from.address,
      subject: params.subject,
      headers: params.headers,
      receivedAt,
    }).catch((err) => {
      logger.warn('Inbox capability event fan-out failed', {
        messageId: message._id.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Fire-and-forget AI processing (non-blocking, only for non-spam)
    if (!isSpam) {
      const msgId = message._id.toString();
      aiLabelingService.enqueueClassification(userId, msgId);
      cardExtractionService.extractAndUpdate(userId, msgId).catch((err) => {
        logger.warn('Card extraction failed', { msgId, error: String(err) });
      });
    }

    // Fire-and-forget filter application (non-blocking)
    const msgIdForFilters = message._id.toString();
    this.applyFilters(userId, msgIdForFilters).catch((err) => {
      logger.warn('Email filter application failed', { messageId: msgIdForFilters, error: String(err) });
    });

    // Fire-and-forget global auto-forwarding (non-blocking, only for non-spam)
    if (!isSpam) {
      this.applyGlobalAutoForward(userId, message._id.toString()).catch((err) => {
        logger.warn('Global auto-forward failed', { userId, error: String(err) });
      });
    }

    // Fire-and-forget push notification (non-blocking, only for non-spam)
    if (!isSpam) {
      const senderName = params.from.name || params.from.address;
      const pushBody = params.subject || '(no subject)';
      pushService.sendPushNotification({
        userId,
        title: senderName,
        body: pushBody,
        channelId: 'email',
        data: {
          messageId: message._id.toString(),
          mailboxId: mailbox._id.toString(),
        },
      }).catch((err) => {
        logger.warn('Push notification failed', { userId, error: String(err) });
      });
    }

    return message.toJSON();
  }

  // ─── Read Receipt (MDN) ────────────────────────────────────────────

  /**
   * Send an MDN (Message Disposition Notification) for a message that requested one.
   * RFC 3798 compliant: multipart/report with human-readable and machine-readable parts.
   */
  async sendReadReceipt(userId: string, messageId: string): Promise<void> {
    const message = await Message.findOne({ _id: messageId, userId })
      .select('+headers')
      .lean();
    if (!message) throw new NotFoundError('Message not found');

    if (!message.readReceiptRequested) {
      throw new BadRequestError('This message did not request a read receipt');
    }
    if (message.readReceiptSent) {
      throw new BadRequestError('Read receipt has already been sent');
    }

    // Get the Disposition-Notification-To address from headers
    const headers = message.headers as Record<string, string> | undefined;
    const dntAddress = headers?.['disposition-notification-to'];
    if (!dntAddress) {
      throw new BadRequestError('Missing Disposition-Notification-To header');
    }

    // Parse the notification address (may be "Name <email>" or just "email")
    const emailMatch = dntAddress.match(/<([^>]+)>/) || dntAddress.match(/([^\s,]+@[^\s,]+)/);
    const notifyEmail = emailMatch ? emailMatch[1] : dntAddress.trim();

    // Get user info for the From address
    const user = await User.findById(userId).select('username name');
    if (!user || !user.username) throw new BadRequestError('User must have a username');

    const fromAddress = resolveEmailAddress(user.username);
    const fromName = user.name?.first
      ? `${user.name.first} ${user.name.last || ''}`.trim()
      : user.username;

    // Build and send the MDN message (RFC 3798)
    const originalMessageId = message.messageId;
    const originalSubject = message.subject;

    await smtpOutbound.sendMdn({
      from: { name: fromName, address: fromAddress },
      to: notifyEmail,
      originalRecipient: fromAddress,
      originalMessageId,
      originalSubject,
    });

    // Mark receipt as sent
    await Message.updateOne(
      { _id: messageId, userId },
      { $set: { readReceiptSent: true } },
    );

    logger.info('Read receipt (MDN) sent', { userId, messageId, to: notifyEmail });
  }

  // ─── Compose & save draft / send ──────────────────────────────────

  async saveDraft(
    userId: string,
    draft: {
      to?: IEmailAddress[];
      cc?: IEmailAddress[];
      bcc?: IEmailAddress[];
      subject?: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      existingDraftId?: string;
    }
  ): Promise<any> {
    await this.ensureMailboxes(userId);
    const draftsMailbox = await this.getMailboxBySpecialUse(userId, '\\Drafts');
    if (!draftsMailbox) throw new NotFoundError('Drafts mailbox not found');

    const user = await User.findById(userId);
    if (!user || !user.username) throw new BadRequestError('User must have a username to send email');

    const fromAddress = resolveEmailAddress(user.username);
    const size = Buffer.byteLength(
      (draft.text || '') + (draft.html || ''),
      'utf8'
    );

    if (draft.existingDraftId) {
      // Update existing draft
      const updated = await Message.findOneAndUpdate(
        { _id: draft.existingDraftId, userId, 'flags.draft': true },
        {
          $set: {
            to: draft.to ?? [],
            cc: draft.cc ?? [],
            bcc: draft.bcc ?? [],
            subject: draft.subject ?? '',
            text: draft.text,
            html: draft.html,
            inReplyTo: draft.inReplyTo,
            references: draft.references ?? [],
            size,
            date: new Date(),
          },
        },
        { new: true }
      ).lean({ virtuals: true });

      if (updated) return updated;
    }

    // Create new draft
    const message = await Message.create({
      userId: new mongoose.Types.ObjectId(userId),
      mailboxId: draftsMailbox._id,
      messageId: `<${uuidv4()}@${EMAIL_DOMAIN}>`,
      from: { name: user.name?.first ? `${user.name.first} ${user.name.last || ''}`.trim() : user.username, address: fromAddress },
      to: draft.to ?? [],
      cc: draft.cc ?? [],
      bcc: draft.bcc ?? [],
      subject: draft.subject ?? '',
      text: draft.text,
      html: draft.html,
      headers: {},
      attachments: [],
      flags: { seen: true, starred: false, answered: false, forwarded: false, draft: true },
      size,
      inReplyTo: draft.inReplyTo,
      references: draft.references ?? [],
      date: new Date(),
      receivedAt: new Date(),
    });

    await Mailbox.findByIdAndUpdate(draftsMailbox._id, {
      $inc: { totalMessages: 1, size },
    });

    return message.toJSON();
  }

  /**
   * Move a sent message to the Sent mailbox after it has been dispatched.
   */
  async storeSentMessage(
    userId: string,
    messageData: {
      messageId: string;
      from: IEmailAddress;
      to: IEmailAddress[];
      cc?: IEmailAddress[];
      bcc?: IEmailAddress[];
      subject: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: IAttachment[];
      size: number;
    }
  ): Promise<any> {
    await this.ensureMailboxes(userId);
    const sentMailbox = await this.getMailboxBySpecialUse(userId, '\\Sent');
    if (!sentMailbox) throw new NotFoundError('Sent mailbox not found');

    // Count body + attachment bytes toward the storage quota on the send path.
    const size = this.calculateMessageStorageSize(messageData);
    await this.enforceQuota(userId, size);

    const message = await Message.create({
      userId: new mongoose.Types.ObjectId(userId),
      mailboxId: sentMailbox._id,
      messageId: messageData.messageId,
      from: messageData.from,
      to: messageData.to,
      cc: messageData.cc ?? [],
      bcc: messageData.bcc ?? [],
      subject: messageData.subject,
      text: messageData.text,
      html: messageData.html,
      headers: {},
      attachments: messageData.attachments ?? [],
      flags: { seen: true, starred: false, answered: false, forwarded: false, draft: false },
      size,
      inReplyTo: messageData.inReplyTo,
      references: messageData.references ?? [],
      date: new Date(),
      receivedAt: new Date(),
    });

    await Mailbox.findByIdAndUpdate(sentMailbox._id, {
      $inc: { totalMessages: 1, size },
    });

    return message.toJSON();
  }

  // ─── Snooze ──────────────────────────────────────────────────────────

  async snoozeMessage(userId: string, messageId: string, until: Date): Promise<any> {
    const message = await Message.findOne({ _id: messageId, userId });
    if (!message) throw new NotFoundError('Message not found');

    const snoozedMailbox = await this.getMailboxBySpecialUse(userId, '\\Snoozed');
    if (!snoozedMailbox) throw new NotFoundError('Snoozed mailbox not found');

    // Already snoozed — just update the time
    if (message.snoozedUntil) {
      message.snoozedUntil = until;
      await message.save();
      return message.toJSON();
    }

    const sourceMailboxId = message.mailboxId;
    message.snoozedUntil = until;
    message.snoozedFromMailbox = sourceMailboxId;
    message.mailboxId = snoozedMailbox._id;
    await message.save();

    // Update mailbox counters
    const unseenDelta = message.flags.seen ? 0 : 1;
    await Promise.all([
      Mailbox.findByIdAndUpdate(sourceMailboxId, {
        $inc: { totalMessages: -1, unseenMessages: -unseenDelta, size: -message.size },
      }),
      Mailbox.findByIdAndUpdate(snoozedMailbox._id, {
        $inc: { totalMessages: 1, unseenMessages: unseenDelta, size: message.size },
      }),
    ]);

    logger.info('Message snoozed', { userId, messageId, until: until.toISOString() });
    return message.toJSON();
  }

  async unsnoozeMessage(userId: string, messageId: string): Promise<any> {
    const message = await Message.findOne({ _id: messageId, userId });
    if (!message) throw new NotFoundError('Message not found');
    if (!message.snoozedUntil || !message.snoozedFromMailbox) {
      throw new BadRequestError('Message is not snoozed');
    }

    const targetMailboxId = message.snoozedFromMailbox;
    const snoozedMailboxId = message.mailboxId;

    message.mailboxId = targetMailboxId;
    message.snoozedUntil = null;
    message.snoozedFromMailbox = null;
    // Mark as unseen so it stands out when it reappears
    message.flags.seen = false;
    await message.save();

    // Update mailbox counters (now unseen in target)
    await Promise.all([
      Mailbox.findByIdAndUpdate(snoozedMailboxId, {
        $inc: { totalMessages: -1, size: -message.size },
      }),
      Mailbox.findByIdAndUpdate(targetMailboxId, {
        $inc: { totalMessages: 1, unseenMessages: 1, size: message.size },
      }),
    ]);

    logger.info('Message unsnoozed', { userId, messageId });
    return message.toJSON();
  }

  /**
   * Process all snoozed messages whose snooze time has passed.
   * Called by the snooze cron job every minute.
   */
  async processSnoozedMessages(): Promise<number> {
    const now = new Date();
    const due = await Message.find({
      snoozedUntil: { $lte: now, $ne: null },
      snoozedFromMailbox: { $ne: null },
    }).select('_id userId');

    let count = 0;
    for (const msg of due) {
      try {
        await this.unsnoozeMessage(msg.userId.toString(), msg._id.toString());
        count++;
      } catch (err) {
        logger.error('Failed to unsnooze message', err instanceof Error ? err : new Error(String(err)), {
          messageId: msg._id.toString(),
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
      from: IEmailAddress;
      to: IEmailAddress[];
      cc?: IEmailAddress[];
      bcc?: IEmailAddress[];
      subject: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: IAttachment[];
      scheduledAt: Date;
    }
  ): Promise<any> {
    await this.ensureMailboxes(userId);
    const sentMailbox = await this.getMailboxBySpecialUse(userId, '\\Sent');
    if (!sentMailbox) throw new NotFoundError('Sent mailbox not found');

    // Count body + attachment bytes toward the storage quota.
    const size = this.calculateMessageStorageSize(params);
    await this.enforceQuota(userId, size);

    const message = await Message.create({
      userId: new mongoose.Types.ObjectId(userId),
      mailboxId: sentMailbox._id,
      messageId: `<${uuidv4()}@${EMAIL_DOMAIN}>`,
      from: params.from,
      to: params.to,
      cc: params.cc ?? [],
      bcc: params.bcc ?? [],
      subject: params.subject,
      text: params.text,
      html: params.html,
      headers: {},
      attachments: params.attachments ?? [],
      flags: { seen: true, starred: false, answered: false, forwarded: false, draft: false },
      size,
      inReplyTo: params.inReplyTo,
      references: params.references ?? [],
      scheduledAt: params.scheduledAt,
      date: new Date(),
      receivedAt: new Date(),
    });

    await Mailbox.findByIdAndUpdate(sentMailbox._id, {
      $inc: { totalMessages: 1, size },
    });

    logger.info('Message scheduled', {
      userId,
      messageId: message.messageId,
      scheduledAt: params.scheduledAt.toISOString(),
    });

    return message.toJSON();
  }

  /**
   * Process all scheduled messages whose send time has passed.
   * Called by the scheduled send cron job every minute.
   */
  async processScheduledMessages(): Promise<number> {
    const now = new Date();
    const due = await Message.find({
      scheduledAt: { $lte: now, $ne: null },
    }).select('+text +html');

    let count = 0;
    for (const msg of due) {
      try {
        await smtpOutbound.sendRaw({
          userId: msg.userId.toString(),
          from: msg.from,
          to: msg.to,
          cc: msg.cc?.length ? msg.cc : undefined,
          bcc: msg.bcc?.length ? msg.bcc : undefined,
          subject: msg.subject,
          text: msg.text ?? undefined,
          html: msg.html ?? undefined,
          inReplyTo: msg.inReplyTo ?? undefined,
          references: msg.references?.length ? msg.references : undefined,
          attachments: msg.attachments?.length ? msg.attachments : undefined,
        });

        // Clear scheduledAt to mark as sent
        msg.scheduledAt = null;
        await msg.save();
        count++;
      } catch (err) {
        logger.error('Failed to send scheduled message', err instanceof Error ? err : new Error(String(err)), {
          messageId: msg._id.toString(),
        });
      }
    }

    if (count > 0) {
      logger.info('Scheduled send cron processed', { count });
    }
    return count;
  }

  // ─── Thread / Conversation ─────────────────────────────────────────

  async getThread(userId: string, messageId: string): Promise<any[]> {
    const anchor = await Message.findOne({ _id: messageId, userId })
      .select('+text +html +headers')
      .lean({ virtuals: true });
    if (!anchor) throw new NotFoundError('Message not found');

    // Collect all Message-IDs related to this thread
    const threadIds: string[] = [];
    if (anchor.messageId) threadIds.push(anchor.messageId);
    if (anchor.inReplyTo) threadIds.push(anchor.inReplyTo);
    if (anchor.references?.length) threadIds.push(...anchor.references);

    // Build query to find all related messages
    // This finds: messages this one references AND messages that reference this one
    const orConditions: any[] = [];

    if (threadIds.length > 0) {
      orConditions.push(
        { messageId: { $in: threadIds } },
        { inReplyTo: { $in: threadIds } },
        { references: { $in: threadIds } }
      );
    }

    // Also find messages that reply to THIS message (for when opening first message in thread)
    if (anchor.messageId) {
      orConditions.push(
        { inReplyTo: anchor.messageId },
        { references: anchor.messageId }
      );
    }

    // If no thread relations exist, return just the anchor
    if (orConditions.length === 0) return [anchor];

    const related = await Message.find({
      userId,
      $or: orConditions,
    })
      .select('+text +html +headers')
      .sort({ date: 1 })
      .lean({ virtuals: true });

    // Deduplicate (anchor may appear in results)
    const seen = new Set<string>();
    const thread: any[] = [];
    for (const msg of related) {
      const id = msg._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        thread.push(msg);
      }
    }
    if (!seen.has(anchor._id.toString())) {
      thread.push(anchor);
      thread.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }

    await EmailService.enrichWithAvatars(thread);

    return thread;
  }

  // ─── Labels ──────────────────────────────────────────────────────────

  async listLabels(userId: string): Promise<any[]> {
    const custom = await Label.find({ userId }).sort({ order: 1, name: 1 }).lean({ virtuals: true });
    // A row left over from when the system labels were seeded per user is
    // shadowed by its constant, so the list never shows the same name twice.
    const own = custom
      .filter((l: any) => !isSystemLabel(l.name))
      .map((l: any) => ({ ...l, system: false }));
    return [...SYSTEM_LABELS, ...own];
  }

  async createLabel(userId: string, name: string, color: string): Promise<any> {
    if (isSystemLabel(name)) throw new BadRequestError(`Label "${name.trim()}" already exists`);

    const existing = await Label.findOne({ userId, name }).collation({ locale: 'en', strength: 2 });
    if (existing) throw new BadRequestError(`Label "${name}" already exists`);

    const count = await Label.countDocuments({ userId });
    const label = await Label.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: name.trim(),
      color,
      order: count,
    });
    return label.toJSON();
  }

  async updateLabel(userId: string, labelId: string, updates: { name?: string; color?: string }): Promise<any> {
    if (isSystemLabelId(labelId)) throw new BadRequestError('System labels cannot be edited');
    if (updates.name && isSystemLabel(updates.name)) {
      throw new BadRequestError(`Label "${updates.name.trim()}" already exists`);
    }

    const label = await Label.findOneAndUpdate(
      { _id: labelId, userId },
      { $set: updates },
      { new: true }
    ).lean({ virtuals: true });
    if (!label) throw new NotFoundError('Label not found');
    return label;
  }

  async deleteLabel(userId: string, labelId: string): Promise<void> {
    if (isSystemLabelId(labelId)) throw new BadRequestError('System labels cannot be deleted');

    const label = await Label.findOne({ _id: labelId, userId });
    if (!label) throw new NotFoundError('Label not found');

    // Remove label from all messages
    await Message.updateMany(
      { userId, labels: label.name },
      { $pull: { labels: label.name } }
    );
    await Label.findByIdAndDelete(labelId);
  }

  async updateMessageLabels(userId: string, messageId: string, add: string[], remove: string[]): Promise<any> {
    // Validate that labels being added actually exist for this user. A system
    // label is valid without a row behind it — that is the whole point of it
    // being a constant — so only the rest are looked up.
    const unknown = add.filter((name) => !isSystemLabel(name));
    if (unknown.length > 0) {
      const existingLabels = await Label.find({ userId, name: { $in: unknown } }).select('name').lean();
      const existingNames = new Set(existingLabels.map((l) => l.name));
      const missing = unknown.filter((name) => !existingNames.has(name));
      if (missing.length > 0) {
        throw new BadRequestError(`Labels not found: ${missing.join(', ')}`);
      }
    }

    // MongoDB cannot $addToSet and $pull on the same field in one operation,
    // so we run them sequentially with the final one returning the result.
    const filter = { _id: messageId, userId };

    // Verify message exists first
    const exists = await Message.findOne(filter).select('_id').lean();
    if (!exists) throw new NotFoundError('Message not found');

    if (add.length > 0) {
      await Message.updateOne(filter, { $addToSet: { labels: { $each: add } } });
    }
    if (remove.length > 0) {
      await Message.updateOne(filter, { $pull: { labels: { $in: remove } } });
    }

    // Return the final state
    const message = await Message.findOne(filter).lean({ virtuals: true });
    return message;
  }

  // ─── Filters ─────────────────────────────────────────────────────────

  async listFilters(userId: string): Promise<any[]> {
    return EmailFilter.find({ userId }).sort({ order: 1, createdAt: 1 }).lean({ virtuals: true });
  }

  async createFilter(userId: string, data: {
    name: string;
    enabled: boolean;
    conditions: Array<{ field: string; operator: string; value: string }>;
    matchAll: boolean;
    actions: Array<{ type: string; value?: string }>;
    order: number;
  }): Promise<any> {
    const count = await EmailFilter.countDocuments({ userId });
    const filter = await EmailFilter.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: data.name,
      enabled: data.enabled,
      conditions: data.conditions,
      matchAll: data.matchAll,
      actions: data.actions,
      order: data.order ?? count,
    });
    return filter.toJSON();
  }

  async updateFilter(userId: string, filterId: string, updates: Record<string, unknown>): Promise<any> {
    const filter = await EmailFilter.findOneAndUpdate(
      { _id: filterId, userId },
      { $set: updates },
      { new: true }
    ).lean({ virtuals: true });
    if (!filter) throw new NotFoundError('Filter not found');
    return filter;
  }

  async deleteFilter(userId: string, filterId: string): Promise<void> {
    const filter = await EmailFilter.findOne({ _id: filterId, userId });
    if (!filter) throw new NotFoundError('Filter not found');
    await EmailFilter.findByIdAndDelete(filterId);
  }

  /**
   * Apply user's enabled email filters to an incoming message.
   * Called after the message is stored in storeIncomingMessage().
   * Batch-loads all enabled filters once, then evaluates each.
   */
  async applyFilters(userId: string, messageId: string): Promise<void> {
    const filters = await EmailFilter.find({ userId, enabled: true })
      .sort({ order: 1 })
      .lean();

    if (filters.length === 0) return;

    const message = await Message.findOne({ _id: messageId, userId });
    if (!message) return;

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
    message: any,
    conditions: Array<{ field: string; operator: string; value: string }>,
    matchAll: boolean,
  ): boolean {
    const results = conditions.map((cond) => this.evaluateCondition(message, cond));
    return matchAll ? results.every(Boolean) : results.some(Boolean);
  }

  /**
   * Evaluate a single filter condition against a message.
   */
  private evaluateCondition(
    message: any,
    condition: { field: string; operator: string; value: string },
  ): boolean {
    const { field, operator, value } = condition;

    let fieldValue: string;

    switch (field) {
      case 'from':
        fieldValue = `${message.from?.name || ''} ${message.from?.address || ''}`.toLowerCase();
        break;
      case 'to': {
        const toAddrs = (message.to || []).map(
          (a: { name?: string; address: string }) => `${a.name || ''} ${a.address}`.toLowerCase()
        );
        fieldValue = toAddrs.join(' ');
        break;
      }
      case 'subject':
        fieldValue = (message.subject || '').toLowerCase();
        break;
      case 'has-attachment':
        // For has-attachment, operator is 'equals' and value is 'true' or 'false'
        return value === 'true'
          ? (message.attachments?.length ?? 0) > 0
          : (message.attachments?.length ?? 0) === 0;
      case 'size':
        return this.evaluateNumericCondition(message.size || 0, operator, value);
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
    actions: Array<{ type: string; value?: string }>,
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
              await this.moveMessage(userId, messageId, archive._id.toString());
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

    const message = await Message.findOne({ _id: messageId, userId })
      .select('+text +html +headers')
      .lean();
    if (!message) {
      logger.warn('Message not found for forwarding', { userId, messageId });
      return;
    }

    // Resolve the sender (the user whose account is forwarding)
    const user = await User.findById(userId).select('username name');
    if (!user?.username) {
      logger.warn('User not found for forwarding', { userId });
      return;
    }

    const fromAddress = resolveEmailAddress(user.username);
    const fromName = user.name?.first
      ? `${user.name.first} ${user.name.last || ''}`.trim()
      : user.username;

    // Build forwarded subject
    const subject = message.subject?.startsWith('Fwd:')
      ? message.subject
      : `Fwd: ${message.subject || '(no subject)'}`;

    // Build forwarded body with original message attribution
    const originalFrom = message.from?.name
      ? `${message.from.name} <${message.from.address}>`
      : message.from?.address || 'unknown';
    const originalTo = (message.to || [])
      .map((a: { name?: string; address: string }) => a.name ? `${a.name} <${a.address}>` : a.address)
      .join(', ');
    const originalDate = message.date ? new Date(message.date).toUTCString() : 'unknown';

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
      references: message.references?.length ? message.references : undefined,
      attachments: message.attachments?.length ? message.attachments : undefined,
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
    const user = await User.findById(userId).select('+autoForwardTo +autoForwardKeepCopy');
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
    const msg = await Message.findOne({ _id: messageId, userId })
      .select('+text +html +headers')
      .lean();
    if (!msg) throw new NotFoundError('Message not found');

    const formatAddr = (a: IEmailAddress) =>
      a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address;

    const lines: string[] = [];
    lines.push(`From: ${formatAddr(msg.from)}`);
    if (msg.to?.length) lines.push(`To: ${msg.to.map(formatAddr).join(', ')}`);
    if (msg.cc?.length) lines.push(`Cc: ${msg.cc.map(formatAddr).join(', ')}`);
    lines.push(`Subject: ${msg.subject || ''}`);
    lines.push(`Date: ${new Date(msg.date).toUTCString()}`);
    lines.push(`Message-ID: ${msg.messageId}`);
    if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);
    if (msg.references?.length) lines.push(`References: ${msg.references.join(' ')}`);
    lines.push(`MIME-Version: 1.0`);

    const hasText = !!msg.text;
    const hasHtml = !!msg.html;

    if (hasText && hasHtml) {
      const boundary = `----=_Part_${uuidv4().replace(/-/g, '')}`;
      lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      lines.push('');
      lines.push(`--${boundary}`);
      lines.push('Content-Type: text/plain; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(msg.text!);
      lines.push(`--${boundary}`);
      lines.push('Content-Type: text/html; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(msg.html!);
      lines.push(`--${boundary}--`);
    } else if (hasHtml) {
      lines.push('Content-Type: text/html; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(msg.html!);
    } else {
      lines.push('Content-Type: text/plain; charset=utf-8');
      lines.push('Content-Transfer-Encoding: quoted-printable');
      lines.push('');
      lines.push(msg.text || '');
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
    const user = await User.findById(userId);
    if (!user || !user.username) throw new BadRequestError('User must have a username');

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

        const from: IEmailAddress = parsed.from?.value?.[0]
          ? { name: parsed.from.value[0].name || '', address: parsed.from.value[0].address || '' }
          : { name: '', address: 'unknown@unknown' };

        const mapAddresses = (addrs: typeof parsed.to): IEmailAddress[] => {
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
        const storedAttachments: IAttachment[] = [];
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
              fileId: uploadedFile._id.toString(),
              name: uploadedFile.originalName || att.filename || 'attachment',
              contentType: uploadedFile.mime,
              size: uploadedFile.size,
              ...(att.contentId ? { contentId: att.contentId } : {}),
              isInline: att.related ?? false,
            });
            importedFileIds.push(uploadedFile._id.toString());
          }
        }

        const message = await Message.create({
          userId: new mongoose.Types.ObjectId(userId),
          mailboxId: inbox._id,
          messageId: parsed.messageId || `<imported-${uuidv4()}@${EMAIL_DOMAIN}>`,
          from,
          to,
          cc,
          bcc: [],
          subject: parsed.subject || '(no subject)',
          text: parsed.text || undefined,
          html: parsed.html || undefined,
          headers: {},
          attachments: storedAttachments,
          flags: { seen: true, starred: false, answered: false, forwarded: false, draft: false },
          encrypted: false,
          size: totalSize,
          inReplyTo: parsed.inReplyTo as string | undefined,
          references: Array.isArray(parsed.references)
            ? parsed.references
            : parsed.references
              ? [parsed.references]
              : [],
          date: parsed.date || new Date(),
          receivedAt: new Date(),
        });

        await Mailbox.findByIdAndUpdate(inbox._id, {
          $inc: { totalMessages: 1, size: totalSize },
        });

        // Best-effort link of imported attachments to the new message
        for (const importedFileId of importedFileIds) {
          try {
            await assetService.linkFile(importedFileId, {
              app: 'oxy-mail',
              entityType: 'message',
              entityId: message._id.toString(),
              createdBy: userId,
            });
          } catch (linkErr) {
            logger.warn('Failed to link imported attachment to message', {
              fileId: importedFileId,
              messageId: message._id.toString(),
              error: linkErr instanceof Error ? linkErr.message : String(linkErr),
            });
          }
        }

        // Fire-and-forget AI processing
        const msgId = message._id.toString();
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
    } = {}
  ): Promise<{ data: any[]; total: number; limit: number; offset: number }> {
    const { limit = 50, offset = 0, mailboxId, from, to, subject, hasAttachment, dateAfter, dateBefore, starred, label, seen } = options;

    const filter: Record<string, unknown> = {
      userId: new mongoose.Types.ObjectId(userId),
    };

    if (query) {
      filter.$text = { $search: query };
    }
    if (mailboxId) {
      filter.mailboxId = new mongoose.Types.ObjectId(mailboxId);
    }
    const fromFilter = normalizeStructuredSearchFilter(from);
    const toFilter = normalizeStructuredSearchFilter(to);
    const subjectFilter = normalizeStructuredSearchFilter(subject);

    if (fromFilter) {
      filter['from.address'] = { $regex: fromFilter, $options: 'i' };
    }
    if (toFilter) {
      filter['to.address'] = { $regex: toFilter, $options: 'i' };
    }
    if (subjectFilter) {
      filter.subject = { $regex: subjectFilter, $options: 'i' };
    }
    if (hasAttachment) {
      filter['attachments.0'] = { $exists: true };
    }
    if (starred) {
      filter['flags.starred'] = true;
    }
    if (seen !== undefined) {
      filter['flags.seen'] = seen;
    }
    if (label) {
      filter.labels = label;
    }
    if (dateAfter || dateBefore) {
      const dateFilter: Record<string, Date> = {};
      if (dateAfter) dateFilter.$gte = new Date(dateAfter);
      if (dateBefore) dateFilter.$lte = new Date(dateBefore);
      filter.date = dateFilter;
    }

    const projection = query ? { score: { $meta: 'textScore' } } : {};
    const sort: Record<string, SortOrder | { $meta: string }> = query
      ? { score: { $meta: 'textScore' } }
      : { date: -1 };

    const [data, total] = await Promise.all([
      Message.find(filter, projection)
        .sort(sort)
        .skip(offset)
        .limit(limit)
        .maxTimeMS(EMAIL_SEARCH_MAX_TIME_MS)
        .lean({ virtuals: true }),
      Message.countDocuments(filter).maxTimeMS(EMAIL_SEARCH_MAX_TIME_MS),
    ]);

    return { data, total, limit, offset };
  }

  // ─── Quota ────────────────────────────────────────────────────────

  async getQuotaUsage(userId: string): Promise<{ used: number; limit: number; percentage: number }> {
    const result = await Mailbox.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: null, totalSize: { $sum: '$size' } } },
    ]);
    const used = result[0]?.totalSize ?? 0;
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

    return Message.countDocuments({
      userId,
      mailboxId: sentMailbox._id,
      receivedAt: { $gte: startOfDay },
    });
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
    // Delete all attachment files from S3
    await this.deleteAttachmentsForUser(userId);

    // Delete all messages and mailboxes
    await Message.deleteMany({ userId });
    await Mailbox.deleteMany({ userId });

    logger.info('All email data deleted for user', { userId });
  }

  /**
   * Resolve an incoming email address to a user.
   * Returns the user and alias tag (if any).
   */
  async resolveRecipient(
    emailAddress: string
  ): Promise<{ user: IUser; aliasTag: string | null } | null> {
    const username = extractUsername(emailAddress);
    if (!username) return null;

    const user = await User.findOne({ username });
    if (!user) return null;

    const aliasTag = extractAliasTag(emailAddress);
    return { user, aliasTag };
  }

  // ─── Email settings ───────────────────────────────────────────────

  async getEmailSettings(userId: string): Promise<{
    signature?: string;
    autoReply?: { enabled: boolean; subject?: string; body?: string; startDate?: Date; endDate?: Date };
    autoForwardTo?: string;
    autoForwardKeepCopy?: boolean;
    address: string;
  }> {
    const user = await User.findById(userId).select('+emailSignature +autoReply +autoForwardTo +autoForwardKeepCopy +username');
    if (!user) throw new NotFoundError('User not found');
    return {
      signature: user.emailSignature ?? '',
      autoReply: user.autoReply ?? { enabled: false },
      autoForwardTo: user.autoForwardTo ?? '',
      autoForwardKeepCopy: user.autoForwardKeepCopy ?? true,
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
    const update: Record<string, unknown> = {};
    if (settings.signature !== undefined) update.emailSignature = settings.signature;
    if (settings.autoReply !== undefined) update.autoReply = settings.autoReply;
    if (settings.autoForwardTo !== undefined) update.autoForwardTo = settings.autoForwardTo;
    if (settings.autoForwardKeepCopy !== undefined) update.autoForwardKeepCopy = settings.autoForwardKeepCopy;

    await User.findByIdAndUpdate(userId, { $set: update });
    userCache.invalidate(userId);
  }

  // ─── Subscriptions ──────────────────────────────────────────────

  /**
   * Attach `senderAvatarPath` to each message based on sender email.
   * Uses the shared SenderAvatar cache (resolved server-side, 7-day TTL).
   */
  private static async enrichWithAvatars(messages: Array<Record<string, unknown> & { from?: IEmailAddress; senderAvatarPath?: string | null }>): Promise<void> {
    if (messages.length === 0) return;
    const emails = messages.map((m) => m.from?.address).filter((e): e is string => Boolean(e));
    if (emails.length === 0) return;
    try {
      const avatarMap = await getAvatarPathsBatch(emails);
      for (const msg of messages) {
        const addr = msg.from?.address?.trim().toLowerCase();
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
  ): Promise<{ data: any[]; total: number }> {
    const { limit = 50, offset = 0 } = options;

    // Only aggregate from Inbox and Archive (received mail, not sent/drafts/trash)
    const receivedMailboxes = await Mailbox.find({
      userId,
      specialUse: { $in: ['\\Inbox', '\\Archive'] },
    })
      .select('_id')
      .lean();
    const mailboxIds = receivedMailboxes.map((m) => m._id);

    if (mailboxIds.length === 0) {
      return { data: [], total: 0 };
    }

    const pipeline: any[] = [
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          mailboxId: { $in: mailboxIds },
        },
      },
      {
        $group: {
          _id: '$from.address',
          name: { $last: '$from.name' },
          messageCount: { $sum: 1 },
          // Same pass as the count: how many of this sender's messages were
          // ever opened. A sender you never read is the one worth dropping.
          readCount: { $sum: { $cond: [{ $eq: ['$flags.seen', true] }, 1, 0] } },
          latestDate: { $max: '$date' },
          oldestDate: { $min: '$date' },
          latestMessageId: { $last: '$_id' },
        },
      },
      { $match: { messageCount: { $gte: 3 } } },
      // `_id` (the sender address) breaks ties. Sorting on `messageCount`
      // alone leaves equal-count senders in an arbitrary order that can
      // differ between two offset pages, so the same sender comes back twice
      // while another is skipped entirely.
      { $sort: { messageCount: -1, _id: 1 } },
      {
        $facet: {
          data: [{ $skip: offset }, { $limit: limit }],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await Message.aggregate(pipeline);
    const senders = result?.data ?? [];
    const total = result?.total?.[0]?.count ?? 0;

    if (senders.length === 0) {
      return { data: [], total };
    }

    // Phase 2: fetch List-Unsubscribe headers for each sender's latest message
    const latestMsgIds = senders.map((s: any) => s.latestMessageId);
    const latestMessages = await Message.find({ _id: { $in: latestMsgIds } })
      .select('+headers')
      .lean();

    const headerMap = new Map<string, Record<string, string>>();
    for (const msg of latestMessages) {
      const headers: Record<string, string> = {};
      if (msg.headers instanceof Map) {
        msg.headers.forEach((v: string, k: string) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (msg.headers && typeof msg.headers === 'object') {
        for (const [k, v] of Object.entries(msg.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      headerMap.set(msg._id.toString(), headers);
    }

    // Enrich senders with unsubscribe info and type detection
    const enriched = senders.map((sender: any) => {
      const headers = headerMap.get(sender.latestMessageId.toString()) || {};
      const listUnsub = headers['list-unsubscribe'] || null;
      const listUnsubPost = headers['list-unsubscribe-post'] || null;

      let type: 'list-unsubscribe' | 'pattern-match' | 'frequent' = 'frequent';
      if (listUnsub) {
        type = 'list-unsubscribe';
      } else if (
        EmailService.NEWSLETTER_PATTERNS.some((p) => p.test(sender._id))
      ) {
        type = 'pattern-match';
      }

      return {
        _id: sender._id,
        name: sender.name || sender._id.split('@')[0],
        messageCount: sender.messageCount,
        readCount: sender.readCount ?? 0,
        latestDate: sender.latestDate,
        oldestDate: sender.oldestDate,
        latestMessageId: sender.latestMessageId,
        hasListUnsubscribe: !!listUnsub,
        type,
      };
    });

    // Enrich subscriptions with sender avatars
    const subEmails = enriched.map((s: any) => s._id);
    try {
      const avatarMap = await getAvatarPathsBatch(subEmails);
      for (const sub of enriched) {
        const addr = sub._id.trim().toLowerCase();
        sub.senderAvatarPath = avatarMap.get(addr) ?? null;
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
    if (method === 'list-unsubscribe') {
      // Find the latest message from this sender with headers
      const latestMsg = await Message.findOne({
        userId,
        'from.address': senderAddress.toLowerCase(),
      })
        .sort({ date: -1 })
        .select('+headers')
        .lean();

      if (latestMsg?.headers) {
        const headers: Record<string, string> = {};
        if (latestMsg.headers instanceof Map) {
          latestMsg.headers.forEach((v: string, k: string) => {
            headers[k.toLowerCase()] = v;
          });
        } else if (typeof latestMsg.headers === 'object') {
          for (const [k, v] of Object.entries(latestMsg.headers as Record<string, string>)) {
            headers[k.toLowerCase()] = v;
          }
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

              const user = await User.findById(userId).select('username name');
              if (user?.username) {
                await smtpOutbound.send({
                  userId,
                  from: {
                    name: user.name?.first
                      ? `${user.name.first} ${user.name.last || ''}`.trim()
                      : user.username,
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

    // Block sender: move all messages from this sender to Spam
    const spamMailbox = await this.getMailboxBySpecialUse(userId, '\\Junk');
    if (spamMailbox) {
      // Get messages not already in spam to update counters properly
      const messagesToMove = await Message.find({
        userId,
        'from.address': senderAddress.toLowerCase(),
        mailboxId: { $ne: spamMailbox._id },
      })
        .select('mailboxId size flags')
        .lean();

      if (messagesToMove.length > 0) {
        // Group by source mailbox for counter updates
        const byMailbox = new Map<string, { count: number; unseenCount: number; totalSize: number }>();
        for (const msg of messagesToMove) {
          const key = msg.mailboxId.toString();
          const entry = byMailbox.get(key) || { count: 0, unseenCount: 0, totalSize: 0 };
          entry.count++;
          if (!msg.flags.seen) entry.unseenCount++;
          entry.totalSize += msg.size;
          byMailbox.set(key, entry);
        }

        // Move all at once
        await Message.updateMany(
          {
            userId,
            'from.address': senderAddress.toLowerCase(),
            mailboxId: { $ne: spamMailbox._id },
          },
          { $set: { mailboxId: spamMailbox._id } },
        );

        // Update source mailbox counters
        const counterUpdates = [];
        let totalMoved = 0;
        let totalUnseenMoved = 0;
        let totalSizeMoved = 0;
        for (const [mbId, entry] of byMailbox) {
          counterUpdates.push(
            Mailbox.findByIdAndUpdate(mbId, {
              $inc: {
                totalMessages: -entry.count,
                unseenMessages: -entry.unseenCount,
                size: -entry.totalSize,
              },
            }),
          );
          totalMoved += entry.count;
          totalUnseenMoved += entry.unseenCount;
          totalSizeMoved += entry.totalSize;
        }

        // Update spam mailbox counter
        counterUpdates.push(
          Mailbox.findByIdAndUpdate(spamMailbox._id, {
            $inc: {
              totalMessages: totalMoved,
              unseenMessages: totalUnseenMoved,
              size: totalSizeMoved,
            },
          }),
        );

        await Promise.all(counterUpdates);
      }
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

  private async getUserTier(userId: string): Promise<SubscriptionTier> {
    try {
      const BillingSubscription = mongoose.model('BillingSubscription');
      const subscription = await BillingSubscription.findOne({
        userId,
        status: { $in: ['active', 'trialing'] },
      }).select('plan.name').lean() as { plan?: { name?: string } } | null;

      if (!subscription?.plan?.name) return 'free';

      const planName = subscription.plan.name.toLowerCase();
      if (planName === 'business') return 'business';
      if (planName === 'pro') return 'pro';
      return 'free';
    } catch {
      // Model not registered or DB error -- default to free
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
  private async deleteMessageAttachments(message: Pick<IMessage, '_id' | 'messageId' | 'attachments'>): Promise<void> {
    const entityIds = [message._id.toString()];
    if (message.messageId && !entityIds.includes(message.messageId)) {
      entityIds.push(message.messageId);
    }

    for (const att of message.attachments ?? []) {
      for (const entityId of entityIds) {
        try {
          await assetService.unlinkFile(att.fileId, 'oxy-mail', 'message', entityId);
        } catch (error) {
          logger.error('Failed to unlink attachment file from message', error instanceof Error ? error : new Error(String(error)), {
            fileId: att.fileId,
            entityId,
          });
        }
      }
    }
  }

  private async deleteAttachmentsForMailbox(userId: string, mailboxId: string): Promise<void> {
    const cursor = Message.find({ userId, mailboxId })
      .select('attachments messageId')
      .cursor();

    for await (const msg of cursor) {
      await this.deleteMessageAttachments(msg as IMessage);
    }
  }

  private async deleteAttachmentsForUser(userId: string): Promise<void> {
    const cursor = Message.find({ userId })
      .select('attachments messageId')
      .cursor();

    for await (const msg of cursor) {
      await this.deleteMessageAttachments(msg as IMessage);
    }
  }

  // ─── Bundles ─────────────────────────────────────────────────────

  async ensureDefaultBundles(userId: string): Promise<void> {
    const count = await Bundle.countDocuments({ userId });
    if (count > 0) return;

    const docs = EmailService.DEFAULT_BUNDLES.map((b) => ({
      userId: new mongoose.Types.ObjectId(userId),
      name: b.name,
      icon: b.icon,
      color: b.color,
      matchLabels: b.matchLabels,
      order: b.order,
      enabled: true,
      collapsed: true,
    }));

    try {
      await Bundle.insertMany(docs, { ordered: false });
      logger.info('Default bundles seeded', { userId });
    } catch (err: any) {
      if (err.code !== 11000 && !err.message?.includes('E11000')) {
        throw err;
      }
    }
  }

  async listBundles(userId: string): Promise<any[]> {
    await this.ensureDefaultBundles(userId);
    return Bundle.find({ userId }).sort({ order: 1 }).lean();
  }

  async updateBundle(
    userId: string,
    bundleId: string,
    updates: { enabled?: boolean; collapsed?: boolean; matchLabels?: string[]; order?: number },
  ): Promise<any> {
    const bundle = await Bundle.findOneAndUpdate(
      { _id: bundleId, userId },
      { $set: updates },
      { new: true },
    ).lean();
    if (!bundle) throw new NotFoundError('Bundle not found');
    return bundle;
  }

  async listBundledMessages(
    userId: string,
    mailboxId: string | null,
    options: { limit: number; offset: number },
  ): Promise<{
    primary: any[];
    bundles: Array<{ bundle: any; messages: any[]; unreadCount: number }>;
    total: number;
  }> {
    // Get enabled bundles
    await this.ensureDefaultBundles(userId);
    const bundles = await Bundle.find({ userId, enabled: true }).sort({ order: 1 }).lean();

    // Collect all label names that belong to any bundle
    const bundledLabels = new Set<string>();
    for (const b of bundles) {
      for (const l of b.matchLabels) {
        bundledLabels.add(l);
      }
    }

    // Query all messages for this mailbox
    const query: Record<string, any> = { userId };
    if (mailboxId) query.mailboxId = new mongoose.Types.ObjectId(mailboxId);

    const allMessages = await Message.find(query)
      .sort({ 'flags.pinned': -1, date: -1 })
      .skip(options.offset)
      .limit(options.limit)
      .lean();

    const total = await Message.countDocuments(query);

    // Partition into primary vs bundled
    const primary: any[] = [];
    const bundleMap = new Map<string, any[]>();

    for (const b of bundles) {
      bundleMap.set(b._id.toString(), []);
    }

    for (const msg of allMessages) {
      const msgLabels = msg.labels || [];
      let matched = false;

      for (const b of bundles) {
        if (b.matchLabels.some((l: string) => msgLabels.includes(l))) {
          bundleMap.get(b._id.toString())!.push(msg);
          matched = true;
          break; // First matching bundle wins
        }
      }

      if (!matched) {
        primary.push(msg);
      }
    }

    const bundleResults = bundles.map((b) => {
      const messages = bundleMap.get(b._id.toString()) || [];
      const unreadCount = messages.filter((m: any) => !m.flags?.seen).length;
      return { bundle: b, messages, unreadCount };
    }).filter((br) => br.messages.length > 0);

    return { primary, bundles: bundleResults, total };
  }

  // ─── Reminders ──────────────────────────────────────────────────

  async createReminder(
    userId: string,
    data: { text: string; remindAt: string; relatedMessageId?: string },
  ) {
    const reminder = await Reminder.create({
      userId,
      text: data.text,
      remindAt: new Date(data.remindAt),
      relatedMessageId: data.relatedMessageId || null,
    });
    return reminder.toJSON();
  }

  async listReminders(
    userId: string,
    options: { includeCompleted?: boolean; limit?: number; offset?: number } = {},
  ) {
    const filter: Record<string, any> = { userId };
    if (!options.includeCompleted) {
      filter.completed = false;
    }

    const total = await Reminder.countDocuments(filter);
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const reminders = await Reminder.find(filter)
      .sort({ pinned: -1, remindAt: 1 })
      .skip(offset)
      .limit(limit)
      .lean();

    return {
      data: reminders,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    };
  }

  async getReminder(userId: string, reminderId: string) {
    const reminder = await Reminder.findOne({ _id: reminderId, userId });
    if (!reminder) throw new NotFoundError('Reminder not found');
    return reminder.toJSON();
  }

  async updateReminder(
    userId: string,
    reminderId: string,
    updates: { text?: string; remindAt?: string; completed?: boolean; pinned?: boolean; snoozedUntil?: string | null },
  ) {
    const updateData: Record<string, any> = {};
    if (updates.text !== undefined) updateData.text = updates.text;
    if (updates.remindAt !== undefined) updateData.remindAt = new Date(updates.remindAt);
    if (updates.completed !== undefined) updateData.completed = updates.completed;
    if (updates.pinned !== undefined) updateData.pinned = updates.pinned;
    if (updates.snoozedUntil !== undefined) {
      updateData.snoozedUntil = updates.snoozedUntil ? new Date(updates.snoozedUntil) : null;
    }

    const reminder = await Reminder.findOneAndUpdate(
      { _id: reminderId, userId },
      { $set: updateData },
      { new: true },
    );
    if (!reminder) throw new NotFoundError('Reminder not found');
    return reminder.toJSON();
  }

  async deleteReminder(userId: string, reminderId: string) {
    const result = await Reminder.deleteOne({ _id: reminderId, userId });
    if (result.deletedCount === 0) throw new NotFoundError('Reminder not found');
  }

  async processDueReminders() {
    const now = new Date();
    const dueReminders = await Reminder.find({
      completed: false,
      remindAt: { $lte: now },
      $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: now } }],
    }).lean();

    // For now, mark due reminders as "ready" by clearing snoozedUntil
    // In the future, this could push notifications
    for (const reminder of dueReminders) {
      if (reminder.snoozedUntil) {
        await Reminder.updateOne(
          { _id: reminder._id },
          { $set: { snoozedUntil: null } },
        );
      }
    }

    return dueReminders.length;
  }

  // ─── Templates ──────────────────────────────────────────────────

  async listTemplates(userId: string): Promise<any[]> {
    return EmailTemplate.find({ userId }).sort({ order: 1, name: 1 }).lean({ virtuals: true });
  }

  async createTemplate(userId: string, data: { name: string; subject?: string; body: string }): Promise<any> {
    const existing = await EmailTemplate.findOne({ userId, name: data.name }).collation({ locale: 'en', strength: 2 });
    if (existing) throw new BadRequestError(`Template "${data.name}" already exists`);

    const count = await EmailTemplate.countDocuments({ userId });
    const template = await EmailTemplate.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: data.name.trim(),
      subject: data.subject || '',
      body: data.body,
      order: count,
    });
    return template.toJSON();
  }

  async updateTemplate(userId: string, templateId: string, updates: { name?: string; subject?: string; body?: string }): Promise<any> {
    const cleanUpdates: Record<string, string> = {};
    if (updates.name !== undefined) cleanUpdates.name = updates.name.trim();
    if (updates.subject !== undefined) cleanUpdates.subject = updates.subject;
    if (updates.body !== undefined) cleanUpdates.body = updates.body;

    const template = await EmailTemplate.findOneAndUpdate(
      { _id: templateId, userId },
      { $set: cleanUpdates },
      { new: true }
    ).lean({ virtuals: true });
    if (!template) throw new NotFoundError('Template not found');
    return template;
  }

  async deleteTemplate(userId: string, templateId: string): Promise<void> {
    const template = await EmailTemplate.findOne({ _id: templateId, userId });
    if (!template) throw new NotFoundError('Template not found');
    await EmailTemplate.findByIdAndDelete(templateId);
  }

  // ─── Contacts ──────────────────────────────────────────────────────

  async listContacts(
    userId: string,
    options: { q?: string; starred?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ data: unknown[]; total: number }> {
    const { q, starred, limit = 50, offset = 0 } = options;

    const filter: Record<string, unknown> = { userId: new mongoose.Types.ObjectId(userId) };

    if (starred) {
      filter.starred = true;
    }

    if (q && q.trim().length >= 1) {
      const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
        { company: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      Contact.find(filter)
        .sort({ starred: -1, name: 1 })
        .skip(offset)
        .limit(limit)
        .lean({ virtuals: true }),
      Contact.countDocuments(filter),
    ]);

    return { data, total };
  }

  async createContact(
    userId: string,
    data: { name: string; email: string; company?: string; notes?: string; starred?: boolean },
  ) {
    const existing = await Contact.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      email: data.email.toLowerCase(),
    });

    if (existing) {
      throw new BadRequestError('A contact with this email already exists');
    }

    const contact = await Contact.create({
      userId: new mongoose.Types.ObjectId(userId),
      name: data.name.trim(),
      email: data.email.trim().toLowerCase(),
      company: data.company?.trim() || undefined,
      notes: data.notes?.trim() || undefined,
      starred: data.starred ?? false,
      autoCollected: false,
    });

    return contact.toJSON();
  }

  async updateContact(
    userId: string,
    contactId: string,
    updates: { name?: string; email?: string; company?: string; notes?: string; starred?: boolean },
  ) {
    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name.trim();
    if (updates.email !== undefined) updateData.email = updates.email.trim().toLowerCase();
    if (updates.company !== undefined) updateData.company = updates.company.trim() || undefined;
    if (updates.notes !== undefined) updateData.notes = updates.notes.trim() || undefined;
    if (updates.starred !== undefined) updateData.starred = updates.starred;

    const contact = await Contact.findOneAndUpdate(
      { _id: contactId, userId },
      { $set: updateData },
      { new: true },
    ).lean({ virtuals: true });
    if (!contact) throw new NotFoundError('Contact not found');
    return contact;
  }

  async deleteContact(userId: string, contactId: string): Promise<void> {
    const result = await Contact.deleteOne({ _id: contactId, userId });
    if (result.deletedCount === 0) throw new NotFoundError('Contact not found');
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
    const userOid = new mongoose.Types.ObjectId(userId);

    for (const addr of addresses) {
      if (!addr.address) continue;
      const email = addr.address.trim().toLowerCase();
      if (!email) continue;

      try {
        // Use upsert to avoid race conditions; only set fields on insert
        await Contact.updateOne(
          { userId: userOid, email },
          {
            $setOnInsert: {
              userId: userOid,
              name: addr.name?.trim() || email.split('@')[0],
              email,
              autoCollected: true,
              starred: false,
            },
            $set: {
              lastContactedAt: new Date(),
            },
          },
          { upsert: true },
        );
      } catch (err: unknown) {
        // Ignore duplicate key errors (race condition safe)
        const errObj = err as { code?: number; message?: string };
        if (errObj.code !== 11000 && !errObj.message?.includes('E11000')) {
          logger.warn('Failed to auto-collect contact', {
            email,
            error: String(err),
          });
        }
      }
    }
  }

  /**
   * Search contacts for autocomplete suggestions.
   * Returns contacts matching the query, ordered by relevance.
   */
  async searchContacts(
    userId: string,
    query: string,
    limit = 10,
  ): Promise<Array<{ name: string; address: string }>> {
    if (!query || query.length < 2) return [];

    const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const contacts = await Contact.find({
      userId: new mongoose.Types.ObjectId(userId),
      $or: [
        { name: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ],
    })
      .sort({ starred: -1, lastContactedAt: -1, name: 1 })
      .limit(limit)
      .select('name email')
      .lean();

    return contacts.map((c) => ({ name: c.name, address: c.email }));
  }
}

export const emailService = new EmailService();
export default emailService;
