import {
  emailAttachmentSchema,
  emailContactSchema,
  emailMessageSchema,
  rfcMessageIdSchema,
} from '../email/messages';

const NOW = '2026-09-27T05:56:22.583Z';

function message(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'm1',
    id: 'm1',
    userId: 'u1',
    mailboxId: 'mb1',
    messageId: '<abc@example.com>',
    threadId: 'm1',
    from: { name: '', address: 'communications@ramp.com' },
    to: [{ name: 'Nate', address: 'nate@oxy.so' }],
    cc: [],
    bcc: [],
    subject: '977687 is your Ramp sign-in code',
    attachments: [],
    flags: { seen: false, starred: false, answered: false, forwarded: false, draft: false, pinned: false },
    labels: [],
    highlights: [],
    encrypted: false,
    spamScore: 0,
    spamAction: null,
    size: 1024,
    inReplyTo: null,
    references: [],
    aliasTag: null,
    snoozedUntil: null,
    snoozedFromMailbox: null,
    scheduledAt: null,
    readReceiptRequested: false,
    readReceiptSent: false,
    date: NOW,
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    draftRevision: 1,
    ...overrides,
  };
}

describe('email message wire contract', () => {
  it('accepts an attachment without a Content-ID, which the server sends as null', () => {
    const attachment = {
      fileId: 'f1',
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      size: 10,
      contentId: null,
      isInline: false,
    };
    expect(emailAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(emailMessageSchema.safeParse(message({ attachments: [attachment] })).success).toBe(true);
  });

  it('accepts a card whose extracted fields are all unknown', () => {
    const card = { type: 'purchase', data: null, confidence: null, extractedAt: null };
    expect(emailMessageSchema.parse(message({ card })).card).toEqual(card);
  });

  it('keeps working when the server adds a field', () => {
    const parsed = emailMessageSchema.parse(message({ somethingNew: 1 }));
    expect(parsed).not.toHaveProperty('somethingNew');
  });

  it('accepts a contact without company or notes', () => {
    expect(
      emailContactSchema.safeParse({
        _id: 'c1',
        id: 'c1',
        userId: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        company: null,
        notes: null,
        starred: false,
        autoCollected: true,
        lastContactedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
  });
});

describe('rfcMessageIdSchema', () => {
  it.each([
    '<abc@example.com>',
    '<010101a0e167f1da-8a9cef8c-000000@us-west-2.amazonses.com>',
    '<CAAvFJMOiMbDeL+fqoFbu7Khs+-=y+B=ZjLZGUUoquHA-kzv3jQ@mail.gmail.com>',
  ])('accepts %s', (id) => {
    expect(rfcMessageIdSchema.parse(id)).toBe(id);
  });

  it.each([
    '01a0821a-7395-7e43-bdb4-fa5166ea32d1',
    '<01a0821a-7395-7e43-bdb4-fa5166ea32d1>',
    'abc@example.com',
    '<a b@example.com>',
    '',
  ])('refuses %s — a row id or a bare address is not a Message-ID', (id) => {
    expect(rfcMessageIdSchema.safeParse(id).success).toBe(false);
  });
});
