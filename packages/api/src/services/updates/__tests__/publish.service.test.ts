/**
 * Publish-service tests against a REAL Postgres. Only S3 is mocked — the
 * database is the thing most of these guarantees live in, so mocking it would
 * leave every one of them asserted against a fixture instead of a constraint.
 *
 * What is under test, beyond "the CRUD works":
 *  - **The rollback-to-embedded directive is replaced by ONE statement.** Three
 *    cases: the replacement wins (which `onConflictDoNothing` would fail), the
 *    row is never DELETED on the way (which a delete-then-insert would fail,
 *    proved by a trigger that refuses the delete rather than by a race), and
 *    concurrent rollbacks converge on exactly one row.
 *  - **An update's asset list keeps its published ORDER**, through publish and
 *    through promotion — the manifest is signed, so a reordered list is an
 *    invalid signature on a device that may fetch this update years later.
 *  - **A publish is atomic**: a rejected one leaves no channel, no update and no
 *    descriptors behind.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { CreateUpdateRequest } from '@oxyhq/contracts';

const mockPresign = jest.fn();
const mockHeadObject = jest.fn();
const mockDownloadBuffer = jest.fn();

jest.mock('../../s3ServiceSingleton', () => ({
  __esModule: true,
  s3Service: {
    getPresignedUploadUrl: (...args: unknown[]) => mockPresign(...args),
    headObject: (...args: unknown[]) => mockHeadObject(...args),
    downloadBuffer: (...args: unknown[]) => mockDownloadBuffer(...args),
  },
}));
jest.mock('../../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applications } from '../../../db/schema/applications';
import { appUpdateAssets } from '../../../db/schema/appUpdateAssets';
import { appUpdates } from '../../../db/schema/appUpdates';
import { updateAssets } from '../../../db/schema/updateAssets';
import { updateChannelRollbacks } from '../../../db/schema/updateChannelRollbacks';
import { updateChannels } from '../../../db/schema/updateChannels';
import { users } from '../../../db/schema/users';
import * as publishService from '../publish.service';
import { updateAssetS3Key } from '../assetKeys';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPresign.mockResolvedValue('https://s3.example/presigned-put');
});

/** A random lowercase-hex SHA-256, the shape every asset reference must match. */
function sha256Hex(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 64);
}

