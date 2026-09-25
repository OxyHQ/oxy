/**
 * `POST /federation/move` against a REAL Postgres, with a fake remote actor.
 *
 * The remote side is the one call Oxy makes to it — a FRESH fetch of the old
 * actor — replaced with an in-memory actor store (the production path is the
 * SSRF-safe signed client, which refuses loopback). What is pinned:
 *  - a valid Move repoints the old account's local followers to the target,
 *    carries inbound blocks, records the redirect, marks the claim linked;
 *  - a block between the target and a follower, either way, is respected;
 *  - no alias → 422, `movedTo` mismatch → 422, unreachable actor → 502,
 *    a target on a host the caller is not registered for → 400;
 *  - the same activity twice applies once;
 *  - `federation:write` is required.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

let currentServiceApp: Record<string, unknown> | undefined;

jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (req: { serviceApp?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.serviceApp = currentServiceApp;
    next();
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn(), get: jest.fn(), set: jest.fn() } }));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { blocks } from '../../db/schema/blocks';
import { canonicalUserRedirects, externalIdentities, externalIdentityActors, externalIdentityClaims } from '../../db/schema/externalIdentities';
import { federatedAccountMoves } from '../../db/schema/federatedAccountMoves';
import { followEvents } from '../../db/schema/followEvents';
import { followRelationships } from '../../db/schema/followRelationships';
import { followTargets } from '../../db/schema/followTargets';
import { userFollows } from '../../db/schema/userFollows';
import { userLinkedAccounts } from '../../db/schema/userLinkedAccounts';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { federationService } from '../../services/federation.service';
import credentialDomainCache from '../../utils/credentialDomainCache';
import userCache from '../../utils/userCache';
import federationRouter from '../federation';

/** The fake remote server: actor URI → the document it serves now. */
const remoteActors = new Map<string, Record<string, unknown>>();

let server: http.Server;
let relayAppId: string;

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> & { data?: Record<string, unknown>; error?: string } }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/federation/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function localUser(): Promise<{ id: string; username: string }> {
  const username = `u${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const [row] = await getDb().insert(users).values({ username, type: 'local' }).returning({ id: users.id });
  return { id: row.id, username };
}

/** A remote account that moved to a fresh local account, with the alias in place. */
async function scenario(options: { alias?: boolean; movedTo?: 'target' | 'elsewhere' | 'unreachable' } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const oldActorUri = `https://mastodon.example/users/old${suffix}`;
  const canonicalAcct = `old${suffix}@mastodon.example`;
  const [oldUser] = await getDb()
    .insert(users)
    .values({ username: canonicalAcct, type: 'federated', federationActorUri: oldActorUri })
    .returning({ id: users.id });
  await getDb().insert(externalIdentities).values({ canonicalAcct, userId: oldUser.id, network: 'mastodon.example' });
  await getDb().insert(externalIdentityActors).values({ actorUri: oldActorUri, canonicalAcct, transportAcct: canonicalAcct, protocol: 'activitypub' });

  const target = await localUser();
  const targetActorUri = `https://mention.earth/ap/users/${target.username}`;
  if (options.alias !== false) {
    await getDb().insert(userLinkedAccounts).values({
      userId: target.id, network: 'activitypub', accountKey: canonicalAcct, actorUri: oldActorUri,
      handle: `@${canonicalAcct}`, host: 'mastodon.example', verifiedAt: new Date(),
    });
  }
  const movedTo = options.movedTo ?? 'target';
  if (movedTo !== 'unreachable') {
    remoteActors.set(oldActorUri, {
      id: oldActorUri,
      type: 'Person',
      movedTo: movedTo === 'target' ? targetActorUri : 'https://elsewhere.example/users/x',
    });
  }
  return { oldActorUri, oldUserId: oldUser.id, target, targetActorUri, canonicalAcct };
}

/** Follow the old account the two ways a local user can: the projection and a v2 relationship. */
async function followOld(followerId: string, oldUserId: string, viaRelationship = false): Promise<void> {
  await getDb().insert(userFollows).values({ followerId, followedId: oldUserId }).onConflictDoNothing();
  if (viaRelationship) {
    await getDb()
      .insert(followTargets)
      .values({ canonicalUri: `https://oxy.so/users/${oldUserId}`, kind: 'oxy.user', localUserId: oldUserId })
      .onConflictDoNothing();
    const [target] = await getDb().select({ id: followTargets.id }).from(followTargets).where(eq(followTargets.localUserId, oldUserId));
    await getDb().insert(followRelationships).values({ followerUserId: followerId, followTargetId: target.id, state: 'active' });
  }
}

async function follows(followerId: string, followedId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)));
  return rows.length > 0;
}

beforeAll(async () => {
  await connectPostgres();
  const owner = await localUser();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `Mention ${randomUUID()}`, ownerAccountId: owner.id, redirectUris: ['https://mention.earth'] })
    .returning({ id: applications.id });
  relayAppId = app.id;
  jest.spyOn(federationService, 'fetchActorDocument').mockImplementation(async (uri: string) => remoteActors.get(uri) ?? null);
  const app2 = express();
  app2.use(express.json());
  app2.use('/federation', federationRouter);
  app2.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app2.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

beforeEach(() => {
  credentialDomainCache.clear();
  currentServiceApp = { type: 'service', appId: relayAppId, appName: 'Mention', credentialId: 'c', scopes: ['federation:write'] };
});

