/**
 * The file manager's trash decisions (ADR 0043 D5), without the UI: "delete"
 * in the library moves to trash (a blocked file, which cannot be trashed, is
 * deleted); permanent deletion forces past remaining uses only after the
 * person says yes; restore reports a stale trash list instead of failing.
 */
import {
  deletePermanently,
  errorStatus,
  libraryRemovalFor,
  remainingUses,
  removeFromLibrary,
  restoreFromTrash,
  type TrashAssetsApi,
} from '../trashActions';

/** An `OxyApiError`-shaped refusal, as `@oxy.so/core` throws it. */
function apiError(status: number, code: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(code), { status, code, details });
}

const stillUsed = (remainingLinks: number) =>
  apiError(409, 'CONFLICT', {
    summary: { fileId: 'f', wouldDelete: false, affectedApps: ['a'], remainingLinks, variants: [] },
    message: 'Use ?force=true to delete anyway',
  });

function assetsApi(overrides: Partial<Record<keyof TrashAssetsApi, jest.Mock>> = {}) {
  return {
    trash: overrides.trash ?? jest.fn(async () => ({})),
    restore: overrides.restore ?? jest.fn(async () => ({})),
    delete: overrides.delete ?? jest.fn(async () => ({})),
  };
}

describe('libraryRemovalFor', () => {
  it('trashes an active file (or one whose status the server did not say)', () => {
    expect(libraryRemovalFor({ status: 'active' })).toBe('trash');
    expect(libraryRemovalFor({ status: undefined })).toBe('trash');
  });

  it('deletes a blocked file, which cannot go to trash', () => {
    expect(libraryRemovalFor({ status: 'blocked' })).toBe('delete');
  });
});

describe('errorStatus and remainingUses', () => {
  it('read the status from the error or its response', () => {
    expect(errorStatus(apiError(404, 'NOT_FOUND'))).toBe(404);
    expect(errorStatus({ response: { status: 409 } })).toBe(409);
    expect(errorStatus(new Error('network'))).toBeUndefined();
  });

  it('count remaining uses only on the 409 that carries a delete summary', () => {
    expect(remainingUses(stillUsed(3))).toBe(3);
    expect(remainingUses(apiError(409, 'FILE_NOT_IN_TRASH', { status: 'active' }))).toBeNull();
    expect(remainingUses(apiError(500, 'INTERNAL'))).toBeNull();
    expect(remainingUses(stillUsed(0))).toBeNull();
  });
});

describe('deletePermanently', () => {
  it('deletes without force when nothing uses the file', async () => {
    const assets = assetsApi();
    const confirm = jest.fn();
    await expect(deletePermanently(assets, 'f', confirm)).resolves.toBe('deleted');
    expect(assets.delete).toHaveBeenCalledTimes(1);
    expect(assets.delete).toHaveBeenCalledWith('f');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before forcing past remaining uses, and forces only on a yes', async () => {
    const assets = assetsApi({
      delete: jest.fn(async (_id: string, options?: { force?: boolean }) => {
        if (!options?.force) throw stillUsed(2);
        return {};
      }),
    });
    const confirm = jest.fn(async () => true);
    await expect(deletePermanently(assets, 'f', confirm)).resolves.toBe('deleted');
    expect(confirm).toHaveBeenCalledWith(2);
    expect(assets.delete).toHaveBeenLastCalledWith('f', { force: true });
  });

  it('keeps the file when the person says no', async () => {
    const assets = assetsApi({
      delete: jest.fn(async () => {
        throw stillUsed(1);
      }),
    });
    await expect(deletePermanently(assets, 'f', async () => false)).resolves.toBe('cancelled');
    expect(assets.delete).toHaveBeenCalledTimes(1);
  });

  it('reports a file already gone, and throws any other failure', async () => {
    const gone = assetsApi({
      delete: jest.fn(async () => {
        throw apiError(404, 'NOT_FOUND');
      }),
    });
    await expect(deletePermanently(gone, 'f', jest.fn())).resolves.toBe('gone');
    const broken = assetsApi({
      delete: jest.fn(async () => {
        throw apiError(500, 'INTERNAL');
      }),
    });
    await expect(deletePermanently(broken, 'f', jest.fn())).rejects.toMatchObject({ status: 500 });
  });
});

describe('restoreFromTrash', () => {
  it('restores', async () => {
    const assets = assetsApi();
    await expect(restoreFromTrash(assets, 'f')).resolves.toBe('restored');
    expect(assets.restore).toHaveBeenCalledWith('f');
  });

  it('reports a file no longer in trash (restored elsewhere, or blocked) or gone', async () => {
    const notInTrash = assetsApi({
      restore: jest.fn(async () => {
        throw apiError(409, 'FILE_NOT_IN_TRASH', { status: 'blocked' });
      }),
    });
    await expect(restoreFromTrash(notInTrash, 'f')).resolves.toBe('not_in_trash');
    const gone = assetsApi({
      restore: jest.fn(async () => {
        throw apiError(404, 'NOT_FOUND');
      }),
    });
    await expect(restoreFromTrash(gone, 'f')).resolves.toBe('gone');
    const otherConflict = assetsApi({
      restore: jest.fn(async () => {
        throw apiError(409, 'CONFLICT');
      }),
    });
    await expect(restoreFromTrash(otherConflict, 'f')).rejects.toMatchObject({ status: 409 });
  });
});

describe('removeFromLibrary', () => {
  it('trashes the active files and deletes the blocked ones; one failure stops nothing', async () => {
    const assets = assetsApi({
      trash: jest.fn(async (id: string) => {
        if (id === 'broken') throw apiError(500, 'INTERNAL');
        return {};
      }),
    });
    const result = await removeFromLibrary(
      assets,
      [
        { id: 'a', filename: 'a.png', status: 'active' },
        { id: 'broken', filename: 'b.png', status: 'active' },
        { id: 'taken-down', filename: 'c.png', status: 'blocked' },
      ],
      jest.fn(),
    );
    expect(result).toEqual({ trashed: ['a'], deleted: ['taken-down'], failed: ['broken'] });
    expect(assets.trash).not.toHaveBeenCalledWith('taken-down');
    expect(assets.delete).toHaveBeenCalledWith('taken-down');
  });

  it('asks about a used blocked file by name, and leaves it out when kept', async () => {
    const assets = assetsApi({
      delete: jest.fn(async () => {
        throw stillUsed(4);
      }),
    });
    const confirm = jest.fn(async () => false);
    const result = await removeFromLibrary(
      assets,
      [{ id: 'x', filename: 'claimed.jpg', status: 'blocked' }],
      confirm,
    );
    expect(confirm).toHaveBeenCalledWith(4, 'claimed.jpg');
    expect(result).toEqual({ trashed: [], deleted: [], failed: [] });
  });
});
