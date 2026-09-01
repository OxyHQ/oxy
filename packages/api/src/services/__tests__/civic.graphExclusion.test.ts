/**
 * `graphExclusion` — the shared sock-puppet test, against a REAL Postgres.
 *
 * This is the anti-sybil gate BOTH the real-life attestation flow and the jury
 * selection delegate to, so a false NEGATIVE here is a farm of fake accounts
 * attesting each other and a false POSITIVE is two strangers who can never
 * attest at all. The suite it replaces drove `Follow`/`Block`/`Session` through
 * an in-memory fixture keyed on the exact query shape the Mongoose code emitted,
 * which meant it re-stated the queries rather than the RULE — it could not tell
 * a predicate on the wrong column of `blocks` (both columns are user ids) from a
 * correct one, and it could not see the `is_active` filter at all because the
 * fixture never modelled an inactive session.
 *
 * So every case below writes real rows and asserts the verdict. The two that
 * carry the most weight:
 *
 *  - **A shared `device_fingerprint` must NOT yield `shared_device`.** The
 *    fingerprint is a sha256 of a client-supplied environment blob with ZERO
 *    device-unique inputs on React Native, so two DISTINCT phones on the same
 *    locale produce the same value — a prod incident. The fixture is
 *    discriminating: both accounts carry the SAME fingerprint and DIFFERENT
 *    device ids, so a rule that reads the fingerprint goes red.
 *  - **An expired/revoked session must not link two accounts.** `is_active` is
 *    the only thing separating "these two are on one phone right now" from
 *    "these two once signed in on a phone that has since been signed out".
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { blocks } from '../../db/schema/blocks';
import { sessions } from '../../db/schema/sessions';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import {
  areGraphRelated,
  isSockPuppetRelation,
  sessionDeviceIds,
  sessionDeviceIdsFor,
  shareDevice,
} from '../civic/graphExclusion';

const unique = () => randomUUID();

/** Fresh accounts. Every id is per-test, so nothing depends on an empty table. */
async function accounts(count: number): Promise<string[]> {
  const rows = await getDb()
    .insert(users)
    .values(Array.from({ length: count }, () => ({ username: `u-${unique().slice(0, 18)}` })))
    .returning({ id: users.id });
  return rows.map((row) => row.id);
}

