import {
  emailTicketSchema,
  emailVerificationConfirmRequestSchema,
  emailVerificationStartRequestSchema,
} from '../accountEmail';
import { webauthnRegisterOptionsRequestSchema, webauthnRegisterVerifyRequestSchema } from '../webauthn';

const TICKET = 'A'.repeat(43);

describe('recovery email contracts', () => {
  it('stores a sign-up email trimmed and lowercase', () => {
    expect(emailVerificationStartRequestSchema.parse({ purpose: 'signup', email: '  Ada@Example.COM ' })).toEqual({
      purpose: 'signup',
      email: 'ada@example.com',
    });
  });

  it('recovers by username or email, and never takes an email field for recovery', () => {
    expect(emailVerificationStartRequestSchema.parse({ purpose: 'recovery', identifier: 'ada' })).toEqual({
      purpose: 'recovery',
      identifier: 'ada',
    });
    expect(emailVerificationStartRequestSchema.safeParse({ purpose: 'recovery', email: 'ada@example.com' }).success).toBe(false);
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

  it('carries the sign-up email and its ticket, and a recovery ticket, through registration', () => {
    expect(
      webauthnRegisterVerifyRequestSchema.parse({ username: 'ada', email: 'Ada@example.com', emailTicket: TICKET }),
    ).toEqual({ username: 'ada', email: 'ada@example.com', emailTicket: TICKET });
    expect(webauthnRegisterOptionsRequestSchema.parse({ recoveryTicket: TICKET })).toEqual({ recoveryTicket: TICKET });
    // The web identity enrollment is gone: an `identity` field is not part of the contract.
    expect(webauthnRegisterVerifyRequestSchema.parse({ username: 'ada', identity: {} })).toEqual({ username: 'ada' });
  });
});
