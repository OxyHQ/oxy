/**
 * The node registry (F5a user nodes), against a REAL Postgres.
 *
 * The suite this replaces mocked `models/UserNode` and asserted on the ARGUMENTS
 * handed to `findOneAndUpdate` — `update.$set` — so it described a Mongoose call
 * shape rather than a stored row, and every one of those assertions would still
 * have passed against a service that wrote nothing. The model is not imported by
 * the service any more, so those mocks are also inert. What survives is the set
 * of guarantees, each now checked against rows written in the same test:
 *
 *  - **A registration is an UPSERT, and re-registering is idempotent.** One row
 *    per account, `id` and `created_at` never move, and the projected fields are
 *    rewritten every time — so flipping operator or endpoint is deterministic.
 *  - **The read path never reaches the node.** `getUserNode` answers from the
 *    Oxy DB alone; a node that is down or has never been probed still resolves,
 *    which is what keeps a DID document readable.
 *  - **An absent optional is OMITTED, never `null`.** Drizzle returns `null`
 *    where a lean Mongoose document returned `undefined`, and `GET /nodes/me`
 *    serializes these fields straight onto the wire — a `null` there is a wire
 *    format change for every consumer. Asserted as an exact JSON body.
 *  - **`managed` and `controller` cannot disagree.** The schema CHECK makes the
 *    contradiction unrepresentable and the option carries ONE operator field.
 *  - **The liveness sweep takes never-probed nodes FIRST.** Mongo sorts a
 *    missing date ahead of every date; Postgres sorts NULLs LAST by default, so
 *    without the explicit `nulls first` a newly registered node is starved
 *    forever — a silent, unbounded regression.
 *
 * Only `safeFetch` is mocked: it is the network, and the point of the probe is
 * what it writes for a given response. Everything else — the upsert, the CHECK
 * constraints, the unique `user_id`, the ordering — is the real database.
 *
 * The whole run shares one database, so every account is created per test and
 * every assertion is scoped to rows the test wrote.
 */

import { and, eq, inArray } from 'drizzle-orm';

const mockSafeFetch = jest.fn();
jest.mock('@oxyhq/core/server', () => ({
  ...jest.requireActual('@oxyhq/core/server'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userNodes } from '../../db/schema/userNodes';
import { users } from '../../db/schema/users';
import userCache from '../../utils/userCache';
import {
  NODE_LIVENESS_SWEEP_BATCH,
  NODE_WELL_KNOWN_PATH,
} from '../../utils/nodes.constants';
import {
  getUserNode,
  materializeNodeFromRecord,
  probeLiveness,
  removeNode,
  sweepNodeLiveness,
  type UserNodeRecord,
} from '../nodeRegistry.service';

/** 66-char compressed secp256k1 hex — the shape `nodeRecordSchema` accepts. */
const NODE_PUBLIC_KEY = 'ab'.repeat(33);

let invalidateSpy: jest.SpyInstance<void, [string]>;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  invalidateSpy = jest.spyOn(userCache, 'invalidate');
  // A 2xx by default: several cases fire the post-registration probe, which the
  // service deliberately does not await.
  mockSafeFetch.mockResolvedValue({
    status: 200,
    response: { destroy: jest.fn() },
    headers: {},
    finalUrl: '',
  });
});

afterEach(() => {
  invalidateSpy.mockRestore();
});

/** A fresh account. Every test gets its own, so no case can see another's rows. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** The stored row, straight from the table — never the service's return value. */
async function storedNode(userId: string) {
  const [row] = await getDb().select().from(userNodes).where(eq(userNodes.userId, userId)).limit(1);
  return row;
}

/** Every `user_nodes` row for an account, so "exactly one" is assertable. */
async function storedNodeCount(userId: string): Promise<number> {
  const rows = await getDb().select({ id: userNodes.id }).from(userNodes).where(eq(userNodes.userId, userId));
  return rows.length;
}

/** A minimal, well-formed `type:'node'` record payload. */
function nodeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { endpoint: 'https://node.example.com', nodePublicKey: NODE_PUBLIC_KEY, ...overrides };
}

/**
 * Poll until `read()` satisfies `done`, then return it. The post-registration
 * liveness probe is FIRE-AND-FORGET by design (the read-path invariant), so
 * observing it means waiting for its write rather than awaiting a promise the
 * service never hands back. Fails loudly on timeout instead of passing vacuously.
 */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Probes that have called `safeFetch` since the last `clearAllMocks`. */
