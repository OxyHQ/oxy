import type { OxyServices } from '@oxy.so/core';
import { completeOAuthCode } from '../completeOAuthCode';
import type { OAuthSessionCommitInput } from '../types';

const HANDSHAKE = { state: 'state-abc', codeVerifier: 'verifier-xyz' };
const REDIRECT_URI = 'https://mention.earth';

const SESSION = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  deviceSecret: 'secret-1',
  accessToken: 'token-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: 'user-1', username: 'nate', avatar: 'a1' },
};

function makeOxyServices(exchange: jest.Mock): OxyServices {
  return { exchangeOAuthCode: exchange } as unknown as OxyServices;
}

describe('completeOAuthCode', () => {
  it('exchanges the code and commits the session it returns', async () => {
    const exchange = jest.fn().mockResolvedValue(SESSION);
    const committed: OAuthSessionCommitInput[] = [];

    const result = await completeOAuthCode({
      oxyServices: makeOxyServices(exchange),
      clientId: 'oxy_dk_test',
      code: 'code-1',
      returnedState: HANDSHAKE.state,
      handshake: HANDSHAKE,
      redirectUri: REDIRECT_URI,
      commitSession: async (input) => {
        committed.push(input);
      },
    });

    expect(result).toEqual({ ok: true });
    expect(exchange).toHaveBeenCalledWith({
      code: 'code-1',
      clientId: 'oxy_dk_test',
      redirectUri: REDIRECT_URI,
      codeVerifier: HANDSHAKE.codeVerifier,
    });
    expect(committed).toEqual([
      {
        sessionId: 'sess-1',
        accessToken: 'token-1',
        deviceId: 'dev-1',
        deviceSecret: 'secret-1',
        userId: 'user-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        user: SESSION.user,
      },
    ]);
  });

  it('cleans up BEFORE committing, so a stale code cannot re-enter the exchange', async () => {
    const order: string[] = [];
    const result = await completeOAuthCode({
      oxyServices: makeOxyServices(jest.fn().mockResolvedValue(SESSION)),
      clientId: 'oxy_dk_test',
      code: 'code-1',
      returnedState: HANDSHAKE.state,
      handshake: HANDSHAKE,
      redirectUri: REDIRECT_URI,
      commitSession: async () => {
        order.push('commit');
      },
      cleanup: () => {
        order.push('cleanup');
      },
    });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['cleanup', 'commit']);
  });

  it.each([
    ['a mismatched state', 'someone-elses-state', HANDSHAKE],
    ['no returned state', null, HANDSHAKE],
    ['no stored handshake', HANDSHAKE.state, null],
  ])('refuses to exchange the code with %s', async (_label, returnedState, handshake) => {
    const exchange = jest.fn();
    const commitSession = jest.fn();
    const cleanup = jest.fn();

    const result = await completeOAuthCode({
      oxyServices: makeOxyServices(exchange),
      clientId: 'oxy_dk_test',
      code: 'code-1',
      returnedState,
      handshake,
      redirectUri: REDIRECT_URI,
      commitSession,
      cleanup,
    });

    expect(result).toEqual({ ok: false, reason: 'state-mismatch' });
    expect(exchange).not.toHaveBeenCalled();
    expect(commitSession).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports a failed exchange without throwing, and still cleans up', async () => {
    const cleanup = jest.fn();
    const commitSession = jest.fn();

    const result = await completeOAuthCode({
      oxyServices: makeOxyServices(jest.fn().mockRejectedValue(new Error('invalid_grant'))),
      clientId: 'oxy_dk_test',
      code: 'code-1',
      returnedState: HANDSHAKE.state,
      handshake: HANDSHAKE,
      redirectUri: REDIRECT_URI,
      commitSession,
      cleanup,
    });

    expect(result).toEqual({ ok: false, reason: 'exchange-failed' });
    expect(commitSession).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports a failed commit without throwing, and cleans up exactly once', async () => {
    const cleanup = jest.fn();

    const result = await completeOAuthCode({
      oxyServices: makeOxyServices(jest.fn().mockResolvedValue(SESSION)),
      clientId: 'oxy_dk_test',
      code: 'code-1',
      returnedState: HANDSHAKE.state,
      handshake: HANDSHAKE,
      redirectUri: REDIRECT_URI,
      commitSession: jest.fn().mockRejectedValue(new Error('commit blew up')),
      cleanup,
    });

    expect(result).toEqual({ ok: false, reason: 'exchange-failed' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
