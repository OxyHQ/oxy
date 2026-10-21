/**
 * The one place a postgres.js client is constructed: `createDatabase`'s pool,
 * the migrator's and the test harness's single connections, and any
 * application's own raw client all come through {@link openPostgresClient}.
 *
 * What it adds to `postgres(url, options)`, every one a default the caller's
 * `client` options override:
 *
 * - `statement_timeout` ({@link DEFAULT_POOL_STATEMENT_TIMEOUT_MS}, sent at
 *   connect), so the shared server cancels a runaway statement;
 * - a client-side query deadline (`socket.ts`): a connection whose server sends
 *   nothing for longer than any statement may run is destroyed, its queries
 *   reject with a `QueryDeadlineError`, and the pool replaces it, instead of
 *   the query hanging until the kernel abandons the socket (~15 min);
 * - TCP keepalive after {@link DEFAULT_KEEP_ALIVE_SECONDS} idle;
 * - `connect_timeout` of {@link DEFAULT_CONNECT_TIMEOUT_SECONDS}.
 *
 * ## The two limits move together
 *
 * The deadline cannot be shorter than the longest statement a connection runs
 * (the server is silent while one runs), and a client that gave up while the
 * server kept going would leave the statement running for nobody. So the
 * deadline is derived from the statement timeout: the larger of it and
 * {@link QUERY_DEADLINE_FLOOR_MS}, plus {@link QUERY_DEADLINE_GRACE_MS}. The
 * floor is there because a transaction may raise its own `statement_timeout`
 * with `SET LOCAL` above the pool's; one that raises it past the floor must
 * raise the pool's `statementTimeoutMs` (or `queryDeadlineMs`) to match.
 *
 * Long one-shot work (a backfill, an index build) raises `statementTimeoutMs`,
 * and the deadline follows. `statementTimeoutMs: 0` means no server limit and,
 * unless `queryDeadlineMs` is also given, no deadline either, since nothing
 * then bounds how long a live server may be silent.
 */

import postgres from 'postgres';
import { deadlineSocketFactory } from './socket';

/** The server-side `statement_timeout` every pool connection starts with: 5 minutes. */
export const DEFAULT_POOL_STATEMENT_TIMEOUT_MS = 300_000;

/** The shortest default deadline, whatever the statement timeout: 5 minutes. */
export const QUERY_DEADLINE_FLOOR_MS = 300_000;

/** How far the default deadline sits past the statement timeout (or the floor). */
export const QUERY_DEADLINE_GRACE_MS = 30_000;

/** Seconds of idleness before TCP keepalive probes a connection (postgres.js: 60). */
export const DEFAULT_KEEP_ALIVE_SECONDS = 30;

/** Seconds to establish a connection, TLS and authentication included (postgres.js: 30). */
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

/** The two limits {@link openPostgresClient} applies. Milliseconds; 0 = none. */
export interface QueryLimits {
  /**
   * Server-side `statement_timeout`, sent at connect. Default
   * {@link DEFAULT_POOL_STATEMENT_TIMEOUT_MS}; 0 sends none (the server's own
   * default applies).
   */
  readonly statementTimeoutMs?: number;
  /**
   * How long the server may send nothing after a request before the
   * connection is destroyed. Default: the larger of `statementTimeoutMs` and
   * {@link QUERY_DEADLINE_FLOOR_MS}, plus {@link QUERY_DEADLINE_GRACE_MS}; off
   * when `statementTimeoutMs` is 0. 0 turns it off. postgres.js only: Bun.SQL
   * has no socket hook, so a `bun-sql` handle gets the statement timeout alone.
   */
  readonly queryDeadlineMs?: number;
}

export interface OpenPostgresClientOptions extends QueryLimits {
  /** postgres.js options. Each one set here wins over this package's default. */
  readonly client?: postgres.Options<Record<string, never>>;
}

function assertDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `@oxy.so/db: ${name} must be a whole number of milliseconds >= 0, got ${value}.`,
    );
  }
}

/** The limits {@link openPostgresClient} applies for `limits`, defaults filled in. */
export function resolveQueryLimits(limits: QueryLimits = {}): Required<QueryLimits> {
  const statementTimeoutMs = limits.statementTimeoutMs ?? DEFAULT_POOL_STATEMENT_TIMEOUT_MS;
  assertDuration('statementTimeoutMs', statementTimeoutMs);
  const queryDeadlineMs =
    limits.queryDeadlineMs ??
    (statementTimeoutMs === 0
      ? 0
      : Math.max(statementTimeoutMs, QUERY_DEADLINE_FLOOR_MS) + QUERY_DEADLINE_GRACE_MS);
  assertDuration('queryDeadlineMs', queryDeadlineMs);
  return { statementTimeoutMs, queryDeadlineMs };
}

/**
 * Server runtime parameters carrying `statementTimeoutMs`, under any the caller
 * set itself (a caller's own `statement_timeout` wins).
 */
export function withStatementTimeout<T extends Readonly<Record<string, unknown>>>(
  statementTimeoutMs: number,
  connection: T | undefined,
): T | Record<string, unknown> | undefined {
  if (statementTimeoutMs === 0) return connection;
  return { statement_timeout: statementTimeoutMs, ...connection };
}

/** postgres.js's options, plus the `socket` hook its type declarations omit. */
type ClientSettings = postgres.Options<Record<string, never>> & {
  socket?: ReturnType<typeof deadlineSocketFactory>;
};

/**
 * Open a postgres.js client with this package's limits (see the module
 * header). Use it, not `postgres()` directly, for any connection to a shared
 * server.
 */
export function openPostgresClient(
  databaseUrl: string,
  options: OpenPostgresClientOptions = {},
): postgres.Sql {
  const { statementTimeoutMs, queryDeadlineMs } = resolveQueryLimits(options);
  const caller = options.client ?? {};
  const connection = withStatementTimeout(statementTimeoutMs, caller.connection);
  const settings: ClientSettings = {
    connect_timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
    keep_alive: DEFAULT_KEEP_ALIVE_SECONDS,
    ...caller,
    ...(connection ? { connection: connection as ClientSettings['connection'] } : {}),
    ...(queryDeadlineMs > 0 ? { socket: deadlineSocketFactory(queryDeadlineMs) } : {}),
  };
  return postgres(databaseUrl, settings);
}
