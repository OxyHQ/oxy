/**
 * The behaviour #809 specifies, as tests.
 *
 * The interesting cases are the ones about what must NOT happen: a second
 * application consuming an existing relationship must not create a second event
 * or move counts again, disabling in one application must not touch the global
 * edge, and an expiry must go down the same path as a manual unfollow rather
 * than a quiet delete.
 */

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { followApplicationOverrides } from '../../db/schema/followApplicationOverrides';
import { followEvents } from '../../db/schema/followEvents';
import { followRelationships } from '../../db/schema/followRelationships';
import { followNamespaces } from '../../db/schema/followNamespaces';
import { followTargetKinds } from '../../db/schema/followTargetKinds';
import { followTargets } from '../../db/schema/followTargets';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import type { FollowCapability } from '../followCapability.service';
import {
  expireDueFollows,
  followTarget,
  getFollowStatus,
  restoreInheritance,
  setApplicationMode,
  unfollowEverywhere,
} from '../followCommand.service';
import { BadRequestError } from '../../utils/error';

let followerId: string;
let followedId: string;
let appA: string;
let appB: string;
let userTarget: { id: string; canonicalUri: string; kind: string; localUserId: string | null };
let counter = 0;

const unique = (prefix: string) => `${prefix}${(counter += 1)}`;

function capabilityFor(applicationId: string): FollowCapability {
  return {
    userId: followerId,
    applicationId,
    grantId: null as unknown as string,
    scopes: ['follows:read', 'follows:write', 'follows:context:write'],
    sessionId: 'session',
  };
}

async function makeApplication(name: string) {
  const [app] = await getDb()
    .insert(applications)
    .values({ name, status: 'active', ownerAccountId: followerId })
    .returning({ id: applications.id });
  return app.id;
}

async function makeUserTarget(localUserId: string) {
  const uri = unique('https://oxy.so/users/u');
  const [row] = await getDb()
    .insert(followTargets)
    .values({ canonicalUri: uri, kind: 'oxy.user', localUserId })
    .returning({ id: followTargets.id });
  return { id: row.id, canonicalUri: uri, kind: 'oxy.user', localUserId };
}

async function eventsFor(relationshipId: string) {
  return getDb()
    .select({ type: followEvents.type, cause: followEvents.cause })
    .from(followEvents)
    .where(eq(followEvents.relationshipId, relationshipId));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  const [a] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [b] = await getDb().insert(users).values({}).returning({ id: users.id });
  followerId = a.id;
  followedId = b.id;
  appA = await makeApplication(unique('App A '));
  appB = await makeApplication(unique('App B '));
  userTarget = await makeUserTarget(followedId);
});

describe('following is global, and happens once', () => {
  it('writes the relationship, the account graph and the event together', async () => {
    const result = await followTarget({ capability: capabilityFor(appA), target: userTarget });

    expect(result.created).toBe(true);
    expect(result.status.effectiveState).toBe('following');

    const [edge] = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
      .limit(1);
    expect(edge).toBeDefined();
    expect(await eventsFor(result.relationshipId)).toEqual([
      { type: 'follow.created', cause: 'user_action' },
    ]);
  });

  it('is idempotent — following twice is one relationship and one event', async () => {
    const first = await followTarget({ capability: capabilityFor(appA), target: userTarget });
    const second = await followTarget({ capability: capabilityFor(appA), target: userTarget });

    expect(second.relationshipId).toBe(first.relationshipId);
    expect(second.created).toBe(false);
    expect(await eventsFor(first.relationshipId)).toHaveLength(1);
  });

  it('shows as following in ANOTHER application, and emits nothing for it', async () => {
    // The rule #809 states directly: follow from app A, and app B sees it
    // silently. A second event here would become a second "new follower"
    // notification for the same edge.
    const created = await followTarget({ capability: capabilityFor(appA), target: userTarget });

    const seenFromB = await getFollowStatus({
      capability: capabilityFor(appB),
      targetId: userTarget.id,
    });

    expect(seenFromB.effectiveState).toBe('following');
    expect(seenFromB.applicationMode).toBe('inherit');
    expect(await eventsFor(created.relationshipId)).toHaveLength(1);
  });

  it('refuses to let a user follow themselves', async () => {
    const self = await makeUserTarget(followerId);

    await expect(
      followTarget({ capability: capabilityFor(appA), target: self })
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('disabling in one application is private and local', () => {
  it('leaves the global relationship and the account graph untouched', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });

    await setApplicationMode({
      capability: capabilityFor(appB),
      relationshipId,
      mode: 'disabled',
    });

    const [relationship] = await getDb()
      .select({ state: followRelationships.state })
      .from(followRelationships)
      .where(eq(followRelationships.id, relationshipId))
      .limit(1);
    expect(relationship.state).toBe('active');

    const [edge] = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
      .limit(1);
    expect(edge).toBeDefined();
  });

  it('changes what THIS application sees and nothing about the others', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });
    await setApplicationMode({ capability: capabilityFor(appB), relationshipId, mode: 'disabled' });

    const fromB = await getFollowStatus({
      capability: capabilityFor(appB),
      targetId: userTarget.id,
    });
    const fromA = await getFollowStatus({
      capability: capabilityFor(appA),
      targetId: userTarget.id,
    });

    expect(fromB.applicationMode).toBe('disabled');
    expect(fromB.effectiveState).toBe('not_following');
    // Still following globally, and still visible as such where it was not
    // disabled — the state the UI has to be able to say out loud.
    expect(fromB.globalState).toBe('active');
    expect(fromA.effectiveState).toBe('following');
  });

  it('restores inheritance by REMOVING the override, not by writing enabled', async () => {
    // "I never said" and "I said yes here" are different answers, and only the
    // first keeps following a future change of default.
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });
    await setApplicationMode({ capability: capabilityFor(appB), relationshipId, mode: 'disabled' });

    await restoreInheritance({ capability: capabilityFor(appB), relationshipId });

    const rows = await getDb()
      .select({ id: followApplicationOverrides.id })
      .from(followApplicationOverrides)
      .where(eq(followApplicationOverrides.relationshipId, relationshipId));
    expect(rows).toHaveLength(0);

    const events = await eventsFor(relationshipId);
    expect(events.map((e) => e.type)).toEqual([
      'follow.created',
      'follow.context_disabled',
      'follow.context_enabled',
    ]);
  });

  it('does not write a duplicate event when the mode is already set', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });

    await setApplicationMode({ capability: capabilityFor(appB), relationshipId, mode: 'disabled' });
    await setApplicationMode({ capability: capabilityFor(appB), relationshipId, mode: 'disabled' });

    const events = await eventsFor(relationshipId);
    expect(events.filter((e) => e.type === 'follow.context_disabled')).toHaveLength(1);
  });

  it('refuses to configure a relationship belonging to somebody else', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });
    const [stranger] = await getDb().insert(users).values({}).returning({ id: users.id });

    const result = await setApplicationMode({
      capability: { ...capabilityFor(appA), userId: stranger.id },
      relationshipId,
      mode: 'disabled',
    });

    expect(result.ok).toBe(false);
  });
});

