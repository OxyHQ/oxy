import type { Persister } from '@oxy.so/bloom-data';
import { hasIndexedDb, indexedDbPersister } from '@oxy.so/bloom-data/indexeddb';

/**
 * The durable copy of one account's data (or the device's, `DEVICE_DATA_ACCOUNT`)
 * on the web: an IndexedDB database per account. None where the runtime has no
 * IndexedDB (a server render, a test): the data then lives in memory only.
 * The native build has its own file (`persister.native.ts`).
 */
export function dataPersister(account: string): Persister | undefined {
  return hasIndexedDb() ? indexedDbPersister(`oxy-data-${account}`) : undefined;
}
