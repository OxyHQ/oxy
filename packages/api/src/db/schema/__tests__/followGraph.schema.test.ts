/**
 * The invariants the follow graph relies on the DATABASE to keep.
 *
 * Every one of these is enforced in Postgres rather than in a service, because
 * each is a rule a migration, a repair script or a future service could
 * otherwise walk straight past — and the damage would be silent: a duplicate
 * relationship that doubles a follower count, one application redefining
 * another's kinds, an event deleted at the moment a consumer needed it.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applications } from '../applications';
import { followApplicationOverrides } from '../followApplicationOverrides';
import { followEvents } from '../followEvents';
import { followNamespaces } from '../followNamespaces';
import { followRelationships } from '../followRelationships';
import { followTargetKinds } from '../followTargetKinds';
import { followTargets } from '../followTargets';
import { users } from '../users';

let userId: string;
let applicationId: string;
let counter = 0;

function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

async function makeApplication(name = 'Test app') {
  const [app] = await getDb()
    .insert(applications)
    .values({ name, status: 'active', ownerAccountId: userId })
    .returning({ id: applications.id });
  return app.id;
}

async function registerKind(kind: string, namespace: string, appId: string | null = applicationId) {
  // The namespace has to exist first: since 0018 it is a foreign key rather
  // than a string, which is what stops one application defining another's
  // kinds. Claiming it here mirrors what the registry service does.
  await getDb()
    .insert(followNamespaces)
    .values({ namespace, applicationId: appId })
    .onConflictDoNothing({ target: followNamespaces.namespace });
  const [row] = await getDb()
    .insert(followTargetKinds)
    .values({ kind, namespace, applicationId: appId })
    .returning({ kind: followTargetKinds.kind });
  return row.kind;
}

async function makeTarget(kind: string, uri: string) {
  const [row] = await getDb()
    .insert(followTargets)
    .values({ canonicalUri: uri, kind })
    .returning({ id: followTargets.id });
  return row.id;
}

async function follow(targetId: string, extra: Record<string, unknown> = {}) {
  const [row] = await getDb()
    .insert(followRelationships)
    .values({ followerUserId: userId, followTargetId: targetId, ...extra })
    .returning({ id: followRelationships.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  const [user] = await getDb().insert(users).values({}).returning({ id: users.id });
  userId = user.id;
  applicationId = await makeApplication();
});

describe('kinds are registered by applications, not enumerated by the platform', () => {
  it('ships the platform kinds already registered', async () => {
    const [row] = await getDb()
      .select({ kind: followTargetKinds.kind, applicationId: followTargetKinds.applicationId })
      .from(followTargetKinds)
      .where(eq(followTargetKinds.kind, 'oxy.user'))
      .limit(1);

    expect(row).toBeDefined();
    // Owned by the platform, not by an application row.
    expect(row.applicationId).toBeNull();
  });

  it('lets an application register a kind in its own namespace', async () => {
    const ns = unique('mercaria');
    await expect(registerKind(`${ns}.store`, ns)).resolves.toBe(`${ns}.store`);
  });

  it('refuses a kind that does not live in the namespace it claims', async () => {
    // The multi-tenant safety property: one application must not be able to
    // define — or silently redefine — another's kinds.
    const ns = unique('mercaria');
    await expect(registerKind('syra.artist', ns)).rejects.toThrow();
  });

  it('refuses a namespace that is not a single segment', async () => {
    // `a.b` claiming to be its own namespace would let it register `a.b.c`,
    // which reads as nesting and is really a second owner for `a`.
    await expect(registerKind('mercaria.shop.store', 'mercaria.shop')).rejects.toThrow();
    await expect(registerKind('.store', '')).rejects.toThrow();
  });

  it('refuses a target whose kind was never registered', async () => {
    await expect(makeTarget('nobody.registered_this', unique('https://x.example/a'))).rejects.toThrow();
  });
});

describe('the relationship is the user’s', () => {
  it('allows only one relationship per user and target', async () => {
    // What makes a repeated follow idempotent instead of a second row — and a
    // second row is how a follower count starts drifting.
    const ns = unique('appx');
    await registerKind(`${ns}.thing`, ns);
    const targetId = await makeTarget(`${ns}.thing`, unique('https://x.example/t'));
    await follow(targetId);

    await expect(follow(targetId)).rejects.toThrow();
  });

  it('survives the application that created it being deleted', async () => {
    // Provenance, not ownership. Deleting the app the user happened to be using
    // must not delete what the user chose.
    const ns = unique('appx');
    await registerKind(`${ns}.thing`, ns);
    const targetId = await makeTarget(`${ns}.thing`, unique('https://x.example/t'));
    const relationshipId = await follow(targetId, { originApplicationId: applicationId });

    await getDb().delete(applications).where(eq(applications.id, applicationId));

    const [row] = await getDb()
      .select({ id: followRelationships.id, origin: followRelationships.originApplicationId })
      .from(followRelationships)
      .where(eq(followRelationships.id, relationshipId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.origin).toBeNull();
  });

  it('drops a per-application override when its application goes, and keeps the follow', async () => {
    const ns = unique('appx');
    await registerKind(`${ns}.thing`, ns);
    const targetId = await makeTarget(`${ns}.thing`, unique('https://x.example/t'));
    const relationshipId = await follow(targetId);
    const otherApp = await makeApplication('App with an override');
    await getDb()
      .insert(followApplicationOverrides)
      .values({ relationshipId, applicationId: otherApp, mode: 'disabled' });

    await getDb().delete(applications).where(eq(applications.id, otherApp));

    const overrides = await getDb()
      .select({ id: followApplicationOverrides.id })
      .from(followApplicationOverrides)
      .where(eq(followApplicationOverrides.relationshipId, relationshipId));
    expect(overrides).toHaveLength(0);
    const [stillFollowing] = await getDb()
      .select({ id: followRelationships.id })
      .from(followRelationships)
      .where(eq(followRelationships.id, relationshipId))
      .limit(1);
    expect(stillFollowing).toBeDefined();
  });

  it('allows one override per relationship and application', async () => {
    const ns = unique('appx');
    await registerKind(`${ns}.thing`, ns);
    const targetId = await makeTarget(`${ns}.thing`, unique('https://x.example/t'));
    const relationshipId = await follow(targetId);
    const values = { relationshipId, applicationId, mode: 'disabled' as const };
    await getDb().insert(followApplicationOverrides).values(values);

    await expect(getDb().insert(followApplicationOverrides).values(values)).rejects.toThrow();
  });
});

describe('the closed value sets are closed in the DATABASE, not only in TypeScript', () => {
  // The drizzle `enum` on each of these columns is a COMPILE-TIME claim. 0016
  // created all five tables without the CHECK this repo puts beside such a
  // column (see `account_credentials` in 0006), so until 0019 nothing stopped a
  // repair script, a migration, or a service built against a different revision
  // from storing a value every consumer then has to survive at runtime.
  //
  // Each case writes a value ONE character away from a real one, because that
  // is the shape a typo actually takes.

  async function aRelationship() {
    const ns = unique('enumns');
    await registerKind(`${ns}.thing`, ns);
    const uri = unique('https://x.example/t');
    const targetId = await makeTarget(`${ns}.thing`, uri);
    return { relationshipId: await follow(targetId), uri, kind: `${ns}.thing` };
  }

  it('refuses an event type nothing knows how to handle', async () => {
    const { relationshipId, uri, kind } = await aRelationship();
    await expect(
      getDb().insert(followEvents).values({
        eventId: unique('event-'),
        // `follow.create`, not `follow.created`.
        type: 'follow.create' as unknown as 'follow.created',
        cause: 'user_action',
        actorUserId: userId,
        relationshipId,
        targetUri: uri,
        targetKind: kind,
      })
    ).rejects.toThrow();
  });

  it('refuses a cause that would make an expiry indistinguishable from a decision', async () => {
    const { relationshipId, uri, kind } = await aRelationship();
    await expect(
      getDb().insert(followEvents).values({
        eventId: unique('event-'),
        type: 'follow.removed',
        cause: 'expiry' as unknown as 'expired',
        actorUserId: userId,
        relationshipId,
        targetUri: uri,
        targetKind: kind,
      })
    ).rejects.toThrow();
  });

  it('refuses a relationship state no client can render', async () => {
    const ns = unique('enumns');
    await registerKind(`${ns}.thing`, ns);
    const targetId = await makeTarget(`${ns}.thing`, unique('https://x.example/t'));
    await expect(
      follow(targetId, { state: 'pending' })
    ).rejects.toThrow();
  });

  it('refuses a source that is not one of the four ways a follow can arrive', async () => {
    const ns = unique('enumns');
    await registerKind(`${ns}.thing`, ns);
    const targetId = await makeTarget(`${ns}.thing`, unique('https://x.example/t'));
    await expect(follow(targetId, { source: 'import' })).rejects.toThrow();
  });

  it('refuses a stored override mode of `inherit`', async () => {
    // Inheriting means having NO row here. Storing it would give one state two
    // representations, and a reader would then have to handle both.
    const { relationshipId } = await aRelationship();
    await expect(
      getDb()
        .insert(followApplicationOverrides)
        .values({
          relationshipId,
          applicationId,
          mode: 'inherit' as unknown as 'disabled',
        })
    ).rejects.toThrow();
  });
});

describe('the outbox outlives what it describes', () => {
  it('keeps a removal event after its relationship is gone', async () => {
    // `follow.removed` describes a relationship that no longer exists. A foreign
    // key here would delete the event at the exact moment a consumer needs it —
    // which is why `relationship_id` is a plain column.
    const ns = unique('appx');
    await registerKind(`${ns}.thing`, ns);
    const uri = unique('https://x.example/t');
    const targetId = await makeTarget(`${ns}.thing`, uri);
    const relationshipId = await follow(targetId);

    await getDb().insert(followEvents).values({
      eventId: unique('event-'),
      type: 'follow.removed',
      cause: 'user_action',
      actorUserId: userId,
      relationshipId,
      targetUri: uri,
      targetKind: `${ns}.thing`,
    });
    await getDb().delete(followRelationships).where(eq(followRelationships.id, relationshipId));

    const events = await getDb()
      .select({ id: followEvents.id })
      .from(followEvents)
      .where(eq(followEvents.relationshipId, relationshipId));
    expect(events).toHaveLength(1);
  });

  it('refuses two events with the same id, so a redelivery cannot double-count', async () => {
    const ns = unique('appx');
    await registerKind(`${ns}.thing`, ns);
    const uri = unique('https://x.example/t');
    const targetId = await makeTarget(`${ns}.thing`, uri);
    const relationshipId = await follow(targetId);
    const event = {
      eventId: unique('event-'),
      type: 'follow.created' as const,
      cause: 'user_action' as const,
      actorUserId: userId,
      relationshipId,
      targetUri: uri,
      targetKind: `${ns}.thing`,
    };
    await getDb().insert(followEvents).values(event);

    await expect(getDb().insert(followEvents).values(event)).rejects.toThrow();
  });
});