describe('unfollowing everywhere', () => {
  it('removes the relationship, the edge and the overrides, and says so once', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });
    await setApplicationMode({ capability: capabilityFor(appB), relationshipId, mode: 'disabled' });

    const result = await unfollowEverywhere({ capability: capabilityFor(appA), relationshipId });

    expect(result.removed).toBe(true);
    expect(
      await getDb()
        .select({ id: followRelationships.id })
        .from(followRelationships)
        .where(eq(followRelationships.id, relationshipId))
    ).toHaveLength(0);
    expect(
      await getDb()
        .select({ id: followApplicationOverrides.id })
        .from(followApplicationOverrides)
        .where(eq(followApplicationOverrides.relationshipId, relationshipId))
    ).toHaveLength(0);
    expect(
      await getDb()
        .select({ id: userFollows.id })
        .from(userFollows)
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
    ).toHaveLength(0);
  });

  it('keeps the removal event after the relationship is gone', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });

    await unfollowEverywhere({ capability: capabilityFor(appA), relationshipId });

    const events = await eventsFor(relationshipId);
    expect(events).toContainEqual({ type: 'follow.removed', cause: 'user_action' });
  });

  it('is idempotent, and refuses somebody else’s relationship', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });
    const [stranger] = await getDb().insert(users).values({}).returning({ id: users.id });

    expect(
      await unfollowEverywhere({
        capability: { ...capabilityFor(appA), userId: stranger.id },
        relationshipId,
      })
    ).toEqual({ removed: false });

    await unfollowEverywhere({ capability: capabilityFor(appA), relationshipId });
    expect(
      await unfollowEverywhere({ capability: capabilityFor(appA), relationshipId })
    ).toEqual({ removed: false });
  });
});

describe('a timed follow ends like a manual one', () => {
  it('expires down the same path, and says the cause was the clock', async () => {
    // The point of routing expiry through the command service: it emits
    // `follow.removed`, so federation teardown and count movement happen exactly
    // as they do for a decision. `cause` is what lets a consumer tell them
    // apart — nobody was told there was a clock, so nobody is notified.
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
      expiresAt: new Date(Date.now() - 1000),
    });

    const removed = await expireDueFollows();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await eventsFor(relationshipId)).toContainEqual({
      type: 'follow.removed',
      cause: 'expired',
    });
    expect(
      await getDb()
        .select({ id: userFollows.id })
        .from(userFollows)
        .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)))
    ).toHaveLength(0);
  });

  it('leaves a follow whose time has not come', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expireDueFollows();

    expect(
      await getDb()
        .select({ id: followRelationships.id })
        .from(followRelationships)
        .where(eq(followRelationships.id, relationshipId))
    ).toHaveLength(1);
  });

  it('never touches a permanent follow', async () => {
    const { relationshipId } = await followTarget({
      capability: capabilityFor(appA),
      target: userTarget,
    });

    await expireDueFollows();

    expect(
      await getDb()
        .select({ id: followRelationships.id })
        .from(followRelationships)
        .where(eq(followRelationships.id, relationshipId))
    ).toHaveLength(1);
  });
});

describe('non-user targets', () => {
  it('follows a target that is not an account, without touching the account graph', async () => {
    const ns = unique('shopz');
    // The namespace comes first: since 0018 it is a foreign key rather than a
    // string, which is what stops one application defining another's kinds.
    await getDb().insert(followNamespaces).values({ namespace: ns, applicationId: appA });
    await getDb().insert(followTargetKinds).values({ kind: `${ns}.store`, namespace: ns });
    const uri = unique('https://shop.example/stores/s');
    const [row] = await getDb()
      .insert(followTargets)
      .values({ canonicalUri: uri, kind: `${ns}.store` })
      .returning({ id: followTargets.id });

    const result = await followTarget({
      capability: capabilityFor(appA),
      target: { id: row.id, canonicalUri: uri, kind: `${ns}.store`, localUserId: null },
    });

    expect(result.created).toBe(true);
    expect(
      await getDb()
        .select({ id: userFollows.id })
        .from(userFollows)
        .where(eq(userFollows.followerId, followerId))
    ).toHaveLength(0);
  });
});
