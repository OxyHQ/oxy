import { relayAssignedMessageId } from '../relayMessageId';

describe('relayAssignedMessageId', () => {
  it('reads the id SES substituted for ours from its 250 answer', () => {
    expect(
      relayAssignedMessageId(
        'email-smtp.us-west-2.amazonaws.com',
        '250 Ok 010101a0e167f1da-8a9cef8c-7895-4d67-ace3-1b62e41ee6a2-000000',
      ),
    ).toBe('<010101a0e167f1da-8a9cef8c-7895-4d67-ace3-1b62e41ee6a2-000000@us-west-2.amazonses.com>');
  });

  it('is null for a relay that keeps our Message-ID', () => {
    expect(relayAssignedMessageId('mail.oxy.so', '250 2.0.0 Ok: queued as 4ZQ1xK')).toBeNull();
  });

  it('is null when SES answers without an id', () => {
    expect(relayAssignedMessageId('email-smtp.eu-west-1.amazonaws.com', '250 Ok')).toBeNull();
    expect(relayAssignedMessageId('email-smtp.eu-west-1.amazonaws.com', undefined)).toBeNull();
  });
});