function probesSoFar(): number {
  return mockSafeFetch.mock.calls.length;
}

/**
 * Let the floating post-registration probe finish before the test ends.
 *
 * `probesBefore` is {@link probesSoFar} read immediately BEFORE the call that
 * fired this probe, and a RE-registration must pass it. Without it the wait is
 * vacuous on the second probe of a test: it asked only whether `lastProbeAt` is
 * non-null, which the FIRST probe's write already made true, so the settle
 * returned on its first poll and left the new probe in flight. That probe's
 * `safeFetch` then landed in whatever test was running when it resolved —
 * against a spy `beforeEach` had already cleared — which is the flake in #836,
 * reproduced here 1 full-suite run in 3 and always in the case that follows the
 * last re-registration.
 *
 * Counting the mock's calls rather than comparing timestamps is deliberate:
 * `lastProbeAt` is a `Date` at millisecond resolution and two probes inside one
 * millisecond are ordinary against a local database, so a "strictly newer"
 * comparison would trade this flake for a timeout.
 *
 * The default of `0` stays correct for a user with NO prior probe — including
 * the two-account cases, where another account's probe may already have bumped
 * the count but this account's `lastProbeAt` is still null and does the waiting.
 * It is only a RE-registration, where both halves are already satisfied, that
 * needs the explicit baseline.
 */
async function settleProbe(userId: string, probesBefore = 0): Promise<void> {
  await waitFor(
    async () => ({ row: await storedNode(userId), probes: probesSoFar() }),
    ({ row, probes }) =>
      // No row means materialization was skipped, so no probe was ever fired.
      row === undefined || (probes > probesBefore && row.lastProbeAt !== null),
    'the fire-and-forget liveness probe to call safeFetch and write lastProbeAt',
  );
}

