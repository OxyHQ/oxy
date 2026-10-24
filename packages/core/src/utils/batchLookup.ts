/**
 * A chunked lookup by key that keeps "the server said no" apart from "we never
 * heard back".
 *
 * Every batch read by id used to fold a failed chunk into an empty answer, so a
 * caller could not tell an account the server does not return (deleted,
 * hidden) from a request that never landed (a timeout, a dropped connection).
 * Apps cache absence — Allo's people layer remembers an unanswered id for five
 * minutes — so one network blip blanked a conversation's names and avatars for
 * minutes. A {@link BatchLookup} reports both, per key.
 */
import { logger } from '../logger';
import { extractErrorStatus } from './errorUtils';

/**
 * What a chunked lookup found, per requested key. The three key lists are
 * disjoint and together hold every (deduplicated, valid) key that was asked
 * for, in the order first asked:
 *
 * - `found`: the items the server returned;
 * - `missing`: keys whose chunk the server ANSWERED without them. This is the
 *   server's word that it has nothing for that key (deleted, hidden, unknown)
 *   — the one list that is safe to cache as absent;
 * - `failed`: keys whose chunk FAILED (network error, timeout, 5xx, 429, an
 *   unreadable answer). Nothing is known about them; ask again later, never
 *   cache them as absent;
 * - `error`: the first chunk failure, as thrown, when `failed` is not empty.
 */
export interface BatchLookup<T> {
  found: T[];
  missing: string[];
  failed: string[];
  error?: unknown;
}

/** One chunked lookup: how to fetch a chunk, and which key an answer item is for. */
export interface BatchLookupPlan<T> {
  /** For the failure log, e.g. `users.lookupMany`. Never logs a key. */
  method: string;
  /** Deduplicated, valid keys, in the order first asked. */
  keys: string[];
  chunkSize: number;
  fetchChunk: (keys: string[]) => Promise<unknown>;
  /** Maps a raw answer item to what the caller gets (e.g. identity normalization). */
  mapItem: (item: T) => T;
  /** The key an answer item answers for. */
  keyOf: (item: T) => string | undefined;
  /** Extra fields for the failure log. */
  logContext?: Record<string, unknown>;
}

/**
 * Run `plan` one request per chunk, in parallel, and sort every key into found,
 * missing or failed. Never rejects for a chunk failure: that is what `failed`
 * and `error` are for. An answer that is not an array is a failure, not an
 * empty answer — an answer that cannot be read says nothing about absence.
 */
export async function runBatchLookup<T>(plan: BatchLookupPlan<T>): Promise<BatchLookup<T>> {
  const { keys } = plan;
  if (keys.length === 0) return { found: [], missing: [], failed: [] };

  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += plan.chunkSize) {
    chunks.push(keys.slice(i, i + plan.chunkSize));
  }

  const failedKeys = new Set<string>();
  let firstError: unknown;
  let hasError = false;

  const settled = await Promise.all(
    chunks.map(async (part): Promise<T[]> => {
      try {
        const answer = await plan.fetchChunk(part);
        if (!Array.isArray(answer)) {
          throw new Error(`${plan.method}: unexpected response (not an array)`);
        }
        return (answer as T[]).map((item) => plan.mapItem(item));
      } catch (error: unknown) {
        logger.warn(`${plan.method}: chunk failed`, {
          method: plan.method,
          ...plan.logContext,
          chunkSize: part.length,
          status: extractErrorStatus(error),
          error: error instanceof Error ? error.message : String(error),
        });
        for (const key of part) failedKeys.add(key);
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        return [];
      }
    }),
  );

  const found = settled.flat();
  const answered = new Set<string>();
  for (const item of found) {
    const key = plan.keyOf(item);
    if (typeof key === 'string') answered.add(key);
  }

  const missing: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    if (failedKeys.has(key)) failed.push(key);
    else if (!answered.has(key)) missing.push(key);
  }

  const result: BatchLookup<T> = { found, missing, failed };
  if (hasError) result.error = firstError;
  return result;
}
