/**
 * What the file manager does when the person removes, restores or deletes a
 * file (ADR 0043 D5). Pure of React and of the UI: every call takes the asset
 * API and the confirmation it may need, so the decisions are testable on their
 * own and the screens only render.
 *
 * - "Delete" in the library MOVES TO TRASH: the file stops being served, is
 *   kept, and can be restored from Trash. A `blocked` file (taken down after a
 *   content claim, D10) cannot be trashed — it is already served to nobody —
 *   so removing it is the permanent delete, which is its owner's to make.
 * - Permanent deletion happens only from Trash (or for a blocked file). The
 *   API refuses to delete a file an application still uses (409, with the
 *   number of uses); the person is told and decides, and only then is the
 *   delete forced.
 */
import type { FileMetadata } from '@oxy.so/core';

/** The part of `oxyServices.assets` these actions use. */
export interface TrashAssetsApi {
  trash(fileId: string): Promise<unknown>;
  restore(fileId: string): Promise<unknown>;
  delete(fileId: string, options?: { force?: boolean }): Promise<unknown>;
}

/** What removing a file from the library does to it. */
export type LibraryRemoval = 'trash' | 'delete';

/**
 * A `blocked` file is deleted (it cannot go to trash), and so is a `lost` one
 * (ADR 0043 D13: nothing is left to restore); every other is trashed.
 */
export function libraryRemovalFor(file: Pick<FileMetadata, 'status'>): LibraryRemoval {
  return file.status === 'blocked' || file.status === 'lost' ? 'delete' : 'trash';
}

/** The HTTP status of a failed asset call, when it carries one. */
export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
    const response = (error as { response?: { status?: unknown } }).response;
    if (response && typeof response.status === 'number') return response.status;
  }
  return undefined;
}

/** The API's machine code of a failed asset call, when it carries one. */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * How many uses an application still has of a file the API refused to delete
 * (409, `details.summary.remainingLinks`), or `null` when the refusal is not
 * that one.
 */
export function remainingUses(error: unknown): number | null {
  if (errorStatus(error) !== 409 || !error || typeof error !== 'object') return null;
  const details = (error as { details?: unknown }).details;
  const summary =
    details && typeof details === 'object' ? (details as { summary?: unknown }).summary : undefined;
  const remaining =
    summary && typeof summary === 'object'
      ? (summary as { remainingLinks?: unknown }).remainingLinks
      : undefined;
  return typeof remaining === 'number' && remaining > 0 ? remaining : null;
}

/** Outcome of {@link deletePermanently}. */
export type PermanentDeleteOutcome = 'deleted' | 'cancelled' | 'gone';

/**
 * Delete a file for good. When applications still use it the API refuses;
 * `confirmStillUsed(count)` asks the person, and only a yes forces the delete.
 * A file already gone (404) is `gone` — the caller just refreshes. Any other
 * failure is thrown.
 */
export async function deletePermanently(
  assets: TrashAssetsApi,
  fileId: string,
  confirmStillUsed: (uses: number) => Promise<boolean>,
): Promise<PermanentDeleteOutcome> {
  try {
    await assets.delete(fileId);
    return 'deleted';
  } catch (error) {
    if (errorStatus(error) === 404) return 'gone';
    const uses = remainingUses(error);
    if (uses === null) throw error;
    if (!(await confirmStillUsed(uses))) return 'cancelled';
    await assets.delete(fileId, { force: true });
    return 'deleted';
  }
}

/** Outcome of {@link restoreFromTrash}. */
export type RestoreOutcome = 'restored' | 'not_in_trash' | 'gone';

/**
 * Bring a file back from trash. One that is no longer in trash — restored
 * elsewhere, or blocked after a claim (409 `FILE_NOT_IN_TRASH`) — or no longer
 * exists (404) is reported, not thrown: the trash list is just stale.
 */
export async function restoreFromTrash(
  assets: TrashAssetsApi,
  fileId: string,
): Promise<RestoreOutcome> {
  try {
    await assets.restore(fileId);
    return 'restored';
  } catch (error) {
    if (errorStatus(error) === 404) return 'gone';
    if (errorStatus(error) === 409 && errorCode(error) === 'FILE_NOT_IN_TRASH') {
      return 'not_in_trash';
    }
    throw error;
  }
}

/** Per-file outcome of removing several files from the library. */
export interface LibraryRemovalResult {
  trashed: string[];
  deleted: string[];
  failed: string[];
}

/**
 * Remove several files from the library at once: each goes to trash, except a
 * blocked one, which is deleted (asking about remaining uses as
 * {@link deletePermanently} does). One failure never stops the others.
 */
export async function removeFromLibrary(
  assets: TrashAssetsApi,
  files: ReadonlyArray<Pick<FileMetadata, 'id' | 'status' | 'filename'>>,
  confirmStillUsed: (uses: number, filename: string) => Promise<boolean>,
): Promise<LibraryRemovalResult> {
  const result: LibraryRemovalResult = { trashed: [], deleted: [], failed: [] };
  const toTrash = files.filter((file) => libraryRemovalFor(file) === 'trash');
  const toDelete = files.filter((file) => libraryRemovalFor(file) === 'delete');

  const trashed = await Promise.allSettled(toTrash.map((file) => assets.trash(file.id)));
  trashed.forEach((settled, index) => {
    (settled.status === 'fulfilled' ? result.trashed : result.failed).push(toTrash[index].id);
  });

  // One at a time: each may ask the person a question, and two questions at
  // once would stack.
  for (const file of toDelete) {
    try {
      const outcome = await deletePermanently(assets, file.id, (uses) =>
        confirmStillUsed(uses, file.filename),
      );
      // `cancelled`: the person kept it; nothing to report.
      if (outcome !== 'cancelled') result.deleted.push(file.id);
    } catch {
      result.failed.push(file.id);
    }
  }
  return result;
}
