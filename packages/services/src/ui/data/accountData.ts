/**
 * The data stores of `@oxy.so/bloom-data`, one per account, opened by the
 * session.
 *
 * Every record an app or this SDK holds in bloom-data (a person in `User`, an
 * app's posts) lives in the store of the account that read it, and each store
 * keeps its own durable copy (`dataPersister`: one SQLite file per account on
 * a device, one IndexedDB database on the web). The session decides which store is open: the runtime calls
 * `open` on every subject change, BETWEEN committing the new bearer and waking
 * anybody (ADR 0002), so nothing woken by a switch can read the previous
 * account's records, and an answer that lands for the previous account goes to
 * its closed store and is dropped.
 *
 * Signed out is an account of its own (`SIGNED_OUT_DATA_ACCOUNT`): public
 * reads still have a store, and none of them reach a signed-in account's.
 */
import { useCallback, useEffect, useState } from 'react';
import { type Accounts, createAccounts, type Store } from '@oxy.so/bloom-data';
import { dataPersister } from './persister';

/** The store key of the signed-out viewer. */
export const SIGNED_OUT_DATA_ACCOUNT = 'anon';

/** The store key of a session subject (an account id, or `null` signed out). */
export function accountDataKey(subject: string | null): string {
  return subject ?? SIGNED_OUT_DATA_ACCOUNT;
}

export interface AccountData {
  /** The open account's store, for `<DataProvider>`. */
  store: Store;
  /** Opens the store of `subject` (closing the previous one). Called by the runtime's subject change. */
  open: (subject: string | null) => void;
  /** Deletes an account's data from this device (sign-out), closing its store if open. */
  forget: (subject: string) => Promise<void>;
}

/**
 * The provider's account stores. `currentSubject` reads the session's subject
 * now (the runtime snapshot) and must be stable (it is the runtime's); every
 * change after mount goes through `open`.
 */
export function useAccountData(currentSubject: () => string | null): AccountData {
  const [accounts] = useState<Accounts>(() => createAccounts({ persister: dataPersister }));
  const [store, setStore] = useState<Store>(() => accounts.open(accountDataKey(currentSubject())));
  const open = useCallback(
    (next: string | null) => setStore(accounts.open(accountDataKey(next))),
    [accounts],
  );
  const forget = useCallback(
    (subject: string) => accounts.forget(accountDataKey(subject)),
    [accounts],
  );
  // Closing on unmount lets the last queued writes reach the file. A remount
  // (Strict Mode, a host remounting the provider) opens the account again.
  useEffect(() => {
    open(currentSubject());
    return () => {
      void accounts.close();
    };
  }, [accounts, open, currentSubject]);
  return { store, open, forget };
}
