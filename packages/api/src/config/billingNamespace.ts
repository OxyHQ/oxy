/** Physical billing database boundary. Session GUCs never establish provisioning. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseOrTransaction } from './postgres';

export const billingNamespaceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live'), environment: z.literal('production') }).strict(),
  z.object({ mode: z.literal('test'), environment: z.enum(['test', 'staging', 'development']) }).strict(),
]);
export type BillingNamespace = z.infer<typeof billingNamespaceSchema>;

/** No key means the existing live deployment; a sandbox is always explicit. */
export function configuredBillingNamespace(): BillingNamespace {
  const key = process.env.STRIPE_SECRET_KEY;
  const mode = key ? key.match(/^(?:sk|rk)_(live|test)_/u)?.[1] : 'live';
  const environment = process.env.BILLING_PROCESSOR_ENVIRONMENT ?? (mode === 'live' ? 'production' : undefined);
  const namespace = billingNamespaceSchema.parse({ mode, environment });
  if (namespace.mode === 'test' && !['test', 'development'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('Sandbox billing requires an explicit test or development process');
  }
  return namespace;
}

export function assertPersistedBillingNamespace(declaration: string | null, namespace = configuredBillingNamespace()): void {
  const expected = namespace.mode === 'test' ? `test:${namespace.environment}` : null;
  if (declaration !== expected) throw new Error('Billing runtime and persisted database namespace differ');
}

/** setrole=0 is the database-wide ALTER DATABASE declaration, not role/PGOPTIONS state. */
export async function readPersistedBillingNamespace(db: DatabaseOrTransaction): Promise<string | null> {
  const rows = await db.execute<{ declaration: string }>(sql`
    select setting as declaration
    from pg_db_role_setting s
    join pg_database d on d.oid = s.setdatabase
    cross join lateral unnest(s.setconfig) setting
    where d.datname = current_database() and s.setrole = 0
      and split_part(setting, '=', 1) = 'oxy.billing_namespace'
  `);
  if (rows.length > 1) throw new Error('Billing database namespace is ambiguous');
  return rows[0]?.declaration.slice('oxy.billing_namespace='.length) ?? null;
}

export async function assertBillingDatabaseNamespace(db: DatabaseOrTransaction, binding?: BillingNamespace): Promise<BillingNamespace> {
  const namespace = configuredBillingNamespace();
  assertPersistedBillingNamespace(await readPersistedBillingNamespace(db), namespace);
  if (binding && (namespace.mode !== binding.mode || namespace.environment !== binding.environment)) {
    throw new Error('Billing evidence and database namespace differ');
  }
  return namespace;
}
