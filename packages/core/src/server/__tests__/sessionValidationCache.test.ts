/**
 * `server.session.validate` reuses a successful bearer validation for a short
 * TTL, never a failure, and forgets it on the `oxy:user:invalidate` signal.
 */
import { OxyServer } from '../OxyServer';
import { createOxyUserInvalidationHandler } from '../userInvalidation';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims: object) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.sig`;

function setup(config: { sessionValidationCacheTtlMs?: number } = {}) {
  const server = new OxyServer({ baseURL: 'https://api.oxy.test', ...config });
  const request = jest
    .spyOn(server, 'request')
    .mockResolvedValue({ valid: true, user: { id: 'user-1' } } as never);
  const bearer = token({ sessionId: 'session-1', userId: 'user-1' });
  const validate = (options: { fresh?: boolean } = {}) =>
    server.session.validate('session-1', { accessToken: bearer, ...options });
  return { server, request, validate };
}

describe('server.session.validate cache', () => {
  it('reuses a success, refreshes on fresh, and drops it on a user invalidation', async () => {
    const { server, request, validate } = setup();

    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(1);

    await validate({ fresh: true });
    expect(request).toHaveBeenCalledTimes(2);

    createOxyUserInvalidationHandler({ oxy: server })(
      JSON.stringify({ userId: 'user-1', reason: 'profile', at: 1 }),
    );
    await validate();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('never caches a refusal, and a refusal evicts the session', async () => {
    const { request, validate } = setup();
    await validate();

    request.mockRejectedValueOnce(Object.assign(new Error('revoked'), { status: 401 }));
    await expect(validate({ fresh: true })).rejects.toThrow('revoked');
    await expect(validate()).resolves.toMatchObject({ valid: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('is off at a zero TTL', async () => {
    const { request, validate } = setup({ sessionValidationCacheTtlMs: 0 });
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
