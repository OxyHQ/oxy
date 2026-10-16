/**
 * The file library's page mapping and cache helpers for the Trash view (ADR
 * 0041 D5): a trashed file keeps its `trashedAt`, and the library and the
 * trash are separate cache entries under one `files` root.
 */
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import {
  mapRawFileToMetadata,
  removeFileFromCache,
  toUserFilesPage,
  type UserFilesInfinite,
} from '../useFileQueries';

jest.mock('../../../context/OxyContext', () => ({ useOxy: () => ({}) }));

const page = (ids: string[]): UserFilesInfinite => ({
  pages: [
    {
      files: ids.map((id) => mapRawFileToMetadata({ id, originalName: `${id}.png` })),
      total: ids.length,
      hasMore: false,
      nextOffset: 40,
    },
  ],
  pageParams: [0],
});

describe('mapRawFileToMetadata', () => {
  it('keeps the status and when the file went to trash', () => {
    const file = mapRawFileToMetadata({
      id: 'f',
      originalName: 'f.png',
      status: 'trash',
      trashedAt: '2026-10-16T10:00:00.000Z',
    });
    expect(file).toMatchObject({ status: 'trash', trashedAt: '2026-10-16T10:00:00.000Z' });
    expect(mapRawFileToMetadata({ id: 'g', trashedAt: null })).not.toHaveProperty('trashedAt');
  });
});

describe('toUserFilesPage', () => {
  it('maps a page and where the next one starts', () => {
    const mapped = toUserFilesPage({ files: [{ id: 'a' }], total: 41, hasMore: true }, 0);
    expect(mapped).toMatchObject({ total: 41, hasMore: true, nextOffset: 40 });
    expect(mapped.files.map((file) => file.id)).toEqual(['a']);
  });
});

describe('the trash cache', () => {
  it('is its own entry under files.all, and removal targets the list it names', () => {
    expect(queryKeys.files.trash('u').slice(0, 1)).toEqual([...queryKeys.files.all]);
    expect(queryKeys.files.trash('u')).not.toEqual(queryKeys.files.list('u'));

    const client = new QueryClient();
    client.setQueryData(queryKeys.files.list('u'), page(['a', 'b']));
    client.setQueryData(queryKeys.files.trash('u'), page(['b', 't']));

    removeFileFromCache(client, 'u', 'b', 'trash');
    const ids = (key: readonly unknown[]) =>
      client
        .getQueryData<UserFilesInfinite>(key)
        ?.pages.flatMap((p) => p.files.map((file) => file.id));
    expect(ids(queryKeys.files.trash('u'))).toEqual(['t']);
    expect(ids(queryKeys.files.list('u'))).toEqual(['a', 'b']);

    removeFileFromCache(client, 'u', 'a');
    expect(ids(queryKeys.files.list('u'))).toEqual(['b']);
  });
});
