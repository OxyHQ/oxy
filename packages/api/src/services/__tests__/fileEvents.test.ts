/**
 * File events to applications (ADR 0041 D9), against a REAL Postgres:
 * what is queued, for whom, in which transaction — and how the worker sends it.
 *
 *  1. Recipients: the owning application and every application holding a
 *     reference, each with a VERIFIED endpoint, never a deleted one; each sees
 *     only its own references; an account owner is never named.
 *  2. Written in the state change's transaction: a rollback queues nothing.
 *  3. Every state change emits: delete (`file.deleted`), visibility
 *     (`file.visibility_changed`), owner's trash (`file.trashed`), restore and
 *     a reference reviving a trashed file (`file.restored`).
 *  4. The worker signs `<t>.<body>` with the application's CURRENT secret —
 *     the SDK's `verifyFileEventSignature` accepts it — acknowledges on 2xx,
 *     backs off and dead-letters otherwise, and dead-letters at once when the
 *     endpoint is gone.
 */

import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { verifyFileEventSignature } from '@oxy.so/core/server';

jest.mock('../variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));
jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  FILE_EVENT_MAX_ATTEMPTS,
  applications,
  fileEventDeliveries,
  fileReferences,
  files,
  users,
} from '../../db/schema';
import { AssetService } from '../assetService';
import { recordFileEvents, sealFileWebhookSecret } from '../fileEvents.service';
import {
  fileEventBackoffMs,
  runFileEventDeliveryBatch,
  type FileEventWebhookRequest,
} from '../fileEventDelivery.worker';
import { addFileReferences } from '../fileRepository';
import { S3Service } from '../s3Service';

jest.setTimeout(60_000);

class MemoryBucket {
  readonly objects = new Map<string, Buffer>();
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const input = command.input;
    const key = String(input.Key ?? '');
    switch (command.constructor.name) {
      case 'HeadObjectCommand':
        if (!this.objects.has(key))
          throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return { ContentLength: this.objects.get(key)?.length };
      case 'CopyObjectCommand': {
        const source = String(input.CopySource).split('/').slice(1).join('/');
        const bytes = this.objects.get(source);
        if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        this.objects.set(key, bytes);
        return {};
      }
      case 'PutObjectCommand':
        this.objects.set(key, Buffer.isBuffer(input.Body) ? input.Body : Buffer.alloc(0));
        return {};
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        return {};
      case 'ListObjectsV2Command':
        return { Contents: [] };
      default:
        throw new Error(`MemoryBucket: unexpected ${command.constructor.name}`);
    }
  }
}

function harness() {
  const bucket = new MemoryBucket();
  const s3 = new S3Service(
    { accessKeyId: 'test', secretAccessKey: 'test', bucketName: 'media', region: 'us-east-1' },
    { enqueueDeletedKey: () => undefined },
  );
  const client: unknown = Reflect.get(s3, 's3Client');
  Reflect.set(client as object, 'send', (command: Parameters<MemoryBucket['send']>[0]) =>
    bucket.send(command),
  );
  return { bucket, service: new AssetService(s3) };
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function application(
  options: { webhook?: boolean; status?: 'active' | 'deleted'; secret?: string } = {},
): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `app-${id.slice(0, 6)}`,
      type: 'first_party',
      ownerAccountId: await account(),
      status: options.status ?? 'active',
      ...(options.webhook === false
        ? {}
        : {
            filesWebhookUrl: `https://${id}.receiver.example/files`,
            filesWebhookSecretCiphertext: sealFileWebhookSecret(id, options.secret ?? 'whsec_one'),
            filesWebhookVerifiedAt: new Date(),
          }),
    });
  return id;
}

async function file(
  owner: { ownerUserId?: string; ownerApplicationId?: string },
  visibility: 'public' | 'private' = 'public',
) {
  const sha = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: 1,
      mime: 'image/png',
      ext: 'png',
      ownerUserId: owner.ownerUserId ?? null,
      ownerApplicationId: owner.ownerApplicationId ?? null,
      visibility,
      storageKey: visibility === 'public' ? `public/content/${sha}.png` : `content/${sha}.png`,
      originalName: 'x.png',
    })
    .returning();
  return row;
}

