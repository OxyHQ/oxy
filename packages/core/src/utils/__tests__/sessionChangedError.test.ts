import { isUnauthorizedError } from '../../shared/utils/errorUtils';
import { isAuthenticationError, withAuthErrorHandling } from '../authHelpers';
import type { OxyServices } from '../../OxyServices';

it('does not classify a locally superseded request as a server 401 or retry it', async () => {
  const changed = { code: 'AUTH_SESSION_CHANGED', status: 401 };
  const syncSession = jest.fn();
  expect(isUnauthorizedError(changed)).toBe(false);
  expect(isAuthenticationError(changed)).toBe(false);
  await expect(
    withAuthErrorHandling(
      async () => {
        throw changed;
      },
      { syncSession, oxyServices: {} as OxyServices },
    ),
  ).rejects.toBe(changed);
  expect(syncSession).not.toHaveBeenCalled();
});

it('continues to classify a genuine 401 as an authentication failure', () => {
  const unauthorized = { code: 'UNAUTHORIZED', status: 401 };
  expect(isUnauthorizedError(unauthorized)).toBe(true);
  expect(isAuthenticationError(unauthorized)).toBe(true);
});
