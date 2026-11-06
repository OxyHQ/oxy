/**
 * A federated account's links, brought in line with its source profile. The
 * account holds them as a native account does, so the rows are read back from
 * the table. Clarity is replaced by a double that resolves every URL unless a
 * test says otherwise.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userLinkMetadata } from '../../db/schema/userLinkMetadata';
import { users } from '../../db/schema/users';
import { resolveLinkDocuments } from '../clarityLinkDocuments.service';
import { replaceSourceProfileLinks } from '../profileLinks.service';

jest.mock('../clarityLinkDocuments.service', () => {
  const actual = jest.requireActual('../clarityLinkDocuments.service');
  return { ...actual, resolveLinkDocuments: jest.fn() };
});

const resolveMock = resolveLinkDocuments as jest.MockedFunction<typeof resolveLinkDocuments>;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  resolveMock.mockImplementation(async (urls) => ({
    documents: new Map(
      urls.map((url) => [
        url,
        { id: `doc:${url.replace(/\/$/, '')}`, canonicalUrl: url, faviconUrl: null },
      ]),
    ),
    pending: [],
  }));
});

async function makeUser(): Promise<string> {
  const id = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, email: `${id}@example.test` });
  return id;
}

async function storedLinks(userId: string) {
  return getDb()
    .select({
      clarityDocumentId: userLinkMetadata.clarityDocumentId,
      title: userLinkMetadata.title,
    })
    .from(userLinkMetadata)
    .where(eq(userLinkMetadata.userId, userId))
    .orderBy(asc(userLinkMetadata.position));
}

describe('replaceSourceProfileLinks', () => {
  it('writes the source links in order, titled by the source', async () => {
    const userId = await makeUser();

    const result = await replaceSourceProfileLinks(userId, [
      { title: 'YouTube', url: 'https://youtube.test/a' },
      { title: 'Blog', url: 'https://blog.test/' },
    ]);

    expect(result).toBe('replaced');
    expect(await storedLinks(userId)).toEqual([
      { clarityDocumentId: 'doc:https://youtube.test/a', title: 'YouTube' },
      { clarityDocumentId: 'doc:https://blog.test', title: 'Blog' },
    ]);
  });

  it('drops the links the source no longer publishes', async () => {
    const userId = await makeUser();
    await replaceSourceProfileLinks(userId, [{ title: 'Old', url: 'https://old.test/' }]);

    await replaceSourceProfileLinks(userId, []);

    expect(await storedLinks(userId)).toEqual([]);
  });

  it('keeps the links it had while Clarity is still fetching one of the new ones', async () => {
    const userId = await makeUser();
    await replaceSourceProfileLinks(userId, [{ title: 'Kept', url: 'https://kept.test/' }]);
    resolveMock.mockResolvedValueOnce({
      documents: new Map([
        [
          'https://kept.test/',
          { id: 'doc:https://kept.test', canonicalUrl: 'https://kept.test/', faviconUrl: null },
        ],
      ]),
      pending: [{ url: 'https://new.test/', status: 'queued' }],
    });

    const result = await replaceSourceProfileLinks(userId, [
      { title: 'Kept', url: 'https://kept.test/' },
      { title: 'New', url: 'https://new.test/' },
    ]);

    expect(result).toBe('kept');
    expect(await storedLinks(userId)).toEqual([
      { clarityDocumentId: 'doc:https://kept.test', title: 'Kept' },
    ]);
  });
});
