import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost } from '../SessionClient';
import { logger } from '../../logger';

const STATE = (rev: number): DeviceSessionState => ({
  deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: rev, updatedAt: 1720000000000,
});

function makeHost(makeRequest: jest.Mock): SessionClientHost {
  return {
    makeRequest,
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 't',
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => null,
  };
}

describe('SessionClient sync diagnostics', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs the failing zod issue path + code when a nested field is the wrong type', async () => {
    // authuser must be a non-negative integer; a string trips invalid_type at accounts[0].authuser.
    const badAuthuser = { accountId: 'a1', sessionId: 's1', authuser: 'not-a-number' };
    const state = { ...STATE(3), accounts: [badAuthuser] };
    const makeRequest = jest.fn().mockResolvedValueOnce({ state, activeToken: null });
    const c = new SessionClient(makeHost(makeRequest));

    await c.bootstrap();

    expect(c.getState()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[SessionClient] discarded invalid session sync',
      expect.objectContaining({ component: 'SessionClient' }),
    );
    const context = warnSpy.mock.calls[0][1];
    expect(context.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'state.accounts.0.authuser', code: 'invalid_type' }),
      ]),
    );
    // invalid_type issues carry TYPE names (safe), not values.
    const authuserIssue = context.issues.find((i: { path: string }) => i.path === 'state.accounts.0.authuser');
    expect(authuserIssue.received).toBe('string');
    expect(authuserIssue.expected).toBe('number');
    // Top-level envelope keys are summarized to catch drift.
    expect(context.keys).toEqual(['state', 'activeToken']);
  });

  it('never leaks token-like values into the logged diagnostics', async () => {
    // A valid-looking accessToken alongside an otherwise-invalid state must not surface in the log.
    const secretToken = 'jwt-SUPER-SECRET-ACCESS-TOKEN-abc123';
    const makeRequest = jest.fn().mockResolvedValueOnce({
      state: { deviceId: 'd1' /* missing required fields */ },
      activeToken: { accessToken: secretToken, expiresAt: 'x' },
    });
    const c = new SessionClient(makeHost(makeRequest));

    await c.bootstrap();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(warnSpy.mock.calls[0]);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain('SUPER-SECRET');
  });

  it('reports envelope drift via keys and a top-level invalid_type when raw is undefined', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(undefined);
    const c = new SessionClient(makeHost(makeRequest));

    await c.bootstrap();

    const context = warnSpy.mock.calls[0][1];
    expect(context.keys).toEqual([]);
    expect(context.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '', code: 'invalid_type', expected: 'object', received: 'undefined' }),
      ]),
    );
  });
});
