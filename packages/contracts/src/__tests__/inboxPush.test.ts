/**
 * Inbox push wire-contract regression tests.
 */

import {
  INBOX_EMAIL_PUSH_CHANNEL,
  INBOX_EMAIL_PUSH_TYPE,
  inboxEmailPushDataSchema,
} from '../inboxPush';

describe('inboxPush contracts', () => {
  it('pins the Android channel id', () => {
    expect(INBOX_EMAIL_PUSH_CHANNEL).toBe('email');
  });

  it('pins the payload type discriminator', () => {
    expect(INBOX_EMAIL_PUSH_TYPE).toBe('oxy_inbox_new_message');
  });

  it('validates a well-formed push data payload', () => {
    const parsed = inboxEmailPushDataSchema.safeParse({
      type: INBOX_EMAIL_PUSH_TYPE,
      messageId: 'msg-1',
      mailboxId: 'mbox-1',
    });
    expect(parsed.success).toBe(true);
  });
});
