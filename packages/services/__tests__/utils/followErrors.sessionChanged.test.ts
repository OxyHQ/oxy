import { toFollowErrorCode } from '../../src/ui/utils/followErrors';

it('does not describe a superseded request as a signed-out session', () => {
  expect(toFollowErrorCode({ code: 'AUTH_SESSION_CHANGED', status: 401 }, 'update_failed')).toBe(
    'update_failed',
  );
  expect(toFollowErrorCode({ code: 'UNAUTHORIZED', status: 401 }, 'update_failed')).toBe(
    'signed_out',
  );
});
