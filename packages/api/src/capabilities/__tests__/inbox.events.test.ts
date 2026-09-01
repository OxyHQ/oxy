import { buildInboxMessageEvents } from '../inbox.events';

const base = {
  ownerAccountId: 'account-1',
  mailboxId: 'mailbox-1',
  messageId: 'message-1',
  senderAddress: 'person@example.com',
  subject: 'Can you review this?',
  headers: {},
  receivedAt: new Date('2026-09-02T10:00:00.000Z'),
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
        eventId: 'message-1:email_needs_response',
        type: 'email_needs_response',
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
});
