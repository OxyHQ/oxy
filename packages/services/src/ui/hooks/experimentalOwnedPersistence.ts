import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { accountQueryOwnership, type AccountQueriesConfig } from './accountQueryPersistence';
import {
  experimentalOwnerStorageKey,
  type ExperimentalMutationOwner,
} from './experimentalOwnedMutationCache';
import type { ExperimentalOwnedMutationRegistry } from './experimentalOwnedMutationRegistry';
import { ExperimentalQuarantinedMutationCache } from './experimentalQuarantinedMutationCache';

interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Each codec owns its root and the fields it permits, including strings and keys. */
export interface ExperimentalQueryCodec {
  root: string;
  version: number;
  encode(query: Query): unknown;
  decode(payload: unknown): { queryKey: QueryKey; data: unknown } | null;
}

function sameOwner(a: ExperimentalMutationOwner, b: ExperimentalMutationOwner): boolean {
  return a.actorId === b.actorId && a.accountId === b.accountId && a.sessionId === b.sessionId;
}

/**
 * Experimental owner-partitioned preparation for a dedicated strict client.
 * It does not migrate old account-only blobs or coordinate multiple instances
 * of the same storage backend.
 */
export function createExperimentalOwnedPersistence(options: {
  client: QueryClient;
  storage: Storage;
  registry: ExperimentalOwnedMutationRegistry;
  accountQueries?: AccountQueriesConfig;
  codecs?: readonly ExperimentalQueryCodec[];
}) {
  const { client, storage, registry } = options;
  const ownership = accountQueryOwnership(options.accountQueries);
  const codecs = new Map<string, ExperimentalQueryCodec>();
  for (const codec of options.codecs ?? []) {
    if (
      !codec.root ||
      !Number.isSafeInteger(codec.version) ||
      codec.version < 1 ||
      codecs.has(codec.root)
    )
      throw new Error('Invalid or duplicate query codec');
    codecs.set(codec.root, Object.freeze({ ...codec }));
  }
  const restoredRegistries = new Set<string>();
  const observedBlobs = new Map<string, string | null>();
  let activeOwner: ExperimentalMutationOwner | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function writeOwner(owner: ExperimentalMutationOwner): Promise<boolean> {
    if (!activeOwner || !sameOwner(activeOwner, owner)) return false;
    const queries: Array<{ root: string; version: number; payload: unknown }> = [];
    for (const query of client.getQueryCache().getAll()) {
      if (query.state.status !== 'success' || !ownership.persistsQuery(query)) continue;
      const root = query.queryKey[0];
      const codec = typeof root === 'string' ? codecs.get(root) : undefined;
      if (!codec) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(JSON.stringify(codec.encode(query))) as unknown;
        const decoded = codec.decode(payload);
        if (!decoded || decoded.queryKey[0] !== codec.root) throw new Error('invalid');
      } catch {
        throw new Error('Query codec failed');
      }
      queries.push({ root: codec.root, version: codec.version, payload });
    }
    const body = JSON.stringify({
      version: 2,
      owner,
      queries,
      registry: registry.serialize(owner),
    });
    const key = experimentalOwnerStorageKey(owner);
    const existing = await storage.getItem(key);
    if (!observedBlobs.has(key) || observedBlobs.get(key) !== existing)
      throw new Error('Owner snapshot changed externally');
    if (existing !== null) {
      let previous: unknown;
      try {
        previous = JSON.parse(existing);
      } catch {
        throw new Error('Invalid owner snapshot');
      }
      if (
        !previous ||
        typeof previous !== 'object' ||
        !('version' in previous) ||
        previous.version !== 2
      )
        throw new Error('Existing owner snapshot requires migration');
    }
    await storage.setItem(key, body);
    if ((await storage.getItem(key)) !== body) return false;
    observedBlobs.set(key, body);
    return true;
  }

  async function prepare(
    owner: ExperimentalMutationOwner,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!(client.getMutationCache() instanceof ExperimentalQuarantinedMutationCache))
      throw new Error('Strict mutation quarantine is required');
    if (!isCurrent()) throw new Error('Context binding unavailable');
    if (activeOwner && sameOwner(activeOwner, owner)) return;

    if (activeOwner) {
      if (!(await writeOwner(activeOwner))) throw new Error('Owner snapshot was not persisted');
      if (!isCurrent()) throw new Error('Context binding unavailable');
    }

    activeOwner = null;
    client.removeQueries({ predicate: ownership.ownsQuery });
    if (!isCurrent()) throw new Error('Context binding unavailable');
    const key = experimentalOwnerStorageKey(owner);
    const raw = await storage.getItem(key);
    if (!isCurrent()) throw new Error('Context binding unavailable');
    if (raw !== null) {
      let blob: unknown;
      try {
        blob = JSON.parse(raw);
      } catch {
        throw new Error('Invalid owner snapshot');
      }
      if (!blob || typeof blob !== 'object') throw new Error('Invalid owner snapshot');
      const value = blob as {
        version?: unknown;
        owner?: ExperimentalMutationOwner;
        queries?: unknown;
        registry?: unknown;
      };
      if (
        value.version !== 2 ||
        !value.owner ||
        !sameOwner(value.owner, owner) ||
        !Array.isArray(value.queries) ||
        typeof value.registry !== 'string'
      )
        throw new Error('Invalid owner snapshot');
      const decoded: Array<{ queryKey: QueryKey; data: unknown }> = [];
      for (const record of value.queries) {
        if (!record || typeof record !== 'object') throw new Error('Invalid query snapshot');
        const item = record as { root?: unknown; version?: unknown; payload?: unknown };
        const codec = typeof item.root === 'string' ? codecs.get(item.root) : undefined;
        if (!codec || item.version !== codec.version) throw new Error('Unknown query codec');
        let query: { queryKey: QueryKey; data: unknown } | null;
        try {
          query = codec.decode(item.payload);
          if (
            !query ||
            query.queryKey[0] !== codec.root ||
            !ownership.persistsQuery({ queryKey: query.queryKey })
          )
            throw new Error('invalid');
        } catch {
          throw new Error('Query codec failed');
        }
        decoded.push(query);
      }
      if (!restoredRegistries.has(key)) {
        registry.restore(value.registry, owner);
        restoredRegistries.add(key);
      }
      for (const query of decoded) {
        client.setQueryData(query.queryKey, query.data);
        if (!isCurrent()) throw new Error('Context binding unavailable');
      }
      if (!isCurrent()) throw new Error('Context binding unavailable');
    } else {
      restoredRegistries.add(key);
    }
    observedBlobs.set(key, raw);
    activeOwner = { ...owner };
  }

  return {
    /** A successful read-back proves the snapshot landed for this local queue. */
    checkpoint(owner: ExperimentalMutationOwner): Promise<boolean> {
      const result = tail.then(() => writeOwner(owner)).catch(() => false);
      tail = result.then(() => undefined);
      return result;
    },
    /** Queue local transitions; callers must still fence lifecycle outside this instance. */
    prepareCommit(
      _previous: ExperimentalMutationOwner | null,
      next: ExperimentalMutationOwner,
      isCurrent: () => boolean,
    ): Promise<void> {
      const result = tail.then(() => prepare(next, isCurrent));
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
