/**
 * The Oxy Updates (OTA) cluster, against a REAL Postgres.
 *
 * The decisions under test are the ones a published manifest's correctness rests
 * on: the ordinal that keeps an update's asset list byte-stable, the generated
 * S3 key that cannot disagree with its content address, the `RESTRICT` that
 * stops referenced bytes from being deleted, the `extra.expoClient` CHECK that
 * replaces a bypassable Mongoose validator, and the child table that replaced an
 * array Mongo addressed by inner field.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import {
  UPDATE_ASSET_KEY_PREFIX as SERVICE_UPDATE_ASSET_KEY_PREFIX,
  updateAssetS3Key,
} from '../../../services/updates/assetKeys';
import { applications } from '../applications';
import { appUpdateAssets } from '../appUpdateAssets';
import { APP_UPDATE_STATUSES, appUpdates } from '../appUpdates';
import {
  UPDATE_ASSET_KEY_PREFIX,
  UPDATE_ASSET_STATUSES,
  updateAssets,
} from '../updateAssets';
import { updateChannelRollbacks } from '../updateChannelRollbacks';
import { UPDATE_PLATFORMS, updateChannels } from '../updateChannels';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `generated_always` — a write to a generated column. */
const GENERATED_ALWAYS = '428C9';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** The SQLSTATE a driver error carries; drizzle nests it under `cause`. */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Await a query expecting rejection, issuing exactly one statement. */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A random lowercase-hex SHA-256, the shape every asset reference must match. */
function sha256Hex(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 64);
}

