/**
 * The local copy of the sealed envelope, in this origin's IndexedDB.
 *
 * A convenience, never the source of truth: Safari deletes a site's storage
 * after seven days without first-party interaction, private windows drop it, and
 * an identity moved to Commons must stop opening here. The server copy decides;
 * this copy only saves a round trip and survives a network blip. Everything in
 * it is ciphertext — the same bytes the server holds.
 */

import { webIdentityEnvelopeSchema, type WebIdentityEnvelope } from '@oxy.so/contracts';
import type { LocalEnvelopePort } from './carrier';

const DB_NAME = 'oxy-identity';
const STORE = 'envelopes';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** IndexedDB-backed store. Failures degrade to "no local copy" — the server copy still works. */
export const indexedDbEnvelopeStore: LocalEnvelopePort = {
  async read(userId) {
    try {
      const value = await withStore<unknown>('readonly', (store) => store.get(userId));
      const parsed = webIdentityEnvelopeSchema.safeParse(value);
      return parsed.success ? (parsed.data as WebIdentityEnvelope) : null;
    } catch {
      return null;
    }
  },
  async write(userId, envelope) {
    try {
      await withStore('readwrite', (store) => store.put(envelope, userId));
    } catch {
      // Storage unavailable (private window, quota): the server copy is enough.
    }
  },
  async remove(userId) {
    try {
      await withStore('readwrite', (store) => store.delete(userId));
    } catch {
      // Nothing to remove from storage that cannot be opened.
    }
  },
};
