/**
 * `oxy.appData` — a small per-user JSON key/value store (`/users/me/app-data`).
 *
 * For cross-device app state: course progress, "last viewed" markers,
 * dismissed banners. Not for blobs or anything that needs querying.
 *
 * - `namespace` and `key` must match `[a-z0-9_-]{1,64}` (checked here first).
 * - Values are capped at 64 KB; writes at 100/minute/user (server-enforced).
 */
import type { OxyContext } from '../client/context';

const IDENTIFIER = /^[a-z0-9_-]{1,64}$/u;

/** Thrown when a namespace or key is not `[a-z0-9_-]{1,64}`. */
export class OxyAppDataIdentifierError extends Error {
  constructor(field: 'namespace' | 'key', value: string) {
    super(
      `Invalid app-data ${field} "${value}": must match [a-z0-9_-]{1,64} (lowercase letters, digits, dashes, underscores).`,
    );
    this.name = 'OxyAppDataIdentifierError';
  }
}

function check(field: 'namespace' | 'key', value: string): string {
  if (!IDENTIFIER.test(value)) throw new OxyAppDataIdentifierError(field, value);
  return encodeURIComponent(value);
}

export class AppDataApi {
  constructor(protected readonly ctx: OxyContext) {}

  /** The value under `(namespace, key)`, or `null` when nothing is stored. */
  async get<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const res = await this.ctx.request<{ value: T | null }>('GET', this.path(namespace, key), undefined, { cache: false });
    return res?.value ?? null;
  }

  /** Store `value` under `(namespace, key)`; returns what the server stored. */
  async set<T = unknown>(namespace: string, key: string, value: T): Promise<T> {
    const res = await this.ctx.request<{ value: T | null }>('PUT', this.path(namespace, key), { value }, { cache: false });
    return (res?.value ?? value) as T;
  }

  /** Delete `(namespace, key)`. Idempotent. */
  async delete(namespace: string, key: string): Promise<void> {
    await this.ctx.request('DELETE', this.path(namespace, key), undefined, { cache: false });
  }

  /** Every entry in `namespace` (an empty object when there are none). */
  async list<T = unknown>(namespace: string): Promise<Record<string, T>> {
    const res = await this.ctx.request<{ entries: Record<string, T> }>(
      'GET',
      `/users/me/app-data/${check('namespace', namespace)}`,
      undefined,
      { cache: false },
    );
    return res?.entries ?? {};
  }

  private path(namespace: string, key: string): string {
    return `/users/me/app-data/${check('namespace', namespace)}/${check('key', key)}`;
  }
}
