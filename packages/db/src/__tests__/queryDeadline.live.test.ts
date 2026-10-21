/**
 * The client-side query deadline (`socket.ts`), against a real server: a
 * statement the server stays silent through rejects at the deadline instead of
 * waiting, and the connection it ran on is destroyed and replaced rather than
 * handed back to the pool. `pg_sleep` with no `statement_timeout` is, from the
 * socket's side, exactly a connection nothing will ever arrive on.
 *
 * Skipped without `OXYDB_TEST_ADMIN_URL`, like every live suite here.
 */

import { openPostgresClient } from '../client';
import { QUERY_DEADLINE_EXCEEDED } from '../socket';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;

describeLive('query deadline', () => {
  it('rejects a query the server does not answer in time and replaces its connection', async () => {
    const deadlineMs = 500;
    const client = openPostgresClient(ADMIN_URL as string, {
      client: { max: 1 },
      statementTimeoutMs: 0,
      queryDeadlineMs: deadlineMs,
    });
    try {
      const [before] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;

      const startedAt = Date.now();
      const error = await client`select pg_sleep(10)`.then(
        () => null,
        (caught: unknown) => caught,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(error).toMatchObject({ code: QUERY_DEADLINE_EXCEEDED });
      expect(elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
      expect(elapsedMs).toBeLessThan(10_000);

      const [after] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(after.pid).not.toBe(before.pid);
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 20_000);
});
