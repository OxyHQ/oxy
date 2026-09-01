/**
 * Email API client
 *
 * Wraps the Oxy email REST API for use in the Inbox app.
 * Uses OxyServices.httpService for automatic auth and CSRF handling.
 * All responses validated with zod schemas at runtime.
 */

import { z } from 'zod';
import type { OxyServices } from '@oxyhq/core';

// Runtime schemas + inferred types live in `@/schemas/emailSchemas`. They are
// re-exported here so existing `@/services/emailApi` imports keep working.
import {
  MessageSchema,
  MailboxSchema,
  LabelSchema,
  PaginationSchema,
  QuotaUsageSchema,
  EmailSettingsSchema,
  SubscriptionSchema,
  UnsubscribeResultSchema,
  BundleSchema,
  ReminderSchema,
  ContactSuggestionSchema,
  ContactSchema,
  EmailFilterSchema,
  EmailTemplateSchema,
} from '@/schemas/emailSchemas';
import type {
  EmailAddress,
  Message,
  Mailbox,
  Label,
  Pagination,
  MessageFlags,
  QuotaUsage,
  EmailSettings,
  Subscription,
  UnsubscribeResult,
  Bundle,
  Reminder,
  ContactSuggestion,
  Contact,
  EmailFilter,
  EmailFilterCondition,
  EmailFilterAction,
  EmailTemplate,
} from '@/schemas/emailSchemas';

export * from '@/schemas/emailSchemas';

type HttpService = OxyServices['httpService'];

// ─── Response Helpers ──────────────────────────────────────────────

// HttpService.unwrapResponse() already strips the { data: ... } wrapper for
// non-paginated responses and returns paginated { data, pagination } as-is.
// So http.get() returns the inner value directly (or { data, pagination } for
// paginated endpoints). No extra unwrapping needed here.

interface PaginatedResult<T> {
  data: T[];
  pagination: Pagination;
}

/** Parse an array of messages, skipping any that fail validation. */
function parseMessages(items: unknown): Message[] {
  if (!Array.isArray(items)) return [];
  return items.reduce<Message[]>((acc, item) => {
    const result = MessageSchema.safeParse(item);
    if (result.success) {
      acc.push(result.data);
    }
    // Invalid messages are silently skipped — the response shape is validated
    // server-side; any failures here are usually stale-cache items.
    return acc;
  }, []);
}

// ─── API Client ────────────────────────────────────────────────────

