import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountAcquisition } from '../../db/schema/accountAcquisition';
import { users } from '../../db/schema/users';
import {
  reportAccountAcquisition,
  validateAcquisitionReportRange,
} from '../accountAcquisitionReport.service';
import { canonicalUsername, createPersonalAccount } from '../accountCreation.service';

beforeAll(connectPostgres);
afterAll(closePostgres);

it.each([
  ['2026-02-30', '2026-03-03'],
  ['2026-02-01', '2026-02-01'],
  ['2026-03-01', '2026-02-01'],
  ['2024-01-01', '2026-01-01'],
  ['2026-01-01T00:00:00Z', '2026-02-01'],
])('rejects invalid or unbounded reporting interval %s to %s', (from, to) => {
  expect(() => validateAcquisitionReportRange(from, to)).toThrow();
});

it('groups signups without account/click IDs, excludes end day and erases acquisition on deletion', async () => {
  const source = `test-${randomUUID()}`;
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const account = await getDb().transaction((tx) =>
      createPersonalAccount(
        tx,
        canonicalUsername(`u${randomUUID().replaceAll('-', '').slice(0, 12)}`, 'personal'),
        { email: `${randomUUID()}@example.com` },
        {
          campaignAttribution: {
            utmSource: source,
            utmCampaign: 'launch',
            fbclid: 'private-click',
          },
        },
      ),
    );
    ids.push(account.id);
    await getDb()
      .update(accountAcquisition)
      .set({ createdAt: new Date(index === 2 ? '2026-02-02T00:00:00Z' : '2026-02-01T23:59:00Z') })
      .where(eq(accountAcquisition.userId, account.id));
  }
  const result = (await reportAccountAcquisition('2026-02-01', '2026-02-02')).filter(
    (row) => row.source === source,
  );
  expect(result).toEqual([
    { day: '2026-02-01', source, medium: null, campaign: 'launch', signups: 2 },
  ]);
  for (const id of ids) await getDb().delete(users).where(eq(users.id, id));
  expect(
    (await reportAccountAcquisition('2026-02-01', '2026-02-03')).filter(
      (row) => row.source === source,
    ),
  ).toEqual([]);
});