describe('POST /federation/move — a verified Move', () => {
  it('repoints followers, respects blocks, carries blocks, records the redirect and links the claim', async () => {
    const s = await scenario();
    const plain = await localUser();
    const viaRelationship = await localUser();
    const blockedByTarget = await localUser();
    const blocksTarget = await localUser();
    const blockedOld = await localUser();
    const already = await localUser();
    for (const follower of [plain, blockedByTarget, blocksTarget, blockedOld, already]) await followOld(follower.id, s.oldUserId);
    await followOld(viaRelationship.id, s.oldUserId, true);
    await getDb().insert(userFollows).values({ followerId: already.id, followedId: s.target.id });
    await getDb().insert(blocks).values([
      { userId: s.target.id, blockedId: blockedByTarget.id },
      { userId: blocksTarget.id, blockedId: s.target.id },
      { userId: blockedOld.id, blockedId: s.oldUserId },
    ]);

    const activityId = `${s.oldActorUri}#moves/1`;
    const res = await post({ oldActorUri: s.oldActorUri, targetActorUri: s.targetActorUri, activityId });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      replayed: false,
      oldUserId: s.oldUserId,
      targetUserId: s.target.id,
      followersMoved: 2,
      alreadyFollowing: 1,
      skippedBlocked: 3,
    });

    expect(await follows(plain.id, s.target.id)).toBe(true);
    expect(await follows(viaRelationship.id, s.target.id)).toBe(true);
    for (const skipped of [blockedByTarget, blocksTarget, blockedOld]) expect(await follows(skipped.id, s.target.id)).toBe(false);
    // Nobody still follows the old account: it redirects to the target now.
    for (const follower of [plain, viaRelationship, blockedByTarget, blocksTarget, blockedOld, already]) {
      expect(await follows(follower.id, s.oldUserId)).toBe(false);
    }
    // The block against the OLD account now holds against the target.
    const carried = await getDb().select().from(blocks).where(and(eq(blocks.userId, blockedOld.id), eq(blocks.blockedId, s.target.id)));
    expect(carried).toHaveLength(1);

    const [redirect] = await getDb().select().from(canonicalUserRedirects).where(eq(canonicalUserRedirects.userId, s.oldUserId));
    expect(redirect.canonicalUserId).toBe(s.target.id);
    const [claim] = await getDb().select().from(externalIdentityClaims).where(eq(externalIdentityClaims.actorUri, s.oldActorUri));
    expect(claim).toMatchObject({ state: 'linked', targetAcct: `${s.target.username}@mention.earth` });

    const events = await getDb().select({ type: followEvents.type, cause: followEvents.cause }).from(followEvents)
      .where(eq(followEvents.actorUserId, viaRelationship.id));
    expect(events).toEqual(expect.arrayContaining([
      { type: 'follow.created', cause: 'migration' },
      { type: 'follow.removed', cause: 'migration' },
    ]));

    // The signal a relying app reattributes content on.
    expect(userCache.invalidate).toHaveBeenCalledWith(s.oldUserId);
    expect(userCache.invalidate).toHaveBeenCalledWith(s.target.id);
  });

  it('is idempotent: the same activity twice applies once and reports the first result', async () => {
    const s = await scenario();
    const follower = await localUser();
    await followOld(follower.id, s.oldUserId);
    const body = { oldActorUri: s.oldActorUri, targetActorUri: s.targetActorUri, activityId: `${s.oldActorUri}#moves/2` };
    const first = await post(body);
    const second = await post(body);
    expect(first.body.data).toMatchObject({ replayed: false, followersMoved: 1 });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ replayed: true, followersMoved: 1, moveId: first.body.data.moveId });
    const audit = await getDb().select().from(federatedAccountMoves).where(eq(federatedAccountMoves.activityId, body.activityId));
    expect(audit).toHaveLength(1);
  });
});

describe('POST /federation/move — refusals', () => {
  it('refuses a target that has not linked the old account as an alias (422)', async () => {
    const s = await scenario({ alias: false });
    const res = await post({ oldActorUri: s.oldActorUri, targetActorUri: s.targetActorUri, activityId: `${s.oldActorUri}#m` });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('alias_missing');
    expect(await getDb().select().from(canonicalUserRedirects).where(eq(canonicalUserRedirects.userId, s.oldUserId))).toEqual([]);
  });

  it('refuses when the old actor, fetched fresh, names a different movedTo (422)', async () => {
    const s = await scenario({ movedTo: 'elsewhere' });
    const follower = await localUser();
    await followOld(follower.id, s.oldUserId);
    const res = await post({ oldActorUri: s.oldActorUri, targetActorUri: s.targetActorUri, activityId: `${s.oldActorUri}#m` });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('moved_to_mismatch');
    expect(await follows(follower.id, s.oldUserId)).toBe(true);
  });

  it('refuses when the old actor cannot be fetched (502)', async () => {
    const s = await scenario({ movedTo: 'unreachable' });
    const res = await post({ oldActorUri: s.oldActorUri, targetActorUri: s.targetActorUri, activityId: `${s.oldActorUri}#m` });
    expect(res.status).toBe(502);
  });

  it('refuses a target on a host the relaying app is not registered for (400)', async () => {
    const s = await scenario();
    const res = await post({
      oldActorUri: s.oldActorUri,
      targetActorUri: `https://evil.example/ap/users/${s.target.username}`,
      activityId: `${s.oldActorUri}#m`,
    });
    expect(res.status).toBe(400);
  });

  it('requires federation:write', async () => {
    const s = await scenario();
    currentServiceApp = { type: 'service', appId: relayAppId, scopes: ['federation:identities:resolve'] };
    const res = await post({ oldActorUri: s.oldActorUri, targetActorUri: s.targetActorUri, activityId: `${s.oldActorUri}#m` });
    expect(res.status).toBe(403);
  });
});
