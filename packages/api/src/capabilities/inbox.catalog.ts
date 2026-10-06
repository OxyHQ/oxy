import type { AppCapabilityCatalog, CatalogTool } from '@oxy.so/contracts';

/**
 * The Inbox capability catalog: the one description of every Inbox tool, read
 * by Alia (which turns each tool into a model tool as-is), by the external MCP
 * server, and by the permission UI. Descriptions are written for a MODEL acting
 * for the account owner — Alia is first-party, so nothing here says "delegated".
 *
 * Every tool is executed by `inbox.tools.ts`, whichever transport carried it;
 * `invocation` is only the address a capability ticket request is sent to, and
 * no two invocations may overlap (`appCapabilityCatalogSchema` refuses it).
 *
 * 2.0.0 is breaking on purpose: the message path parameter is `emailId` (it
 * was `messageId`, which models kept confusing with the RFC `messageId` FIELD
 * every email also carries), `moveEmail` takes `mailbox`, list tools paginate
 * by cursor only, and `idempotencyKey` is no longer a model argument — HTTP
 * carries it in the `Idempotency-Key` header and MCP adds it back as a
 * transport argument (`inbox.handlers.ts`).
 */

/** The page size a list tool uses when the caller does not ask for one. */
export const INBOX_DEFAULT_PAGE_SIZE = 20;
export const INBOX_MAX_PAGE_SIZE = 100;

/**
 * The special mailboxes a tool accepts by NAME, mapped to their IMAP
 * special-use attribute. A model can say `archive` without first calling
 * listMailboxes — and a mailbox-scoped caller, which cannot list the account's
 * mailboxes, can still name the folder it means.
 */
export const INBOX_SPECIAL_MAILBOXES = {
  inbox: '\\Inbox',
  sent: '\\Sent',
  drafts: '\\Drafts',
  archive: '\\Archive',
  trash: '\\Trash',
  spam: '\\Junk',
  snoozed: '\\Snoozed',
} as const;

const objectOutput = { type: 'object', additionalProperties: true } as const;
const emptyInput = { type: 'object', properties: {}, additionalProperties: false } as const;

