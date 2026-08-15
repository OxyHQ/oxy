import { z } from 'zod';

// POST /email/mailboxes
export const createMailboxSchema = z.object({
  name: z.string().trim().min(1),
  parentPath: z.string().trim().optional(),
});

// Params with :mailboxId
export const mailboxIdParams = z.object({
  mailboxId: z.string().trim().min(1),
});

// Params with :messageId
export const messageIdParams = z.object({
  messageId: z.string().trim().min(1),
});

// PUT /email/messages/:messageId/flags
export const updateFlagsSchema = z.object({
  flags: z.object({
    seen: z.boolean().optional(),
    starred: z.boolean().optional(),
    answered: z.boolean().optional(),
    forwarded: z.boolean().optional(),
    draft: z.boolean().optional(),
    pinned: z.boolean().optional(),
  }),
});

// PUT /email/messages/:messageId/labels
export const updateLabelsSchema = z.object({
  add: z.array(z.string()).optional().default([]),
  remove: z.array(z.string()).optional().default([]),
});

// POST /email/messages/:messageId/move
export const moveMessageSchema = z.object({
  mailboxId: z.string().trim().min(1),
});

// POST /email/messages/:messageId/snooze
export const snoozeMessageSchema = z.object({
  until: z.string().trim().min(1),
});

// POST /email/messages/bulk/flags
export const bulkUpdateFlagsSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(100),
  flags: z.object({
    seen: z.boolean().optional(),
    starred: z.boolean().optional(),
    answered: z.boolean().optional(),
    forwarded: z.boolean().optional(),
    draft: z.boolean().optional(),
    pinned: z.boolean().optional(),
  }),
});

// POST /email/messages/bulk/move
export const bulkMoveMessagesSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(100),
  mailboxId: z.string().trim().min(1),
});

// POST /email/labels
export const createLabelSchema = z.object({
  name: z.string().trim().min(1),
  color: z.string().trim().optional(),
});

// Params with :labelId
export const labelIdParams = z.object({
  labelId: z.string().trim().min(1),
});

// PUT /email/labels/:labelId
export const updateLabelSchema = z.object({
  name: z.string().trim().optional(),
  color: z.string().trim().optional(),
});

// Canonical recipient shape used across the inbound path (storeIncomingMessage),
// the stored form (`EmailAddress` in `db/schema/messages.ts`), the outbound
// transporter (smtpOutbound.send), and the inbox UI. RFC 5321 address-spec is required;
// display name is optional. We do NOT accept bare strings or "Name <addr>"
// — clients must parse and submit the canonical object.
const recipientSchema = z.object({
  name: z.string().trim().max(255).optional(),
  address: z
    .string()
    .trim()
    .min(3)
    .max(320) // RFC 5321 addr-spec maximum
    .email('Recipient address must be a valid email address'),
});

export type RecipientInput = z.infer<typeof recipientSchema>;

// Canonical attachment input — a Message attachment is just a reference into
// the Oxy File Manager. The server resolves the File record, mirrors its
// originalName/mime/size into the Message subdocument, and creates a link
// (app: 'oxy-mail') so the file isn't orphaned. Only the file owner may
// reference their own files (enforced by the controller).
const attachmentInputSchema = z.object({
  fileId: z.string().trim().min(1),
  contentId: z.string().trim().optional(),
  isInline: z.boolean().optional(),
});

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

// POST /email/messages (send)
export const sendMessageSchema = z.object({
  to: z.array(recipientSchema).min(1).max(100),
  cc: z.array(recipientSchema).max(100).optional(),
  bcc: z.array(recipientSchema).max(100).optional(),
  subject: z.string().max(998).optional(), // RFC 5322 line length limit
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyTo: z.string().trim().optional(),
  references: z.array(z.string().trim()).optional(),
  attachments: z.array(attachmentInputSchema).max(20).optional(),
  scheduledAt: z.string().optional(),
  requestReadReceipt: z.boolean().optional(),
});

