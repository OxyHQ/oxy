import {
  emailTicketSchema,
  emailVerificationConfirmRequestSchema,
  emailVerificationStartRequestSchema,
} from '../accountEmail';

const TICKET = 'A'.repeat(43);

describe('email verification contracts', () => {
  it('stores a sign-up email trimmed and lowercase', () => {
    expect(emailVerificationStartRequestSchema.parse({ purpose: 'signup', email: '  Ada@Example.COM ' })).toEqual({
      purpose: 'signup',
      email: 'ada@example.com',
    });
  });

  it('is for sign-up only: there is no recovery purpose', () => {
    expect(emailVerificationStartRequestSchema.safeParse({ purpose: 'recovery', identifier: 'ada' }).success).toBe(false);
  });

  it('refuses a malformed email and an unknown purpose', () => {
    expect(emailVerificationStartRequestSchema.safeParse({ purpose: 'signup', email: 'not-an-email' }).success).toBe(false);
    expect(emailVerificationStartRequestSchema.safeParse({ purpose: 'login', email: 'ada@example.com' }).success).toBe(false);
  });

  it('takes exactly six digits as a code', () => {
    expect(emailVerificationConfirmRequestSchema.safeParse({ verificationId: 'v', code: '012345' }).success).toBe(true);
    expect(emailVerificationConfirmRequestSchema.safeParse({ verificationId: 'v', code: '12345' }).success).toBe(false);
    expect(emailVerificationConfirmRequestSchema.safeParse({ verificationId: 'v', code: '12345a' }).success).toBe(false);
  });

  it('takes a ticket of 32 base64url bytes only', () => {
    expect(emailTicketSchema.safeParse(TICKET).success).toBe(true);
    expect(emailTicketSchema.safeParse(`${TICKET}=`).success).toBe(false);
    expect(emailTicketSchema.safeParse('A'.repeat(42)).success).toBe(false);
  });

  it('confirms a code alone: an authenticator code is not part of it', () => {
    expect(
      emailVerificationConfirmRequestSchema.safeParse({ verificationId: 'v', code: '012345', totpCode: '123456' }).success,
    ).toBe(false);
  });
});
