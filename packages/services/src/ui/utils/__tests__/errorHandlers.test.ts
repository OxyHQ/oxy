import { isInvalidSessionError } from '../errorHandlers';

it('does not treat an acting-session mismatch as an expired bearer', () => {
  expect(
    isInvalidSessionError({
      status: 403,
      code: 'ACTING_SESSION_MISMATCH',
      message: 'Acting session does not match the authenticated session',
    }),
  ).toBe(false);
  expect(isInvalidSessionError({ status: 401, message: 'Invalid session' })).toBe(true);
});
