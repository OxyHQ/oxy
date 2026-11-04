import { isoDateTime, utf16MinLength } from '@oxy.so/contracts';
/** Historical I05 receipt parser and bounded credential revocation only.
 * Scope fields validate old receipts; they are never read from or written to workloads. */
import { canonicalCapabilityJson } from '@oxy.so/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { users } from '../db/schema/users';
import { recordCredentialLifecycleEvent } from '../services/applicationCredentialAudit.service';
import { intersectScopes, isPrivilegedScope } from '../utils/applicationScopes';
import { isCredentialUsable } from '../utils/credentialUsability';
import {
  MENTION_APPLICATION_ID,
  OXY_PROFILE_REGISTRAR_APPLICATION_ID,
} from './seedOxyApplicationsSpecs';

export const MENTION_BACKEND_ROLE = 'arn:aws:iam::237343248947:role/oxy-mention-task';
export const MENTION_MCP_ROLE = 'arn:aws:iam::237343248947:role/oxy-mention-mcp-task';
const TICKET_SCOPE = 'capability-tickets:issue';
const COORDINATE = 'agency:coordinate';
const revision = z.string().regex(/^\d+$/);
const strings = z
  .array(z.string().check(utf16MinLength(1)))
  .refine((values) => new Set(values).size === values.length);
const account = z.object({
  id: z.string().check(utf16MinLength(1)),
  account_status: z.literal('active'),
  row_revision: revision,
});
const application = z
  .object({
    id: z.literal(MENTION_APPLICATION_ID),
    type: z.literal('first_party'),
    status: z.literal('active'),
    is_official: z.literal(true),
    is_internal: z.literal(false),
    owner_account_id: z.string().check(utf16MinLength(1)),
    scopes: strings,
    capabilities: strings,
    row_revision: revision,
  })
  .strict();
const workload = z
  .object({
    id: z.string().check(utf16MinLength(1)),
    application_id: z.literal(MENTION_APPLICATION_ID),
    provider: z.literal('aws-iam'),
    subject: z.enum([MENTION_BACKEND_ROLE, MENTION_MCP_ROLE]),
    scopes: strings,
    expires_at: z.null(),
    row_revision: revision,
  })
  .strict();
const workloadCredential = z
  .object({
    id: z.string().startsWith('wl_'),
    application_id: z.literal(MENTION_APPLICATION_ID),
    type: z.literal('workload'),
    environment: z.literal('production'),
    status: z.literal('active'),
    expires_at: z.null(),
    scopes: z.array(z.string()).length(0),
    workload_identity_id: z.string().check(utf16MinLength(1)),
    row_revision: revision,
  })
  .strict();
// Existing OAuth identities participate in the complete CAS census.
// Their rows stay unchanged; the app ceiling must not widen usable authority.
const retainedCredential = z
  .object({
    id: z
      .string()
      .check(utf16MinLength(1))
      .refine((id) => !id.startsWith('wl_')),
    application_id: z.literal(MENTION_APPLICATION_ID),
    type: z.enum(['public', 'service']),
    environment: z.literal('production'),
    status: z.enum(['active', 'deprecated', 'revoked']),
    expires_at: z.string().check(isoDateTime()).nullable(),
    scopes: strings,
    workload_identity_id: z.null(),
    row_revision: revision,
  })
  .strict();
const credential = z.union([workloadCredential, retainedCredential]);
const credentialCensus = z
  .array(credential)
  .min(2)
  .max(20)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
  .refine((rows) => rows.filter((row) => row.type === 'workload').length === 2);
const rootAccount = account
  .extend({
    kind: z.literal('organization'),
    is_platform_root: z.literal(true),
  })
  .strict();
export interface ForegroundPilotPlan {
  schemaVersion: 1;
  kind: 'i05-foreground-configuration';
  nonce: string;
  createdAt: string;
  expiresAt: string;
  expectedApplication: z.infer<typeof application>;
  expectedWorkloads: z.infer<typeof workload>[];
  expectedCredentials: z.infer<typeof credential>[];
  expectedOwners: z.infer<typeof account>[];
  registrarOwner: z.infer<typeof rootAccount>;
  afterScopes: string[];
  afterCapabilities: string[];
  backendWorkloadId: string;
  afterBackendScopes: string[];
}
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('i05-foreground-configuration'),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    createdAt: z.string(),
    expiresAt: z.string(),
    expectedApplication: application,
    expectedWorkloads: z.array(workload).length(2),
    expectedCredentials: credentialCensus,
    expectedOwners: z.array(account.strict()).min(1).max(2),
    registrarOwner: rootAccount,
    afterScopes: strings,
    afterCapabilities: strings,
    backendWorkloadId: z.string().check(utf16MinLength(1)),
    afterBackendScopes: strings,
  })
  .strict();