/** A session row for `userId` on `deviceId`. Active unless told otherwise. */
async function session(
  userId: string,
  deviceId: string,
  overrides: { isActive?: boolean; deviceFingerprint?: string } = {}
): Promise<void> {
  const token = unique();
  await getDb().insert(sessions).values({
    sessionId: `s-${token}`,
    userId,
    deviceId,
    deviceType: 'mobile',
    platform: 'ios',
    accessToken: `at-${token}`,
    refreshToken: `rt-${token}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    isActive: overrides.isActive ?? true,
    deviceFingerprint: overrides.deviceFingerprint,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('isSockPuppetRelation — the social-graph signal', () => {
  it('excludes an account from itself', async () => {
    const [a] = await accounts(1);
    expect(await isSockPuppetRelation(a, a)).toEqual({ excluded: true, reason: 'self' });
  });

  it('excludes a follow edge in EITHER direction', async () => {
    const [a, b, c, d] = await accounts(4);
    await getDb().insert(userFollows).values({ followerId: a, followedId: b });
    await getDb().insert(userFollows).values({ followerId: d, followedId: c });

    // a → b (outgoing for a, incoming for b): both orders must exclude.
    expect(await isSockPuppetRelation(a, b)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
    expect(await isSockPuppetRelation(b, a)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
    // d → c: the same, seeded the other way round so neither direction of the
    // read can be the one that happens to work.
    expect(await isSockPuppetRelation(c, d)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
  });

  it('excludes a block edge in EITHER direction', async () => {
    // `blocks` has two user-id columns, so a predicate on the wrong one reports
    // the inverse relationship with no type error. Both orders are stated.
    const [a, b, c, d] = await accounts(4);
    await getDb().insert(blocks).values({ userId: a, blockedId: b });
    await getDb().insert(blocks).values({ userId: d, blockedId: c });

    expect(await isSockPuppetRelation(a, b)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
    expect(await isSockPuppetRelation(b, a)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
    expect(await isSockPuppetRelation(c, d)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
  });

  it('does not exclude two accounts with no edge and no shared device', async () => {
    const [a, b, other] = await accounts(3);
    // Each has real edges and real sessions — just not with each other, so a
    // rule that answered "excluded" on the mere PRESENCE of rows goes red.
    await getDb().insert(userFollows).values({ followerId: a, followedId: other });
    await getDb().insert(blocks).values({ userId: b, blockedId: other });
    await session(a, `dev-${unique()}`);
    await session(b, `dev-${unique()}`);

    expect(await isSockPuppetRelation(a, b)).toEqual({ excluded: false });
  });

  it('reports the graph reason FIRST when an account is both a neighbour and a co-device', async () => {
    const [a, b] = await accounts(2);
    const device = `dev-${unique()}`;
    await getDb().insert(userFollows).values({ followerId: a, followedId: b });
    await session(a, device);
    await session(b, device);

    expect(await isSockPuppetRelation(a, b)).toEqual({
      excluded: true,
      reason: 'graph_neighbor',
    });
  });
});

describe('isSockPuppetRelation — the device signal', () => {
  it('excludes two accounts signed in on the SAME device id', async () => {
    const [a, b] = await accounts(2);
    const device = `dev-${unique()}`;
    await session(a, device);
    await session(b, device);

    expect(await isSockPuppetRelation(a, b)).toEqual({
      excluded: true,
      reason: 'shared_device',
    });
  });

  it('does NOT exclude two distinct installs that share only the coarse environment fingerprint', async () => {
    // The prod incident: `device_fingerprint` is sha256 of {userAgent, platform,
    // language, timezone, screen} — no device-unique input on React Native — so
    // two separate phones on the same locale hash identically. Discriminating by
    // construction: identical fingerprint, different device id.
    const [a, b] = await accounts(2);
    const sharedFingerprint = `fp-${unique()}`;
    await session(a, `dev-${unique()}`, { deviceFingerprint: sharedFingerprint });
    await session(b, `dev-${unique()}`, { deviceFingerprint: sharedFingerprint });

    expect(await isSockPuppetRelation(a, b)).toEqual({ excluded: false });
    expect(await shareDevice(a, b)).toBe(false);
  });

  it('still excludes a shared device id when the fingerprints DIFFER', async () => {
    // The other half of the same rule: the fingerprint neither creates nor
    // suppresses a verdict. `device_id` alone decides.
    const [a, b] = await accounts(2);
    const device = `dev-${unique()}`;
    await session(a, device, { deviceFingerprint: `fp-${unique()}` });
    await session(b, device, { deviceFingerprint: `fp-${unique()}` });

    expect(await isSockPuppetRelation(a, b)).toEqual({
      excluded: true,
      reason: 'shared_device',
    });
  });

  it('ignores an INACTIVE session on the shared device', async () => {
    // Dropping the `is_active` predicate would make a signed-out session link
    // two accounts forever — the whole difference between "on one phone now"
    // and "once signed in on a phone".
    const [a, b] = await accounts(2);
    const device = `dev-${unique()}`;
    await session(a, device, { isActive: false });
    await session(b, device);

    expect(await isSockPuppetRelation(a, b)).toEqual({ excluded: false });
    expect(await sessionDeviceIds(a)).toEqual(new Set());
    expect(await sessionDeviceIds(b)).toEqual(new Set([device]));
  });
});

describe('areGraphRelated — hop radius', () => {
  it('treats a common neighbour as related at 2 hops but NOT at 1', async () => {
    const [a, b, x] = await accounts(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: a, followedId: x },
        { followerId: b, followedId: x },
      ]);

    expect(await areGraphRelated(a, b, 1)).toBe(false);
    expect(await areGraphRelated(a, b, 2)).toBe(true);
  });

  it('finds a direct edge at ANY radius, including the default', async () => {
    const [a, b] = await accounts(2);
    await getDb().insert(userFollows).values({ followerId: a, followedId: b });

    expect(await areGraphRelated(a, b)).toBe(true);
    expect(await areGraphRelated(a, b, 1)).toBe(true);
    expect(await areGraphRelated(a, b, 2)).toBe(true);
  });

  it('leaves two accounts three hops apart unrelated even at 2 hops', async () => {
    // a → x → y ← b: no shared DIRECT neighbour, so the 2-hop intersection is
    // empty. Without this, "2 hops" could quietly mean "reachable at all".
    const [a, b, x, y] = await accounts(4);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: a, followedId: x },
        { followerId: x, followedId: y },
        { followerId: b, followedId: y },
      ]);

    expect(await areGraphRelated(a, b, 2)).toBe(false);
    // …and the two pairs that ARE one hop apart still are.
    expect(await areGraphRelated(a, x, 1)).toBe(true);
    expect(await areGraphRelated(b, y, 1)).toBe(true);
  });
});

describe('sessionDeviceIdsFor — the batched read the sybil clustering runs on', () => {
  it('keys every account to its OWN devices and nobody else’s', async () => {
    const [a, b, c] = await accounts(3);
    const deviceA1 = `dev-${unique()}`;
    const deviceA2 = `dev-${unique()}`;
    const deviceB = `dev-${unique()}`;
    await session(a, deviceA1);
    await session(a, deviceA2);
    await session(b, deviceB);

    const byUser = await sessionDeviceIdsFor([a, b, c]);

    expect(byUser.get(a)).toEqual(new Set([deviceA1, deviceA2]));
    expect(byUser.get(b)).toEqual(new Set([deviceB]));
    // An account with no session is PRESENT with an empty set, not absent — the
    // clustering indexes by account and a missing key would read as a miss.
    expect(byUser.get(c)).toEqual(new Set());
  });

  it('returns an empty map for no accounts', async () => {
    expect(await sessionDeviceIdsFor([])).toEqual(new Map());
  });
});