export function createEmailApi(http: HttpService) {
  return {
    // ─── Mailboxes ──────────────────────────────────────────────────

    async listMailboxes(): Promise<Mailbox[]> {
      const res = await http.get('/email/mailboxes');
      return z.array(MailboxSchema).parse(res);
    },

    async createMailbox(name: string, parentPath?: string): Promise<Mailbox> {
      const res = await http.post('/email/mailboxes', { name, parentPath });
      return MailboxSchema.parse(res);
    },

    async deleteMailbox(mailboxId: string): Promise<void> {
      await http.delete(`/email/mailboxes/${mailboxId}`);
    },

    // ─── Messages ───────────────────────────────────────────────────

    async listMessages(
      options: {
        mailboxId?: string;
        starred?: boolean;
        label?: string;
        limit?: number;
        offset?: number;
        unseenOnly?: boolean;
      } = {},
    ): Promise<{ data: Message[]; pagination: Pagination }> {
      const params: Record<string, string> = {};
      if (options.mailboxId) params.mailbox = options.mailboxId;
      if (options.starred) params.starred = 'true';
      if (options.label) params.label = options.label;
      if (options.limit !== undefined) params.limit = String(options.limit);
      if (options.offset !== undefined) params.offset = String(options.offset);
      if (options.unseenOnly) params.unseen = 'true';

      const res = (await http.get('/email/messages', { params })) as PaginatedResult<unknown>;
      return {
        data: parseMessages(res.data),
        pagination: PaginationSchema.parse(res.pagination),
      };
    },

    async getMessage(messageId: string): Promise<Message> {
      const res = await http.get(`/email/messages/${messageId}`);
      return MessageSchema.parse(res);
    },

    async getThread(messageId: string): Promise<Message[]> {
      const res = await http.get(`/email/messages/${messageId}/thread`);
      return parseMessages(res);
    },

    async updateFlags(messageId: string, flags: Partial<MessageFlags>): Promise<Message> {
      const res = await http.put(`/email/messages/${messageId}/flags`, { flags });
      return MessageSchema.parse(res);
    },

    async updateLabels(messageId: string, add: string[], remove: string[]): Promise<Message> {
      const res = await http.put(`/email/messages/${messageId}/labels`, { add, remove });
      return MessageSchema.parse(res);
    },

    async moveMessage(messageId: string, mailboxId: string): Promise<Message> {
      const res = await http.post(`/email/messages/${messageId}/move`, { mailboxId });
      return MessageSchema.parse(res);
    },

    async snoozeMessage(messageId: string, until: string): Promise<Message> {
      const res = await http.post(`/email/messages/${messageId}/snooze`, { until });
      return MessageSchema.parse(res);
    },

    async unsnoozeMessage(messageId: string): Promise<Message> {
      const res = await http.post(`/email/messages/${messageId}/unsnooze`);
      return MessageSchema.parse(res);
    },

    async deleteMessage(messageId: string, permanent = false): Promise<void> {
      const params = permanent ? '?permanent=true' : '';
      await http.delete(`/email/messages/${messageId}${params}`);
    },

    // ─── Bulk Operations ──────────────────────────────────────────────

    async bulkUpdateFlags(
      messageIds: string[],
      flags: Partial<MessageFlags>,
    ): Promise<{ matched: number; modified: number }> {
      const res = await http.post('/email/messages/bulk/flags', { messageIds, flags });
      return z.object({ matched: z.number(), modified: z.number() }).parse(res);
    },

    async bulkMoveMessages(
      messageIds: string[],
      mailboxId: string,
    ): Promise<{ matched: number; modified: number }> {
      const res = await http.post('/email/messages/bulk/move', { messageIds, mailboxId });
      return z.object({ matched: z.number(), modified: z.number() }).parse(res);
    },

    // ─── Labels ─────────────────────────────────────────────────────

    async listLabels(): Promise<Label[]> {
      const res = await http.get('/email/labels');
      return z.array(LabelSchema).parse(res);
    },

    async createLabel(name: string, color: string): Promise<Label> {
      const res = await http.post('/email/labels', { name, color });
      return LabelSchema.parse(res);
    },

    async updateLabel(labelId: string, updates: { name?: string; color?: string }): Promise<Label> {
      const res = await http.put(`/email/labels/${labelId}`, updates);
      return LabelSchema.parse(res);
    },

    async deleteLabel(labelId: string): Promise<void> {
      await http.delete(`/email/labels/${labelId}`);
    },

    // ─── Compose ────────────────────────────────────────────────────

    async sendMessage(message: {
      to: EmailAddress[];
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      subject: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: { fileId: string; contentId?: string; isInline?: boolean }[];
      scheduledAt?: string;
    }): Promise<{ messageId: string; queued: boolean; message: string }> {
      const res = await http.post('/email/messages', message);
      return z.object({
        messageId: z.string(),
        queued: z.boolean(),
        message: z.string(),
      }).parse(res);
    },

    async saveDraft(draft: {
      to?: EmailAddress[];
      cc?: EmailAddress[];
      bcc?: EmailAddress[];
      subject?: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      existingDraftId?: string;
    }): Promise<Message> {
      const res = await http.post('/email/drafts', draft);
      return MessageSchema.parse(res);
    },

    // ─── Search ─────────────────────────────────────────────────────

    async search(
      options: {
        q?: string;
        from?: string;
        to?: string;
        subject?: string;
        hasAttachment?: boolean;
        dateAfter?: string;
        dateBefore?: string;
        mailbox?: string;
        starred?: boolean;
        label?: string;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<{ data: Message[]; pagination: Pagination }> {
      const params: Record<string, string> = {};
      if (options.q) params.q = options.q;
      if (options.from) params.from = options.from;
      if (options.to) params.to = options.to;
      if (options.subject) params.subject = options.subject;
      if (options.hasAttachment) params.hasAttachment = 'true';
      if (options.dateAfter) params.dateAfter = options.dateAfter;
      if (options.dateBefore) params.dateBefore = options.dateBefore;
      if (options.mailbox) params.mailbox = options.mailbox;
      if (options.starred) params.starred = 'true';
      if (options.label) params.label = options.label;
      if (options.limit !== undefined) params.limit = String(options.limit);
      if (options.offset !== undefined) params.offset = String(options.offset);

      const res = (await http.get('/email/search', { params })) as PaginatedResult<unknown>;
      return {
        data: parseMessages(res.data),
        pagination: PaginationSchema.parse(res.pagination),
      };
    },

    // ─── Quota ──────────────────────────────────────────────────────

    async getQuota(): Promise<QuotaUsage> {
      const res = await http.get('/email/quota');
      return QuotaUsageSchema.parse(res);
    },

    // ─── Settings ───────────────────────────────────────────────────

    async getSettings(): Promise<EmailSettings> {
      const res = await http.get('/email/settings');
      return EmailSettingsSchema.parse(res);
    },

    async updateSettings(
      settings: {
        signature?: string;
        autoReply?: Partial<EmailSettings['autoReply']>;
        autoForwardTo?: string;
        autoForwardKeepCopy?: boolean;
      },
    ): Promise<void> {
      await http.put('/email/settings', settings);
    },

    // ─── Subscriptions ───────────────────────────────────────────────

    async listSubscriptions(
      options: { limit?: number; offset?: number } = {},
    ): Promise<{ data: Subscription[]; pagination: Pagination }> {
      const params: Record<string, string> = {};
      if (options.limit !== undefined) params.limit = String(options.limit);
      if (options.offset !== undefined) params.offset = String(options.offset);

      const res = (await http.get('/email/subscriptions', { params })) as PaginatedResult<Subscription>;
      return {
        data: z.array(SubscriptionSchema).parse(res.data),
        pagination: PaginationSchema.parse(res.pagination),
      };
    },

    async unsubscribe(
      senderAddress: string,
      method?: 'list-unsubscribe' | 'block',
    ): Promise<UnsubscribeResult> {
      const res = await http.post('/email/subscriptions/unsubscribe', {
        senderAddress,
        method,
      });
      return UnsubscribeResultSchema.parse(res);
    },

    // ─── Bundles ────────────────────────────────────────────────────

    async listBundles(): Promise<Bundle[]> {
      const res = await http.get('/email/bundles');
      return z.array(BundleSchema).parse(res);
    },

    async updateBundle(
      bundleId: string,
      updates: { enabled?: boolean; collapsed?: boolean; matchLabels?: string[]; order?: number },
    ): Promise<Bundle> {
      const res = await http.put(`/email/bundles/${bundleId}`, updates);
      return BundleSchema.parse(res);
    },

    async listBundledMessages(
      options: { mailboxId?: string; limit?: number; offset?: number } = {},
    ): Promise<{
      primary: Message[];
      bundles: { bundle: Bundle; messages: Message[]; unreadCount: number }[];
      pagination: Pagination;
    }> {
      const params: Record<string, string> = {};
      if (options.mailboxId) params.mailbox = options.mailboxId;
      if (options.limit !== undefined) params.limit = String(options.limit);
      if (options.offset !== undefined) params.offset = String(options.offset);

      const res = await http.get('/email/messages/bundled', { params }) as {
        data: {
          primary: Message[];
          bundles: { bundle: Bundle; messages: Message[]; unreadCount: number }[];
        };
        pagination: Pagination;
      };
      return {
        primary: parseMessages(res.data.primary),
        bundles: res.data.bundles.map((b) => ({
          bundle: BundleSchema.parse(b.bundle),
          messages: parseMessages(b.messages),
          unreadCount: b.unreadCount,
        })),
        pagination: PaginationSchema.parse(res.pagination),
      };
    },

    // ─── Reminders ────────────────────────────────────────────────

    async createReminder(data: {
      text: string;
      remindAt: string;
      relatedMessageId?: string;
    }): Promise<Reminder> {
      const res = await http.post('/email/reminders', data);
      return ReminderSchema.parse(res);
    },

    async listReminders(
      options: { includeCompleted?: boolean; limit?: number; offset?: number } = {},
    ): Promise<{ data: Reminder[]; pagination: Pagination }> {
      const params: Record<string, string> = {};
      if (options.includeCompleted) params.completed = 'true';
      if (options.limit !== undefined) params.limit = String(options.limit);
      if (options.offset !== undefined) params.offset = String(options.offset);

      const res = (await http.get('/email/reminders', { params })) as PaginatedResult<Reminder>;
      return {
        data: z.array(ReminderSchema).parse(res.data),
        pagination: PaginationSchema.parse(res.pagination),
      };
    },

    async getReminder(reminderId: string): Promise<Reminder> {
      const res = await http.get(`/email/reminders/${reminderId}`);
      return ReminderSchema.parse(res);
    },

    async updateReminder(
      reminderId: string,
      updates: { text?: string; remindAt?: string; completed?: boolean; pinned?: boolean; snoozedUntil?: string | null },
    ): Promise<Reminder> {
      const res = await http.put(`/email/reminders/${reminderId}`, updates);
      return ReminderSchema.parse(res);
    },

    async deleteReminder(reminderId: string): Promise<void> {
      await http.delete(`/email/reminders/${reminderId}`);
    },

    // ─── Contacts ────────────────────────────────────────────────────

    async suggestContacts(query: string): Promise<ContactSuggestion[]> {
      const res = await http.get('/email/contacts/suggest', {
        params: { q: query },
      });
      const parsed = z.object({ data: z.array(ContactSuggestionSchema) }).parse(res);
      return parsed.data;
    },

    async listContacts(
      options: { q?: string; starred?: boolean; limit?: number; offset?: number } = {},
    ): Promise<{ data: Contact[]; pagination: Pagination }> {
      const params: Record<string, string> = {};
      if (options.q) params.q = options.q;
      if (options.starred) params.starred = 'true';
      if (options.limit !== undefined) params.limit = String(options.limit);
      if (options.offset !== undefined) params.offset = String(options.offset);

      const res = (await http.get('/email/contacts', { params })) as PaginatedResult<Contact>;
      return {
        data: z.array(ContactSchema).parse(res.data),
        pagination: PaginationSchema.parse(res.pagination),
      };
    },

    async createContact(data: {
      name: string;
      email: string;
      company?: string;
      notes?: string;
      starred?: boolean;
    }): Promise<Contact> {
      const res = await http.post('/email/contacts', data);
      return ContactSchema.parse(res);
    },

    async updateContact(
      contactId: string,
      updates: { name?: string; email?: string; company?: string; notes?: string; starred?: boolean },
    ): Promise<Contact> {
      const res = await http.put(`/email/contacts/${contactId}`, updates);
      return ContactSchema.parse(res);
    },

    async deleteContact(contactId: string): Promise<void> {
      await http.delete(`/email/contacts/${contactId}`);
    },

    // ─── Templates ────────────────────────────────────────────────────

    async listTemplates(): Promise<EmailTemplate[]> {
      const res = await http.get('/email/templates');
      return z.array(EmailTemplateSchema).parse(res);
    },

    async createTemplate(data: { name: string; subject?: string; body: string }): Promise<EmailTemplate> {
      const res = await http.post('/email/templates', data);
      return EmailTemplateSchema.parse(res);
    },

    async updateTemplate(templateId: string, updates: { name?: string; subject?: string; body?: string }): Promise<EmailTemplate> {
      const res = await http.put(`/email/templates/${templateId}`, updates);
      return EmailTemplateSchema.parse(res);
    },

    async deleteTemplate(templateId: string): Promise<void> {
      await http.delete(`/email/templates/${templateId}`);
    },

    // ─── Filters ─────────────────────────────────────────────────────

    async listFilters(): Promise<EmailFilter[]> {
      const res = await http.get('/email/filters');
      return z.array(EmailFilterSchema).parse(res);
    },

    async createFilter(data: {
      name: string;
      enabled?: boolean;
      conditions: EmailFilterCondition[];
      matchAll?: boolean;
      actions: EmailFilterAction[];
      order?: number;
    }): Promise<EmailFilter> {
      const res = await http.post('/email/filters', data);
      return EmailFilterSchema.parse(res);
    },

    async updateFilter(
      filterId: string,
      updates: {
        name?: string;
        enabled?: boolean;
        conditions?: EmailFilterCondition[];
        matchAll?: boolean;
        actions?: EmailFilterAction[];
        order?: number;
      },
    ): Promise<EmailFilter> {
      const res = await http.put(`/email/filters/${filterId}`, updates);
      return EmailFilterSchema.parse(res);
    },

    async deleteFilter(filterId: string): Promise<void> {
      await http.delete(`/email/filters/${filterId}`);
    },

    // ─── Import / Export ────────────────────────────────────────────

    /**
     * Export a message as .eml file. Returns the raw content as a string.
     * The caller is responsible for triggering the download.
     */
    async exportMessage(messageId: string): Promise<{ content: string; filename: string }> {
      // The export endpoint responds with `message/rfc822`; HttpService returns
      // non-JSON content types as raw text.
      const res = await http.get<string>(`/email/messages/${messageId}/export`, {
        headers: { Accept: 'message/rfc822' },
      });
      return {
        content: res,
        filename: 'message.eml',
      };
    },

    /**
     * Import .eml files. Returns the count of successfully imported messages.
     */
    async importMessages(files: File[]): Promise<{ imported: number; total: number }> {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file, file.name);
      }
      const res = await http.post('/email/import', formData);
      return z.object({ imported: z.number(), total: z.number() }).parse(res);
    },
  };
}

export type EmailApiInstance = ReturnType<typeof createEmailApi>;
