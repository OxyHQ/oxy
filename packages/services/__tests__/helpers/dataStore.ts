/**
 * A fresh bloom-data store per test, made active (what an action or a write
 * outside React acts on) and given to every rendered hook through
 * `DataProvider`, as `OxyProvider` gives the signed-in account's store.
 */
import { createElement, type ReactNode } from 'react';
import { DataProvider, setActiveStore, Store } from '@oxy.so/bloom-data';

export function openTestStore(): Store {
  const store = new Store();
  setActiveStore(store);
  return store;
}

export function dataWrapper(store: Store) {
  return function DataWrapper({ children }: { children: ReactNode }) {
    return createElement(DataProvider, { store }, children);
  };
}
