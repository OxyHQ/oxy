/**
 * `SessionClient` on the device DIRECTORY (issue #937, ADR 0002).
 *
 * The four properties the account lane already holds are re-asserted here for
 * the context lane, because none of them transfers for free:
 *   1. last-writer-wins is `deviceId`-SCOPED, not global;
 *   2. the bearer for the new context is committed BEFORE any subscriber is
 *      notified;
 *   3. an identity-pinned client tracks the device truthfully and never adopts
 *      a foreign bearer;
 *   4. an idempotent activation moves nothing, so it reconciles nothing and
 *      wakes nobody — the client-side reading of the server's `changed: false`.
 */
import type { DeviceDirectory, DeviceSessionState } from '@oxyhq/contracts';
import { SessionClient, type SessionClientHost } from '../SessionClient';
import { computeIdentityTag } from '../../utils/cacheKey';

/** A minimal jwt-decode-able token whose `userId` claim is `accountId`. */
function jwtFor(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId: accountId })).toString('base64url');
  return `h.${payload}.s`;
}

/**
 * Nate (personal) plus `org`, reached through Nate. `activeContextId` picks
 * which one is live.
 */
function directoryAt(
  revision: number,
  activeContextId: string | null,
  deviceId = 'd1',
): DeviceDirectory {
  return {
    deviceId,
    revision,
    activeContextId,
    updatedAt: 1_720_000_000_000,
    principals: [
      {
        id: 'p-nate',
        userId: 'nate',
        authuser: 0,
        user: { id: 'nate', username: 'nate' },
        contexts: [
          {
            id: 'ctx-nate',
            accountId: 'nate',
            kind: 'personal',
            relationship: 'self',
            account: { id: 'nate', username: 'nate' },
            onDevice: true,
            available: true,
            active: activeContextId === 'ctx-nate',
            lastUsedAt: null,
          },
          {
            id: 'ctx-org',
            accountId: 'org',
            kind: 'organization',
            relationship: 'owner',
            account: { id: 'org', username: 'oxy' },
            onDevice: true,
            available: true,
            active: activeContextId === 'ctx-org',
            lastUsedAt: null,
          },
        ],
      },
    ],
  };
}

function stateAt(revision: number, activeAccountId: string, deviceId = 'd1'): DeviceSessionState {
  return {
    deviceId,
    accounts: [
      { accountId: 'nate', sessionId: 's-nate', authuser: 0 },
      { accountId: 'org', sessionId: 's-org', authuser: 1, operatedByUserId: 'nate' },
    ],
    activeAccountId,
    revision,
    updatedAt: 1_720_000_000_000,
  };
}

type Route = () => unknown;

interface TestHost extends SessionClientHost {
  urls: string[];
  bodies: unknown[];
  planted(): string | null;
}

function makeHost(routes: Record<string, Route>, initialToken: string | null): TestHost {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  let planted = initialToken;
  return {
    makeRequest: jest.fn(async (_method: string, url: string, data?: unknown) => {
      urls.push(url);
      bodies.push(data);
      const route = routes[url];
      if (!route) {
        throw new Error(`unexpected request: ${url}`);
      }
      return route();
    }),
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => planted,
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: (token: string) => {
      planted = token;
    },
    getCurrentAccountId: () => null,
    urls,
    bodies,
    planted: () => planted,
  };
}

/** `applyState` is protected; a tiny subclass exposes it for the unit tests. */
class TestClient extends SessionClient {
  public apply(raw: unknown): boolean {
    return this.applyState(raw);
  }
}

const countOf = (urls: string[], url: string): number => urls.filter((seen) => seen === url).length;

/**
 * A recording stand-in for `BroadcastChannel`.
 *
 * Node's real one is ref'd and would keep the Jest event loop alive forever, but
 * simply feature-detecting it away would ALSO make the cross-tab wake
 * unobservable — and "an idempotent activation wakes nobody" is one of the
 * properties under test, so it has to be a fake rather than an absence.
 */
const posted: unknown[] = [];
class RecordingBroadcastChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: unknown): void {
    posted.push(message);
  }
  close(): void {
    /* nothing to release */
  }
}

