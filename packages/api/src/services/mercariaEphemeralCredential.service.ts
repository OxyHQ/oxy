import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { type Transaction, getDb } from '../config/postgres';
import { accountClosureFences } from '../db/schema/accountClosureFences';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import type { CredentialVerifier } from '../utils/credentialMaterial';
import { isCredentialUsable } from '../utils/credentialUsability';
import {
  type BillingAuthorityActor,
  MERCARIA_BILLING_SCOPES,
} from './mercariaBillingAuthority.service';

export type EphemeralTarget = { applicationId: string; ownerAccountId: string };
type AppState = { version: string; updatedAt: string; scopes: string[] };
export type EphemeralPlan = {
  kind: 'mercaria-ephemeral-service-v1';
  target: EphemeralTarget;
  credentialId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  before: AppState;
};
export type EphemeralVerifier = CredentialVerifier;
export type EphemeralState = {
  version: string;
  updatedAt: string;
  status: string;
};
export const EPHEMERAL_PAYMENT_SCOPES = ['payments:read', 'payments:write'] as const;
const PREFIX = 'i08-sandbox-';
const MAX_LIFETIME_MS = 3600_000;
function refuse(): never {
  throw new Error('ephemeral_credential_precondition_failed');
}
function operator(actor: BillingAuthorityActor) {
  if (!actor.isPlatformStaff || !actor.describedAs.trim()) refuse();
}
function validPlan(plan: EphemeralPlan, issuing: boolean) {
  const issuedAt = Date.parse(plan.issuedAt);
  const expiresAt = Date.parse(plan.expiresAt);
  if (
    plan.kind !== 'mercaria-ephemeral-service-v1' ||
    !/^[a-f0-9]{24}$/.test(plan.nonce) ||
    !/^[a-f0-9-]{36}$/.test(plan.credentialId) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_LIFETIME_MS ||
    issuedAt > Date.now() ||
    (issuing && expiresAt <= Date.now())
  )
    refuse();
}
function validMaterial(material: EphemeralVerifier) {
  if (
    !/^oxy_dk_[a-f0-9]{48}$/.test(material.publicKey) ||
    !/^[a-f0-9]{64}$/.test(material.secretHash)
  )
    refuse();
}

async function lockedApp(
  tx: Transaction,
  target: EphemeralTarget,
  issuing: boolean,
): Promise<AppState> {
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
  if (!owner || !app || app.owner !== target.ownerAccountId || app.type !== 'first_party') refuse();
  if (
    issuing &&
    (owner.status !== 'active' ||
      fence ||
      app.status !== 'active' ||
      app.scopes.length !== MERCARIA_BILLING_SCOPES.length ||
      !MERCARIA_BILLING_SCOPES.every((scope) => app.scopes.includes(scope)))
  )
    refuse();
  return { version: app.version, updatedAt: app.updatedAt, scopes: app.scopes };
}
async function noActiveDevelopmentCredential(tx: Transaction, applicationId: string) {
  const rows = await tx
    .select({
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
    })
    .from(applicationCredentials)
    .where(
      and(
        eq(applicationCredentials.applicationId, applicationId),
        eq(applicationCredentials.environment, 'development'),
        eq(applicationCredentials.type, 'service'),
      ),
    );
  if (rows.some(isCredentialUsable)) refuse();
}
export async function prepareEphemeralCredential(
  target: EphemeralTarget,
  actor: BillingAuthorityActor,
): Promise<EphemeralPlan> {
  operator(actor);
  return getDb().transaction(async (tx) => {
    const before = await lockedApp(tx, target, true);
    await noActiveDevelopmentCredential(tx, target.applicationId);
    const issuedAt = new Date();
    return {
      kind: 'mercaria-ephemeral-service-v1',
      target,
      credentialId: randomUUID(),
      nonce: randomBytes(12).toString('hex'),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + MAX_LIFETIME_MS).toISOString(),
      before,
    };
  });
}
async function ownedRow(tx: Transaction, plan: EphemeralPlan, material: EphemeralVerifier) {
  const [row] = await tx
    .select({
      id: applicationCredentials.id,
      app: applicationCredentials.applicationId,
      name: applicationCredentials.name,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      publicKey: applicationCredentials.publicKey,
      secretHash: applicationCredentials.secretHash,
      scopes: applicationCredentials.scopes,
      expiresAt: applicationCredentials.expiresAt,
      rotatedFrom: applicationCredentials.rotatedFromCredentialId,
      workload: applicationCredentials.workloadIdentityId,
      createdBy: applicationCredentials.createdByUserId,
      status: applicationCredentials.status,
      version: sql<string>`xmin::text`,
      updatedAt: sql<string>`updated_at::text`,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, plan.credentialId))
    .for('update');
  if (
    !row ||
    row.app !== plan.target.applicationId ||
    row.name !== PREFIX + plan.nonce ||
    row.type !== 'service' ||
    row.environment !== 'development' ||
    row.createdBy !== null ||
    row.rotatedFrom !== null ||
    row.workload !== null ||
    row.publicKey !== material.publicKey ||
    row.secretHash !== material.secretHash ||
    row.expiresAt?.toISOString() !== plan.expiresAt ||
    JSON.stringify(row.scopes) !== JSON.stringify(EPHEMERAL_PAYMENT_SCOPES)
  )
    refuse();
  return row;
}
const stateOf = (row: EphemeralState): EphemeralState => ({
  version: row.version,
  updatedAt: row.updatedAt,
  status: row.status,
});

