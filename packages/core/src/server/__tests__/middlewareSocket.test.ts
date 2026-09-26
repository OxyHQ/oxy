import { OxyServer } from '../OxyServer';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.forged-signature`;
}

async function runAuthSocket(oxy: OxyServer, token: string) {
  const socket: {
    handshake: { auth: { token: string } };
    data?: Record<string, unknown>;
    user?: { id: string; userId: string; sessionId?: string | null };
  } = { handshake: { auth: { token } } };
  let nextError: Error | undefined;

  await oxy.middleware.socket()(socket, (err?: Error) => {
    nextError = err;
  });

  return { socket, nextError };
}

describe('authSocket', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('rejects decoded JWT payloads that do not include a server-validated session', async () => {
    const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const { socket, nextError } = await runAuthSocket(oxy, createJwt({
      userId: 'victimUserId',
      exp: 4102444800,
    }));

    expect(nextError?.message).toBe('Session required');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(socket.data?.userId).toBeUndefined();
    expect(socket.user).toBeUndefined();
  });

  it('rejects tokens whose decoded user does not match the validated session user', async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        valid: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        lastActivity: '2026-06-24T00:00:00.000Z',
        user: { id: 'realUserId', username: 'real', publicKey: 'pub_1' },
      });

    const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
    const { socket, nextError } = await runAuthSocket(oxy, createJwt({
      userId: 'victimUserId',
      sessionId: 'session_1',
      exp: 4102444800,
    }));

    expect(nextError?.message).toBe('Session user mismatch');
    expect(socket.data?.userId).toBeUndefined();
    expect(socket.user).toBeUndefined();
  });

  it('attaches the validated session user when the decoded user matches', async () => {
    globalThis.fetch = async () =>
      jsonResponse({
        valid: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        lastActivity: '2026-06-24T00:00:00.000Z',
        user: { id: 'user_1', username: 'nate', publicKey: 'pub_1' },
      });

    const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
    const { socket, nextError } = await runAuthSocket(oxy, createJwt({
      userId: 'user_1',
      sessionId: 'session_1',
      exp: 4102444800,
    }));

    expect(nextError).toBeUndefined();
    expect(socket.data?.userId).toBe('user_1');
    expect(socket.data?.sessionId).toBe('session_1');
    expect(socket.user).toEqual({ id: 'user_1', userId: 'user_1', sessionId: 'session_1' });
  });
});
