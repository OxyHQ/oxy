/**
 * Node-ingest scheduling (F5b), in-process fallback — against a REAL Postgres.
 *
 * Two separable subjects:
 *
 *  1. **`enqueueNodeIngest` dedupes per user.** Two enqueues for the same user
 *     before the drain runs produce a single `ingestFromNode` call. No database
 *     involved: this is the in-process pending set.
 *  2. **`sweepPullNodes` selects the right nodes, in the right order.** That is
 *     a claim about ROWS, so the rows are real. The previous version replaced
 *     `models/UserNode` with a `jest.fn()` and asserted the FILTER OBJECT the
 *     stub received with `toMatchObject({ mode: 'pull' })` — a partial match on
 *     a query shape, which said nothing about the status set, nothing about the
 *     ordering, nothing about the batch bound, and could not observe a node that
 *     should have been EXCLUDED because no node existed.
 *
 * Queues are forced disabled (`isQueueEnabled → false`) so the in-process path is
 * exercised without BullMQ/Redis. `ingestFromNode` is mocked because it is real
 * outbound node I/O with its own suite; the logger and the queue connection are
 * mocked. Nothing else is.
 *
 * ## Reading assertions on a SHARED database
 *
 * The sweep is fleet-wide by definition: it reads every eligible row, including
 * ones other suites in this run inserted. So every assertion is scoped to the
 * users THIS file created, and the ordering case carries a vacuity floor — if
 * the shared database ever holds a full batch of eligible rows, the case would
 * silently stop proving anything, so it fails naming that instead.
 */

const mockIngest = jest.fn();

jest.mock('../../services/nodeSync.service', () => ({
  ingestFromNode: (...args: unknown[]) => mockIngest(...args),
}));
jest.mock('../connection', () => ({ getQueueConnectionOptions: jest.fn(() => ({})) }));
jest.mock('../queueManager', () => ({ isQueueEnabled: () => false }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { USER_NODE_MODES, USER_NODE_STATUSES, userNodes } from '../../db/schema/userNodes';
import { users } from '../../db/schema/users';
import { NODE_INGEST_SWEEP_BATCH } from '../../utils/nodes.constants';
import { enqueueNodeIngest, sweepPullNodes } from '../nodeIngest.queue';

type NodeMode = (typeof USER_NODE_MODES)[number];
type NodeStatus = (typeof USER_NODE_STATUSES)[number];

/** Drain the floating setImmediate-scheduled drain + its awaited microtasks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/**
 * A registered node for a brand-new account. `lastSyncedAt: null` (the default)
 * is the state every registration reaches before its first ingest lands.
 */
async function insertNode(fields: {
  mode?: NodeMode;
  status?: NodeStatus;
  lastSyncedAt?: Date | null;
} = {}): Promise<string> {
  const userId = await insertUser();
  await getDb().insert(userNodes).values({
    userId,
    endpoint: 'https://node.example',
    nodePublicKey: '04'.repeat(33),
    ...fields,
  });
  return userId;
}

/** The user ids handed to `ingestFromNode`, in order, restricted to `mine`. */
function ingestedAmong(mine: readonly string[]): string[] {
  const owned = new Set(mine);
  return mockIngest.mock.calls
    .map((call) => String(call[0]))
    .filter((userId) => owned.has(userId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  // Drain BEFORE clearing, so a previous case's tail cannot land in this
  // case's call list and pollute an ordering assertion.
  await flush();
  jest.clearAllMocks();
  mockIngest.mockResolvedValue(undefined);
});

describe('enqueueNodeIngest (in-process fallback)', () => {
  it('dedupes: two enqueues for the same user before the drain → one ingest', async () => {
    enqueueNodeIngest('user-1');
    enqueueNodeIngest('user-1');

    await flush();

    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledWith('user-1');
  });

  it('runs distinct users independently', async () => {
    enqueueNodeIngest('user-a');
    enqueueNodeIngest('user-b');

    await flush();

    expect(mockIngest).toHaveBeenCalledTimes(2);
    expect(mockIngest).toHaveBeenCalledWith('user-a');
    expect(mockIngest).toHaveBeenCalledWith('user-b');
  });
});

describe('sweepPullNodes — which nodes are eligible', () => {
  it('sweeps an active pull node', async () => {
    const active = await insertNode({ mode: 'pull', status: 'active' });

    await sweepPullNodes();
    await flush();

    expect(ingestedAmong([active])).toEqual([active]);
  });

  it('sweeps an UNREACHABLE pull node — a node being down is why we re-pull', async () => {
    const unreachable = await insertNode({ mode: 'pull', status: 'unreachable' });

    await sweepPullNodes();
    await flush();

    expect(ingestedAmong([unreachable])).toEqual([unreachable]);
  });

  it('never sweeps a REVOKED node', async () => {
    // The registration is gone: there is no chain left to mirror, and pulling
    // one would re-ingest records from a node the user disowned.
    const revoked = await insertNode({ mode: 'pull', status: 'revoked' });
    const active = await insertNode({ mode: 'pull', status: 'active' });

    await sweepPullNodes();
    await flush();

    expect(ingestedAmong([revoked, active])).toEqual([active]);
  });

  it('never sweeps a PUSH-mode node', async () => {
    // In push mode Oxy sends records to the node; there is nothing to pull, and
    // sweeping one would schedule an ingest that can only be a no-op.
    const push = await insertNode({ mode: 'push', status: 'active' });
    const pull = await insertNode({ mode: 'pull', status: 'active' });

    await sweepPullNodes();
    await flush();

    expect(ingestedAmong([push, pull])).toEqual([pull]);
  });
});

describe('sweepPullNodes — ordering', () => {
  it('takes a NEVER-synced node before an old one, and an old one before a recent one', async () => {
    // Mongo sorts a missing `lastSyncedAt` ahead of every date on an ascending
    // sort; Postgres puts NULLs LAST unless told otherwise. Without `nulls
    // first` a freshly registered node sorts behind every node that has ever
    // been ingested — and since the sweep is bounded to
    // `NODE_INGEST_SWEEP_BATCH`, it is never picked up at all.
    const recent = await insertNode({ lastSyncedAt: new Date() });
    const old = await insertNode({ lastSyncedAt: new Date(Date.now() - 86_400_000) });
    const neverSynced = await insertNode({ lastSyncedAt: null });

    // Vacuity floor: the sweep is bounded, so a shared database holding a full
    // batch of eligible rows would make this case pass without proving
    // anything. Fail naming that reason instead.
    const eligible = await getDb()
      .select({ id: userNodes.id })
      .from(userNodes)
      .where(inArray(userNodes.status, ['active', 'unreachable']));
    expect(eligible.length).toBeLessThan(NODE_INGEST_SWEEP_BATCH);

    await sweepPullNodes();
    await flush();

    expect(ingestedAmong([recent, old, neverSynced])).toEqual([neverSynced, old, recent]);
  });
});