describe('materializeNodeFromRecord', () => {
  it('upserts one row from a verified node record and invalidates the user cache', async () => {
    const userId = await account();

    const node = await materializeNodeFromRecord(userId, nodeRecord({
      endpoint: 'https://node.example.com/', // trailing slash normalised away
      mode: 'push',
      nodeDid: 'did:web:node.example.com',
    }));

    expect(node).not.toBeNull();
    const row = await storedNode(userId);
    expect(row).toMatchObject({
      userId,
      endpoint: 'https://node.example.com',
      nodePublicKey: NODE_PUBLIC_KEY,
      mode: 'push',
      managed: false,
      controller: 'self',
      status: 'active',
      nodeDid: 'did:web:node.example.com',
      lastError: null,
      cursor: null,
    });
    expect(await storedNodeCount(userId)).toBe(1);
    expect(invalidateSpy).toHaveBeenCalledWith(userId);

    await settleProbe(userId);
  });

  it('fires the post-registration liveness probe without awaiting it', async () => {
    const userId = await account();

    await materializeNodeFromRecord(userId, nodeRecord());

    const row = await waitFor(
      () => storedNode(userId),
      (value) => value?.lastSeenAt !== null,
      'the post-registration probe to mark the node seen',
    );
    expect(row.status).toBe('active');
    expect(mockSafeFetch).toHaveBeenCalledWith(
      `https://node.example.com${NODE_WELL_KNOWN_PATH}`,
      expect.objectContaining({ maxRedirects: 1 }),
    );
  });

  it('defaults mode to pull when the record omits it', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    expect((await storedNode(userId)).mode).toBe('pull');
    await settleProbe(userId);
  });

  it('re-registering updates the SAME row in place — id and created_at never move', async () => {
    // The `$setOnInsert` guarantee: the upsert must stay idempotent, so the
    // insert-only columns really are insert-only.
    const userId = await account();
    const first = await materializeNodeFromRecord(userId, nodeRecord({ nodeDid: 'did:web:first.example' }));
    await settleProbe(userId);
    const before = await storedNode(userId);

    const probesBefore = probesSoFar();
    const second = await materializeNodeFromRecord(userId, nodeRecord({
      endpoint: 'https://moved.example.com',
      mode: 'push',
    }));
    await settleProbe(userId, probesBefore);
    const after = await storedNode(userId);

    expect(await storedNodeCount(userId)).toBe(1);
    expect(second?.id).toBe(first?.id);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(after.endpoint).toBe('https://moved.example.com');
    expect(after.mode).toBe('push');
    // A record that omits `nodeDid` leaves whatever the row already advertised.
    expect(after.nodeDid).toBe('did:web:first.example');
  });

  it('clears a stale lastError on re-registration', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    await settleProbe(userId);
    await getDb().update(userNodes).set({ lastError: 'boom' }).where(eq(userNodes.userId, userId));

    const probesBefore = probesSoFar();
    await materializeNodeFromRecord(userId, nodeRecord());

    expect((await storedNode(userId)).lastError).toBeNull();
    await settleProbe(userId, probesBefore);
  });

  it('records an Oxy-operated node as managed + controller oxy, together', async () => {
    // `user_nodes_managed_controller_check` refuses a pair that disagrees, and
    // the option carries ONE operator so the contradiction cannot be expressed.
    const userId = await account();

    await materializeNodeFromRecord(userId, nodeRecord(), { operator: 'oxy' });

    expect(await storedNode(userId)).toMatchObject({ managed: true, controller: 'oxy' });
    await settleProbe(userId);
  });

  it('flips a managed node back to self-hosted deterministically', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord(), { operator: 'oxy' });
    await settleProbe(userId);

    const probesBefore = probesSoFar();
    await materializeNodeFromRecord(userId, nodeRecord(), { operator: 'self' });

    expect(await storedNode(userId)).toMatchObject({ managed: false, controller: 'self' });
    // The settle that used to be vacuous, and the one whose leaked probe landed
    // in the very next case — see `settleProbe`.
    await settleProbe(userId, probesBefore);
  });

  it.each([
    ['a non-HTTPS endpoint', nodeRecord({ endpoint: 'http://node.example.com' })],
    ['an endpoint carrying credentials', nodeRecord({ endpoint: 'https://user:pw@node.example.com' })],
    ['an unparseable endpoint', nodeRecord({ endpoint: 'not a url' })],
    ['a missing nodePublicKey', { endpoint: 'https://node.example.com' }],
    ['a non-hex nodePublicKey', nodeRecord({ nodePublicKey: 'not-hex' })],
    ['an out-of-range mode', nodeRecord({ mode: 'sideways' })],
  ])('skips materialization for %s — no row, no cache sweep, no probe', async (_label, record) => {
    const userId = await account();

    const node = await materializeNodeFromRecord(userId, record);

    expect(node).toBeNull();
    expect(await storedNode(userId)).toBeUndefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

describe('an absent optional is OMITTED, never null — the /nodes/me wire contract', () => {
  it('returns no key at all for every unset column', async () => {
    // Drizzle hands back `null` where a lean Mongoose document handed back
    // `undefined`. `JSON.stringify` drops an undefined property and EMITS a null,
    // so serializing the row as-is would put `"nodeDid": null` on a wire that has
    // never carried one.
    const userId = await account();
    const node = await materializeNodeFromRecord(userId, nodeRecord());
    if (!node) throw new Error('expected the node to materialize');

    for (const key of ['nodeDid', 'lastSeenAt', 'lastProbeAt', 'lastError', 'cursor', 'lastSyncedAt']) {
      expect(key in node).toBe(false);
    }

    // The exact body `GET /nodes/me` serializes from this record.
    expect(JSON.parse(JSON.stringify(serializeLikeTheRoute(node)))).toEqual({
      endpoint: 'https://node.example.com',
      nodePublicKey: NODE_PUBLIC_KEY,
      mode: 'pull',
      managed: false,
      controller: 'self',
      status: 'active',
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
    });

    await settleProbe(userId);
  });

  it('carries every optional through once it is set', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord({ nodeDid: 'did:web:node.example.com' }));
    await settleProbe(userId);
    await getDb()
      .update(userNodes)
      .set({ cursor: 7, lastSyncedAt: new Date('2026-01-01T00:00:00.000Z'), lastError: 'chain_gap' })
      .where(eq(userNodes.userId, userId));

    const node = await getUserNode(userId);

    expect(node).toMatchObject({
      nodeDid: 'did:web:node.example.com',
      cursor: 7,
      lastSyncedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastError: 'chain_gap',
    });
    expect(node?.lastProbeAt).toBeInstanceOf(Date);
    expect(node?.lastSeenAt).toBeInstanceOf(Date);
  });
});

