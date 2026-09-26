import { EMAIL_VERIFICATION_PURPOSES } from '../accountEmail';
import { identityLinkCompleteRequestSchema } from '../identityLink';
import {
  emailReauthProofSchema,
  emailSignInLinkRequestSchema,
  emailSignInStartRequestSchema,
  isSecondFactorRequired,
  passwordSetRequestSchema,
  passwordSignInRequestSchema,
  reauthProofSchema,
  secondFactorRequiredSchema,
  signUpRequestSchema,
  totpBackupCodesResponseSchema,
  totpEnrollResponseSchema,
} from '../signIn';

const TOKEN = 'A'.repeat(43);
const DEVICE = { deviceId: 'device-1', deviceSecret: 'secret-1' };

describe('sign-in contracts', () => {
  it('knows the sign-in and re-verification code purposes', () => {
    expect(EMAIL_VERIFICATION_PURPOSES).toEqual(['signup', 'recovery', 'signin', 'reauth']);
  });

  it('starts an email sign-in with an identifier and, optionally, the device', () => {
    expect(emailSignInStartRequestSchema.parse({ identifier: ' ada ', device: DEVICE })).toEqual({ identifier: 'ada', device: DEVICE });
    expect(emailSignInStartRequestSchema.safeParse({ identifier: '' }).success).toBe(false);
    // No stray fields: a caller cannot name a device id without proving it.
    expect(emailSignInStartRequestSchema.safeParse({ identifier: 'ada', deviceId: 'x' }).success).toBe(false);
  });

  it('requires a device proof to approve a link', () => {
    expect(emailSignInLinkRequestSchema.safeParse({ token: TOKEN }).success).toBe(false);
    expect(emailSignInLinkRequestSchema.safeParse({ token: TOKEN, device: DEVICE }).success).toBe(true);
    expect(emailSignInLinkRequestSchema.safeParse({ token: 'short', device: DEVICE }).success).toBe(false);
  });

  it('accepts any typed password at sign-in but enforces length when setting one', () => {
    expect(passwordSignInRequestSchema.safeParse({ identifier: 'ada', password: 'x' }).success).toBe(true);
    const reauth = { password: 'current password' };
    expect(passwordSetRequestSchema.safeParse({ newPassword: 'short', reauth }).success).toBe(false);
    expect(passwordSetRequestSchema.safeParse({ newPassword: 'long enough!', reauth }).success).toBe(true);
    expect(passwordSetRequestSchema.safeParse({ newPassword: 'x'.repeat(257), reauth }).success).toBe(false);
  });

  it('needs a password or an email code in every proof', () => {
    expect(reauthProofSchema.safeParse({ totpCode: '123456' }).success).toBe(false);
    expect(reauthProofSchema.safeParse({ emailCode: { verificationId: 'v', code: '12345' } }).success).toBe(false);
    expect(reauthProofSchema.safeParse({ emailCode: { verificationId: 'v', code: '123456' }, totpCode: '654321' }).success).toBe(true);
    expect(emailReauthProofSchema.safeParse({ password: 'nope' }).success).toBe(false);
  });

  it('completes a Commons link with an email proof or a passkey, never both or neither', () => {
    const reauth = { emailCode: { verificationId: 'v', code: '123456' } };
    expect(identityLinkCompleteRequestSchema.safeParse({ reauth }).success).toBe(true);
    expect(identityLinkCompleteRequestSchema.safeParse({}).success).toBe(false);
    expect(identityLinkCompleteRequestSchema.safeParse({ reauth: { password: 'x' } }).success).toBe(false);
  });

  it('signs up with a username, an email and its ticket', () => {
    expect(signUpRequestSchema.parse({ username: 'ada', email: ' Ada@Example.com ', emailTicket: TOKEN }).email).toBe('ada@example.com');
    expect(signUpRequestSchema.safeParse({ username: 'ada', email: 'ada@example.com' }).success).toBe(false);
  });

  it('tells a second-factor step from a session', () => {
    const step = { secondFactorRequired: true as const, challengeId: TOKEN, expiresAt: 1 };
    expect(secondFactorRequiredSchema.safeParse(step).success).toBe(true);
    expect(isSecondFactorRequired(step)).toBe(true);
    expect(isSecondFactorRequired({ sessionId: 's', deviceId: 'd', expiresAt: 'x', user: { id: 'u' } })).toBe(false);
  });

  it('shapes the authenticator answers', () => {
    expect(totpEnrollResponseSchema.safeParse({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Oxy:ada?secret=JBSWY3DPEHPK3PXP' }).success).toBe(true);
    expect(totpEnrollResponseSchema.safeParse({ secret: 'lowercase', otpauthUri: 'otpauth://totp/x' }).success).toBe(false);
    const codes = Array.from({ length: 10 }, () => 'abcde-fghjk');
    expect(totpBackupCodesResponseSchema.safeParse({ backupCodes: codes }).success).toBe(true);
    expect(totpBackupCodesResponseSchema.safeParse({ backupCodes: codes.slice(1) }).success).toBe(false);
  });
});