// POST /email/drafts
export const saveDraftSchema = z.object({
  to: z.array(recipientSchema).max(100).optional(),
  cc: z.array(recipientSchema).max(100).optional(),
  bcc: z.array(recipientSchema).max(100).optional(),
  subject: z.string().max(998).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyTo: z.string().trim().optional(),
  references: z.array(z.string().trim()).optional(),
  attachments: z.array(attachmentInputSchema).max(20).optional(),
  existingDraftId: z.string().trim().optional(),
});

// POST /email/subscriptions/unsubscribe
export const unsubscribeSchema = z.object({
  senderAddress: z.string().trim().min(1),
  method: z.enum(['list-unsubscribe', 'block']).optional(),
});

// PUT /email/bundles/:bundleId
export const bundleIdParams = z.object({
  bundleId: z.string().trim().min(1),
});

export const updateBundleSchema = z.object({
  enabled: z.boolean().optional(),
  collapsed: z.boolean().optional(),
  matchLabels: z.array(z.string()).optional(),
  order: z.number().optional(),
});

// PUT /email/settings
export const updateEmailSettingsSchema = z.object({
  signature: z.string().optional(),
  autoReply: z.any().optional(),
  autoForwardTo: z.string().optional(),
  autoForwardKeepCopy: z.boolean().optional(),
});

// POST /email/reminders
export const createReminderSchema = z.object({
  text: z.string().trim().min(1),
  remindAt: z.string().trim().min(1),
  relatedMessageId: z.string().optional(),
});

// Params with :reminderId
export const reminderIdParams = z.object({
  reminderId: z.string().trim().min(1),
});

// PUT /email/reminders/:reminderId
export const updateReminderSchema = z.object({
  text: z.string().trim().optional(),
  remindAt: z.string().trim().optional(),
  status: z.enum(['pending', 'completed', 'dismissed']).optional(),
});

// ─── Contacts ──────────────────────────────────────────────────────

// POST /email/contacts
export const createContactSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  company: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  starred: z.boolean().optional(),
});

// Params with :contactId
export const contactIdParams = z.object({
  contactId: z.string().trim().min(1),
});

// PUT /email/contacts/:contactId
export const updateContactSchema = z.object({
  name: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  company: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  starred: z.boolean().optional(),
});

// ─── Email Filters ──────────────────────────────────────────────────

const filterConditionSchema = z.object({
  field: z.enum(['from', 'to', 'subject', 'has-attachment', 'size']),
  operator: z.enum(['contains', 'equals', 'not-contains', 'starts-with', 'ends-with', 'greater-than', 'less-than']),
  value: z.string().min(1),
});

const filterActionSchema = z.object({
  type: z.enum(['move', 'label', 'star', 'mark-read', 'archive', 'delete', 'forward']),
  value: z.string().optional(),
});

// POST /email/filters
export const createFilterSchema = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  conditions: z.array(filterConditionSchema).min(1),
  matchAll: z.boolean().optional(),
  actions: z.array(filterActionSchema).min(1),
  order: z.number().optional(),
});

// Params with :filterId
export const filterIdParams = z.object({
  filterId: z.string().trim().min(1),
});

// PUT /email/filters/:filterId
export const updateFilterSchema = z.object({
  name: z.string().trim().optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(filterConditionSchema).min(1).optional(),
  matchAll: z.boolean().optional(),
  actions: z.array(filterActionSchema).min(1).optional(),
  order: z.number().optional(),
});

// ─── Templates ──────────────────────────────────────────────────

// POST /email/templates
export const createTemplateSchema = z.object({
  name: z.string().trim().min(1),
  subject: z.string().trim().optional(),
  body: z.string().min(1),
});

// Params with :templateId
export const templateIdParams = z.object({
  templateId: z.string().trim().min(1),
});

// PUT /email/templates/:templateId
export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  subject: z.string().trim().optional(),
  body: z.string().min(1).optional(),
});
