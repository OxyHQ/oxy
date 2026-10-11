import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  assertBillingDatabaseNamespace,
  configuredBillingNamespace,
  readPersistedBillingNamespace,
} from '../billingNamespace';
import { connectPostgres, closePostgres, getDb } from '../postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { users, userCredits } from '../../db/schema';
import { addCredits } from '../../db/credits';
import { getBillingStripe } from '../../utils/billingStripe';
import { productProviderBindingSchema } from '../../services/productAccessPersistence.service';

let providerAccess = 0;
jest.mock('../../utils/stripeClient', () => ({
  getStripe: () => {
    providerAccess += 1;
    return {};
  },
}));
const previous = {
  url: process.env.DATABASE_URL,
  key: process.env.STRIPE_SECRET_KEY,
  environment: process.env.BILLING_PROCESSOR_ENVIRONMENT,
  node: process.env.NODE_ENV,
};
let sandboxUrl: string;
function live() {
  if (!previous.url) throw new Error('worker database absent');
  process.env.DATABASE_URL = previous.url;
  Reflect.deleteProperty(process.env, 'STRIPE_SECRET_KEY');
  Reflect.deleteProperty(process.env, 'BILLING_PROCESSOR_ENVIRONMENT');
  process.env.NODE_ENV = 'test';
}
function sandbox(url = sandboxUrl) {
  process.env.DATABASE_URL = url;
  process.env.STRIPE_SECRET_KEY = 'sk_test_SYNTHETIC_NO_NETWORK';
  process.env.BILLING_PROCESSOR_ENVIRONMENT = 'test';
  process.env.NODE_ENV = 'test';
}
beforeAll(async () => {
  live();
  sandboxUrl = await createTestDatabase({ assignEnv: false, billingSandboxNamespace: 'test:test' });
});
afterEach(async () => {
  await closePostgres();
  live();
});
afterAll(async () => {
  await closePostgres();
  try {
    await dropTestDatabase(sandboxUrl);
  } finally {
    for (const [key, value] of Object.entries({
      DATABASE_URL: previous.url,
      STRIPE_SECRET_KEY: previous.key,
      BILLING_PROCESSOR_ENVIRONMENT: previous.environment,
      NODE_ENV: previous.node,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});
it('a test key needs explicit environment and a test/development process', () => {
  sandbox();
  Reflect.deleteProperty(process.env, 'BILLING_PROCESSOR_ENVIRONMENT');
  expect(() => configuredBillingNamespace()).toThrow();
  sandbox();
  process.env.NODE_ENV = 'production';
  expect(() => configuredBillingNamespace()).toThrow('explicit test or development');
});
it('test runtime cannot connect to an unmarked normal database', async () => {
  sandbox(previous.url);
  await expect(connectPostgres()).rejects.toThrow('persisted database namespace differ');
});
it('connection startup options cannot provision an unmarked normal database', async () => {
  if (!previous.url) throw new Error('worker database absent');
  const disguised = new URL(previous.url);
  disguised.searchParams.set('options', '-c oxy.billing_namespace=test:test');
  sandbox(disguised.toString());
  await expect(connectPostgres()).rejects.toThrow('persisted database namespace differ');
});
it('live runtime cannot connect to a declared sandbox database', async () => {
  live();
  process.env.DATABASE_URL = sandboxUrl;
  await expect(connectPostgres()).rejects.toThrow('persisted database namespace differ');
});
it('a session GUC cannot turn the normal database into a sandbox or hide its declaration', async () => {
  await connectPostgres();
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local oxy.billing_namespace = 'test:test'`);
    expect(await readPersistedBillingNamespace(tx)).toBeNull();
    sandbox(previous.url);
    await expect(assertBillingDatabaseNamespace(tx)).rejects.toThrow(
      'persisted database namespace differ',
    );
  });
});
it('an environment switch fails before Stripe access or a balance write/read', async () => {
  await connectPostgres();
  const db = getDb();
  const [account] = await db
    .insert(users)
    .values({ username: `namespace-${randomUUID()}` })
    .returning();
  await db.insert(userCredits).values({ userId: account.id, creditsPaid: 7 });
  const before = providerAccess;
  sandbox(previous.url);
  await expect(getBillingStripe()).rejects.toThrow('persisted database namespace differ');
  await expect(addCredits(db, account.id, 10, 'paid')).rejects.toThrow(
    'persisted database namespace differ',
  );
  expect(() => getDb()).toThrow('persisted database namespace differ');
  expect(providerAccess).toBe(before);
  live();
  expect(
    (await db.select().from(userCredits).where(eq(userCredits.userId, account.id)))[0].creditsPaid,
  ).toBe(7);
});
it('sandbox balances are physically separate even for the same account id, and live switching is refused', async () => {
  await connectPostgres();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `normal-${randomUUID()}` })
    .returning();
  await getDb().insert(userCredits).values({ userId: account.id, creditsPaid: 7 });
  await closePostgres();
  sandbox();
  await connectPostgres();
  expect(await readPersistedBillingNamespace(getDb())).toBe('test:test');
  await getDb()
    .insert(users)
    .values({ id: account.id, username: `sandbox-${randomUUID()}` });
  await getDb().insert(userCredits).values({ userId: account.id, creditsPaid: 0 });
  expect(await addCredits(getDb(), account.id, 40, 'paid')).toBe(true);
  expect(
    (await getDb().select().from(userCredits).where(eq(userCredits.userId, account.id)))[0]
      .creditsPaid,
  ).toBe(40);
  await getBillingStripe();
  Reflect.deleteProperty(process.env, 'STRIPE_SECRET_KEY');
  process.env.BILLING_PROCESSOR_ENVIRONMENT = 'production';
  expect(() => getDb()).toThrow('persisted database namespace differ');
  await closePostgres();
  live();
  await connectPostgres();
  expect(
    (await getDb().select().from(userCredits).where(eq(userCredits.userId, account.id)))[0]
      .creditsPaid,
  ).toBe(7);
});
it('a declared sandbox cannot accept live product evidence or a different sandbox environment', async () => {
  sandbox();
  await connectPostgres();
  await expect(
    assertBillingDatabaseNamespace(getDb(), { mode: 'live', environment: 'production' }),
  ).rejects.toThrow('evidence and database namespace differ');
  await expect(
    assertBillingDatabaseNamespace(getDb(), { mode: 'test', environment: 'staging' }),
  ).rejects.toThrow('evidence and database namespace differ');
});
it('provider binding admits only live-production and explicit test namespaces', () => {
  expect(
    productProviderBindingSchema.parse({
      providerAccountRef: 'acct_fixture',
      mode: 'test',
      environment: 'staging',
    }).mode,
  ).toBe('test');
  expect(() =>
    productProviderBindingSchema.parse({
      providerAccountRef: 'acct_fixture',
      mode: 'test',
      environment: 'production',
    }),
  ).toThrow();
  expect(() =>
    productProviderBindingSchema.parse({
      providerAccountRef: 'acct_fixture',
      mode: 'live',
      environment: 'staging',
    }),
  ).toThrow();
});
