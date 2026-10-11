import { eq, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';

export const MERCARIA_BILLING_BASE_SCOPES = [
  'user:read',
  'catalogs:write',
  'capabilities:read',
  'capability-audit:write',
] as const;
export const MERCARIA_BILLING_SCOPES = [
  ...MERCARIA_BILLING_BASE_SCOPES,
  'payments:read',
  'payments:write',
];
export type BillingAuthorityTarget = {
  applicationId: string;
  credentialId: string;
  ownerAccountId: string;
};
export type BillingAuthorityActor = {
  isPlatformStaff: boolean;
  describedAs: string;
};
type RowState = { scopes: string[]; version: string; updatedAt: string };
export type BillingAuthorityState = {
  application: RowState;
  credential: RowState;
};
export type BillingAuthorityPlan = {
  kind: 'mercaria-billing-authority-v1';
  target: BillingAuthorityTarget;
  before: BillingAuthorityState;
};
export type BillingAuthorityReceipt = BillingAuthorityPlan & {
  operation: 'apply' | 'rollback';
  actor: string;
  after: BillingAuthorityState;
};

function refuse(): never {
  throw new Error('billing_authority_precondition_failed');
}
function staff(actor: BillingAuthorityActor) {
  // Trusted operator seam, never HTTP/body authorization. The invocation's
  // independently authenticated operator identity must be retained in its receipt.
  if (!actor.isPlatformStaff || !actor.describedAs.trim()) refuse();
}
function sameScopes(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));
}
function sameState(a: BillingAuthorityState, b: BillingAuthorityState) {
  return (['application', 'credential'] as const).every(
    (key) =>
      a[key].version === b[key].version &&
      a[key].updatedAt === b[key].updatedAt &&
      JSON.stringify(a[key].scopes) === JSON.stringify(b[key].scopes),
  );
}
async function readLocked(
  tx: Transaction,
  target: BillingAuthorityTarget,
): Promise<BillingAuthorityState> {
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`set local statement_timeout = '10s'`);
  const [owner] = await tx
    .select({ status: users.accountStatus })
    .from(users)
    .where(eq(users.id, target.ownerAccountId))
    .for('share');
  const [fence] = await tx
    .select({ id: accountClosureFences.accountId })
    .from(accountClosureFences)
    .where(eq(accountClosureFences.accountId, target.ownerAccountId));
  if (!owner || owner.status !== 'active' || fence) refuse();
  const [app] = await tx
    .select({
      owner: applications.ownerAccountId,
      status: applications.status,
      type: applications.type,
      scopes: applications.scopes,
      version: sql<string>`xmin::text`,
      updatedAt: sql<string>`updated_at::text`,
    })
    .from(applications)
    .where(eq(applications.id, target.applicationId))
    .for('update');
  const [cred] = await tx
    .select({
      app: applicationCredentials.applicationId,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
      scopes: applicationCredentials.scopes,
      version: sql<string>`xmin::text`,
      updatedAt: sql<string>`updated_at::text`,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, target.credentialId))
    .for('update');
  if (
    !app ||
    app.owner !== target.ownerAccountId ||
    app.status !== 'active' ||
    app.type !== 'first_party' ||
    !cred ||
    cred.app !== target.applicationId ||
    cred.type !== 'service' ||
    cred.environment !== 'production' ||
    cred.status !== 'active' ||
    cred.expiresAt !== null
  )
    refuse();
  return {
    application: {
      scopes: app.scopes,
      version: app.version,
      updatedAt: app.updatedAt,
    },
    credential: {
      scopes: cred.scopes,
      version: cred.version,
      updatedAt: cred.updatedAt,
    },
  };
}
export async function prepareMercariaBillingAuthority(
  target: BillingAuthorityTarget,
  actor: BillingAuthorityActor,
): Promise<BillingAuthorityPlan> {
  staff(actor);
  return getDb().transaction(async (tx) => {
    const before = await readLocked(tx, target);
    if (
      !sameScopes(before.application.scopes, MERCARIA_BILLING_BASE_SCOPES) ||
      !sameScopes(before.credential.scopes, MERCARIA_BILLING_BASE_SCOPES)
    )
      refuse();
    return { kind: 'mercaria-billing-authority-v1', target, before };
  });
}
export async function applyMercariaBillingAuthority(
  plan: BillingAuthorityPlan,
  actor: BillingAuthorityActor,
): Promise<BillingAuthorityReceipt> {
  return change(plan, actor, 'apply');
}
export async function rollbackMercariaBillingAuthority(
  receipt: BillingAuthorityReceipt,
  actor: BillingAuthorityActor,
): Promise<BillingAuthorityReceipt> {
  if (receipt.operation !== 'apply') refuse();
  return change(receipt, actor, 'rollback');
}
async function change(
  plan: BillingAuthorityPlan | BillingAuthorityReceipt,
  actor: BillingAuthorityActor,
  operation: 'apply' | 'rollback',
): Promise<BillingAuthorityReceipt> {
  staff(actor);
  if (
    plan.kind !== 'mercaria-billing-authority-v1' ||
    !sameScopes(plan.before.application.scopes, MERCARIA_BILLING_BASE_SCOPES) ||
    !sameScopes(plan.before.credential.scopes, MERCARIA_BILLING_BASE_SCOPES)
  )
    refuse();
  const expected = operation === 'apply' ? plan.before : (plan as BillingAuthorityReceipt).after;
  return getDb().transaction(async (tx) => {
    const current = await readLocked(tx, plan.target);
    if (
      !sameState(current, expected) ||
      (operation === 'rollback' &&
        (!sameScopes(current.application.scopes, MERCARIA_BILLING_SCOPES) ||
          !sameScopes(current.credential.scopes, MERCARIA_BILLING_SCOPES)))
    )
      refuse();
    const appScopes =
      operation === 'apply' ? MERCARIA_BILLING_SCOPES : plan.before.application.scopes;
    const credScopes =
      operation === 'apply' ? MERCARIA_BILLING_SCOPES : plan.before.credential.scopes;
    await tx
      .update(applications)
      .set({ scopes: [...appScopes], updatedAt: sql`clock_timestamp()` })
      .where(eq(applications.id, plan.target.applicationId));
    await tx
      .update(applicationCredentials)
      .set({ scopes: [...credScopes], updatedAt: sql`clock_timestamp()` })
      .where(eq(applicationCredentials.id, plan.target.credentialId));
    return {
      ...plan,
      operation,
      actor: actor.describedAs,
      after: await readLocked(tx, plan.target),
    };
  });
}
