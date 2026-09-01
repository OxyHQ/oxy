/**
 * Pictures on a store page.
 *
 * Two things here are worth more than the CRUD around them, and both are
 * covered by cases that FAIL rather than by cases that succeed.
 *
 * The first is scoping: every write names the listing as well as the screenshot
 * id, so holding `app:update` on your own app does not let you edit a picture
 * on somebody else's by guessing an id. The test for it uses two real listings
 * and asks one to touch the other's row.
 *
 * The second is the file check. The foreign key only proves a row exists; it
 * says nothing about whether the asset is live, is an image, or is the caller's
 * to publish.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appListingScreenshots } from '../../db/schema/appListingScreenshots';
import { applications } from '../../db/schema/applications';
import { files } from '../../db/schema/files';
import { users } from '../../db/schema/users';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/error';
import {
  addScreenshot,
  deleteScreenshot,
  listScreenshots,
  reorderScreenshots,
  updateScreenshot,
  upsertListing,
} from '../store.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function insertUser(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getDb()
    .insert(users)
    .values({ username: `shot-${suffix}`, email: `shot-${suffix}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

/** An application with a listing, plus the account that owns both. */
async function listedApp(): Promise<{ applicationId: string; ownerId: string }> {
  const ownerId = await insertUser();
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId: ownerId })
    .returning({ id: applications.id });
  await upsertListing({ applicationId: application.id, slug: `slug-${randomUUID().slice(0, 8)}` });
  return { applicationId: application.id, ownerId };
}

/** An uploaded asset belonging to `ownerUserId`. */
async function uploadFile(
  ownerUserId: string | null,
  overrides: Partial<typeof files.$inferInsert> = {}
): Promise<string> {
  const suffix = randomUUID();
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: suffix.replace(/-/g, '').repeat(2).slice(0, 64),
      size: 1024,
      mime: 'image/png',
      ext: 'png',
      ownerUserId,
      storageKey: `test/${suffix}.png`,
      ...overrides,
    })
    .returning({ id: files.id });
  return row.id;
}

describe('attaching a picture', () => {
  it('appends it, and hands back where it landed', async () => {
    const { applicationId, ownerId } = await listedApp();

    const first = await addScreenshot({
      applicationId,
      callerUserId: ownerId,
      fileId: await uploadFile(ownerId),
      platform: 'phone',
      caption: 'The inbox',
    });
    const second = await addScreenshot({
      applicationId,
      callerUserId: ownerId,
      fileId: await uploadFile(ownerId),
    });

    expect(first.position).toBe(0);
    expect(first.platform).toBe('phone');
    expect(first.caption).toBe('The inbox');
    expect(second.position).toBe(1);
    // Not carried over from the previous shot, and not null: the column's own
    // default is what an unspecified frame means.
    expect(second.platform).toBe('desktop');
  });

  it('refuses a file that is not an image', async () => {
    const { applicationId, ownerId } = await listedApp();
    const fileId = await uploadFile(ownerId, { mime: 'application/pdf', ext: 'pdf' });

    await expect(addScreenshot({ applicationId, callerUserId: ownerId, fileId })).rejects.toThrow(
      BadRequestError
    );
  });

  it('refuses a file that is in the trash', async () => {
    const { applicationId, ownerId } = await listedApp();
    const fileId = await uploadFile(ownerId, { status: 'trash' });

    await expect(addScreenshot({ applicationId, callerUserId: ownerId, fileId })).rejects.toThrow(
      NotFoundError
    );
  });

  it('refuses a stranger’s file — the foreign key would have accepted it', async () => {
    const { applicationId, ownerId } = await listedApp();
    const someoneElse = await insertUser();
    const fileId = await uploadFile(someoneElse);

    await expect(addScreenshot({ applicationId, callerUserId: ownerId, fileId })).rejects.toThrow(
      ForbiddenError
    );
  });

  it('says so when the application has no listing to hold pictures', async () => {
    const ownerId = await insertUser();
    const [application] = await getDb()
      .insert(applications)
      .values({ name: `App ${randomUUID().slice(0, 8)}`, ownerAccountId: ownerId })
      .returning({ id: applications.id });

    await expect(
      addScreenshot({
        applicationId: application.id,
        callerUserId: ownerId,
        fileId: await uploadFile(ownerId),
      })
    ).rejects.toThrow(NotFoundError);
  });
});