async function deliveriesFor(fileId: string) {
  return getDb()
    .select()
    .from(fileEventDeliveries)
    .where(eq(fileEventDeliveries.fileId, fileId))
    .orderBy(fileEventDeliveries.createdAt);
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('recordFileEvents — who is told, and what', () => {
  it('tells the owner and every referencing application with a verified endpoint, each its own references', async () => {
    const owner = await application();
    const user = await application();
    const silent = await application({ webhook: false });
    const gone = await application({ status: 'deleted' });
    const target = await file({ ownerApplicationId: owner });
    await addFileReferences([
      { fileId: target.id, applicationId: user, entityType: 'post', entityId: 'p1' },
      { fileId: target.id, applicationId: user, entityType: 'post', entityId: 'p2' },
      { fileId: target.id, applicationId: silent, entityType: 'thing', entityId: 't' },
    ]);
    // A deleted application's reference cannot be added any more; plant one.
    await getDb()
      .insert(fileReferences)
      .values({ fileId: target.id, applicationId: gone, entityType: 'x', entityId: 'y' });

    await getDb().transaction((tx) => recordFileEvents(tx, 'file.trashed', [target.id]));

    const rows = await deliveriesFor(target.id);
    expect(rows.map((row) => row.applicationId).sort()).toEqual([owner, user].sort());
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(1);
    const toUser = rows.find((row) => row.applicationId === user);
    if (!toUser) throw new Error('no delivery for the referencing application');
    expect(toUser.payload).toEqual({
      id: toUser.eventId,
      type: 'file.trashed',
      occurredAt: toUser.occurredAt.toISOString(),
      file: { id: target.id, ownerKind: 'application', visibility: 'public', status: 'active' },
      references: [
        { entityType: 'post', entityId: 'p1' },
        { entityType: 'post', entityId: 'p2' },
      ],
    });
    expect(rows.find((row) => row.applicationId === owner)?.payload).toMatchObject({
      references: [],
    });
  });

  it('never names the account that owns a file', async () => {
    const person = await account();
    const user = await application();
    const target = await file({ ownerUserId: person });
    await addFileReferences([
      { fileId: target.id, applicationId: user, entityType: 'avatar', entityId: 'a' },
    ]);
    await getDb().transaction((tx) => recordFileEvents(tx, 'file.deleted', [target.id]));
    const [row] = await deliveriesFor(target.id);
    expect(row.payload).toMatchObject({ file: { ownerKind: 'account' } });
    expect(JSON.stringify(row.payload)).not.toContain(person);
  });

  it('queues nothing when the change rolls back', async () => {
    const owner = await application();
    const target = await file({ ownerApplicationId: owner });
    await expect(
      getDb().transaction(async (tx) => {
        await recordFileEvents(tx, 'file.deleted', [target.id]);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await deliveriesFor(target.id)).toHaveLength(0);
  });
});

describe('every state change emits in its own transaction', () => {
  it('delete, visibility, trash and restore', async () => {
    const { service } = harness();
    const person = await account();
    const user = await application();

    const visible = await file({ ownerUserId: person }, 'private');
    await addFileReferences([
      { fileId: visible.id, applicationId: user, entityType: 'post', entityId: 'v' },
    ]);
    await service.updateFileVisibility(visible.id, 'unlisted');
    expect((await deliveriesFor(visible.id)).map((row) => [row.type, row.payload.file])).toEqual([
      ['file.visibility_changed', expect.objectContaining({ visibility: 'unlisted' })],
    ]);

    const trashed = await file({ ownerUserId: person }, 'private');
    await addFileReferences([
      { fileId: trashed.id, applicationId: user, entityType: 'post', entityId: 't' },
    ]);
    expect(await service.trashFile(trashed.id, await account())).toBeNull();
    const inTrash = await service.trashFile(trashed.id, person);
    expect(inTrash?.status).toBe('trash');
    await service.restoreFile(trashed.id);
    expect(
      (await deliveriesFor(trashed.id)).map((row) => [row.type, row.payload.file.status]),
    ).toEqual([
      ['file.trashed', 'trash'],
      ['file.restored', 'active'],
    ]);

    const deleted = await file({ ownerUserId: person }, 'private');
    await addFileReferences([
      { fileId: deleted.id, applicationId: user, entityType: 'post', entityId: 'd' },
    ]);
    await service.deleteFile(deleted.id, true, person);
    expect(
      (await deliveriesFor(deleted.id)).map((row) => [row.type, row.payload.file.status]),
    ).toEqual([['file.deleted', 'deleted']]);
  });

  it('a new reference bringing a trashed application file back is a restore', async () => {
    const owner = await application();
    const target = await file({ ownerApplicationId: owner }, 'private');
    await getDb()
      .update(files)
      .set({ status: 'trash', trashedAt: new Date() })
      .where(eq(files.id, target.id));
    await addFileReferences([
      { fileId: target.id, applicationId: owner, entityType: 'brand', entityId: 'b' },
    ]);
    const rows = await deliveriesFor(target.id);
    expect(rows.map((row) => row.type)).toEqual(['file.restored']);
    expect(rows[0].payload).toMatchObject({
      file: { status: 'active' },
      references: [{ entityType: 'brand', entityId: 'b' }],
    });
  });
});

describe('the delivery worker', () => {
  async function queued(secret = 'whsec_one') {
    const owner = await application({ secret });
    const target = await file({ ownerApplicationId: owner });
    await getDb().transaction((tx) => recordFileEvents(tx, 'file.deleted', [target.id]));
    const [row] = await deliveriesFor(target.id);
    return { owner, row };
  }

  /** Run batches until this delivery is claimed (other files' rows may share the table). */
  async function deliverOnly(
    id: string,
    deliver: (request: FileEventWebhookRequest) => Promise<number>,
    now?: () => Date,
  ) {
    const seen: FileEventWebhookRequest[] = [];
    await runFileEventDeliveryBatch({
      ownerId: `test-${randomBytes(3).toString('hex')}`,
      batchSize: 1000,
      now,
      deliver: async (request) => {
        const [mine] = await getDb()
          .select({ id: fileEventDeliveries.id })
          .from(fileEventDeliveries)
          .where(
            and(eq(fileEventDeliveries.id, id), eq(fileEventDeliveries.eventId, request.eventId)),
          );
        if (mine) seen.push(request);
        return mine ? deliver(request) : 200;
      },
    });
    const [after] = await getDb()
      .select()
      .from(fileEventDeliveries)
      .where(eq(fileEventDeliveries.id, id));
    return { seen, after };
  }

  it('signs what the SDK verifies, and acknowledges a 2xx', async () => {
    const { row } = await queued('whsec_signing');
    const { seen, after } = await deliverOnly(row.id, async () => 204);
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request.url).toMatch(/^https:\/\/.*\/files$/);
    const event = verifyFileEventSignature(
      request.body,
      { 'oxy-signature': request.signature },
      'whsec_signing',
    );
    expect(event).toMatchObject({ id: row.eventId, type: 'file.deleted' });
    expect(() =>
      verifyFileEventSignature(request.body, { 'oxy-signature': request.signature }, 'whsec_other'),
    ).toThrow('does not match');
    expect(() =>
      verifyFileEventSignature(
        request.body.replace('file.deleted', 'file.restored'),
        {
          'oxy-signature': request.signature,
        },
        'whsec_signing',
      ),
    ).toThrow();
    expect(after.deliveredAt).not.toBeNull();
    expect(after).toMatchObject({ attempts: 1, lastStatus: 204, lastError: null });
  });

  it('backs off on a failure, and dead-letters after the last attempt', async () => {
    const { row } = await queued();
    const start = new Date();
    const { after } = await deliverOnly(
      row.id,
      async () => 503,
      () => start,
    );
    expect(after.deliveredAt).toBeNull();
    expect(after.failedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('503');
    expect(after.nextAttemptAt.getTime()).toBe(start.getTime() + fileEventBackoffMs(1));

    await getDb()
      .update(fileEventDeliveries)
      .set({ attempts: FILE_EVENT_MAX_ATTEMPTS - 1, nextAttemptAt: new Date(0) })
      .where(eq(fileEventDeliveries.id, row.id));
    const last = await deliverOnly(row.id, async () => {
      throw new Error('connection refused');
    });
    expect(last.after.attempts).toBe(FILE_EVENT_MAX_ATTEMPTS);
    expect(last.after.failedAt).not.toBeNull();
  });

  it('signs with the current secret, and dead-letters at once when the endpoint is gone', async () => {
    const { owner, row } = await queued('whsec_old');
    await getDb()
      .update(applications)
      .set({ filesWebhookSecretCiphertext: sealFileWebhookSecret(owner, 'whsec_new') })
      .where(eq(applications.id, owner));
    const rotated = await deliverOnly(row.id, async () => 200);
    expect(() =>
      verifyFileEventSignature(
        rotated.seen[0].body,
        { 'oxy-signature': rotated.seen[0].signature },
        'whsec_new',
      ),
    ).not.toThrow();

    const second = await queued();
    await getDb()
      .update(applications)
      .set({
        filesWebhookUrl: null,
        filesWebhookSecretCiphertext: null,
        filesWebhookVerifiedAt: null,
      })
      .where(eq(applications.id, second.owner));
    const gone = await deliverOnly(second.row.id, async () => 200);
    expect(gone.seen).toHaveLength(0);
    expect(gone.after.failedAt).not.toBeNull();
    expect(gone.after.lastError).toContain('no file-events endpoint');
  });
});
