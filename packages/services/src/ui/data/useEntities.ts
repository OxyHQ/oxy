/**
 * `useEntities`: several records of one entity, read together.
 *
 * `useEntity` reads one record; a screen that needs a whole set at once (the
 * files of a library page, the people behind a "Follow all" button) reads
 * them here. The hook re-renders when any of the records changes, and returns
 * the same array while none did, so a memo over it recomputes only then.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { type Entity, type Store, useStore } from '@oxy.so/bloom-data';

/** Keeps the last answer, so an unchanged set reads as the same array. */
class EntitiesReader<T> {
  private last: readonly (T | undefined)[] = [];

  constructor(
    readonly store: Store,
    readonly entity: Entity<T>,
  ) {}

  snapshot(ids: readonly string[]): readonly (T | undefined)[] {
    const next = ids.map((id) => this.store.read(this.entity.definition, id) as T | undefined);
    const last = this.last;
    if (last.length === next.length && last.every((record, index) => record === next[index])) {
      return last;
    }
    this.last = next;
    return next;
  }
}

/**
 * The records of `ids`, in order (`undefined` for one not held), from the
 * tree's store.
 */
export function useEntities<T>(
  entity: Entity<T>,
  ids: readonly string[],
): readonly (T | undefined)[] {
  const store = useStore();
  const reader = useMemo(() => new EntitiesReader(store, entity), [store, entity]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = ids.map((id) =>
        store.listen(store.slot(entity.definition, id, true), listener),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
    [store, entity, ids],
  );
  const getSnapshot = () => reader.snapshot(ids);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