/** Material must already be durably reserved by the operator CLI before this call. */
export async function issueEphemeralCredential(
  plan: EphemeralPlan,
  material: EphemeralVerifier,
  actor: BillingAuthorityActor,
) {
  operator(actor);
  validPlan(plan, true);
  validMaterial(material);
  return getDb().transaction(async (tx) => {
    const current = await lockedApp(tx, plan.target, true);
    if (
      current.version !== plan.before.version ||
      current.updatedAt !== plan.before.updatedAt ||
      JSON.stringify(current.scopes) !== JSON.stringify(plan.before.scopes)
    )
      refuse();
    await noActiveDevelopmentCredential(tx, plan.target.applicationId);
    validPlan(plan, true); // Expiry may have elapsed while waiting for locks.
    await tx.insert(applicationCredentials).values({
      id: plan.credentialId,
      applicationId: plan.target.applicationId,
      name: PREFIX + plan.nonce,
      type: 'service',
      environment: 'development',
      status: 'active',
      publicKey: material.publicKey,
      secretHash: material.secretHash,
      scopes: [...EPHEMERAL_PAYMENT_SCOPES],
      expiresAt: new Date(plan.expiresAt),
      createdByUserId: null,
    });
    return {
      plan,
      actor: actor.describedAs,
      operation: 'issue' as const,
      state: stateOf(await ownedRow(tx, plan, material)),
    };
  });
}
/** Read-only reconciliation after use or uncertain output; no second issue is attempted. */
export async function inspectEphemeralCredential(
  plan: EphemeralPlan,
  material: EphemeralVerifier,
  actor: BillingAuthorityActor,
) {
  operator(actor);
  validPlan(plan, false);
  validMaterial(material);
  return getDb().transaction(async (tx) => {
    await lockedApp(tx, plan.target, false);
    return {
      plan,
      actor: actor.describedAs,
      operation: 'inspect' as const,
      state: stateOf(await ownedRow(tx, plan, material)),
    };
  });
}
/** A fresh inspect handles legitimate lastUsedAt row writes; later races fail CAS. */
export async function revokeEphemeralCredential(
  plan: EphemeralPlan,
  material: EphemeralVerifier,
  expected: EphemeralState,
  actor: BillingAuthorityActor,
) {
  operator(actor);
  validPlan(plan, false);
  validMaterial(material);
  return getDb().transaction(async (tx) => {
    await lockedApp(tx, plan.target, false);
    const current = await ownedRow(tx, plan, material);
    if (
      current.status !== 'active' ||
      current.version !== expected.version ||
      current.updatedAt !== expected.updatedAt ||
      current.status !== expected.status
    )
      refuse();
    await tx
      .update(applicationCredentials)
      .set({ status: 'revoked', updatedAt: sql`clock_timestamp()` })
      .where(eq(applicationCredentials.id, plan.credentialId));
    return {
      plan,
      actor: actor.describedAs,
      operation: 'revoke' as const,
      state: stateOf(await ownedRow(tx, plan, material)),
    };
  });
}
