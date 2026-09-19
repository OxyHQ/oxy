/**
 * Bounce/complaint ingestion — the authenticity half.
 *
 * Every row this route writes takes away someone's ability to email an address.
 * An endpoint that accepted unverified notifications would be a
 * denial-of-service primitive: post fabricated bounces and the platform stops
 * talking to whoever you name. These tests pin the control that prevents the
 * subtle version of that attack — an otherwise well-formed SNS message that
 * points the verifier at a certificate the attacker controls, so the signature
 * checks out against the wrong key.
 */

import { extractAngleAddress, isAmazonSigningCertUrl, snsStringToSign } from '../emailFeedback';

describe('isAmazonSigningCertUrl', () => {
  it('accepts Amazon SNS signing hosts', () => {
    expect(isAmazonSigningCertUrl('https://sns.us-west-2.amazonaws.com/SimpleNotificationService-abc.pem')).toBe(true);
    expect(isAmazonSigningCertUrl('https://sns.eu-west-1.amazonaws.com/x.pem')).toBe(true);
    expect(isAmazonSigningCertUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem')).toBe(true);
  });

  it('rejects a certificate URL an attacker controls', () => {
    // The whole attack: valid-looking payload, signature verifies — against the
    // attacker's key, because they chose where the key came from.
    expect(isAmazonSigningCertUrl('https://evil.example.com/cert.pem')).toBe(false);
    expect(isAmazonSigningCertUrl('https://sns.us-west-2.amazonaws.com.evil.example.com/x.pem')).toBe(false);
    expect(isAmazonSigningCertUrl('https://evil.example.com/sns.us-west-2.amazonaws.com/x.pem')).toBe(false);
    expect(isAmazonSigningCertUrl('https://amazonaws.com/x.pem')).toBe(false);
  });

  it('rejects a host with an extra label in front', () => {
    // `evil.sns.us-west-2.amazonaws.com` is a host the attacker can own under a
    // domain they control that ends the same way; only pinning the position of
    // every label rejects it.
    expect(isAmazonSigningCertUrl('https://evil.sns.us-west-2.amazonaws.com/x.pem')).toBe(false);
    expect(isAmazonSigningCertUrl('https://sns.amazonaws.com/x.pem')).toBe(false);
  });

  it('rejects a region label that is not shaped like one', () => {
    expect(isAmazonSigningCertUrl('https://sns.evil.amazonaws.com/x.pem')).toBe(false);
  });

  it('rejects credentials embedded in the URL', () => {
    expect(isAmazonSigningCertUrl('https://user:pw@sns.us-west-2.amazonaws.com/x.pem')).toBe(false);
  });

  it('rejects plaintext and malformed URLs', () => {
    expect(isAmazonSigningCertUrl('http://sns.us-west-2.amazonaws.com/x.pem')).toBe(false);
    expect(isAmazonSigningCertUrl('not a url')).toBe(false);
    expect(isAmazonSigningCertUrl('')).toBe(false);
  });
});

describe('snsStringToSign', () => {
  it('uses the Notification field order Amazon signs', () => {
    expect(
      snsStringToSign({
        Type: 'Notification',
        MessageId: 'm1',
        TopicArn: 't1',
        Subject: 's1',
        Message: 'body',
        Timestamp: 'ts',
      }),
    ).toBe('Message\nbody\nMessageId\nm1\nSubject\ns1\nTimestamp\nts\nTopicArn\nt1\nType\nNotification\n');
  });

  it('skips Subject when absent rather than signing an empty one', () => {
    // Amazon omits the field entirely; emitting `Subject\n\n` makes every
    // signature fail for a reason nothing reports.
    expect(
      snsStringToSign({ Type: 'Notification', MessageId: 'm1', TopicArn: 't1', Message: 'b', Timestamp: 'ts' }),
    ).toBe('Message\nb\nMessageId\nm1\nTimestamp\nts\nTopicArn\nt1\nType\nNotification\n');
  });

  it('uses the confirmation field order for a subscription confirmation', () => {
    expect(
      snsStringToSign({
        Type: 'SubscriptionConfirmation',
        MessageId: 'm1',
        TopicArn: 't1',
        Message: 'b',
        Timestamp: 'ts',
        Token: 'tok',
        SubscribeURL: 'https://sns.us-west-2.amazonaws.com/?x=1',
      }),
    ).toBe(
      'Message\nb\nMessageId\nm1\nSubscribeURL\nhttps://sns.us-west-2.amazonaws.com/?x=1\n'
      + 'Timestamp\nts\nToken\ntok\nTopicArn\nt1\nType\nSubscriptionConfirmation\n',
    );
  });

  it('refuses an unknown message type instead of signing something arbitrary', () => {
    expect(snsStringToSign({ Type: 'SomethingElse', MessageId: 'm' })).toBeNull();
  });
});

describe('extractAngleAddress', () => {
  it('pulls the address out of a display-name header', () => {
    expect(extractAngleAddress('Nate <nate@oxy.so>')).toBe('nate@oxy.so');
  });

  it('accepts a bare address', () => {
    expect(extractAngleAddress('  Nate@Oxy.SO ')).toBe('nate@oxy.so');
  });

  /**
   * The reason this is not a regex. `/<([^>]+)>/` against this input backtracks
   * quadratically, on an endpoint anyone can POST to. Asserting the bound
   * rather than the shape: a regex would not return promptly.
   */
  it('returns promptly on pathological input', () => {
    const hostile = '<'.repeat(50_000);
    const started = Date.now();
    expect(extractAngleAddress(hostile)).toBe(hostile.toLowerCase());
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('ignores an unclosed bracket instead of scanning for one', () => {
    expect(extractAngleAddress('Nate <nate@oxy.so')).toBe('nate <nate@oxy.so');
  });
});
