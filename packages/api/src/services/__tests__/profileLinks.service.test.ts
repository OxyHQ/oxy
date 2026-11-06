/**
 * A profile's links, as Oxy stores them (a Clarity document id, the owner's
 * title, the position) and as a reader sees them (the document Clarity holds).
 * Clarity itself is a network service, so it is replaced here by a double that
 * answers from a fixed table.
 */
import { ConflictError } from '../../utils/error';
import {
  buildProfileLinkRows,
  hydrateProfileLinks,
  parseProfileLinkInputs,
} from '../profileLinks.service';
import { readLinkDocuments, resolveLinkDocuments } from '../clarityLinkDocuments.service';

jest.mock('../clarityLinkDocuments.service', () => {
  const actual = jest.requireActual('../clarityLinkDocuments.service');
  return {
    ...actual,
    resolveLinkDocuments: jest.fn(),
    readLinkDocuments: jest.fn(),
  };
});

const resolveMock = resolveLinkDocuments as jest.MockedFunction<typeof resolveLinkDocuments>;
const readMock = readLinkDocuments as jest.MockedFunction<typeof readLinkDocuments>;

const doc = (id: string, canonicalUrl: string, extra: Record<string, unknown> = {}) => ({
  id,
  canonicalUrl,
  title: `Title of ${id}`,
  description: `About ${id}`,
  faviconUrl: null,
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('hydrateProfileLinks', () => {
  it('reads each document in position order and shows the owner title over Clarity', async () => {
    readMock.mockResolvedValue(
      new Map([
        ['doc-b', doc('doc-b', 'https://b.test/', { imageUrl: 'https://b.test/i.png' })],
        ['doc-a', doc('doc-a', 'https://a.test/', { faviconUrl: 'https://clarity/f/a' })],
      ]),
    );

    const links = await hydrateProfileLinks([
      { position: 1, clarityDocumentId: 'doc-a', title: 'My site' },
      { position: 0, clarityDocumentId: 'doc-b', title: null },
    ]);

    expect(links).toEqual([
      {
        url: 'https://b.test/',
        title: 'Title of doc-b',
        description: 'About doc-b',
        image: 'https://b.test/i.png',
      },
      {
        url: 'https://a.test/',
        title: 'My site',
        description: 'About doc-a',
        faviconUrl: 'https://clarity/f/a',
      },
    ]);
  });

  it('names a link by its page title, and by nothing when the page has none', async () => {
    readMock.mockResolvedValue(
      new Map([
        ['doc-titled', doc('doc-titled', 'https://t.test/')],
        ['doc-untitled', doc('doc-untitled', 'https://u.test/', { title: undefined })],
      ]),
    );

    const links = await hydrateProfileLinks([
      { position: 0, clarityDocumentId: 'doc-titled', title: null },
      { position: 1, clarityDocumentId: 'doc-untitled', title: null },
    ]);

    expect(links.map((link) => link.title)).toEqual(['Title of doc-titled', '']);
  });

  it('omits an absent image and favicon rather than sending null', async () => {
    readMock.mockResolvedValue(new Map([['doc-a', doc('doc-a', 'https://a.test/')]]));

    const [link] = await hydrateProfileLinks([
      { position: 0, clarityDocumentId: 'doc-a', title: null },
    ]);

    expect(link).not.toHaveProperty('image');
    expect(link).not.toHaveProperty('faviconUrl');
  });

  it('leaves out a link whose document Clarity no longer has', async () => {
    readMock.mockResolvedValue(new Map([['gone', null]]));

    expect(
      await hydrateProfileLinks([{ position: 0, clarityDocumentId: 'gone', title: null }]),
    ).toEqual([]);
  });

  it('shows a row from before the backfill from its legacy URL, without calling Clarity for it', async () => {
    readMock.mockResolvedValue(new Map());

    const links = await hydrateProfileLinks([
      {
        position: 0,
        clarityDocumentId: null,
        title: 'Legacy',
        url: 'https://legacy.test',
        description: 'old',
        image: null,
      },
    ]);

    expect(links).toEqual([{ url: 'https://legacy.test', title: 'Legacy', description: 'old' }]);
    expect(readMock).not.toHaveBeenCalled();
  });

  it('keeps the legacy rows and drops the document rows when Clarity cannot be reached', async () => {
    readMock.mockRejectedValue(new Error('down'));

    const links = await hydrateProfileLinks([
      { position: 0, clarityDocumentId: 'doc-a', title: null },
      { position: 1, clarityDocumentId: null, title: 'Kept', url: 'https://kept.test' },
    ]);

    expect(links).toEqual([{ url: 'https://kept.test', title: 'Kept', description: '' }]);
  });
});

describe('buildProfileLinkRows', () => {
  it('stores each document once, with contiguous positions and the owner title cut to 40 characters', async () => {
    resolveMock.mockResolvedValue({
      documents: new Map([
        ['https://same.test', doc('doc-same', 'https://same.test')],
        ['https://other.test', doc('doc-other', 'https://other.test')],
      ]),
      pending: [],
    });

    const rows = await buildProfileLinkRows(
      'user-1',
      parseProfileLinkInputs([
        { url: 'https://same.test' },
        { url: 'https://other.test', title: 'x'.repeat(60) },
        { url: 'https://same.test' },
      ]),
    );

    expect(rows).toEqual([
      { userId: 'user-1', position: 0, clarityDocumentId: 'doc-same', title: null },
      { userId: 'user-1', position: 1, clarityDocumentId: 'doc-other', title: 'x'.repeat(40) },
    ]);
  });

  it('fails the save with the still-pending URLs, so the client can retry', async () => {
    resolveMock.mockResolvedValue({
      documents: new Map(),
      pending: [{ url: 'https://slow.test', status: 'queued' }],
    });

    await expect(
      buildProfileLinkRows('user-1', [{ url: 'https://slow.test' }]),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a link that is not https before asking Clarity anything', async () => {
    await expect(buildProfileLinkRows('user-1', [{ url: 'http://plain.test' }])).rejects.toThrow(
      'https',
    );
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