/** A real `applications` row with its own owning account. */
async function application(): Promise<string> {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({
    id: users.id,
  });
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `OTA ${randomUUID()}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  return row.id;
}

/** An `uploaded` asset, ready to be referenced by a published update. */
async function uploadedAsset(sha256 = sha256Hex()): Promise<string> {
  await getDb()
    .insert(updateAssets)
    .values({ sha256, contentType: 'image/png', size: 1024, status: 'uploaded' });
  return sha256;
}

/** A create-update request with every referenced asset already uploaded. */
async function createRequest(
  applicationId: string,
  overrides: Partial<CreateUpdateRequest> = {}
): Promise<CreateUpdateRequest> {
  return {
    applicationId,
    channel: `production-${randomUUID().slice(0, 8)}`,
    runtimeVersion: '1.0.0',
    platform: 'ios',
    launchAsset: {
      sha256: await uploadedAsset(),
      key: 'bundle',
      contentType: 'application/javascript',
    },
    assets: [
      { sha256: await uploadedAsset(), key: 'a', contentType: 'image/png', fileExtension: '.png' },
      { sha256: await uploadedAsset(), key: 'b', contentType: 'image/png', fileExtension: '.png' },
      { sha256: await uploadedAsset(), key: 'c', contentType: 'image/png', fileExtension: '.png' },
    ],
    extra: { expoClient: { name: 'Commons', slug: 'commons' } },
    ...overrides,
  };
}

/** The active rollback directives of a channel, straight from the table. */
async function storedRollbacks(channelId: string) {
  return getDb()
    .select({
      runtimeVersion: updateChannelRollbacks.runtimeVersion,
      platform: updateChannelRollbacks.platform,
      commitTime: updateChannelRollbacks.commitTime,
    })
    .from(updateChannelRollbacks)
    .where(eq(updateChannelRollbacks.channelId, channelId));
}

async function channelIdOf(applicationId: string, name: string): Promise<string> {
  const [channel] = await getDb()
    .select({ id: updateChannels.id })
    .from(updateChannels)
    .where(and(eq(updateChannels.applicationId, applicationId), eq(updateChannels.name, name)));
  return channel.id;
}

/**
 * Make every DELETE of THIS channel's rollback directives fail, and return the
 * teardown.
 *
 * The guarantee is that replacing a directive never removes it — a
 * delete-then-insert leaves a window in which the manifest endpoint answers "no
 * directive" and hands a device back the very update it was rolled back from.
 * That window is a race nobody can reproduce on demand, so it is turned into a
 * hard, deterministic failure instead: if the write deletes, the statement
 * raises and names the guarantee.
 *
 * Scoped by channel id, so concurrent suites writing to this table are
 * unaffected. `CREATE TRIGGER` is a utility statement and cannot take a bound
 * parameter, hence the raw interpolation of an id this test generated itself.
 */
async function refuseDirectiveDeletes(channelId: string): Promise<() => Promise<void>> {
  const triggerName = `oxy_test_no_delete_${randomUUID().replace(/-/g, '')}`;
  await getDb().execute(
    sql.raw(`
      create or replace function oxy_test_refuse_rollback_delete() returns trigger
      language plpgsql as $fn$
      begin
        raise exception
          'the rollback-to-embedded directive was DELETED: replacing it must be one statement that never removes the row';
      end
      $fn$
    `)
  );
  await getDb().execute(
    sql.raw(`
      create trigger ${triggerName}
      before delete on update_channel_rollbacks
      for each row when (old.channel_id = '${channelId}')
      execute function oxy_test_refuse_rollback_delete()
    `)
  );
  return async () => {
    await getDb().execute(
      sql.raw(`drop trigger if exists ${triggerName} on update_channel_rollbacks`)
    );
  };
}

describe('initAssets', () => {
  test('presigns only the assets not already uploaded', async () => {
    const applicationId = await application();
    const held = await uploadedAsset();
    const fresh = sha256Hex();

    const result = await publishService.initAssets(applicationId, [
      { sha256: held, contentType: 'application/javascript', size: 100 },
      { sha256: fresh, contentType: 'image/png', size: 200 },
      // A duplicate of the same content must never be presigned twice.
      { sha256: fresh, contentType: 'image/png', size: 200 },
    ]);

    expect(result.existing).toEqual([held]);
    expect(result.missing).toEqual([
      {
        sha256: fresh,
        uploadUrl: 'https://s3.example/presigned-put',
        storageKey: updateAssetS3Key(fresh),
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
        checksumSHA256: Buffer.from(fresh, 'hex').toString('base64'),
      },
    ]);
    expect(mockPresign).toHaveBeenCalledWith(updateAssetS3Key(fresh), {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
      checksumSHA256: Buffer.from(fresh, 'hex').toString('base64'),
      expiresIn: 3600,
    });
    expect(mockPresign).toHaveBeenCalledTimes(1);

    // The pending record `completeAssets` will look for, with the S3 key derived
    // from the content address by the database itself.
    const [row] = await getDb()
      .select({ status: updateAssets.status, size: updateAssets.size, s3Key: updateAssets.s3Key })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, fresh));
    expect(row).toEqual({ status: 'pending', size: 200, s3Key: updateAssetS3Key(fresh) });
  });

  test('refreshes a pending asset, and never an uploaded asset’s verified size', async () => {
    const applicationId = await application();
    const pending = sha256Hex();
    await getDb()
      .insert(updateAssets)
      .values({ sha256: pending, contentType: 'image/png', size: 1, status: 'pending' });
    const uploaded = await uploadedAsset();

    await publishService.initAssets(applicationId, [
      { sha256: pending, contentType: 'application/javascript', size: 999 },
      // Re-declaring content we already hold must not overwrite the size S3
      // reported with the one the client claims.
      { sha256: uploaded, contentType: 'application/javascript', size: 999 },
    ]);

    const rows = await getDb()
      .select({
        sha256: updateAssets.sha256,
        contentType: updateAssets.contentType,
        size: updateAssets.size,
      })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, pending));
    expect(rows[0]).toEqual({
      sha256: pending,
      contentType: 'application/javascript',
      size: 999,
    });

    const [untouched] = await getDb()
      .select({ contentType: updateAssets.contentType, size: updateAssets.size })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, uploaded));
    expect(untouched).toEqual({ contentType: 'image/png', size: 1024 });
  });
});

describe('completeAssets', () => {
  test('flips a pending asset to uploaded with the size S3 reports', async () => {
    const applicationId = await application();
    const bytes = Buffer.from('verified update asset');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await getDb()
      .insert(updateAssets)
      .values({ sha256, contentType: 'image/png', size: bytes.length, status: 'pending' });
    mockHeadObject.mockResolvedValue({ size: bytes.length, contentType: 'image/png' });
    mockDownloadBuffer.mockResolvedValue(bytes);

    const result = await publishService.completeAssets(applicationId, [sha256]);

    expect(mockHeadObject).toHaveBeenCalledWith(updateAssetS3Key(sha256));
    expect(mockDownloadBuffer).toHaveBeenCalledWith(updateAssetS3Key(sha256));
    expect(result.assets).toEqual([{ sha256, status: 'uploaded', size: bytes.length }]);

    const [row] = await getDb()
      .select({ status: updateAssets.status, size: updateAssets.size })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, sha256));
    expect(row).toEqual({ status: 'uploaded', size: bytes.length });
  });

  test('leaves an asset pending when its bytes do not match the claimed hash', async () => {
    const applicationId = await application();
    const expected = Buffer.from('legitimate asset');
    const poisoned = Buffer.from('attacker content');
    const sha256 = createHash('sha256').update(expected).digest('hex');
    await getDb().insert(updateAssets).values({
      sha256,
      contentType: 'application/javascript',
      size: poisoned.length,
      status: 'pending',
    });
    mockHeadObject.mockResolvedValue({ size: poisoned.length });
    mockDownloadBuffer.mockResolvedValue(poisoned);

    const result = await publishService.completeAssets(applicationId, [sha256]);

    expect(result.assets).toEqual([{ sha256, status: 'pending', size: 0 }]);
    const [row] = await getDb()
      .select({ status: updateAssets.status })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, sha256));
    expect(row.status).toBe('pending');
  });

  test('leaves an asset pending when the object is missing in S3', async () => {
    const applicationId = await application();
    const sha256 = sha256Hex();
    await getDb()
      .insert(updateAssets)
      .values({ sha256, contentType: 'image/png', size: 0, status: 'pending' });
    mockHeadObject.mockResolvedValue(null);

    const result = await publishService.completeAssets(applicationId, [sha256]);

    expect(result.assets).toEqual([{ sha256, status: 'pending', size: 0 }]);
    const [row] = await getDb()
      .select({ status: updateAssets.status })
      .from(updateAssets)
      .where(eq(updateAssets.sha256, sha256));
    expect(row.status).toBe('pending');
  });

  test('rejects an asset that was never initialised', async () => {
    const applicationId = await application();
    await expect(
      publishService.completeAssets(applicationId, [sha256Hex()])
    ).rejects.toThrow(/never initialised/i);
  });
});

describe('createUpdate', () => {
  test('publishes with its assets at their declared positions', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);

    const update = await publishService.createUpdate(input);

    expect(update.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(update.channel).toBe(input.channel);
    expect(update.status).toBe('published');
    expect(update.rolloutPercent).toBe(100);
    expect(update.launchAssetSha256).toBe(input.launchAsset.sha256);
    // The serialized order is the declared order, not the sha256 order.
    expect(update.assetSha256s).toEqual(input.assets.map((asset) => asset.sha256));

    const [row] = await getDb()
      .select({ id: appUpdates.id })
      .from(appUpdates)
      .where(eq(appUpdates.updateId, update.id));
    const stored = await getDb()
      .select({ ordinal: appUpdateAssets.ordinal, key: appUpdateAssets.key })
      .from(appUpdateAssets)
      .where(eq(appUpdateAssets.appUpdateId, row.id))
      .orderBy(asc(appUpdateAssets.ordinal));
    expect(stored).toEqual([
      { ordinal: 0, key: 'a' },
      { ordinal: 1, key: 'b' },
      { ordinal: 2, key: 'c' },
    ]);
  });

  test('creates the channel on demand and reuses it on the next publish', async () => {
    const applicationId = await application();
    const first = await createRequest(applicationId);
    await publishService.createUpdate(first);
    await publishService.createUpdate(await createRequest(applicationId, { channel: first.channel }));

    const channels = await getDb()
      .select({ id: updateChannels.id })
      .from(updateChannels)
      .where(
        and(
          eq(updateChannels.applicationId, applicationId),
          eq(updateChannels.name, first.channel)
        )
      );
    expect(channels).toHaveLength(1);
  });

  test('clears an active rollback-to-embedded directive for the tuple', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    await publishService.createUpdate(input);
    const channelId = await channelIdOf(applicationId, input.channel);

    await publishService.rollbackToEmbedded(applicationId, input.channel, '1.0.0', 'ios');
    // A directive for a DIFFERENT tuple must survive the publish untouched.
    await publishService.rollbackToEmbedded(applicationId, input.channel, '2.0.0', 'ios');

    await publishService.createUpdate(await createRequest(applicationId, { channel: input.channel }));

    const remaining = await storedRollbacks(channelId);
    expect(remaining.map((entry) => entry.runtimeVersion)).toEqual(['2.0.0']);
  });

  test('rejects, and leaves nothing behind, when a referenced asset is not uploaded', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    const pending = sha256Hex();
    await getDb()
      .insert(updateAssets)
      .values({ sha256: pending, contentType: 'image/png', size: 1, status: 'pending' });

    await expect(
      publishService.createUpdate({
        ...input,
        assets: [...input.assets, { sha256: pending, key: 'd', contentType: 'image/png' }],
      })
    ).rejects.toThrow(/not uploaded/i);

    // A publish is one transaction: the channel it would have created on demand
    // must not survive the rejection either.
    const channels = await getDb()
      .select({ id: updateChannels.id })
      .from(updateChannels)
      .where(eq(updateChannels.applicationId, applicationId));
    expect(channels).toEqual([]);
    const updates = await getDb()
      .select({ id: appUpdates.id })
      .from(appUpdates)
      .where(eq(appUpdates.applicationId, applicationId));
    expect(updates).toEqual([]);
  });
});

describe('rollbackToEmbedded — one idempotent statement', () => {
  test('a replacement leaves exactly ONE directive, carrying the LATEST commitTime', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    await publishService.createUpdate(input);
    const channelId = await channelIdOf(applicationId, input.channel);

    const first = await publishService.rollbackToEmbedded(
      applicationId,
      input.channel,
      '1.0.0',
      'ios'
    );
    const second = await publishService.rollbackToEmbedded(
      applicationId,
      input.channel,
      '1.0.0',
      'ios'
    );

    // Exactly one row: the composite primary key makes a duplicate for the same
    // (channel, runtime, platform) unrepresentable.
    const rows = await storedRollbacks(channelId);
    expect(rows).toHaveLength(1);

    // And the SECOND commitTime won. A conflict clause that did NOTHING would
    // leave the first one standing, and a device running an update published
    // between the two rollbacks would never be told to roll back at all.
    const storedCommitTime = rows[0].commitTime.getTime();
    const commitTimeOfTheFirstRollback = new Date(
      first.rollbacksToEmbedded[0].commitTime
    ).getTime();
    expect(rows[0].commitTime.toISOString()).toBe(second.rollbacksToEmbedded[0].commitTime);
    expect(storedCommitTime).toBeGreaterThan(commitTimeOfTheFirstRollback);
    expect(second.rollbacksToEmbedded).toHaveLength(1);
  });

  test('never DELETES the directive it is replacing', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    await publishService.createUpdate(input);
    const channelId = await channelIdOf(applicationId, input.channel);

    await publishService.rollbackToEmbedded(applicationId, input.channel, '1.0.0', 'ios');

    // From here the row must exist continuously. A delete-then-insert would trip
    // the trigger and fail this call with the message it raises.
    const allowDeletes = await refuseDirectiveDeletes(channelId);
    try {
      const replaced = await publishService.rollbackToEmbedded(
        applicationId,
        input.channel,
        '1.0.0',
        'ios'
      );
      expect(replaced.rollbacksToEmbedded).toHaveLength(1);
    } finally {
      await allowDeletes();
    }

    expect(await storedRollbacks(channelId)).toHaveLength(1);
  });

  test('concurrent rollbacks converge on exactly one directive', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    await publishService.createUpdate(input);
    const channelId = await channelIdOf(applicationId, input.channel);

    // Mongo's pull-then-push could leave two entries here, which the manifest
    // endpoint's `.find()` then resolved arbitrarily.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        publishService.rollbackToEmbedded(applicationId, input.channel, '1.0.0', 'ios')
      )
    );

    expect(results).toHaveLength(4);
    expect(await storedRollbacks(channelId)).toHaveLength(1);
  });
});

describe('rollback', () => {
  test('marks the head rolled_back so the previous update becomes head', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    const previous = await publishService.createUpdate(input);
    // Age the first publish so "newest published" is unambiguous rather than
    // resting on two `now()` values microseconds apart.
    await getDb()
      .update(appUpdates)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(appUpdates.updateId, previous.id));
    const head = await publishService.createUpdate(
      await createRequest(applicationId, { channel: input.channel })
    );

    const result = await publishService.rollback(applicationId, input.channel, '1.0.0', 'ios');

    expect(result.rolledBack.id).toBe(head.id);
    expect(result.rolledBack.status).toBe('rolled_back');
    expect(result.head?.id).toBe(previous.id);
    // Nothing is deleted — the rolled-back update keeps its descriptors and
    // stays servable to a device that is still on it.
    expect(result.rolledBack.assetSha256s).toHaveLength(3);
    expect(result.head?.assetSha256s).toEqual(input.assets.map((asset) => asset.sha256));
  });

  test('leaves no head when the only published update is rolled back', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    await publishService.createUpdate(input);

    const result = await publishService.rollback(applicationId, input.channel, '1.0.0', 'ios');
    expect(result.head).toBeNull();
  });

  test('throws when there is no published update to roll back', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    await publishService.createUpdate(input);

    await expect(
      publishService.rollback(applicationId, input.channel, '9.9.9', 'ios')
    ).rejects.toThrow(/no published update/i);
    await expect(
      publishService.rollback(applicationId, 'never-created', '1.0.0', 'ios')
    ).rejects.toThrow(/not found/i);
  });
});

describe('promote', () => {
  test('creates a NEW update pointing at the same assets, in the same order', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    const source = await publishService.createUpdate(input);

    const promoted = await publishService.promote(applicationId, source.id, 'preview', 50);

    expect(promoted.id).not.toBe(source.id);
    expect(promoted.channel).toBe('preview');
    expect(promoted.rolloutPercent).toBe(50);
    expect(promoted.promotedFromUpdateId).toBe(source.id);
    expect(promoted.launchAssetSha256).toBe(source.launchAssetSha256);
    // Same descriptors AND same positions: a promotion serves the same manifest
    // under a new id, so its asset order cannot be recomputed.
    expect(promoted.assetSha256s).toEqual(source.assetSha256s);

    const [row] = await getDb()
      .select({ id: appUpdates.id })
      .from(appUpdates)
      .where(eq(appUpdates.updateId, promoted.id));
    const stored = await getDb()
      .select({ ordinal: appUpdateAssets.ordinal, key: appUpdateAssets.key })
      .from(appUpdateAssets)
      .where(eq(appUpdateAssets.appUpdateId, row.id))
      .orderBy(asc(appUpdateAssets.ordinal));
    expect(stored).toEqual([
      { ordinal: 0, key: 'a' },
      { ordinal: 1, key: 'b' },
      { ordinal: 2, key: 'c' },
    ]);
  });

  test('throws when the source update does not exist', async () => {
    const applicationId = await application();
    await expect(
      publishService.promote(applicationId, randomUUID(), 'preview')
    ).rejects.toThrow(/not found/i);
  });
});

describe('setRollout', () => {
  test('updates the rollout percentage in place', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    const update = await publishService.createUpdate(input);

    const patched = await publishService.setRollout(applicationId, update.id, 25);

    expect(patched.id).toBe(update.id);
    expect(patched.rolloutPercent).toBe(25);
    expect(patched.channel).toBe(input.channel);
    expect(patched.assetSha256s).toEqual(update.assetSha256s);
  });

  test('throws when the update does not belong to the application', async () => {
    const applicationId = await application();
    const update = await publishService.createUpdate(await createRequest(applicationId));

    await expect(
      publishService.setRollout(await application(), update.id, 25)
    ).rejects.toThrow(/not found/i);
  });
});

describe('reads', () => {
  test('listChannels returns each channel with its active directives', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId, { channel: 'zulu' });
    await publishService.createUpdate(input);
    await publishService.createUpdate(await createRequest(applicationId, { channel: 'alpha' }));
    const directive = await publishService.rollbackToEmbedded(
      applicationId,
      'zulu',
      '1.0.0',
      'ios'
    );

    const channels = await publishService.listChannels(applicationId);

    expect(channels.map((channel) => channel.name)).toEqual(['alpha', 'zulu']);
    expect(channels[0].rollbacksToEmbedded).toEqual([]);
    expect(channels[1].rollbacksToEmbedded).toEqual([
      {
        runtimeVersion: '1.0.0',
        platform: 'ios',
        commitTime: directive.rollbacksToEmbedded[0].commitTime,
      },
    ]);
  });

  test('listUpdates resolves the channel name and filters on the tuple', async () => {
    const applicationId = await application();
    const input = await createRequest(applicationId);
    const first = await publishService.createUpdate(input);
    await getDb()
      .update(appUpdates)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(appUpdates.updateId, first.id));
    const second = await publishService.createUpdate(
      await createRequest(applicationId, { channel: input.channel, platform: 'android' })
    );

    const all = await publishService.listUpdates(applicationId);
    expect(all.map((update) => update.id)).toEqual([second.id, first.id]);
    expect(all.every((update) => update.channel === input.channel)).toBe(true);
    expect(all[0].assetSha256s).toHaveLength(3);

    const androidOnly = await publishService.listUpdates(
      applicationId,
      input.channel,
      '1.0.0',
      'android'
    );
    expect(androidOnly.map((update) => update.id)).toEqual([second.id]);

    // A channel that does not exist filters everything out rather than erroring.
    expect(await publishService.listUpdates(applicationId, 'nope')).toEqual([]);
  });
});
