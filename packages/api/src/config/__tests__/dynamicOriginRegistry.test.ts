/**
 * dynamicOriginRegistry against a REAL Postgres.
 *
 * The registry derives the CORS allowlist from the Application registry:
 *  - trusted apps (official/internal/system/first_party) → credentialed lane;
 *  - third-party active apps → non-credentialed (bearer) lane;
 *  - everything else → denied.
 *
 * The boot seed (bootstrap-core ∪ OXY_EXTRA_ALLOWED_ORIGINS) keeps first-party
 * origins trusted even before/without a refresh, and `refresh()` FAILS SAFE:
 * every failure path leaves the previous snapshot standing rather than
 * publishing a narrower one.
 *
 * The suite this replaces mocked `mongoose.connection.readyState` and
 * `Application.find`, so the "trusted vs third-party" routing was decided over
 * literals a test author typed — it could not have caught a `where` clause that
 * failed to filter `status`, because no row ever had a status.
 *
 * Every test registers its own applications under UNIQUE hosts and asserts only
 * on those, so rows another test (or another suite sharing this database)
 * leaves behind can only add origins nothing here looks at.
 */

const mockError = jest.fn();

/**
 * `getDb` is the real one until a test arms `failDatabaseRead` — the ONE way to
 * make the query itself throw against a live database, which is the path the
 * fail-soft `catch` exists for. Everything else in this file runs against real
 * rows.
 */
let failDatabaseRead = false;

jest.mock('../postgres', () => {
  const actual = jest.requireActual<typeof import('../postgres')>('../postgres');
  return {
    ...actual,
    getDb: () => {
      if (failDatabaseRead) throw new Error('database down');
      return actual.getDb();
    },
  };
});

jest.mock('../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: (...args: unknown[]) => mockError(...args),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { closePostgres, connectPostgres } from '../postgres';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  isTrustedOrigin,
  getCorsDecision,
  refreshOriginRegistry,
  stopOriginRegistry,
  setOriginSnapshotForTests,
  resetOriginRegistryForTests,
  getExtraAllowedOrigins,
  BOOTSTRAP_CORE_ORIGINS,
} from '../dynamicOriginRegistry';
import { isLoopbackOrigin } from '../../utils/origin';

/** A `users` row to own an application. */
async function account(): Promise<string> {
  const { getDb } = jest.requireActual<typeof import('../postgres')>('../postgres');
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/**
 * Register an application. `status` defaults to `active` — the value the
 * registry's own `where` filters on.
 *
 * Rows are NEVER deleted afterwards. The throwaway database is shared by the
 * whole run, and suites that bracket a global COUNT (`platformStats`) assume
 * counts only grow — a cleanup delete makes the service's count fall below the
 * bracket's floor and fails a suite this file has nothing to do with. Isolation
 * comes from UNIQUE ORIGINS instead: every assertion below names a host no
 * other test registers, so an application another test left behind can only add
 * origins nothing here looks at.
 */
async function registerApp(
  fields: Partial<typeof applications.$inferInsert> & { redirectUris: string[] }
): Promise<string> {
  const { getDb } = jest.requireActual<typeof import('../postgres')>('../postgres');
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: 'Test App',
      ownerAccountId: await account(),
      ...fields,
    })
    .returning({ id: applications.id });
  return row.id;
}

const ORIGINAL_EXTRA = process.env.OXY_EXTRA_ALLOWED_ORIGINS;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  stopOriginRegistry();
  await closePostgres();
  if (ORIGINAL_EXTRA === undefined) {
    delete process.env.OXY_EXTRA_ALLOWED_ORIGINS;
  } else {
    process.env.OXY_EXTRA_ALLOWED_ORIGINS = ORIGINAL_EXTRA;
  }
});

beforeEach(() => {
  failDatabaseRead = false;
  mockError.mockReset();
  resetOriginRegistryForTests();
});

