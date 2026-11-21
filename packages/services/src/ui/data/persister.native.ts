import type { Persister } from '@oxy.so/bloom-data';
import { sqlitePersister } from '@oxy.so/bloom-data/sqlite';
import * as SQLite from 'expo-sqlite';

/**
 * The durable copy of one account's data (or the device's, `DEVICE_DATA_ACCOUNT`)
 * on a device: one SQLite file per account (`oxy-data-<account>.db`), written
 * in the background and read when a screen opens, never while React renders.
 *
 * The file is opened with the synchronous API so an app's one boot read
 * (`list.loadNow`) can read it before the first frame; every later call uses
 * the asynchronous API on the same connection. Forgetting the account
 * (sign-out) deletes the file.
 */
export function dataPersister(account: string): Persister {
  const name = `oxy-data-${account.replace(/[^A-Za-z0-9_-]/g, '_')}.db`;
  return sqlitePersister(
    () => SQLite.openDatabaseSync(name),
    () => SQLite.deleteDatabaseAsync(name),
  );
}