describe('SessionClient — device directory', () => {
  const realBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  beforeAll(() => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = RecordingBroadcastChannel;
  });
  afterAll(() => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = realBroadcastChannel;
  });
  beforeEach(() => {
    posted.length = 0;
  });

  it('holds no directory until one is read', () => {
    const client = new SessionClient(makeHost({}, jwtFor('nate')));

    expect(client.getDirectory()).toBeNull();
    expect(client.getActiveContext()).toBeNull();
  });

  it('refreshDirectory GETs the directory, applies it and notifies', async () => {
    const host = makeHost(
      { '/session/device/directory': () => directoryAt(3, 'ctx-org') },
      jwtFor('nate'),
    );
    const client = new SessionClient(host);
    const seen: Array<DeviceDirectory | null> = [];
    client.subscribeDirectory((directory) => seen.push(directory));

    await client.refreshDirectory();

    expect(host.makeRequest).toHaveBeenCalledWith('GET', '/session/device/directory', undefined, { cache: false });
    expect(client.getDirectory()?.revision).toBe(3);
    expect(client.getActiveContext()?.subject.accountId).toBe('org');
    expect(client.getActiveContext()?.actor.userId).toBe('nate');
    expect(seen.at(-1)?.revision).toBe(3);
  });

  it('applies last-writer-wins by revision WITHIN one device', async () => {
    let next = directoryAt(5, 'ctx-nate');
    const host = makeHost({ '/session/device/directory': () => next }, jwtFor('nate'));
    const client = new SessionClient(host);

    await client.refreshDirectory();
    next = directoryAt(5, 'ctx-org');
    await client.refreshDirectory();
    expect(client.getActiveContext()?.subject.accountId).toBe('nate');

    next = directoryAt(4, 'ctx-org');
    await client.refreshDirectory();
    expect(client.getActiveContext()?.subject.accountId).toBe('nate');

    next = directoryAt(6, 'ctx-org');
    await client.refreshDirectory();
    expect(client.getActiveContext()?.subject.accountId).toBe('org');
  });

  it('accepts a LOWER-revision directory from a DIFFERENT device', async () => {
    let next = directoryAt(10, 'ctx-nate', 'A');
    const host = makeHost({ '/session/device/directory': () => next }, jwtFor('nate'));
    const client = new SessionClient(host);

    await client.refreshDirectory();
    expect(client.getDirectory()?.deviceId).toBe('A');

    // Device B is freshly converged at revision 1. The revision is monotone only
    // WITHIN a device, so B must win over A's stale-but-higher number.
    next = directoryAt(1, 'ctx-org', 'B');
    await client.refreshDirectory();
    expect(client.getDirectory()?.deviceId).toBe('B');
    expect(client.getDirectory()?.revision).toBe(1);
  });

  it('discards an invalid directory and keeps the one it holds', async () => {
    let next: unknown = directoryAt(2, 'ctx-nate');
    const host = makeHost({ '/session/device/directory': () => next }, jwtFor('nate'));
    const client = new SessionClient(host);

    await client.refreshDirectory();
    next = { deviceId: 'd1', revision: 9, principals: 'nope' };
    await client.refreshDirectory();

    expect(client.getDirectory()?.revision).toBe(2);
  });

  it('never fetches a directory for a client that has not asked for one', () => {
    const host = makeHost({}, jwtFor('nate'));
    const client = new TestClient(host);

    client.apply(stateAt(1, 'nate'));
    client.apply(stateAt(2, 'org'));

    expect(countOf(host.urls, '/session/device/directory')).toBe(0);
  });

  it('re-reads the directory BEFORE notifying once the flat state moves past it', async () => {
    let releaseDirectory: (() => void) | null = null;
    const host = makeHost(
      {
        '/session/device/directory': () => {
          if (releaseDirectory === null) {
            return directoryAt(2, 'ctx-nate');
          }
          return new Promise((resolve) => {
            releaseDirectory = () => resolve(directoryAt(3, 'ctx-org'));
          });
        },
      },
      jwtFor('nate'),
    );
    const client = new TestClient(host);
    await client.refreshDirectory();

    // Positive control for the previous test: this client HAS a directory, so
    // an advancing state does fetch one.
    const observed: Array<number | undefined> = [];
    client.subscribe(() => observed.push(client.getDirectory()?.revision));
    releaseDirectory = () => undefined;

    client.apply(stateAt(3, 'org'));
    // The directory is still at 2 and the fetch is in flight — nobody has been
    // told about revision 3 yet.
    expect(observed).toEqual([]);
    expect(countOf(host.urls, '/session/device/directory')).toBe(2);

    releaseDirectory();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // The one notify observed BOTH halves at revision 3.
    expect(observed).toEqual([3]);
    expect(client.getActiveContext()?.subject.accountId).toBe('org');
  });

  it('activateContext POSTs { contextId } and nothing else', async () => {
    const host = makeHost(
      {
        '/session/device/activate': () => ({
          directory: directoryAt(4, 'ctx-org'),
          activeToken: { accessToken: jwtFor('org'), expiresAt: 'x' },
        }),
        '/session/device/state': () => ({ state: stateAt(4, 'org'), activeToken: null }),
      },
      jwtFor('nate'),
    );
    const client = new SessionClient(host);

    await client.activateContext('ctx-org');

    expect(host.makeRequest).toHaveBeenCalledWith('POST', '/session/device/activate', { contextId: 'ctx-org' }, { cache: false });
    expect(client.getActiveContext()?.contextId).toBe('ctx-org');
  });

  it('commits the new context bearer BEFORE any subscriber observes the new subject', async () => {
    const host = makeHost(
      {
        '/session/device/activate': () => ({
          directory: directoryAt(4, 'ctx-org'),
          activeToken: { accessToken: jwtFor('org'), expiresAt: 'x' },
        }),
        '/session/device/state': () => ({ state: stateAt(4, 'org'), activeToken: null }),
      },
      jwtFor('nate'),
    );
    const client = new SessionClient(host);

    const observations: Array<{ subject: string | null; bearer: string }> = [];
    client.subscribeDirectory((directory) => {
      observations.push({
        subject: directory?.activeContextId === 'ctx-org' ? 'org' : 'nate',
        bearer: computeIdentityTag(host.getAccessToken()),
      });
    });

    await client.activateContext('ctx-org');

    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.bearer).toBe(observation.subject);
    }
  });

  it('reconciles the flat projection so it cannot lag the directory', async () => {
    const host = makeHost(
      {
        '/session/device/activate': () => ({
          directory: directoryAt(4, 'ctx-org'),
          activeToken: { accessToken: jwtFor('org'), expiresAt: 'x' },
        }),
        '/session/device/state': () => ({ state: stateAt(4, 'org'), activeToken: null }),
      },
      jwtFor('nate'),
    );
    const client = new TestClient(host);
    client.apply(stateAt(3, 'nate'));

    await client.activateContext('ctx-org');

    expect(countOf(host.urls, '/session/device/state')).toBe(1);
    expect(client.getState()?.activeAccountId).toBe('org');
    expect(client.getState()?.revision).toBe(4);
  });

  it('an idempotent activation reconciles nothing and wakes nobody', async () => {
    let directory = directoryAt(4, 'ctx-org');
    const host = makeHost(
      {
        '/session/device/activate': () => ({
          directory,
          activeToken: { accessToken: jwtFor('org'), expiresAt: 'x' },
        }),
        '/session/device/state': () => ({ state: stateAt(directory.revision, 'org'), activeToken: null }),
      },
      jwtFor('nate'),
    );
    const client = new TestClient(host);
    client.apply(stateAt(4, 'org'));
    await client.activateContext('ctx-org');

    const before = host.urls.length;
    // The server answers the SAME revision: nothing was written, nothing
    // broadcast. The client must read that off the revision, not re-fetch —
    // and must not wake the origin's other tabs to converge on a change that
    // did not happen.
    await client.activateContext('ctx-org');
    expect(host.urls.slice(before)).toEqual(['/session/device/activate']);
    expect(posted).toEqual([]);

    // Vacuity floor: a real transition from the same starting point DOES
    // reconcile and DOES wake the siblings, so the assertions above are
    // measuring idempotence and not a client that simply never does either.
    directory = directoryAt(5, 'ctx-nate');
    const beforeReal = host.urls.length;
    await client.activateContext('ctx-nate');
    expect(host.urls.slice(beforeReal)).toEqual(['/session/device/activate', '/session/device/state']);
    expect(posted).toEqual([{ type: 'commit', at: expect.any(Number) }]);
  });

  it('discards an invalid activation response without touching the directory', async () => {
    const host = makeHost(
      {
        '/session/device/directory': () => directoryAt(4, 'ctx-nate'),
        '/session/device/activate': () => ({ directory: { deviceId: 'd1' }, activeToken: null }),
      },
      jwtFor('nate'),
    );
    const client = new SessionClient(host);
    await client.refreshDirectory();

    await client.activateContext('ctx-org');

    expect(client.getActiveContext()?.contextId).toBe('ctx-nate');
    expect(countOf(host.urls, '/session/device/state')).toBe(0);
  });

  describe('under an identity pin', () => {
    it('tracks an activation truthfully but never adopts the foreign bearer', async () => {
      const host = makeHost(
        {
          '/session/device/activate': () => ({
            directory: directoryAt(4, 'ctx-org'),
            activeToken: { accessToken: jwtFor('org'), expiresAt: 'x' },
          }),
          '/session/device/state': () => ({ state: stateAt(4, 'org'), activeToken: null }),
        },
        jwtFor('nate'),
      );
      const client = new SessionClient(host, { getPinnedAccountId: () => 'nate' });

      await client.activateContext('ctx-org');

      expect(client.getActiveContext()?.subject.accountId).toBe('org');
      expect(host.planted()).toBe(jwtFor('nate'));
    });

    it('DOES adopt the bearer when the new subject IS the pinned account', async () => {
      const host = makeHost(
        {
          '/session/device/activate': () => ({
            directory: directoryAt(4, 'ctx-nate'),
            activeToken: { accessToken: jwtFor('nate'), expiresAt: 'x' },
          }),
          '/session/device/state': () => ({ state: stateAt(4, 'nate'), activeToken: null }),
        },
        null,
      );
      const client = new SessionClient(host, { getPinnedAccountId: () => 'nate' });

      await client.activateContext('ctx-nate');

      expect(host.planted()).toBe(jwtFor('nate'));
    });
  });
});
