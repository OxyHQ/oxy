import type { ExperimentalMutationOwner } from './experimentalOwnedMutationCache';

type Request = { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; data?: unknown };
type Lease = {
  owner: ExperimentalMutationOwner;
  isCurrent(): boolean;
  request(request: Request): Promise<unknown>;
};
type Definition = {
  accepts(payload: unknown): boolean;
  /** Explicitly owns the fields and strings permitted in durable storage. */
  codec?: { version: number; encode(payload: unknown): unknown; decode(payload: unknown): unknown };
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
  status: 'queued' | 'inflight' | 'ambiguous' | 'completed';
};
type Checkpoint = (owner: ExperimentalMutationOwner, isCurrent: () => boolean) => Promise<boolean>;

function matches(a: ExperimentalMutationOwner, b: ExperimentalMutationOwner): boolean {
  return a.actorId === b.actorId && a.accountId === b.accountId && a.sessionId === b.sessionId;
}

function accepts(definition: Definition, payload: unknown): boolean {
  try {
    return definition.accepts(payload);
  } catch {
    return false;
  }
}

/** Explicit registry prototype. Only registered operations using its lease-bound transport are covered. */
export class ExperimentalOwnedMutationRegistry {
  private readonly definitions = new Map<string, Definition>();
  private readonly entries = new Map<string, RecordEntry>();

  constructor(private readonly capture: () => Lease | null) {}

  register(kind: string, definition: Definition): void {
    if (!kind || this.definitions.has(kind)) throw new Error('Mutation kind already registered');
    if (
      definition.codec &&
      (!Number.isSafeInteger(definition.codec.version) || definition.codec.version < 1)
    )
      throw new Error('Invalid mutation codec');
    this.definitions.set(
      kind,
      Object.freeze({
        ...definition,
        ...(definition.codec ? { codec: Object.freeze({ ...definition.codec }) } : {}),
      }),
    );
  }

  enqueue(id: string, kind: string, payload: unknown): void {
    const definition = this.definitions.get(kind);
    const lease = this.capture();
    if (!id || this.entries.has(id) || !definition || !lease || !accepts(definition, payload))
      throw new Error('Cannot enqueue mutation');
    let copy: unknown;
    try {
      copy = JSON.parse(JSON.stringify(payload)) as unknown;
    } catch {
      throw new Error('Invalid mutation payload');
    }
    if (!lease.isCurrent() || !accepts(definition, copy) || !lease.isCurrent())
      throw new Error('Mutation owner changed');
    this.entries.set(id, { id, kind, owner: { ...lease.owner }, payload: copy, status: 'queued' });
  }

  async enqueueDurably(
    id: string,
    kind: string,
    payload: unknown,
    checkpoint: Checkpoint,
  ): Promise<void> {
    const lease = this.capture();
    if (!lease || !lease.isCurrent()) throw new Error('Mutation owner unavailable');
    this.enqueue(id, kind, payload);
    const entry = this.entries.get(id);
    if (
      !entry ||
      !matches(entry.owner, lease.owner) ||
      !lease.isCurrent() ||
      !(await checkpoint(entry.owner, lease.isCurrent)) ||
      !lease.isCurrent()
    )
      throw new Error('Mutation was not persisted');
  }

  async execute(id: string): Promise<void> {
    return this.executeInternal(id);
  }

  async executeDurably(id: string, checkpoint: Checkpoint): Promise<void> {
    return this.executeInternal(id, checkpoint);
  }

  private async executeInternal(id: string, checkpoint?: Checkpoint): Promise<void> {
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
      if (checkpoint && !(await checkpoint(entry.owner, lease.isCurrent)))
        throw new Error('Mutation was not persisted');
      if (!lease.isCurrent()) throw new Error('Mutation owner changed');
      const result = await definition.run(entry.payload, {
        idempotencyKey: entry.id,
        request: lease.request,
      });
      if (!lease.isCurrent()) throw new Error('Mutation owner changed');
      definition.commit?.(result);
      if (!lease.isCurrent()) throw new Error('Mutation owner changed');
      entry.status = 'completed';
      if (checkpoint && !(await checkpoint(entry.owner, lease.isCurrent)))
        throw new Error('Mutation completion was not persisted');
      if (!lease.isCurrent()) throw new Error('Mutation owner changed');
    } catch (error) {
      entry.status = 'ambiguous';
      this.entries.set(id, entry);
      if (checkpoint) {
        try {
          await checkpoint(entry.owner, lease.isCurrent);
        } catch {
          /* The durable inflight record remains ambiguous on restart. */
        }
      }
      throw error;
    }
  }

  serialize(owner: ExperimentalMutationOwner): string {
    const entries = [...this.entries.values()]
      .filter((entry) => matches(entry.owner, owner))
      .map((entry) => {
        const definition = this.definitions.get(entry.kind);
        const codec = definition?.codec;
        if (!definition || !codec) throw new Error('Mutation codec is required for persistence');
        let payload: unknown;
        try {
          payload = JSON.parse(JSON.stringify(codec.encode(entry.payload))) as unknown;
          if (!accepts(definition, codec.decode(payload))) throw new Error('invalid');
        } catch {
          throw new Error('Mutation codec failed');
        }
        return { ...entry, payload, codecVersion: codec.version };
      });
    return JSON.stringify({
      version: 2,
      owner,
      entries,
    });
  }

  /** Owner-specific blobs only; an old account-only blob is left untouched by the caller. */
  restore(raw: string, expectedOwner: ExperimentalMutationOwner): void {
    let blob: unknown;
    try {
      blob = JSON.parse(raw);
    } catch {
      throw new Error('Invalid mutation blob');
    }
    if (!blob || typeof blob !== 'object') throw new Error('Invalid mutation blob');
    const value = blob as {
      version?: unknown;
      owner?: ExperimentalMutationOwner;
      entries?: unknown;
    };
    if (
      value.version !== 2 ||
      !value.owner ||
      !matches(value.owner, expectedOwner) ||
      !Array.isArray(value.entries)
    )
      throw new Error('Invalid mutation blob');
    const incoming: RecordEntry[] = [];
    const ids = new Set<string>();
    for (const candidate of value.entries) {
      if (!candidate || typeof candidate !== 'object') throw new Error('Invalid mutation blob');
      const entry = candidate as RecordEntry & { codecVersion?: unknown };
      const definition = this.definitions.get(entry.kind);
      const codec = definition?.codec;
      if (
        typeof entry.id !== 'string' ||
        !entry.id ||
        ids.has(entry.id) ||
        this.entries.has(entry.id) ||
        !entry.owner ||
        !matches(entry.owner, expectedOwner) ||
        !definition ||
        !codec ||
        entry.codecVersion !== codec.version ||
        !['queued', 'inflight', 'ambiguous', 'completed'].includes(entry.status)
      )
        throw new Error('Invalid mutation blob');
      let payload: unknown;
      try {
        payload = codec.decode(entry.payload);
      } catch {
        throw new Error('Mutation codec failed');
      }
      if (!accepts(definition, payload)) throw new Error('Invalid mutation blob');
      ids.add(entry.id);
      incoming.push({
        id: entry.id,
        kind: entry.kind,
        owner: { ...expectedOwner },
        payload,
        status:
          entry.status === 'queued' || entry.status === 'completed' ? entry.status : 'ambiguous',
      });
    }
    for (const entry of incoming) this.entries.set(entry.id, entry);
  }
}