describe('boot seed (no refresh)', () => {
  it('treats every bootstrap-core origin as trusted/credentialed', () => {
    for (const origin of BOOTSTRAP_CORE_ORIGINS) {
      expect(isTrustedOrigin(origin)).toBe(true);
      expect(getCorsDecision(origin)).toEqual({ allow: true, credentials: true });
    }
  });

  it('denies an unregistered origin', () => {
    expect(isTrustedOrigin('https://unknown.example.com')).toBe(false);
    expect(getCorsDecision('https://unknown.example.com')).toEqual({
      allow: false,
      credentials: false,
    });
  });
});

describe('refresh() — trusted vs third-party routing', () => {
  it('routes trusted apps to the credentialed lane and third-party apps to the bearer lane', async () => {
    await registerApp({ type: 'third_party', redirectUris: ['https://third.example.com/cb'] });
    await registerApp({ isOfficial: true, redirectUris: ['https://official.example.com/cb'] });
    await registerApp({ type: 'internal', redirectUris: ['https://internal.example.com/callback'] });
    await registerApp({ type: 'first_party', redirectUris: ['https://first.example.com/x'] });
    await registerApp({ type: 'system', redirectUris: ['https://system.example.com/x'] });

    await refreshOriginRegistry();

    // Third-party → allowed without credentials, NOT trusted.
    expect(isTrustedOrigin('https://third.example.com')).toBe(false);
    expect(getCorsDecision('https://third.example.com')).toEqual({
      allow: true,
      credentials: false,
    });

    // Each trusted classification → credentialed lane + trusted.
    for (const origin of [
      'https://official.example.com',
      'https://internal.example.com',
      'https://first.example.com',
      'https://system.example.com',
    ]) {
      expect(isTrustedOrigin(origin)).toBe(true);
      expect(getCorsDecision(origin)).toEqual({ allow: true, credentials: true });
    }

    // Bootstrap origins survive a refresh.
    expect(getCorsDecision('https://oxy.so')).toEqual({ allow: true, credentials: true });
  });

  it('ignores an application that is not active', async () => {
    await registerApp({
      isOfficial: true,
      status: 'suspended',
      redirectUris: ['https://suspended.example.com/cb'],
    });

    await refreshOriginRegistry();

    // `status: 'active'` is a WHERE clause, not a post-read comparison — a
    // suspended official app must not reach the credentialed lane.
    expect(getCorsDecision('https://suspended.example.com')).toEqual({
      allow: false,
      credentials: false,
    });
  });

  it('normalises redirectUris to origins (drops path/query, lowercases host)', async () => {
    await registerApp({
      type: 'third_party',
      redirectUris: ['https://App.Example.com:8443/cb?x=1'],
    });

    await refreshOriginRegistry();

    expect(getCorsDecision('https://app.example.com:8443')).toEqual({
      allow: true,
      credentials: false,
    });
  });

  it('lets trusted win when a third-party app registers a trusted/bootstrap origin', async () => {
    // A third-party app maliciously/accidentally registers a bootstrap origin.
    await registerApp({ type: 'third_party', redirectUris: ['https://oxy.so/cb'] });
    await registerApp({ isOfficial: true, redirectUris: ['https://shared.example.com/cb'] });
    await registerApp({ type: 'third_party', redirectUris: ['https://shared.example.com/other'] });

    await refreshOriginRegistry();

    // Bootstrap origin must stay credentialed, never demoted to third-party.
    expect(getCorsDecision('https://oxy.so')).toEqual({ allow: true, credentials: true });
    // Origin claimed by BOTH a trusted and a third-party app stays trusted.
    expect(isTrustedOrigin('https://shared.example.com')).toBe(true);
    expect(getCorsDecision('https://shared.example.com')).toEqual({
      allow: true,
      credentials: true,
    });
  });

  it('skips malformed redirectUris without throwing', async () => {
    await registerApp({
      type: 'third_party',
      redirectUris: ['not a url', '', 'https://ok.example.com/cb'],
    });

    await refreshOriginRegistry();

    expect(getCorsDecision('https://ok.example.com')).toEqual({ allow: true, credentials: false });
  });
});

