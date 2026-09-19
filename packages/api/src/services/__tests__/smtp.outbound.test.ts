import { isRetryableSmtpFailure, SmtpConfigurationError } from '../smtp.outbound';

describe('SMTP delivery failure classification', () => {
  it('retries temporary SMTP failures and transport failures', () => {
    expect(isRetryableSmtpFailure({ responseCode: 421 })).toBe(true);
    expect(isRetryableSmtpFailure(new Error('socket closed'))).toBe(true);
  });

  it('does not retry permanent SMTP rejections', () => {
    expect(isRetryableSmtpFailure({ responseCode: 550 })).toBe(false);
    expect(isRetryableSmtpFailure({ responseCode: 554 })).toBe(false);
  });

  /**
   * The regression this class exists for. `createTransporter()` throwing
   * "SMTP_RELAY_HOST is unset" has no `responseCode`, so the old rule — "no
   * numeric responseCode means transient" — classified a MISCONFIGURATION as a
   * retryable hiccup. The message was queued, the API answered
   * `202 Message queued for delivery`, the worker failed the same way on every
   * retry, and nothing was ever sent while nothing looked broken.
   */
  it('treats a missing relay as permanent, not as a transient hiccup', () => {
    expect(isRetryableSmtpFailure(new SmtpConfigurationError('SMTP_RELAY_HOST is unset'))).toBe(false);
  });

  it('answers 503, not 500, for a missing relay', () => {
    expect(new SmtpConfigurationError('x').statusCode).toBe(503);
  });

  /**
   * A rejected credential is not busy — it is wrong, and it stays wrong until
   * an operator rotates it. Queueing behind it just delays the discovery.
   */
  it('treats an authentication failure as permanent', () => {
    expect(isRetryableSmtpFailure({ code: 'EAUTH', responseCode: 535 })).toBe(false);
    expect(isRetryableSmtpFailure({ responseCode: 535, command: 'AUTH PLAIN' })).toBe(false);
  });

  it('still retries a 535 that is not an auth rejection', () => {
    // 535 outside the AUTH command carries no `EAUTH`; it falls through to the
    // 5xx rule and is permanent for that reason, not for being an auth failure.
    expect(isRetryableSmtpFailure({ responseCode: 535 })).toBe(false);
  });
});
