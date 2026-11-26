/**
 * The file library's page mapping and listing helpers for the Trash view (ADR
 * 0043 D5): a trashed file keeps its `trashedAt`, and the library and the
 * trash are separate listings of one owner.
 */
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import {
  AvatarCropSource,
  FileAppAccess,
  FileUrl,
  ImageSize,
  mapRawFileToMetadata,
  PhotoSize,
  removeUserFile,
  toUserFilesPage,
  UserFile,
  UserFiles,
  userFilesKey,
} from '../files';

beforeEach(() => {
  setActiveStore(new Store());
});

const hold = (key: string, ids: string[]) => {
  UserFile.put(ids.map((id) => mapRawFileToMetadata({ id, originalName: `${id}.png` })));
  UserFiles.set(key, () => ({
    ids,
    extra: undefined,
    next: undefined,
    hasMore: false,
    visited: [],
    updatedAt: Date.now(),
    origin: 'network',
  }));
};

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

describe('the trash listing', () => {
  it('is its own listing, and removal targets the listing it names', () => {
    expect(userFilesKey('u', 'trash')).not.toEqual(userFilesKey('u', 'library'));

    hold(userFilesKey('u', 'library'), ['a', 'b']);
    hold(userFilesKey('u', 'trash'), ['b', 't']);

    removeUserFile('u', 'b', 'trash');
    expect(UserFiles.get(userFilesKey('u', 'trash'))?.ids).toEqual(['t']);
    expect(UserFiles.get(userFilesKey('u', 'library'))?.ids).toEqual(['a', 'b']);

    removeUserFile('u', 'a');
    expect(UserFiles.get(userFilesKey('u', 'library'))?.ids).toEqual(['b']);
  });
});

describe('memory only', () => {
  it('never writes a signed URL, a measurement or a file read to disk', () => {
    // A restored signed URL would serve an expired token; the SDK never
    // persisted its file reads either.
    for (const entity of [
      FileUrl,
      AvatarCropSource,
      PhotoSize,
      ImageSize,
      UserFile,
      FileAppAccess,
    ]) {
      expect(entity.definition.persistVersion).toBeNull();
    }
    expect(UserFiles.definition.persist('library:u')).toBe(false);
  });
});
