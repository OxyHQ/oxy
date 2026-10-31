import type { ExperimentalMutationOwner } from './experimentalOwnedMutationCache';

type Request = { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; data?: unknown };
type Lease = {
  owner: ExperimentalMutationOwner;
  isCurrent(): boolean;
  request(request: Request): Promise<unknown>;
};
type Definition = {
  accepts(payload: unknown): boolean;
  run(
    payload: unknown,
    context: { idempotencyKey: string; request: Lease['request'] },
  ): Promise<unknown>;
  commit?(result: unknown): void;
};
type RecordEntry = {
  id: string;
  kind: string;
  owner: ExperimentalMutationOwner;
  payload: unknown;
  status: 'queued' | 'inflight' | 'ambiguous';
};

function matches(a: ExperimentalMutationOwner, b: ExperimentalMutationOwner): boolean {
  return a.actorId === b.actorId && a.accountId === b.accountId && a.sessionId === b.sessionId;
}

/** Explicit registry prototype. Only registered operations using its lease-bound transport are covered. */
export class ExperimentalOwnedMutationRegistry {
  private readonly definitions = new Map<string, Definition>();
  private readonly entries = new Map<string, RecordEntry>();

  constructor(private readonly capture: () => Lease | null) {}

  register(kind: string, definition: Definition): void {
    if (!kind || this.definitions.has(kind)) throw new Error('Mutation kind already registered');
    this.definitions.set(kind, Object.freeze({ ...definition }));
  }

  enqueue(id: string, kind: string, payload: unknown): void {
    const definition = this.definitions.get(kind);
    const lease = this.capture();
    if (!id || this.entries.has(id) || !definition || !lease || !definition.accepts(payload))
      throw new Error('Cannot enqueue mutation');
    const copy = JSON.parse(JSON.stringify(payload)) as unknown;
    if (!lease.isCurrent() || !definition.accepts(copy) || !lease.isCurrent())
      throw new Error('Mutation owner changed');
    this.entries.set(id, { id, kind, owner: { ...lease.owner }, payload: copy, status: 'queued' });
  }

  async execute(id: string): Promise<void> {
    const entry = this.entries.get(id);
    const definition = entry && this.definitions.get(entry.kind);
    const lease = this.capture();
    if (
      !entry ||
      entry.status !== 'queued' ||
      !definition ||
      !lease ||
      !matches(entry.owner, lease.owner) ||
      !lease.isCurrent()
    )
      throw new Error('Mutation owner unavailable');
    entry.status = 'inflight';
    try {
      const result = await definition.run(entry.payload, {
        idempotencyKey: entry.id,
        request: lease.request,
      });
      if (!lease.isCurrent()) throw new Error('Mutation owner changed');
      definition.commit?.(result);
      if (!lease.isCurrent()) throw new Error('Mutation owner changed');
      this.entries.delete(id);
    } catch (error) {
      entry.status = 'ambiguous';
      throw error;
    }
  }

  serialize(owner: ExperimentalMutationOwner): string {
    return JSON.stringify({
      version: 1,
      owner,
      entries: [...this.entries.values()].filter((entry) => matches(entry.owner, owner)),
    });
  }

  /** Owner-specific blobs only; an old account-only blob is left untouched by the caller. */
  restore(raw: string, expectedOwner: ExperimentalMutationOwner): void {
    const blob: unknown = JSON.parse(raw);
    if (!blob || typeof blob !== 'object') throw new Error('Invalid mutation blob');
    const value = blob as {
      version?: unknown;
      owner?: ExperimentalMutationOwner;
      entries?: unknown;
    };
    if (
      value.version !== 1 ||
      !value.owner ||
      !matches(value.owner, expectedOwner) ||
      !Array.isArray(value.entries)
    )
      throw new Error('Invalid mutation blob');
    const incoming: RecordEntry[] = [];
    const ids = new Set<string>();
    for (const candidate of value.entries) {
      if (!candidate || typeof candidate !== 'object') throw new Error('Invalid mutation blob');
      const entry = candidate as RecordEntry;
      const definition = this.definitions.get(entry.kind);
      if (
        typeof entry.id !== 'string' ||
        !entry.id ||
        ids.has(entry.id) ||
        this.entries.has(entry.id) ||
        !entry.owner ||
        !matches(entry.owner, expectedOwner) ||
        !definition ||
        !definition.accepts(entry.payload) ||
        !['queued', 'inflight', 'ambiguous'].includes(entry.status)
      )
        throw new Error('Invalid mutation blob');
      ids.add(entry.id);
      incoming.push({
        ...entry,
        owner: { ...expectedOwner },
        status: entry.status === 'queued' ? 'queued' : 'ambiguous',
      });
    }
    for (const entry of incoming) this.entries.set(entry.id, entry);
  }
}