describe('refresh() — fails SAFE', () => {
  it('keeps the previous snapshot and logs when the database read throws', async () => {
    await registerApp({ isOfficial: true, redirectUris: ['https://keep.example.com/cb'] });
    await refreshOriginRegistry();
    expect(isTrustedOrigin('https://keep.example.com')).toBe(true);

    // Next refresh fails — previous snapshot must be retained. `refresh()` is
    // called directly rather than through `refreshOriginRegistry`, whose
    // second half (the redirect-URI reconcile) is not fail-soft by design.
    failDatabaseRead = true;
    const registry = (await import('../dynamicOriginRegistry')).default;
    await registry.refresh();

    expect(isTrustedOrigin('https://keep.example.com')).toBe(true);
    expect(mockError).toHaveBeenCalled();
  });

  it('never NARROWS the allowlist when the database is unreachable', async () => {
    await registerApp({ isOfficial: true, redirectUris: ['https://survivor.example.com/cb'] });
    await refreshOriginRegistry();

    failDatabaseRead = true;
    const registry = (await import('../dynamicOriginRegistry')).default;
    await registry.refresh();

    // The direction is the whole point: an empty trusted set would deny the
    // credentialed lane to every first-party frontend at once, so a database
    // outage must never be able to publish one.
    expect(getCorsDecision('https://survivor.example.com')).toEqual({
      allow: true,
      credentials: true,
    });
    for (const origin of BOOTSTRAP_CORE_ORIGINS) {
      expect(getCorsDecision(origin)).toEqual({ allow: true, credentials: true });
    }
  });
});

describe('OXY_EXTRA_ALLOWED_ORIGINS', () => {
  it('parses valid https entries and drops invalid ones', () => {
    process.env.OXY_EXTRA_ALLOWED_ORIGINS =
      'https://partner.example.com, http://insecure.example.com, https://bad.example.com/path';
    const parsed = getExtraAllowedOrigins();
    expect(parsed.has('https://partner.example.com')).toBe(true);
    expect(parsed.has('http://insecure.example.com')).toBe(false);
    expect(parsed.has('https://bad.example.com/path')).toBe(false);
  });

  it('unions validated extra origins into the trusted snapshot on refresh', async () => {
    process.env.OXY_EXTRA_ALLOWED_ORIGINS = 'https://extra.example.com';
    await refreshOriginRegistry();
    expect(getCorsDecision('https://extra.example.com')).toEqual({
      allow: true,
      credentials: true,
    });
  });
});

describe('loopback (local dev) origins — always credentialed', () => {
  it.each([
    'http://localhost:8081',
    'http://localhost',
    'http://localhost:54321',
    'http://127.0.0.1:3000',
    'http://127.0.0.1',
    'http://[::1]:19006',
    'http://[::1]',
  ])('grants the credentialed lane to %s', (origin) => {
    expect(getCorsDecision(origin)).toEqual({ allow: true, credentials: true });
  });

  it('lets a loopback origin win even when it is also in the third-party snapshot', () => {
    setOriginSnapshotForTests([], ['http://localhost:8081']);
    expect(getCorsDecision('http://localhost:8081')).toEqual({
      allow: true,
      credentials: true,
    });
  });

  it('does not treat https loopback as a loopback origin (falls through to deny)', () => {
    expect(isLoopbackOrigin('https://localhost:8081')).toBe(false);
    expect(getCorsDecision('https://localhost:8081')).toEqual({
      allow: false,
      credentials: false,
    });
  });

  it('rejects loopback lookalikes', () => {
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('http://localhost.evil.com:3000')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });

  it('normalises scheme/host casing and trailing path before matching', () => {
    expect(isLoopbackOrigin('HTTP://LOCALHOST:3000')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:3000/callback?x=1')).toBe(true);
  });
});

describe('setOriginSnapshotForTests', () => {
  it('overrides both snapshots deterministically', () => {
    setOriginSnapshotForTests(['https://t.example.com'], ['https://tp.example.com']);
    expect(getCorsDecision('https://t.example.com')).toEqual({ allow: true, credentials: true });
    expect(getCorsDecision('https://tp.example.com')).toEqual({ allow: true, credentials: false });
    // The bootstrap origin is no longer present after an explicit override.
    expect(isTrustedOrigin('https://oxy.so')).toBe(false);
  });
});
