import { logoutIsolatedOAuthSession } from '../isolatedOAuthSession';

const session = { sessionId: 'isolated-session', clientId: 'oxy_dk_external' };
function deps() {
  return { session, revokeSelf: jest.fn().mockResolvedValue(undefined), clearSessionState: jest.fn().mockResolvedValue(undefined) };
}

it('revokes exactly itself before clearing runtime/cache/token state', async () => {
  const input = deps();
  await expect(logoutIsolatedOAuthSession(input)).resolves.toEqual({ status: 'signed-out' });
  expect(input.revokeSelf).toHaveBeenCalledWith(session.sessionId);
  expect(input.clearSessionState).toHaveBeenCalledTimes(1);
  expect(input.revokeSelf.mock.invocationCallOrder[0]).toBeLessThan(input.clearSessionState.mock.invocationCallOrder[0]);
});

it('rejects another target before contacting any revocation endpoint', async () => {
  const input = deps();
  expect((await logoutIsolatedOAuthSession({ ...input, targetSessionId: 'other-app-session' })).status).toBe('failed');
  expect(input.revokeSelf).not.toHaveBeenCalled();
  expect(input.clearSessionState).not.toHaveBeenCalled();
});

it('clears an already-invalid session on 401', async () => {
  const input = deps();
  input.revokeSelf.mockRejectedValue({ status: 401, code: 'INVALID_SESSION' });
  expect((await logoutIsolatedOAuthSession(input)).status).toBe('signed-out');
  expect(input.clearSessionState).toHaveBeenCalledTimes(1);
});

it('preserves the session when the server could not complete revocation', async () => {
  const input = deps();
  input.revokeSelf.mockRejectedValue({ status: 503 });
  expect((await logoutIsolatedOAuthSession(input)).status).toBe('failed');
  expect(input.clearSessionState).not.toHaveBeenCalled();
});