/** The projection `routes/nodes.ts` puts on the wire, reproduced field for field. */
function serializeLikeTheRoute(node: UserNodeRecord): Record<string, unknown> {
  return {
    nodeDid: node.nodeDid,
    endpoint: node.endpoint,
    nodePublicKey: node.nodePublicKey,
    mode: node.mode,
    managed: node.managed,
    controller: node.controller,
    status: node.status,
    lastSeenAt: node.lastSeenAt,
    lastProbeAt: node.lastProbeAt,
    lastError: node.lastError,
    cursor: node.cursor,
    lastSyncedAt: node.lastSyncedAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

describe('probeLiveness', () => {
  /** A registered node whose post-registration probe has already settled. */
  async function registered(endpoint = 'https://node.example.com'): Promise<string> {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord({ endpoint }));
    await settleProbe(userId);
    return userId;
  }

  it('marks the node active and stamps lastSeenAt on a 2xx', async () => {
    const userId = await registered();
    await getDb()
      .update(userNodes)
      .set({ status: 'unreachable', lastError: 'ECONNREFUSED', lastSeenAt: null, lastProbeAt: null })
      .where(eq(userNodes.userId, userId));

    await probeLiveness(userId);

    const row = await storedNode(userId);
    expect(row.status).toBe('active');
    expect(row.lastSeenAt).toBeInstanceOf(Date);
    expect(row.lastProbeAt).toEqual(row.lastSeenAt);
    expect(row.lastError).toBeNull();
  });

  it('marks the node unreachable on a non-2xx and keeps the last successful sighting', async () => {
    const userId = await registered();
    const seenAt = (await storedNode(userId)).lastSeenAt;
    expect(seenAt).toBeInstanceOf(Date);
    mockSafeFetch.mockResolvedValue({
      status: 503,
      response: { destroy: jest.fn() },
      headers: {},
      finalUrl: '',
    });

    await probeLiveness(userId);

    const row = await storedNode(userId);
    expect(row.status).toBe('unreachable');
    expect(row.lastError).toBe('node responded with HTTP 503');
    // A failed probe never claims the node was seen.
    expect(row.lastSeenAt).toEqual(seenAt);
  });

  it('marks the node unreachable WITHOUT throwing when the fetch fails', async () => {
    const userId = await registered('https://down.example.com');
    mockSafeFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(probeLiveness(userId)).resolves.toBeUndefined();

    expect(await storedNode(userId)).toMatchObject({
      status: 'unreachable',
      lastError: 'ECONNREFUSED',
    });
  });

  it('destroys the response body — liveness reads the status line only', async () => {
    const userId = await registered();
    const destroy = jest.fn();
    mockSafeFetch.mockResolvedValue({ status: 200, response: { destroy }, headers: {}, finalUrl: '' });

    await probeLiveness(userId);

    expect(destroy).toHaveBeenCalled();
  });

  it('never probes a revoked node, and never resurrects one', async () => {
    const userId = await registered();
    await removeNode(userId);
    jest.clearAllMocks();

    await probeLiveness(userId);

    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect((await storedNode(userId)).status).toBe('revoked');
  });

  it('no-ops for an account with no node at all', async () => {
    const userId = await account();
    await probeLiveness(userId);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await storedNode(userId)).toBeUndefined();
  });
});

