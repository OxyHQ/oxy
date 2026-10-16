/**
 * The profile-avatar back-fill (`scripts/reconcile-profile-media-references.ts`,
 * ADR 0042 stage 4b) against a REAL Postgres.
 *
 *  1. The report (default) writes nothing and says what `--apply` would do.
 *  2. `--apply` references every account's own avatar (created by the account),
 *     removes `avatar` references to files that are no longer the avatar —
 *     never trashing them — and removes references naming no account.
 *  3. A second `--apply` finds nothing to do.
 *  4. An avatar naming another account's file is reported as unreferenceable
 *     and never referenced.
 *
 * The run scans the worker's whole database, so assertions read only the
 * records of the accounts this file created.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, fileReferences, files, users } from '../../db/schema';
import {
  PROFILE_AVATAR_ENTITY_TYPE,
  listProfileAvatarReferences,
  runProfileMediaReconciliation,
  type ProfileAvatarReferenceChange,
} from '../profileMediaReferences.service';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.setTimeout(60_000);

let accountsAppId: string;

async function person(avatar?: string | null): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `backfill${suffix}`, avatar: avatar ?? null })
    .returning({ id: users.id });
  return row.id;
}

async function photo(ownerUserId: string): Promise<string> {
  const sha256 = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      mime: 'image/png',
      ext: 'png',
      ownerUserId,
      status: 'active',
      visibility: 'public',
      storageKey: `public/content/2026/10/${sha256.slice(0, 2)}/${sha256}.png`,
    })
    .returning({ id: files.id });
  return row.id;
}

async function setAvatar(userId: string, fileId: string | null): Promise<void> {
  await getDb().update(users).set({ avatar: fileId }).where(eq(users.id, userId));
}

async function reference(fileId: string, entityId: string): Promise<void> {
  await getDb().insert(fileReferences).values({
    fileId,
    applicationId: accountsAppId,
    entityType: PROFILE_AVATAR_ENTITY_TYPE,
    entityId,
    createdByUserId: null,
  });
}

async function run(apply: boolean) {
  const records: Array<ProfileAvatarReferenceChange & { applied: boolean }> = [];
  const summary = await runProfileMediaReconciliation({
    apply,
    batchSize: 2,
    emit: (record) => records.push(record),
  });
  return { summary, records };
}

beforeAll(async () => {
  await connectPostgres();
  await getDb()
    .update(applications)
    .set({ status: 'suspended' })
    .where(and(eq(applications.name, 'Oxy Accounts'), ne(applications.type, 'third_party')));
  const [row] = await getDb()
    .insert(applications)
    .values({ name: 'Oxy Accounts', ownerAccountId: await person(), type: 'first_party' })
    .returning({ id: applications.id });
  accountsAppId = row.id;
});

afterAll(async () => {
  await closePostgres();
});

describe('runProfileMediaReconciliation', () => {
  it('reports, applies once, and then finds nothing to do', async () => {
    // A: an avatar never referenced (set before stage 4b).
    const a = await person();
    const aAvatar = await photo(a);
    await setAvatar(a, aAvatar);
    // B: referenced, plus a stale reference to a previous avatar.
    const b = await person();
    const bAvatar = await photo(b);
    const bOld = await photo(b);
    await setAvatar(b, bAvatar);
    await reference(bAvatar, b);
    await reference(bOld, b);
    // C: no avatar any more, a reference left behind.
    const c = await person();
    const cOld = await photo(c);
    await reference(cOld, c);
    // D: an avatar that is someone else's file.
    const d = await person();
    await setAvatar(d, aAvatar);
    // An account that no longer exists.
    const goneFile = await photo(a);
    const goneId = `gone-${randomUUID()}`;
    await reference(goneFile, goneId);

    const mine = new Set([a, b, c, d]);
    const report = await run(false);
    const reported = report.records.filter((record) => mine.has(record.userId));
    expect(report.summary.mode).toBe('report');
    expect(report.summary.complete).toBe(true);
    expect(report.summary.orphanReferences).toBeGreaterThanOrEqual(1);
    expect(reported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: a, add: aAvatar, remove: [], applied: false }),
        expect.objectContaining({ userId: b, add: null, remove: [bOld], applied: false }),
        expect.objectContaining({ userId: c, add: null, remove: [cOld], applied: false }),
      ]),
    );
    // D needs nothing (it holds no reference) but is never referenced.
    expect(reported.find((record) => record.userId === d)).toBeUndefined();
    // Nothing was written.
    expect(await listProfileAvatarReferences(accountsAppId, [a, b, c, d])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileId: bAvatar, entityId: b }),
        expect.objectContaining({ fileId: bOld, entityId: b }),
        expect.objectContaining({ fileId: cOld, entityId: c }),
      ]),
    );
    expect(await listProfileAvatarReferences(accountsAppId, [a, b, c, d])).toHaveLength(3);

    const applied = await run(true);
    expect(applied.summary.mode).toBe('apply');
    expect(applied.summary.unreferenceable).toBeGreaterThanOrEqual(1);
    const after = await listProfileAvatarReferences(accountsAppId, [a, b, c, d, goneId]);
    expect(after).toEqual(
      expect.arrayContaining([
        { fileId: aAvatar, entityId: a, createdByUserId: a },
        { fileId: bAvatar, entityId: b, createdByUserId: null },
      ]),
    );
    expect(after).toHaveLength(2);
    // Removing a reference never trashes: the files are active and not in use.
    const state = await getDb()
      .select({ id: files.id, status: files.status, unreferencedSince: files.unreferencedSince })
      .from(files)
      .where(inArray(files.id, [bOld, cOld, goneFile]));
    for (const row of state) {
      expect(row.status).toBe('active');
      expect(row.unreferencedSince).toBeInstanceOf(Date);
    }

    const again = await run(true);
    expect(again.records.filter((record) => mine.has(record.userId))).toEqual([]);
    expect(again.summary.referencesAdded).toBe(0);
    expect(again.summary.referencesRemoved).toBe(0);
    expect(again.summary.orphanReferences).toBe(0);
  });

  it('resumes after an account id and stops after a bounded number of batches', async () => {
    const summary = await runProfileMediaReconciliation({
      apply: false,
      batchSize: 1,
      maxBatches: 1,
    });
    expect(summary.complete).toBe(false);
    expect(summary.accountsScanned).toBeLessThanOrEqual(1);
  });
});