const emailId = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  description: 'The email\'s `id` field, as returned by listEmails, searchEmails, getUnreadEmails or readEmail. '
    + 'NOT its `messageId` field (the RFC Message-ID that looks like <abc@host>).',
} as const;
const mailbox = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  description: `A mailbox: one of ${Object.keys(INBOX_SPECIAL_MAILBOXES).join(', ')}, or a mailbox \`id\` from listMailboxes.`,
} as const;
const pageSize = {
  type: 'integer',
  minimum: 1,
  maximum: INBOX_MAX_PAGE_SIZE,
  default: INBOX_DEFAULT_PAGE_SIZE,
  description: `Maximum number of emails to return (default ${INBOX_DEFAULT_PAGE_SIZE}).`,
} as const;
const cursor = {
  type: 'string',
  minLength: 1,
  maxLength: 2048,
  description: 'Omit for the first page. For the next page pass the previous result\'s `pagination.nextCursor`.',
} as const;
const recipient = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 255 },
    address: { type: 'string', format: 'email' },
  },
  required: ['address'],
  additionalProperties: false,
} as const;
const recipients = { type: 'array', items: recipient, maxItems: 100 } as const;
const attachments = {
  type: 'array',
  maxItems: 20,
  description: 'Files to attach, by Oxy file id. Only files the account owns can be attached.',
  items: {
    type: 'object',
    properties: {
      fileId: { type: 'string', minLength: 1 },
      contentId: { type: 'string', description: 'Content-ID, only for an inline image referenced from html.' },
      isInline: { type: 'boolean' },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
} as const;
const text = { type: 'string', description: 'Plain-text body. Enough on its own; html is optional.' } as const;
const html = { type: 'string', description: 'Optional HTML body, sent alongside text.' } as const;
const scheduledAt = {
  type: 'string',
  maxLength: 64,
  description: 'Send later instead of now: an ISO 8601 date-time in the future with a timezone, '
    + 'e.g. 2026-10-02T09:00:00Z.',
} as const;
const rfcMessageId = {
  type: 'string',
  maxLength: 998,
  description: 'An RFC 5322 Message-ID such as <abc@host> — the `messageId` FIELD of an email, never its `id`.',
} as const;

const DESCRIPTION_SUFFIX = {
  summaries: 'Results are summaries without bodies; call readEmail with a result\'s `id` for the full email. '
    + 'When `pagination.hasMore` is true, call again with `cursor: pagination.nextCursor`.',
  scope: 'With authority over a single mailbox, only emails in that mailbox are visible.',
} as const;

type ToolInput = Pick<CatalogTool, 'name' | 'description' | 'inputSchema' | 'resourceTypes' | 'invocation'>
  & Partial<Pick<CatalogTool, 'limitKeys' | 'exposure'>>;

function readTool(input: ToolInput): CatalogTool {
  return {
    outputSchema: objectOutput,
    exposure: ['internal', 'mcp'],
    limitKeys: [],
    ...input,
    version: '2.0.0',
    capabilityPackage: 'read',
    requiredCapabilities: ['email.read'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
  };
}

/**
 * Every effect requires a retry key — from the `Idempotency-Key` header over
 * HTTP, from the `idempotencyKey` argument over MCP — so a retried request can
 * never send, move or label twice.
 */
function effectTool(
  input: ToolInput & Pick<CatalogTool, 'capabilityPackage' | 'requiredCapabilities' | 'effect' | 'rollback'>,
): CatalogTool {
  return {
    outputSchema: objectOutput,
    exposure: ['internal', 'mcp'],
    limitKeys: [],
    ...input,
    version: '2.0.0',
    idempotency: 'required',
  };
}

function organizeTool(input: ToolInput): CatalogTool {
  return effectTool({
    ...input,
    capabilityPackage: 'administer',
    requiredCapabilities: ['email.organize'],
    effect: 'write',
    rollback: 'manual',
  });
}

const byEmailId = {
  type: 'object',
  properties: { emailId },
  required: ['emailId'],
  additionalProperties: false,
} as const;
const pageLimit: CatalogTool['limitKeys'] = [{ key: 'limit', kind: 'maximum_number' }];

export const INBOX_CAPABILITY_CATALOG: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '2.0.0',
  audience: 'oxy-inbox-api',
  internalBaseUrl: 'https://api.oxy.so',
  externalMcp: { resource: 'https://mcp.inbox.oxy.so' },
  accountResourceType: 'email_account',
  tools: [
    // ─── Finding email ────────────────────────────────────────────────
    readTool({
      name: 'listEmails',
      description: 'Browse email newest first (pinned emails first), like opening a folder. '
        + 'Without filters this lists the inbox; `mailbox` picks another folder, and `starred` or `label` '
        + 'without `mailbox` list matching email across all folders. `unreadOnly` keeps only unread email. '
        + `${DESCRIPTION_SUFFIX.summaries} ${DESCRIPTION_SUFFIX.scope}`,
      inputSchema: {
        type: 'object',
        properties: {
          mailbox,
          starred: { type: 'boolean', description: 'Only starred email.' },
          label: { type: 'string', minLength: 1, maxLength: 255, description: 'Only email with this label name (see listLabels).' },
          unreadOnly: { type: 'boolean', description: 'Only unread email.' },
          limit: pageSize,
          cursor,
        },
        additionalProperties: false,
      },
      limitKeys: pageLimit,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/messages' },
    }),
    readTool({
      name: 'getUnreadEmails',
      description: 'List unread email, newest first, across every folder (spam and trash included) unless '
        + '`mailbox` narrows it — pass `mailbox: "inbox"` for what the owner would call their unread mail. '
        + `${DESCRIPTION_SUFFIX.summaries} ${DESCRIPTION_SUFFIX.scope}`,
      inputSchema: {
        type: 'object',
        properties: { mailbox, limit: pageSize, cursor },
        additionalProperties: false,
      },
      limitKeys: pageLimit,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/unread' },
    }),
    readTool({
      name: 'searchEmails',
      description: 'Search email. `q` is full-text over subject and body in web-search syntax ("exact phrase", '
        + 'OR, -excluded) and also understands is:unread and is:read. Combine it with, or use instead: '
        + '`from`/`to`/`subject` (case-insensitive substring of the address or subject), `mailbox`, `label`, '
        + '`starred`, `unread`, `hasAttachment`, `dateAfter`/`dateBefore` (ISO 8601 dates). At least one '
        + 'criterion is required — to browse a folder use listEmails. Best matches first. '
        + `${DESCRIPTION_SUFFIX.summaries} ${DESCRIPTION_SUFFIX.scope}`,
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: 500, description: 'Full-text query.' },
          from: { type: 'string', maxLength: 128, description: 'Sender address or name fragment.' },
          to: { type: 'string', maxLength: 128, description: 'Recipient address fragment.' },
          subject: { type: 'string', maxLength: 128, description: 'Subject fragment.' },
          mailbox,
          label: { type: 'string', minLength: 1, maxLength: 255, description: 'Label name (see listLabels).' },
          starred: { type: 'boolean', description: 'true: only starred email.' },
          unread: { type: 'boolean', description: 'true: only unread; false: only read.' },
          hasAttachment: { type: 'boolean', description: 'true: only email with attachments.' },
          dateAfter: { type: 'string', maxLength: 40, description: 'Sent on or after, ISO 8601 (e.g. 2026-09-01).' },
          dateBefore: { type: 'string', maxLength: 40, description: 'Sent on or before, ISO 8601.' },
          limit: pageSize,
          cursor,
        },
        additionalProperties: false,
      },
      limitKeys: pageLimit,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/search' },
    }),
    readTool({
      name: 'readEmail',
      description: 'Read one email in full — body (text and html), sender, recipients, attachments and labels. '
        + 'Reading does not mark it as read; use updateEmailFlags with `seen: true` for that. '
        + DESCRIPTION_SUFFIX.scope,
      inputSchema: byEmailId,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/messages/{emailId}' },
    }),
    readTool({
      name: 'getEmailThread',
      description: 'Read the whole conversation an email belongs to, oldest first, bodies included — use it '
        + 'before replying to understand the context. '
        + DESCRIPTION_SUFFIX.scope,
      inputSchema: byEmailId,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'GET', path: '/email/messages/{emailId}/thread' },
    }),
    readTool({
      name: 'listMailboxes',
      description: 'List the account\'s mailboxes (folders) with their `id`, name, special use '
        + '(inbox, sent, drafts, archive, trash, spam, snoozed) and total and unread counts.',
      inputSchema: emptyInput,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/mailboxes' },
    }),
    readTool({
      name: 'listLabels',
      description: 'List the labels that can be put on email: built-in ones and the owner\'s own. '
        + 'Use the label `name` with listEmails, searchEmails and setEmailLabels.',
      inputSchema: emptyInput,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/labels' },
    }),
    readTool({
      name: 'suggestContacts',
      description: 'Find email addresses by a name or address fragment (at least 2 characters), from the '
        + 'address book and past correspondence, most used first. Use it to turn "email Ana" into an address '
        + 'before sending — never guess an address.',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string', minLength: 2, maxLength: 128, description: 'Name or address fragment.' } },
        required: ['q'],
        additionalProperties: false,
      },
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/contacts/suggest' },
    }),
    readTool({
      name: 'getEmailQuota',
      description: 'Read the account\'s email storage use: bytes used, the limit and the percentage.',
      inputSchema: emptyInput,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/quota' },
    }),
    readTool({
      name: 'listOutboundEmails',
      description: 'Delivery status of recently sent email, newest first: pending, processing, sent, failed or '
        + 'cancelled, with the attempts made and the last error. Use it to confirm an email went out. Each '
        + 'entry\'s `messageId` is the RFC Message-ID the send returned; its `id` is what cancelOutboundEmail takes.',
      inputSchema: {
        type: 'object',
        properties: { limit: pageSize },
        additionalProperties: false,
      },
      limitKeys: pageLimit,
      resourceTypes: ['email_account'],
      invocation: { method: 'GET', path: '/email/outbox' },
    }),
    {
      ...readTool({
        name: 'getEmailContext',
        description: 'A compact snapshot for planning: the mailboxes with total and unread counts, the most '
          + 'recent unread email and which of those likely need a reply. In this snapshot an email\'s '
          + '`messageId` field is its `id`, usable as `emailId` with the other tools. '
          + DESCRIPTION_SUFFIX.scope,
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              default: INBOX_DEFAULT_PAGE_SIZE,
              description: `Maximum unread emails in the snapshot (default ${INBOX_DEFAULT_PAGE_SIZE}).`,
            },
          },
          additionalProperties: false,
        },
        limitKeys: pageLimit,
        resourceTypes: ['mailbox', 'email_account'],
        invocation: { method: 'GET', path: '/email/ai-context' },
      }),
      exposure: ['internal'],
    },

    // ─── Writing ──────────────────────────────────────────────────────
    effectTool({
      name: 'sendEmail',
      description: 'Send a new email from the account\'s own address now, or later with `scheduledAt`. To answer '
        + 'an email use replyToEmail instead: it fills the recipients, subject and threading. Resolve names to '
        + 'addresses with suggestContacts first. The result\'s `messageId` is the RFC Message-ID; '
        + 'listOutboundEmails shows whether delivery succeeded. Delivered email cannot be recalled.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { ...recipients, minItems: 1 },
          cc: recipients,
          bcc: recipients,
          subject: { type: 'string', maxLength: 998 },
          text,
          html,
          attachments,
          scheduledAt,
          inReplyTo: { ...rfcMessageId, description: `Only to thread by hand; replyToEmail does it for you. ${rfcMessageId.description}` },
          references: { type: 'array', items: rfcMessageId, maxItems: 100 },
          requestReadReceipt: { type: 'boolean' },
        },
        required: ['to'],
        additionalProperties: false,
      },
      capabilityPackage: 'communicate',
      requiredCapabilities: ['email.send'],
      effect: 'external',
      rollback: 'none',
      resourceTypes: ['email_account'],
      invocation: { method: 'POST', path: '/email/messages' },
    }),
    effectTool({
      name: 'replyToEmail',
      description: 'Reply to an email, now or later with `scheduledAt`. The reply goes to the sender (with '
        + '`replyAll`, also to everyone else on the email except this account), gets a "Re:" subject and is '
        + 'threaded into the same conversation. Write only the new text; the original is not quoted. '
        + '`cc`/`bcc` add recipients. Delivered email cannot be recalled.',
      inputSchema: {
        type: 'object',
        properties: {
          emailId,
          text,
          html,
          replyAll: { type: 'boolean', description: 'Also reply to the other recipients (default false).' },
          cc: recipients,
          bcc: recipients,
          attachments,
          scheduledAt,
        },
        required: ['emailId'],
        additionalProperties: false,
      },
      capabilityPackage: 'communicate',
      requiredCapabilities: ['email.send'],
      effect: 'external',
      rollback: 'none',
      resourceTypes: ['email_account'],
      invocation: { method: 'POST', path: '/email/messages/{emailId}/reply' },
    }),
    effectTool({
      name: 'createDraft',
      description: 'Save an email as a draft in the Drafts mailbox WITHOUT sending it, for the owner to review '
        + 'and send from Inbox. With `replyToEmailId` it is a reply draft: recipients, "Re:" subject and threading '
        + 'come from that email as in replyToEmail, and any field given here overrides them.',
      inputSchema: {
        type: 'object',
        properties: {
          replyToEmailId: { ...emailId, description: `Draft a reply to this email. ${emailId.description}` },
          replyAll: { type: 'boolean', description: 'With replyToEmailId: address everyone on the email.' },
          to: recipients,
          cc: recipients,
          bcc: recipients,
          subject: { type: 'string', maxLength: 998 },
          text,
          html,
          attachments,
        },
        additionalProperties: false,
      },
      capabilityPackage: 'create',
      // A draft never leaves the owner's mailbox, so it is organizing it, not
      // sending. It must be one of the capabilities Inbox already publishes as
      // OAuth scopes (`scopes_supported`): a new one is a new scope for every
      // external MCP client and every existing grant, and the deploy's MCP smoke
      // pins the published set.
      requiredCapabilities: ['email.organize'],
      effect: 'write',
      rollback: 'manual',
      resourceTypes: ['email_account'],
      invocation: { method: 'POST', path: '/email/drafts' },
    }),
    effectTool({
      name: 'cancelOutboundEmail',
      description: 'Stop an email that failed to deliver and is waiting to retry (status pending or failed in '
        + 'listOutboundEmails), by that entry\'s `id`. Email already handed to the mail relay cannot be stopped.',
      inputSchema: {
        type: 'object',
        properties: {
          outboxId: { type: 'string', minLength: 1, maxLength: 255, description: 'The `id` of a listOutboundEmails entry.' },
        },
        required: ['outboxId'],
        additionalProperties: false,
      },
      capabilityPackage: 'communicate',
      requiredCapabilities: ['email.send'],
      effect: 'write',
      rollback: 'none',
      resourceTypes: ['email_account'],
      invocation: { method: 'POST', path: '/email/outbox/{outboxId}/cancel' },
    }),

    // ─── Organizing ──────────────────────────────────────────────────
    // A mailbox-scoped caller may act on email IN its mailbox, including moving
    // it out (triage is the point of that authority); it can never reach email
    // in any other mailbox. `inbox.tools.ts` enforces both halves.
    organizeTool({
      name: 'archiveEmail',
      description: 'Archive an email: move it to the Archive mailbox, out of the inbox. Undo with moveEmail '
        + 'to `inbox`.',
      inputSchema: byEmailId,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'POST', path: '/email/messages/{emailId}/archive' },
    }),
    organizeTool({
      name: 'trashEmail',
      description: 'Move an email to Trash, where it is deleted permanently after 30 days. Until then it can '
        + 'be restored with moveEmail to `inbox`. This tool never deletes permanently.',
      inputSchema: byEmailId,
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'POST', path: '/email/messages/{emailId}/trash' },
    }),
    organizeTool({
      name: 'moveEmail',
      description: 'Move an email to another mailbox. For the usual cases archiveEmail and trashEmail say it '
        + 'more directly; use this for spam, back to the inbox, or a custom folder.',
      inputSchema: {
        type: 'object',
        properties: { emailId, mailbox: { ...mailbox, description: `Destination. ${mailbox.description}` } },
        required: ['emailId', 'mailbox'],
        additionalProperties: false,
      },
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'POST', path: '/email/messages/{emailId}/move' },
    }),
    organizeTool({
      name: 'updateEmailFlags',
      description: 'Mark an email read or unread (`seen`), starred or unstarred, pinned or unpinned. Only the '
        + 'flags given change.',
      inputSchema: {
        type: 'object',
        properties: {
          emailId,
          flags: {
            type: 'object',
            properties: {
              seen: { type: 'boolean', description: 'true = read, false = unread.' },
              starred: { type: 'boolean' },
              pinned: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        required: ['emailId', 'flags'],
        additionalProperties: false,
      },
      limitKeys: [
        { key: 'flags.seen', kind: 'exact_boolean' },
        { key: 'flags.starred', kind: 'exact_boolean' },
        { key: 'flags.pinned', kind: 'exact_boolean' },
      ],
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'PUT', path: '/email/messages/{emailId}/flags' },
    }),
    organizeTool({
      name: 'setEmailLabels',
      description: 'Add and/or remove labels on an email, by label name (see listLabels; a label must exist '
        + 'before it can be added). Labels not named stay as they are.',
      inputSchema: {
        type: 'object',
        properties: {
          emailId,
          add: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 50 },
          remove: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 255 }, maxItems: 50 },
        },
        required: ['emailId'],
        additionalProperties: false,
      },
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'PUT', path: '/email/messages/{emailId}/labels' },
    }),
    organizeTool({
      name: 'snoozeEmail',
      description: 'Snooze an email until a later time: it moves to the Snoozed mailbox and comes back to where '
        + 'it was, marked unread, at `until`. Snoozing a snoozed email changes its time.',
      inputSchema: {
        type: 'object',
        properties: {
          emailId,
          until: {
            type: 'string',
            maxLength: 64,
            description: 'When it comes back: an ISO 8601 date-time in the future with a timezone, '
              + 'e.g. 2026-10-02T09:00:00Z.',
          },
        },
        required: ['emailId', 'until'],
        additionalProperties: false,
      },
      resourceTypes: ['mailbox', 'email_account'],
      invocation: { method: 'POST', path: '/email/messages/{emailId}/snooze' },
    }),
  ],
  events: [
    {
      type: 'new_email', version: '1.1.0',
      description: 'An email arrived in a mailbox. `messageId` is the email\'s `id` (use it as `emailId`). '
        + '`snippet` is the one-line list preview (at most 140 characters, never the body); `folder` is `spam` when it was filed in Junk.',
      dataSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          mailboxId: { type: 'string' },
          from: { type: 'string' },
          subject: { type: 'string' },
          snippet: { type: 'string', maxLength: 140 },
          folder: { type: 'string', enum: ['inbox', 'spam'] },
        },
        required: ['messageId', 'mailboxId'], additionalProperties: false,
      },
      resourceTypes: ['mailbox'],
    },
    {
      type: 'email_needs_reply', version: '1.0.0',
      description: 'An arrived email is likely to need a reply. `messageId` is the email\'s `id` (use it as `emailId`).',
      dataSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' }, mailboxId: { type: 'string' }, reason: { type: 'string' } },
        required: ['messageId', 'mailboxId', 'reason'], additionalProperties: false,
      },
      resourceTypes: ['mailbox'],
    },
  ],
};