/** A real `applications` row with its own owning account. */
async function application(): Promise<string> {
  const [owner] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `OTA ${randomUUID()}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  return row.id;
}

/** A real `update_channels` row. */
async function channel(applicationId: string, name = `production-${randomUUID()}`): Promise<string> {
  const [row] = await getDb()
    .insert(updateChannels)
    .values({ applicationId, name })
    .returning({ id: updateChannels.id });
  return row.id;
}

/** An `uploaded` asset, ready to be referenced by a published update. */
async function uploadedAsset(sha256 = sha256Hex()): Promise<string> {
  await getDb().insert(updateAssets).values({
    sha256,
    contentType: 'application/javascript',
    size: 1024,
    status: 'uploaded',
  });
  return sha256;
}

/** The minimum a published update needs, given an already-uploaded launch asset. */
async function publishedUpdate(
  applicationId: string,
  channelId: string,
  launchAssetSha256: string
): Promise<{ id: string; updateId: string }> {
  const [row] = await getDb()
    .insert(appUpdates)
    .values({
      applicationId,
      channelId,
      runtimeVersion: '1.0.0',
      platform: 'ios',
      launchAssetSha256,
      launchAssetKey: 'bundle',
      launchAssetContentType: 'application/javascript',
      extra: { expoClient: { name: 'Commons', slug: 'commons' } },
    })
    .returning({ id: appUpdates.id, updateId: appUpdates.updateId });
  return row;
}

describe('update_assets — the generated S3 key', () => {
  it('derives the key from the content address', async () => {
    const sha256 = sha256Hex();
    await getDb()
      .insert(updateAssets)
      .values({ sha256, contentType: 'image/png', size: 42 });

    const [row] = await getDb()
      .select()
      .from(updateAssets)
      .where(eq(updateAssets.sha256, sha256));

    // Byte-for-byte what the publish and manifest services compute.
    expect(row.s3Key).toBe(updateAssetS3Key(sha256));
    expect(row.s3Key).toBe(`public/updates/assets/${sha256}`);
    expect(row.status).toBe('pending');
    expect(row.size).toBe(42);
  });

  it('refuses to let any write path supply its own key', async () => {
    // A generated column is not writable at all — which is the whole point over
    // a Mongoose hook, since a backfill or a `psql` session bypasses a hook.
    const error = await rejection(
      getDb().execute(sql`
        insert into update_assets (id, sha256, s3_key, content_type, size)
        values (${randomUUID()}, ${sha256Hex()}, 'public/elsewhere/evil', 'image/png', 1)
      `)
    );
    expect(pgErrorCode(error)).toBe(GENERATED_ALWAYS);
  });

  it('rejects a hash that is not lowercase 64-hex', async () => {
    const error = await rejection(
      getDb()
        .insert(updateAssets)
        .values({ sha256: sha256Hex().toUpperCase(), contentType: 'image/png', size: 1 })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('stores a size beyond a 32-bit integer', async () => {
    // `bigint`, not `integer`: nothing in this system bounds an asset at 2 GiB,
    // and a silent overflow on a file size is the limit nobody remembers choosing.
    const sha256 = sha256Hex();
    const size = 3_000_000_000;
    await getDb()
      .insert(updateAssets)
      .values({ sha256, contentType: 'application/octet-stream', size });

    const [row] = await getDb()
      .select({ size: updateAssets.size })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, sha256));

    expect(row.size).toBe(size);
  });
});

describe('app_updates — the manifest', () => {
  it('mints a parseable UUID for `update_id`, distinct from the row id', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );

    // expo-updates PARSES the manifest id as a UUID. The row's own id is a uuid
    // v7 per CONVENTIONS.md; these are deliberately two different columns.
    expect(update.updateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(update.id).not.toBe(update.updateId);
  });

  it('rejects an `update_id` no client could parse', async () => {
    const applicationId = await application();
    const channelId = await channel(applicationId);
    const sha256 = await uploadedAsset();

    const error = await rejection(
      getDb()
        .insert(appUpdates)
        .values({
          updateId: 'not-a-uuid',
          applicationId,
          channelId,
          runtimeVersion: '1.0.0',
          platform: 'ios',
          launchAssetSha256: sha256,
          launchAssetKey: 'bundle',
          launchAssetContentType: 'application/javascript',
          extra: { expoClient: {} },
        })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('requires `extra.expoClient` to be an object', async () => {
    const applicationId = await application();
    const channelId = await channel(applicationId);
    const launchAssetSha256 = await uploadedAsset();
    const base = {
      applicationId,
      channelId,
      runtimeVersion: '1.0.0',
      platform: 'ios',
      launchAssetSha256,
      launchAssetKey: 'bundle',
      launchAssetContentType: 'application/javascript',
    } as const;

    // Absent: the client's `Constants.expoConfig` would not resolve after the
    // update, so this manifest breaks every device it reaches.
    const missing = await rejection(
      getDb().insert(appUpdates).values({ ...base, extra: { runtimeVersion: '1.0.0' } })
    );
    expect(pgErrorCode(missing)).toBe(CHECK_VIOLATION);

    // Present but null — the case the Mongoose validator singled out.
    const nulled = await rejection(
      getDb().insert(appUpdates).values({ ...base, extra: { expoClient: null } })
    );
    expect(pgErrorCode(nulled)).toBe(CHECK_VIOLATION);

    // Present but a scalar.
    const scalar = await rejection(
      getDb().insert(appUpdates).values({ ...base, extra: { expoClient: 'commons' } })
    );
    expect(pgErrorCode(scalar)).toBe(CHECK_VIOLATION);
  });

  it('defaults `metadata` to an empty object and refuses a non-object', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );
    const [row] = await getDb()
      .select({ metadata: appUpdates.metadata, rolloutPercent: appUpdates.rolloutPercent })
      .from(appUpdates)
      .where(eq(appUpdates.id, update.id));

    expect(row.metadata).toEqual({});
    expect(row.rolloutPercent).toBe(100);

    const error = await rejection(
      getDb().execute(sql`
        update app_updates set metadata = '[]'::jsonb where id = ${update.id}
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('bounds `rollout_percent` to [0, 100]', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );

    const error = await rejection(
      getDb().update(appUpdates).set({ rolloutPercent: 101 }).where(eq(appUpdates.id, update.id))
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a launch asset that was never uploaded', async () => {
    const applicationId = await application();
    const channelId = await channel(applicationId);

    const error = await rejection(
      getDb()
        .insert(appUpdates)
        .values({
          applicationId,
          channelId,
          runtimeVersion: '1.0.0',
          platform: 'ios',
          // A well-formed hash with no `update_assets` row behind it.
          launchAssetSha256: sha256Hex(),
          launchAssetKey: 'bundle',
          launchAssetContentType: 'application/javascript',
          extra: { expoClient: {} },
        })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('links a promotion back to the update it was promoted from', async () => {
    const applicationId = await application();
    const launchAssetSha256 = await uploadedAsset();
    const source = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      launchAssetSha256
    );

    const [promoted] = await getDb()
      .insert(appUpdates)
      .values({
        applicationId,
        channelId: await channel(applicationId, `preview-${randomUUID()}`),
        runtimeVersion: '1.0.0',
        platform: 'ios',
        launchAssetSha256,
        launchAssetKey: 'bundle',
        launchAssetContentType: 'application/javascript',
        extra: { expoClient: {} },
        promotedFromUpdateId: source.updateId,
      })
      .returning({ promotedFromUpdateId: appUpdates.promotedFromUpdateId });

    // The reference is to the PUBLIC handle, not the primary key — that is what
    // the admin API and the manifest speak.
    expect(promoted.promotedFromUpdateId).toBe(source.updateId);

    const dangling = await rejection(
      getDb()
        .insert(appUpdates)
        .values({
          applicationId,
          channelId: await channel(applicationId, `stale-${randomUUID()}`),
          runtimeVersion: '1.0.0',
          platform: 'ios',
          launchAssetSha256,
          launchAssetKey: 'bundle',
          launchAssetContentType: 'application/javascript',
          extra: { expoClient: {} },
          promotedFromUpdateId: randomUUID(),
        })
    );
    expect(pgErrorCode(dangling)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('app_update_assets — the ordinal keeps the manifest byte-stable', () => {
  it('returns the asset list in the published order', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );

    const shas = [await uploadedAsset(), await uploadedAsset(), await uploadedAsset()];
    // Inserted out of order on purpose: without an explicit ordinal the read
    // below would be free to return them in insertion or physical order, and a
    // reordered `assets` array changes the SIGNED manifest bytes.
    await getDb().insert(appUpdateAssets).values([
      { appUpdateId: update.id, ordinal: 2, sha256: shas[2], key: 'c', contentType: 'image/png' },
      { appUpdateId: update.id, ordinal: 0, sha256: shas[0], key: 'a', contentType: 'image/png' },
      { appUpdateId: update.id, ordinal: 1, sha256: shas[1], key: 'b', contentType: 'image/png' },
    ]);

    const rows = await getDb()
      .select({ ordinal: appUpdateAssets.ordinal, key: appUpdateAssets.key })
      .from(appUpdateAssets)
      .where(eq(appUpdateAssets.appUpdateId, update.id))
      .orderBy(asc(appUpdateAssets.ordinal));

    expect(rows.map((row) => row.key)).toEqual(['a', 'b', 'c']);
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1, 2]);
  });

  it('refuses two assets at the same position', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );

    await getDb().insert(appUpdateAssets).values({
      appUpdateId: update.id,
      ordinal: 0,
      sha256: await uploadedAsset(),
      key: 'a',
      contentType: 'image/png',
    });

    const error = await rejection(
      getDb().insert(appUpdateAssets).values({
        appUpdateId: update.id,
        ordinal: 0,
        sha256: await uploadedAsset(),
        key: 'b',
        contentType: 'image/png',
      })
    );
    // The composite primary key IS the position guarantee.
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a negative position', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );

    const error = await rejection(
      getDb().insert(appUpdateAssets).values({
        appUpdateId: update.id,
        ordinal: -1,
        sha256: await uploadedAsset(),
        key: 'a',
        contentType: 'image/png',
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses to delete bytes a published manifest names', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );
    const sha256 = await uploadedAsset();
    await getDb().insert(appUpdateAssets).values({
      appUpdateId: update.id,
      ordinal: 0,
      sha256,
      key: 'a',
      contentType: 'image/png',
    });

    // A device may fetch any historical update's assets at any time, so the
    // object must never disappear. `RESTRICT` says so; Mongo said nothing.
    const error = await rejection(
      getDb().delete(updateAssets).where(eq(updateAssets.sha256, sha256))
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('takes its descriptors with the update when the update is deleted', async () => {
    const applicationId = await application();
    const update = await publishedUpdate(
      applicationId,
      await channel(applicationId),
      await uploadedAsset()
    );
    await getDb().insert(appUpdateAssets).values({
      appUpdateId: update.id,
      ordinal: 0,
      sha256: await uploadedAsset(),
      key: 'a',
      contentType: 'image/png',
    });

    await getDb().delete(appUpdates).where(eq(appUpdates.id, update.id));

    const remaining = await getDb()
      .select({ ordinal: appUpdateAssets.ordinal })
      .from(appUpdateAssets)
      .where(eq(appUpdateAssets.appUpdateId, update.id));

    expect(remaining).toEqual([]);
  });
});

describe('update_channel_rollbacks — the array Mongo addressed by inner field', () => {
  it('holds at most one active directive per (channel, runtime, platform)', async () => {
    const channelId = await channel(await application());
    await getDb()
      .insert(updateChannelRollbacks)
      .values({ channelId, runtimeVersion: '1.0.0', platform: 'ios', commitTime: new Date() });

    // Mongo's `$pull` + `$push` is a two-statement upsert with a crash window
    // between them, and two concurrent rollbacks could leave two entries for the
    // same tuple. The composite primary key makes that unrepresentable.
    const error = await rejection(
      getDb()
        .insert(updateChannelRollbacks)
        .values({ channelId, runtimeVersion: '1.0.0', platform: 'ios', commitTime: new Date() })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('makes the rollback write ONE idempotent statement', async () => {
    const channelId = await channel(await application());
    const first = new Date(Date.now() - 60_000);
    const second = new Date();

    for (const commitTime of [first, second]) {
      await getDb()
        .insert(updateChannelRollbacks)
        .values({ channelId, runtimeVersion: '1.0.0', platform: 'android', commitTime })
        .onConflictDoUpdate({
          target: [
            updateChannelRollbacks.channelId,
            updateChannelRollbacks.runtimeVersion,
            updateChannelRollbacks.platform,
          ],
          set: { commitTime },
        });
    }

    const rows = await getDb()
      .select({ commitTime: updateChannelRollbacks.commitTime })
      .from(updateChannelRollbacks)
      .where(eq(updateChannelRollbacks.channelId, channelId));

    expect(rows).toHaveLength(1);
    expect(rows[0].commitTime.getTime()).toBe(second.getTime());
  });

  it('scopes a directive to one runtime and platform', async () => {
    const channelId = await channel(await application());
    const commitTime = new Date();
    await getDb().insert(updateChannelRollbacks).values([
      { channelId, runtimeVersion: '1.0.0', platform: 'ios', commitTime },
      { channelId, runtimeVersion: '1.0.0', platform: 'android', commitTime },
      { channelId, runtimeVersion: '2.0.0', platform: 'ios', commitTime },
    ]);

    // The manifest endpoint's lookup, as a real indexed predicate rather than a
    // scan of an embedded array.
    const found = await getDb()
      .select({ runtimeVersion: updateChannelRollbacks.runtimeVersion })
      .from(updateChannelRollbacks)
      .where(
        sql`${updateChannelRollbacks.channelId} = ${channelId}
          and ${updateChannelRollbacks.runtimeVersion} = '2.0.0'
          and ${updateChannelRollbacks.platform} = 'ios'`
      );

    expect(found).toHaveLength(1);
  });

  it('rejects a platform expo-updates has no client for', async () => {
    const channelId = await channel(await application());
    const error = await rejection(
      getDb().execute(sql`
        insert into update_channel_rollbacks (channel_id, runtime_version, platform, commit_time)
        values (${channelId}, '1.0.0', 'web', now())
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('goes with its channel', async () => {
    const channelId = await channel(await application());
    await getDb()
      .insert(updateChannelRollbacks)
      .values({ channelId, runtimeVersion: '1.0.0', platform: 'ios', commitTime: new Date() });

    await getDb().delete(updateChannels).where(eq(updateChannels.id, channelId));

    const remaining = await getDb()
      .select({ platform: updateChannelRollbacks.platform })
      .from(updateChannelRollbacks)
      .where(eq(updateChannelRollbacks.channelId, channelId));

    expect(remaining).toEqual([]);
  });
});

describe('update_channels', () => {
  it('scopes a channel name to one application', async () => {
    const applicationId = await application();
    const name = `production-${randomUUID()}`;
    await getDb().insert(updateChannels).values({ applicationId, name });

    const error = await rejection(
      getDb().insert(updateChannels).values({ applicationId, name })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    // The same name under a different application is a different channel.
    await expect(
      getDb().insert(updateChannels).values({ applicationId: await application(), name })
    ).resolves.toBeDefined();
  });
});

describe('constants agree with their other declaration', () => {
  it('the S3 prefix baked into the generated column', () => {
    // The generated expression embeds this literal, so a change to the service
    // constant would silently stop matching stored keys without this check.
    expect(UPDATE_ASSET_KEY_PREFIX).toBe(SERVICE_UPDATE_ASSET_KEY_PREFIX);
  });
});