describe('sweepNodeLiveness', () => {
  it('probes a NEVER-probed node before a recently-probed one', async () => {
    // Mongo sorts a missing `lastProbeAt` ahead of every date on an ascending
    // sort; Postgres puts NULLs LAST unless told otherwise. Without `nulls
    // first`, a freshly registered node is never picked up by the sweep at all.
    const staleEndpoint = `https://stale-${Date.now()}.example.com`;
    const freshEndpoint = `https://fresh-${Date.now()}.example.com`;

    const recentlyProbed = await account();
    await materializeNodeFromRecord(recentlyProbed, nodeRecord({ endpoint: staleEndpoint }));
    await settleProbe(recentlyProbed);

    const neverProbed = await account();
    await materializeNodeFromRecord(neverProbed, nodeRecord({ endpoint: freshEndpoint }));
    await settleProbe(neverProbed);
    // Put it back to "never probed" — the state a registration reaches before
    // its first probe lands, and the one the ordering has to favour.
    await getDb()
      .update(userNodes)
      .set({ lastProbeAt: null, lastSeenAt: null })
      .where(eq(userNodes.userId, neverProbed));

    // A vacuity floor: the sweep is bounded, so if the shared database ever
    // holds more rows than one batch this test would silently stop proving
    // anything. Fail naming the reason instead.
    const sweepable = await getDb()
      .select({ id: userNodes.id })
      .from(userNodes)
      .where(inArray(userNodes.status, ['active', 'unreachable']));
    expect(sweepable.length).toBeLessThan(NODE_LIVENESS_SWEEP_BATCH);

    jest.clearAllMocks();
    await sweepNodeLiveness();

    const probedOrder = mockSafeFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith(freshEndpoint) || url.startsWith(staleEndpoint));
    expect(probedOrder).toEqual([
      `${freshEndpoint}${NODE_WELL_KNOWN_PATH}`,
      `${staleEndpoint}${NODE_WELL_KNOWN_PATH}`,
    ]);
  });

  it('never probes a revoked node', async () => {
    const endpoint = `https://revoked-${Date.now()}.example.com`;
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord({ endpoint }));
    await settleProbe(userId);
    await removeNode(userId);

    jest.clearAllMocks();
    await sweepNodeLiveness();

    expect(mockSafeFetch.mock.calls.map((call) => String(call[0]))).not.toContain(
      `${endpoint}${NODE_WELL_KNOWN_PATH}`,
    );
  });
});

describe('getUserNode', () => {
  it('reads the row from the Oxy database — never the node', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    await settleProbe(userId);

    jest.clearAllMocks();
    const node = await getUserNode(userId);

    expect(node).toMatchObject({ userId, endpoint: 'https://node.example.com', status: 'active' });
    // The read-path invariant: a node being down can never break a DID document.
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('still resolves a node whose last probe failed', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    await settleProbe(userId);
    mockSafeFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await probeLiveness(userId);

    expect(await getUserNode(userId)).toMatchObject({
      status: 'unreachable',
      endpoint: 'https://node.example.com',
    });
  });

  it('returns a revoked row rather than hiding it', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    await settleProbe(userId);
    await removeNode(userId);

    expect(await getUserNode(userId)).toMatchObject({ status: 'revoked' });
  });

  it('returns null for an account with no node', async () => {
    expect(await getUserNode(await account())).toBeNull();
  });

  it('returns null for an id that names no account, without throwing', async () => {
    // No id-shape precheck survives the port: a malformed id is a value that
    // matches no row.
    expect(await getUserNode('not-an-object-id')).toBeNull();
  });
});

describe('removeNode', () => {
  it('flips the row to revoked, clears lastError, and invalidates the user cache', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    await settleProbe(userId);
    await getDb().update(userNodes).set({ lastError: 'chain_gap' }).where(eq(userNodes.userId, userId));
    jest.clearAllMocks();

    await expect(removeNode(userId)).resolves.toBe(true);

    expect(await storedNode(userId)).toMatchObject({ status: 'revoked', lastError: null });
    expect(invalidateSpy).toHaveBeenCalledWith(userId);
  });

  it('returns false and does not invalidate when the node is already revoked', async () => {
    const userId = await account();
    await materializeNodeFromRecord(userId, nodeRecord());
    await settleProbe(userId);
    await removeNode(userId);
    jest.clearAllMocks();

    await expect(removeNode(userId)).resolves.toBe(false);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('returns false for an account that never registered a node', async () => {
    await expect(removeNode(await account())).resolves.toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("never touches another account's node", async () => {
    const mine = await account();
    const theirs = await account();
    await materializeNodeFromRecord(mine, nodeRecord({ endpoint: 'https://mine.example.com' }));
    await materializeNodeFromRecord(theirs, nodeRecord({ endpoint: 'https://theirs.example.com' }));
    await settleProbe(mine);
    await settleProbe(theirs);

    await removeNode(mine);

    expect((await storedNode(theirs)).status).toBe('active');
    const [stillActive] = await getDb()
      .select({ id: userNodes.id })
      .from(userNodes)
      .where(and(eq(userNodes.userId, theirs), eq(userNodes.status, 'active')));
    expect(stillActive).toBeDefined();
  });
});
