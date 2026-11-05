/**
 * `server.session.validate` reuses a successful bearer validation for a short
 * TTL — and ONLY while Oxy's revocation feed is live. Never a failure, never a
 * delegated session, never across a gap in the feed, and never for a session
 * Oxy has just announced revoked.
 *
 * The feed's socket is a fake (`socket.io-client` is mocked); the real socket,
 * against oxy-api's real namespace, is covered by the API's
 * `serviceEvents.socket.test.ts`.
 */
import { EventEmitter } from 'node:events';
import {
  OXY_SERVICE_EVENTS_FORBIDDEN,
  OXY_SERVICE_EVENTS_STALE_AFTER_MS,
  OXY_SESSION_REVOKED_EVENT,
} from '@oxy.so/contracts';

class FakeSocket extends EventEmitter {
  active = true;
  connected = true;
  readonly connect = jest.fn(() => this);
  readonly disconnect = jest.fn(() => this);
}

const sockets: FakeSocket[] = [];
const ioCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
jest.mock('socket.io-client', () => ({
  io: (url: string, options: Record<string, unknown>) => {
    ioCalls.push({ url, options });
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
}));

import { OxyServer } from '../OxyServer';
import { createOxyUserInvalidationHandler } from '../userInvalidation';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims: object) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.sig`;

let clock = 1_800_000_000_000;
beforeEach(() => {
  clock = 1_800_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  sockets.length = 0;
  ioCalls.length = 0;
});
afterEach(() => jest.restoreAllMocks());

function setup(config: { sessionValidationCacheTtlMs?: number; serviceIdentity?: boolean } = {}) {
  const { serviceIdentity = true, ...rest } = config;
  const server = new OxyServer({
    baseURL: 'https://api.oxy.test/v1',
    ...(serviceIdentity ? { serviceAuth: { apiKey: 'oxy_dk_test', apiSecret: 'secret' } } : {}),
    ...rest,
  });
  const request = jest
    .spyOn(server, 'request')
    .mockResolvedValue({ valid: true, user: { id: 'user-1' } } as never);
  const bearer = token({ sessionId: 'session-1', userId: 'user-1' });
  const validate = (options: { fresh?: boolean } = {}, sessionId = 'session-1') =>
    server.session.validate(sessionId, { accessToken: bearer, ...options });
  const feed = () => {
    const socket = sockets[0];
    if (!socket) throw new Error('the feed was never opened');
    return socket;
  };
  const heartbeat = () => feed().emit('heartbeat', { at: clock });
  return { server, request, validate, feed, heartbeat };
}

/** Validate once so the feed opens, then make it live. */
async function live(harness: ReturnType<typeof setup>) {
  await harness.validate();
  harness.heartbeat();
  harness.request.mockClear();
}

describe('server.session.validate cache', () => {
  it('never caches without a service identity, and never opens a feed', async () => {
    const { request, validate } = setup({ serviceIdentity: false });
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(0);
  });

  it('opens the feed on first use, on the API origin, unref’d, and caches only once it is live', async () => {
    const harness = setup();
    const { request, validate } = harness;

    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    expect(ioCalls[0]).toMatchObject({
      url: 'https://api.oxy.test/service-events',
      options: { autoUnref: true, transports: ['websocket'] },
    });

    harness.heartbeat();
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('drops everything on a disconnect, asks Oxy while down, and starts over on the next live period', async () => {
    const harness = setup();
    const { request, validate, feed } = harness;
    await live(harness);
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(1);

    feed().emit('disconnect', 'transport close');
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(3);

    harness.heartbeat();
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('treats a late heartbeat as an interruption, even when nobody asked during the gap', async () => {
    const harness = setup();
    const { request, validate } = harness;
    await live(harness);
    await validate();

    clock += OXY_SERVICE_EVENTS_STALE_AFTER_MS + 1;
    await validate();
    expect(request).toHaveBeenCalledTimes(2);

    harness.heartbeat();
    await validate();
    expect(request).toHaveBeenCalledTimes(3);
    await validate();
    expect(request).toHaveBeenCalledTimes(3);

    // A gap noticed only when the next heartbeat arrives: the entry above was
    // cached before it, so it must not be served after it.
    clock += OXY_SERVICE_EVENTS_STALE_AFTER_MS + 1;
    harness.heartbeat();
    await validate();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not store an answer that was in flight across an interruption', async () => {
    const harness = setup();
    const { request, validate, feed } = harness;
    await live(harness);

    let release: (value: unknown) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as never);
    const inFlight = validate();
    feed().emit('disconnect', 'transport close');
    harness.heartbeat();
    release({ valid: true, user: { id: 'user-1' } });
    await inFlight;

    await validate();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('drops a revoked session at once, and stores nothing for it for the TTL', async () => {
    const harness = setup();
    const { request, validate, feed } = harness;
    await live(harness);
    await validate();
    await validate({}, 'other');

    feed().emit(OXY_SESSION_REVOKED_EVENT, { sessionId: 'session-1', userId: 'user-1', at: 1 });
    // An oxy-api task that has not heard yet still answers valid: not stored.
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(4);
    // Another session is untouched.
    await validate({}, 'other');
    expect(request).toHaveBeenCalledTimes(4);

    clock += 30_001;
    harness.heartbeat();
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('drops every session of a user on a user-level revocation, with their cached identity', async () => {
    const harness = setup();
    const { server, request, feed } = harness;
    const sweep = jest.spyOn(server.http, 'invalidateCache');
    await live(harness);
    const bearerA = token({ sessionId: 'a', userId: 'user-1' });
    const bearerB = token({ sessionId: 'b', userId: 'user-1' });
    await server.session.validate('a', { accessToken: bearerA });
    await server.session.validate('b', { accessToken: bearerB });
    expect(request).toHaveBeenCalledTimes(2);

    feed().emit(OXY_SESSION_REVOKED_EVENT, { userId: 'user-1', at: 1 });
    expect(sweep).toHaveBeenCalledWith(expect.objectContaining({ keys: ['GET:/users/user-1'] }));
    await server.session.validate('a', { accessToken: bearerA });
    await server.session.validate('b', { accessToken: bearerB });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('drops everything when a revocation cannot be read', async () => {
    const harness = setup();
    const { request, validate, feed } = harness;
    await live(harness);
    await validate();
    feed().emit(OXY_SESSION_REVOKED_EVENT, { sessionId: 'session-1' });
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never caches a delegated session', async () => {
    const harness = setup();
    const { request, validate } = harness;
    await live(harness);
    request.mockResolvedValue({
      valid: true,
      user: { id: 'user-1' },
      actor: {
        schemaVersion: 1,
        effectiveAccountId: 'user-1',
        actorAccountId: 'op',
        delegated: true,
      },
    } as never);
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reuses a success, refreshes on fresh, and drops it on a user invalidation', async () => {
    const harness = setup();
    const { server, request, validate } = harness;
    await live(harness);

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

  it('live-session validation neither reuses nor replaces a cached ordinary answer', async () => {
    const harness = setup();
    const { server, request, validate } = harness;
    await live(harness);
    await validate();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      valid: true,
      user: { id: 'user-1' },
      sessionId: 'session-1',
      expiresAt: '2030-01-01T00:00:00Z',
      lastActivity: '2029-01-01T00:00:00Z',
      actor: {
        schemaVersion: 1,
        effectiveAccountId: 'user-1',
        actorAccountId: 'user-1',
        delegated: false,
      },
      liveSessionAuthority: 'session-row-v1',
    } as never);
    await server.session.validate('session-1', {
      accessToken: token({ sessionId: 'session-1', userId: 'user-1' }),
      liveSession: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('live-session validation does not join an ordinary request in flight', async () => {
    const harness = setup();
    const { server, request, validate } = harness;
    await live(harness);
    let release: (value: unknown) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as never);
    const ordinary = validate();
    request.mockResolvedValueOnce({
      valid: true,
      user: { id: 'user-1' },
      sessionId: 'session-1',
      expiresAt: '2030-01-01T00:00:00Z',
      lastActivity: '2029-01-01T00:00:00Z',
      actor: {
        schemaVersion: 1,
        effectiveAccountId: 'user-1',
        actorAccountId: 'user-1',
        delegated: false,
      },
      liveSessionAuthority: 'session-row-v1',
    } as never);
    await server.session.validate('session-1', {
      accessToken: token({ sessionId: 'session-1', userId: 'user-1' }),
      liveSession: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
    release({ valid: true, user: { id: 'user-1' } });
    await ordinary;
  });

  it('never caches a refusal, and a refusal evicts the session', async () => {
    const harness = setup();
    const { request, validate } = harness;
    await live(harness);
    await validate();

    request.mockRejectedValueOnce(Object.assign(new Error('revoked'), { status: 401 }));
    await expect(validate({ fresh: true })).rejects.toThrow('revoked');
    await expect(validate()).resolves.toMatchObject({ valid: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not let an older in-flight success re-cache a session Oxy has since refused', async () => {
    const harness = setup();
    const { request, validate } = harness;
    await live(harness);
    let release: (value: unknown) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as never);
    const older = validate();

    request.mockRejectedValueOnce(Object.assign(new Error('revoked'), { status: 401 }));
    await expect(validate({ fresh: true })).rejects.toThrow('revoked');
    release({ valid: true, user: { id: 'user-1' } });
    await older;

    await validate();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('is off at a zero TTL, and then opens no feed', async () => {
    const { request, validate } = setup({ sessionValidationCacheTtlMs: 0 });
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(0);
  });

  it('closes the feed on dispose and never reopens it', async () => {
    const harness = setup();
    const { server, request, validate, feed } = harness;
    await live(harness);
    server.dispose();
    expect(feed().disconnect).toHaveBeenCalled();
    await validate();
    await validate();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
  });
});

describe('the revocation feed reconnects by itself', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['Date'] }));
  afterEach(() => jest.useRealTimers());

  it('after the server closed the socket, and after a refusal, with backoff', async () => {
    const harness = setup();
    await harness.validate();
    const socket = harness.feed();
    socket.connected = false;

    socket.emit('disconnect', 'io server disconnect');
    jest.advanceTimersByTime(1_000);
    expect(socket.connect).toHaveBeenCalledTimes(1);

    socket.active = false;
    socket.emit('connect_error', new Error('unauthorized'));
    jest.advanceTimersByTime(999);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(socket.connect).toHaveBeenCalledTimes(2);

    socket.emit('connect_error', new Error('unauthorized'));
    jest.advanceTimersByTime(1_999);
    expect(socket.connect).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(socket.connect).toHaveBeenCalledTimes(3);
  });

  it('asks rarely when Oxy will never admit this service', async () => {
    const harness = setup();
    await harness.validate();
    const socket = harness.feed();
    socket.connected = false;
    socket.active = false;
    socket.emit('connect_error', new Error(OXY_SERVICE_EVENTS_FORBIDDEN));
    jest.advanceTimersByTime(60_000);
    expect(socket.connect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10 * 60_000);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('leaves a transport loss to Socket.IO’s own reconnection', async () => {
    const harness = setup();
    await harness.validate();
    const socket = harness.feed();
    socket.emit('connect_error', new Error('xhr poll error'));
    jest.advanceTimersByTime(120_000);
    expect(socket.connect).not.toHaveBeenCalled();
  });
});
