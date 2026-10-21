/**
 * The reclassification one-shot against a REAL Postgres: an actor fetch that
 * never settles is refused at the row deadline instead of holding its batch.
 */

import { randomUUID } from 'node:crypto';

const mockFetchActorProfileResult = jest.fn();
jest.mock('../../services/federation.service', () => ({
  federationService: {
    fetchActorProfileResult: (...args: unknown[]) => mockFetchActorProfileResult(...args),
    registerFetchedActorProfile: jest.fn(),
  },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { reclassifyFederatedAccounts } from '../reclassify-federated-accounts';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it('refuses a row whose actor fetch never settles and finishes the batch', async () => {
  const tag = randomUUID().slice(0, 8);
  const stalledUri = `https://stalled.example/users/${tag}`;
  const [stalled] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      username: `stalled${tag}`,
      type: 'federated',
      federationActorUri: stalledUri,
    })
    .returning({ id: users.id });
  mockFetchActorProfileResult.mockImplementation((uri: string) =>
    uri === stalledUri
      ? new Promise(() => undefined)
      : Promise.resolve({ ok: false, failure: { reason: 'http_status' } }),
  );

  const lines: string[] = [];
  const result = await reclassifyFederatedAccounts({
    concurrency: 2,
    rowFetchDeadlineMs: 50,
    log: (line) => lines.push(line),
  });

  expect(lines).toContain(
    JSON.stringify({ userId: stalled.id, action: 'refused', reason: 'fetch_timeout' }),
  );
  expect(lines.at(-1)).toContain('"progress"');
  expect(result.scanned).toBeGreaterThanOrEqual(1);
});