describe('a write names the listing, not just the id', () => {
  it('will not edit a picture that belongs to another app', async () => {
    const mine = await listedApp();
    const theirs = await listedApp();
    const theirShot = await addScreenshot({
      applicationId: theirs.applicationId,
      callerUserId: theirs.ownerId,
      fileId: await uploadFile(theirs.ownerId),
      caption: 'Theirs',
    });

    await expect(
      updateScreenshot({
        applicationId: mine.applicationId,
        screenshotId: theirShot.id,
        caption: 'Mine now',
      })
    ).rejects.toThrow(NotFoundError);

    const [untouched] = await getDb()
      .select()
      .from(appListingScreenshots)
      .where(eq(appListingScreenshots.id, theirShot.id));
    expect(untouched.caption).toBe('Theirs');
  });

  it('will not delete one either', async () => {
    const mine = await listedApp();
    const theirs = await listedApp();
    const theirShot = await addScreenshot({
      applicationId: theirs.applicationId,
      callerUserId: theirs.ownerId,
      fileId: await uploadFile(theirs.ownerId),
    });

    await expect(
      deleteScreenshot({ applicationId: mine.applicationId, screenshotId: theirShot.id })
    ).rejects.toThrow(NotFoundError);

    expect(await listScreenshots(theirs.applicationId)).toHaveLength(1);
  });
});

describe('editing a picture', () => {
  it('changes only what was named', async () => {
    const { applicationId, ownerId } = await listedApp();
    const shot = await addScreenshot({
      applicationId,
      callerUserId: ownerId,
      fileId: await uploadFile(ownerId),
      platform: 'tablet',
      caption: 'Before',
    });

    const edited = await updateScreenshot({
      applicationId,
      screenshotId: shot.id,
      caption: 'After',
    });

    expect(edited.caption).toBe('After');
    expect(edited.platform).toBe('tablet');
    expect(edited.fileId).toBe(shot.fileId);
  });

  it('clears a caption when asked to, and blank means cleared', async () => {
    const { applicationId, ownerId } = await listedApp();
    const shot = await addScreenshot({
      applicationId,
      callerUserId: ownerId,
      fileId: await uploadFile(ownerId),
      caption: 'Something',
    });

    expect((await updateScreenshot({ applicationId, screenshotId: shot.id, caption: null })).caption).toBeNull();

    await updateScreenshot({ applicationId, screenshotId: shot.id, caption: 'Again' });
    expect(
      (await updateScreenshot({ applicationId, screenshotId: shot.id, caption: '  ' })).caption
    ).toBeNull();
  });
});

describe('removing a picture', () => {
  it('removes the row and leaves the file alone', async () => {
    const { applicationId, ownerId } = await listedApp();
    const fileId = await uploadFile(ownerId);
    const shot = await addScreenshot({ applicationId, callerUserId: ownerId, fileId });

    await deleteScreenshot({ applicationId, screenshotId: shot.id });

    expect(await listScreenshots(applicationId)).toEqual([]);
    // The asset may be in use elsewhere; unpinning it here is not a delete.
    expect(await getDb().select().from(files).where(eq(files.id, fileId))).toHaveLength(1);
  });

  it('says so when there is no such picture here', async () => {
    const { applicationId } = await listedApp();

    await expect(
      deleteScreenshot({ applicationId, screenshotId: `missing-${randomUUID()}` })
    ).rejects.toThrow(NotFoundError);
  });
});

describe('reordering', () => {
  async function threeShots(): Promise<{ applicationId: string; ids: string[] }> {
    const { applicationId, ownerId } = await listedApp();
    const ids: string[] = [];
    for (const caption of ['a', 'b', 'c']) {
      const shot = await addScreenshot({
        applicationId,
        callerUserId: ownerId,
        fileId: await uploadFile(ownerId),
        caption,
      });
      ids.push(shot.id);
    }
    return { applicationId, ids };
  }

  it('puts them in the order asked for', async () => {
    const { applicationId, ids } = await threeShots();

    const reordered = await reorderScreenshots({
      applicationId,
      screenshotIds: [ids[2], ids[0], ids[1]],
    });

    expect(reordered.map((shot) => shot.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(reordered.map((shot) => shot.position)).toEqual([0, 1, 2]);
    // And the order survives a fresh read, rather than only the returned array.
    expect((await listScreenshots(applicationId)).map((shot) => shot.caption)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('refuses a partial list, which would interleave what it omits', async () => {
    const { applicationId, ids } = await threeShots();

    await expect(
      reorderScreenshots({ applicationId, screenshotIds: [ids[1], ids[0]] })
    ).rejects.toThrow(BadRequestError);
    expect((await listScreenshots(applicationId)).map((shot) => shot.id)).toEqual(ids);
  });

  it('refuses a repeated id, and one that is not on this listing', async () => {
    const { applicationId, ids } = await threeShots();
    const elsewhere = await threeShots();

    await expect(
      reorderScreenshots({ applicationId, screenshotIds: [ids[0], ids[0], ids[1]] })
    ).rejects.toThrow(BadRequestError);
    await expect(
      reorderScreenshots({ applicationId, screenshotIds: [ids[0], ids[1], elsewhere.ids[0]] })
    ).rejects.toThrow(BadRequestError);
  });
});