function exact(actual: unknown, expected: unknown, name: string) {
  if (canonicalCapabilityJson(actual) !== canonicalCapabilityJson(expected))
    throw new Error(`I05 ${name} changed; fresh plan required`);
}
function append(values: string[], item: string) {
  return values.includes(item) ? [...values] : [...values, item];
}

/** Validate the original receipt before retiring its exact external credentials. */
function validateForegroundPilotDefinition(plan: ForegroundPilotPlan) {
  planSchema.parse(plan);
  for (const row of plan.expectedCredentials) {
    if (
      row.type === 'workload' ||
      !isCredentialUsable({
        status: row.status,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      })
    )
      continue;
    const effective = (scopes: string[]) =>
      row.scopes.length
        ? intersectScopes(row.scopes, scopes)
        : scopes.filter((scope) => !isPrivilegedScope(scope));
    exact(
      effective(plan.afterScopes),
      effective(plan.expectedApplication.scopes),
      'retained credential effective authority',
    );
  }
  const ownerIds = [
    ...new Set([plan.expectedApplication.owner_account_id, plan.registrarOwner.id]),
  ].sort();
  exact(
    plan.expectedOwners.map((owner) => owner.id),
    ownerIds,
    'owner lock set',
  );
  if (
    new Set(plan.expectedWorkloads.map((binding) => binding.subject)).size !== 2 ||
    new Set(plan.expectedWorkloads.map((binding) => binding.id)).size !== 2 ||
    plan.expectedWorkloads.some(
      (binding) =>
        plan.expectedCredentials.filter(
          (credential) => credential.workload_identity_id === binding.id,
        ).length !== 1,
    )
  ) {
    throw new Error('I05 plan canonical binding mismatch');
  }
  application.parse(plan.expectedApplication);
  rootAccount.parse(plan.registrarOwner);
  for (const row of plan.expectedWorkloads) workload.parse(row);
  for (const row of plan.expectedCredentials) credential.parse(row);
  const backend = plan.expectedWorkloads.find((row) => row.subject === MENTION_BACKEND_ROLE);
  if (!backend || plan.backendWorkloadId !== backend.id)
    throw new Error('I05 plan backend mismatch');
  exact(
    plan.afterScopes,
    append(plan.expectedApplication.scopes, TICKET_SCOPE),
    'application scope delta',
  );
  exact(
    plan.afterCapabilities,
    append(plan.expectedApplication.capabilities, COORDINATE),
    'application capability delta',
  );
  exact(plan.afterBackendScopes, append(backend.scopes, TICKET_SCOPE), 'workload scope delta');
}

/** Cleanup is maintenance: it remains permitted after expiry or owner withdrawal. */
export async function retireEphemeralRegistrarCredentials(plan: ForegroundPilotPlan) {
  validateForegroundPilotDefinition(plan);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '15000'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, plan.registrarOwner.id))
      .for('update');
    const [app] = await tx
      .select({ owner: applications.ownerAccountId })
      .from(applications)
      .where(eq(applications.id, OXY_PROFILE_REGISTRAR_APPLICATION_ID))
      .for('update');
    if (!app || app.owner !== plan.registrarOwner.id)
      throw new Error('I05 cleanup application ownership changed');
    const credentials = await tx
      .select({
        id: applicationCredentials.id,
        status: applicationCredentials.status,
        type: applicationCredentials.type,
        scopes: applicationCredentials.scopes,
        environment: applicationCredentials.environment,
      })
      .from(applicationCredentials)
      .where(
        and(
          eq(applicationCredentials.applicationId, OXY_PROFILE_REGISTRAR_APPLICATION_ID),
          eq(applicationCredentials.name, `I05 ephemeral registrar ${plan.nonce}`),
        ),
      )
      .orderBy(applicationCredentials.id)
      .for('update');
    if (credentials.length > 4) throw new Error('I05 cleanup credential census exceeded');
    for (const credential of credentials) {
      if (credential.type !== 'service' || credential.environment !== 'production')
        throw new Error('I05 cleanup credential identity changed');
      exact(credential.scopes, ['catalogs:write'], 'cleanup scope');
      if (credential.status !== 'revoked') {
        await tx
          .update(applicationCredentials)
          .set({ status: 'revoked' })
          .where(eq(applicationCredentials.id, credential.id));
        await recordCredentialLifecycleEvent(tx, {
          applicationId: OXY_PROFILE_REGISTRAR_APPLICATION_ID,
          credentialId: credential.id,
          eventType: 'revoked',
          actorUserId: plan.registrarOwner.id,
          environment: 'production',
          metadata: {
            administrativeOperation: 'i05-foreground-pilot',
            operationNonce: plan.nonce,
          },
        });
      }
    }
    return {
      retainedCredentialIds: credentials.map((credential) => credential.id),
      allRevoked: true,
    };
  });
}
