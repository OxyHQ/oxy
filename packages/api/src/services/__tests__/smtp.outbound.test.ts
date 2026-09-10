import { isRetryableSmtpFailure } from '../smtp.outbound';

describe('SMTP delivery failure classification', () => {
  it('retries temporary SMTP failures and transport failures', () => {
    expect(isRetryableSmtpFailure({ responseCode: 421 })).toBe(true);
    expect(isRetryableSmtpFailure(new Error('socket closed'))).toBe(true);
  });

  it('does not retry permanent SMTP rejections', () => {
    expect(isRetryableSmtpFailure({ responseCode: 550 })).toBe(false);
    expect(isRetryableSmtpFailure({ responseCode: 554 })).toBe(false);
  });
});
