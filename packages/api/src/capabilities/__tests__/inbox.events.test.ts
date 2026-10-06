import { buildInboxMessageEvents } from '../inbox.events';

const base = {
  ownerAccountId: 'account-1',
  mailboxId: 'mailbox-1',
  messageId: 'message-1',
  senderAddress: 'person@example.com',
  subject: 'Can you review this?',
  headers: {},
  receivedAt: new Date('2026-09-02T10:00:00.000Z'),
  snippet: 'Here is the draft, could you review it by Friday?',
  folder: 'inbox' as const,
};

describe('Inbox normalized events', () => {
  it('binds new mail and response-needed events to the exact account and mailbox', () => {
    expect(buildInboxMessageEvents(base)).toEqual([
      expect.objectContaining({
        eventId: 'message-1:new_email',
        appId: 'inbox',
        accountId: 'account-1',
        resource: {
          appId: 'inbox', effectiveAccountId: 'account-1',
          resourceType: 'mailbox', resourceId: 'mailbox-1',
        },
        type: 'new_email',
      }),
      expect.objectContaining({
        eventId: 'message-1:email_needs_reply',
        type: 'email_needs_reply',
        resource: expect.objectContaining({ resourceId: 'mailbox-1' }),
      }),
    ]);
  });

  it('does not claim that automated mail needs a response', () => {
    const events = buildInboxMessageEvents({
      ...base,
      senderAddress: 'no-reply@example.com',
      headers: { 'auto-submitted': 'auto-generated' },
    });
    expect(events.map((event) => event.type)).toEqual(['new_email']);
  });

  it('keeps the durable event projection minimal and never copies message headers', () => {
    const events = buildInboxMessageEvents({
      ...base,
      headers: {
        authorization: 'Bearer must-not-be-persisted',
        'x-private-routing': 'must-not-be-persisted',
      },
    });

    expect(events[0]?.data).toEqual({
      messageId: 'message-1',
      mailboxId: 'mailbox-1',
      from: 'person@example.com',
      subject: 'Can you review this?',
      snippet: 'Here is the draft, could you review it by Friday?',
      folder: 'inbox',
    });
    expect(events[1]?.data).toEqual({
      messageId: 'message-1',
      mailboxId: 'mailbox-1',
      reason: 'Direct non-automated incoming message',
    });
    expect(JSON.stringify(events)).not.toContain('must-not-be-persisted');
  });

  it('carries at most the one-line preview, never more of the body', () => {
    const [event] = buildInboxMessageEvents({ ...base, snippet: 'y'.repeat(1000) });
    expect(String(event?.data.snippet)).toHaveLength(140);
  });

  it('marks Junk as spam and never claims spam needs a reply', () => {
    const events = buildInboxMessageEvents({ ...base, folder: 'spam' });
    expect(events.map((event) => event.type)).toEqual(['new_email']);
    expect(events[0]?.data.folder).toBe('spam');
  });
});
