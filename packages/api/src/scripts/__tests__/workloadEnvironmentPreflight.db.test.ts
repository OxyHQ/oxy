import { main } from '../../../scripts/provision-workload-environments';

it('refuses the retired inventory backfill before opening any database connection', async () => {
  await expect(main()).rejects.toThrow('backfill is retired');
});
