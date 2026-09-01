#!/usr/bin/env bun
/**
 * Idempotent admin script: register the two production `Application` client ids
 * required by the "Sign in with Oxy" feature —
 *
 *   1. Commons by Oxy  — the native self-sovereign identity wallet whose
 *      `OxyProvider clientId` (`EXPO_PUBLIC_OXY_CLIENT_ID` in
 *      `packages/commons/constants/oxy.ts`) must be a real registered public
 *      `ApplicationCredential`.
 *   2. Oxy Auth        — the third-party OAuth IdP app, which ALSO acts as its
 *      own Relying Party for the Sign-in-with-Oxy QR handoff and therefore
 *      needs a public client id + its own redirect origins.
 *
 * Both Applications live in the production "Oxy" team workspace, owned by the
 * platform user `oxy`. For each app this UPSERTS (never duplicates on re-run):
 *   - Application       keyed by (name + createdByUserId = oxyId)
 *   - a single owner AccountMember for oxy on the Oxy org account (app access
 *     derives from it — no per-app member row)
 *   - ApplicationCredential  type:'public', environment:'production',
 *                            publicKey minted EXACTLY like the real create route
 *                            (`oxy_dk_` + 24 random bytes hex). A `public`
 *                            credential carries NO secret. Existing active public
 *                            production credentials are REUSED — never re-minted.
 *
 * It also grants Commons the staff-only `identity:approval` capability, which is
 * what makes its installs eligible targets for
 * `POST /auth/session/deliver/:authorizeCode` (automatic push delivery of a
 * pending sign-in request). Capabilities are UNIONed into an existing record,
 * never stripped.
 *
 * The "Oxy Auth" app is the SAME record seeded by
 * `scripts/seed-oxy-applications.ts` (idempotency key is name + owner). This
 * script reuses that record and its credential; the only delta is that it UNIONS
 * the auth-RP redirect origins into `redirectUris` (the seed already registers
 * `https://auth.oxy.so`; this script is idempotent if that origin is present).
 *
 * Safety:
 *   - No deletes, no drops. Existing redirectUris/scopes are UNIONed, never
 *     stripped. No modification of unrelated documents.
 *   - Re-running performs 0 inserts/updates once registered.
 *   - DRY_RUN=1 (or DRY_RUN=true) reports the plan without writing.
 *   - Verifies the known production workspace + owner ids exist before writing;
 *     aborts with a clear error if either is missing or mismatched (guards
 *     against pointing at the wrong database/environment).
 *
 * DRY RUN == REAL RUN (by construction). The reconciliation decision lives in
 * `src/scripts/registerCommonsClientsPlan.ts` and is computed UNCONDITIONALLY,
 * on both paths; `DRY_RUN` gates only whether the plan is written. The plan is
 * reported field by field (`changes: [{ field, from, to }]`), so an operator
 * sees WHICH field would change, not just a count. This is not a nicety: a dry
 * run that reported `appsUpdated: 0` immediately before a real run that granted
 * `identity:approval` and reported `appsUpdated: 2` is exactly the failure this
 * structure makes impossible.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/register-commons-clients.ts
 * Or via the npm script (from packages/api):
 *   bun run register:commons-clients
 *
 * Env:
 *   DATABASE_URL  required (injected by ECS from SSM)
 *   DRY_RUN=1     plan only, no writes
 *
 * Output (non-secret client ids — safe to log and parse from ECS task logs):
 *   COMMONS_CLIENT_ID=<oxy_dk_...>
 *   AUTH_IDP_CLIENT_ID=<oxy_dk_...>
 */

import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { accountMembers } from '../src/db/schema/accountMembers';
import { applicationCredentials } from '../src/db/schema/applicationCredentials';
import { applications } from '../src/db/schema/applications';
import { users } from '../src/db/schema/users';
import { accountService } from '../src/services/account.service';
import type { ApplicationType } from '../src/db/schema/applications';
import {
  IDENTITY_APPROVAL_CAPABILITY,
  type ApplicationCapability,
} from '../src/utils/applicationCapabilities';
import type { ApplicationScope } from '../src/utils/applicationScopes';
import { logger } from '../src/utils/logger';
import {
  applyApplicationPlan,
  computeApplicationPlan,
  readApplicationState,
  type MutableApplicationFields,
  type PlannedFieldChange,
  type ReadableApplication,
} from '../src/scripts/registerCommonsClientsPlan';

// ── Mirror routes/applications.ts credential generation EXACTLY ──────────────
const CREDENTIAL_PUBLIC_KEY_PREFIX = 'oxy_dk_';
const PUBLIC_KEY_RANDOM_BYTES = 24;

function generatePublicKey(): string {
  return CREDENTIAL_PUBLIC_KEY_PREFIX + crypto.randomBytes(PUBLIC_KEY_RANDOM_BYTES).toString('hex');
}

// ── Known production identifiers (the Oxy team workspace + platform owner) ───
// These are verified to exist before any write so the script fails loudly if it
// is ever pointed at the wrong database/environment.
const OXY_OWNER_USER_ID = '69b2d3df5d12f58c9800d651';
const OXY_OWNER_USERNAME = 'oxy';
const DRY_RUN_PLACEHOLDER_ID = '000000000000000000000000';

type ClientKey = 'COMMONS_CLIENT_ID' | 'AUTH_IDP_CLIENT_ID';

interface ClientSpec {
  /** Output env key printed at the end. */
  key: ClientKey;
  /** Idempotency key (with createdByUserId = oxyId). DO NOT rename casually. */
  name: string;
  description: string;
  websiteUrl?: string;
  type: ApplicationType;
  redirectUris: string[];
  scopes: ApplicationScope[];
  /**
   * Staff-only platform capability flags. UNIONed into an existing record, never
   * stripped. This is what makes a platform behaviour registry-driven instead of
   * keyed off a hardcoded client id.
   */
  capabilities: ApplicationCapability[];
}

const CLIENTS: ClientSpec[] = [
  {
    key: 'COMMONS_CLIENT_ID',
    name: 'Commons by Oxy',
    description:
      'Official Oxy Commons app — self-sovereign identity wallet and Sign-in-with-Oxy approvals (native).',
    type: 'first_party',
    redirectUris: ['commons://', 'oxycommons://'],
    scopes: ['user:read'],
    capabilities: [IDENTITY_APPROVAL_CAPABILITY],
  },
  {
    key: 'AUTH_IDP_CLIENT_ID',
    name: 'Oxy Auth',
    description:
      'Official Oxy authentication app and third-party OAuth Identity Provider, acting as its own Relying Party for Sign in with Oxy.',
    websiteUrl: 'https://auth.oxy.so',
    type: 'first_party',
    redirectUris: ['https://auth.oxy.so'],
    scopes: ['user:read'],
    capabilities: [],
  },
];

type RecordAction = 'create' | 'update' | 'unchanged';

interface MappingRow {
  key: ClientKey;
  app: string;
  type: ApplicationType;
  applicationId: string;
  clientId: string;
  /** Effective AFTER this run (the union), not the pre-run value. */
  redirectUris: string[];
  applicationAction: RecordAction;
  changes: PlannedFieldChange[];
  credentialAction: 'create' | 'reuse';
}

interface ResolvedTargets {
  oxyId: string;
  ownerAccountId: string | null;
  ownerAccountAction: RecordAction;
  ownerMembershipAction: RecordAction;
}

type ApplicationRow = typeof applications.$inferSelect;

async function findOxyOrgAccount(
  oxyId: string,
  oxyAccountName: string,
): Promise<{ id: string } | null> {
  const [oxyOrg] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.parentAccountId, oxyId),
        eq(users.kind, 'organization'),
        eq(users.nameFirst, oxyAccountName),
      ),
    )
    .limit(1);
  return oxyOrg ?? null;
}

async function ensureOwnerMembership(accountId: string, oxyId: string): Promise<RecordAction> {
  const [existingOwner] = await getDb()
    .select({ id: accountMembers.id })
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.memberUserId, oxyId)),
    )
    .limit(1);

  if (existingOwner) {
    return 'unchanged';
  }

  await getDb().insert(accountMembers).values({
    accountId,
    memberUserId: oxyId,
    role: 'owner',
    inherit: true,
    status: 'active',
    joinedAt: new Date(),
  });
  return 'create';
}

async function resolveTargets(dryRun: boolean): Promise<ResolvedTargets> {
  const [owner] = await getDb()
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, OXY_OWNER_USER_ID))
    .limit(1);

  if (!owner?.id) {
    throw new Error(
      `Owner user _id ${OXY_OWNER_USER_ID} (username "${OXY_OWNER_USERNAME}") not found — ` +
        'refusing to register clients. Wrong database/environment?',
    );
  }
  if (owner.username !== OXY_OWNER_USERNAME) {
    throw new Error(
      `Owner user _id ${OXY_OWNER_USER_ID} resolved to username "${owner.username}", ` +
        `expected "${OXY_OWNER_USERNAME}" — refusing to register clients.`,
    );
  }

  const oxyId = owner.id;
  const oxyAccountName = process.env.OXY_ACCOUNT_NAME || 'Oxy';
  let oxyOrg = await findOxyOrgAccount(oxyId, oxyAccountName);
  const ownerAccountAction: RecordAction = oxyOrg ? 'unchanged' : 'create';

  if (!oxyOrg && !dryRun) {
    const baseUsername = `${OXY_OWNER_USERNAME}-org`;
    let username = baseUsername;
    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const [taken] = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (!taken) break;
      username = `${baseUsername}${suffix}`;
    }
    const { account } = await accountService.createChildAccount(oxyId, oxyId, {
      kind: 'organization',
      username,
      name: { first: oxyAccountName },
    });
    oxyOrg = account;
  }

  const ownerAccountId = oxyOrg?.id ?? null;

  let ownerMembershipAction: RecordAction = 'create';
  if (oxyOrg && !dryRun) {
    ownerMembershipAction = await ensureOwnerMembership(oxyOrg.id, oxyId);
  } else if (oxyOrg) {
    const [existingOwner] = await getDb()
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, oxyOrg.id), eq(accountMembers.memberUserId, oxyId)),
      )
      .limit(1);
    ownerMembershipAction = existingOwner ? 'unchanged' : 'create';
  }

  logger.info('Resolved production targets', {
    dryRun,
    oxyId,
    ownerUsername: OXY_OWNER_USERNAME,
    ownerAccountId: ownerAccountId ?? '(would be minted by this run)',
    ownerAccountAction,
    ownerMembershipAction,
  });

  return { oxyId, ownerAccountId, ownerAccountAction, ownerMembershipAction };
}

function toReadableApplication(application: ApplicationRow): ReadableApplication {
  return {
    status: application.status,
    type: application.type,
    isOfficial: application.isOfficial,
    isInternal: application.isInternal,
    ownerAccountId: { toString: () => application.ownerAccountId },
    redirectUris: application.redirectUris,
    // Postgres enforces `scopes <@ APPLICATION_SCOPES`; the Drizzle select type
    // is still `string[]`, so narrow at the boundary the plan module expects.
    scopes: application.scopes as ApplicationScope[],
    capabilities: application.capabilities,
  };
}

function toMutableApplication(application: ApplicationRow): MutableApplicationFields<string> {
  return {
    status: application.status,
    type: application.type,
    isOfficial: application.isOfficial,
    isInternal: application.isInternal,
    ownerAccountId: application.ownerAccountId,
    redirectUris: application.redirectUris,
    scopes: application.scopes as ApplicationScope[],
    capabilities: application.capabilities,
  };
}

async function register(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  if (dryRun) {
    logger.info('DRY RUN — no writes will be performed');
  }

  const { oxyId, ownerAccountId, ownerAccountAction, ownerMembershipAction } =
    await resolveTargets(dryRun);
  const mapping: MappingRow[] = [];

  const requireOwnerAccountId = (): string => {
    if (!ownerAccountId) {
      throw new Error('Owner organization account was not resolved — refusing to write');
    }
    return ownerAccountId;
  };

  for (const spec of CLIENTS) {
    let application =
      (
        await getDb()
          .select()
          .from(applications)
          .where(and(eq(applications.name, spec.name), eq(applications.createdByUserId, oxyId)))
          .limit(1)
      )[0] ?? null;

    const plan = computeApplicationPlan(
      application ? readApplicationState(toReadableApplication(application)) : null,
      {
        type: spec.type,
        redirectUris: spec.redirectUris,
        scopes: spec.scopes,
        capabilities: spec.capabilities,
        ownerAccountId: ownerAccountId ?? null,
      },
    );

    const applicationAction: RecordAction = plan.creates
      ? 'create'
      : plan.changes.length > 0
        ? 'update'
        : 'unchanged';

    if (!dryRun) {
      if (plan.creates) {
        const [created] = await getDb()
          .insert(applications)
          .values({
            name: spec.name,
            description: spec.description,
            websiteUrl: spec.websiteUrl,
            createdByUserId: oxyId,
            ownerAccountId: requireOwnerAccountId(),
            status: plan.desired.status,
            type: plan.desired.type,
            isOfficial: plan.desired.isOfficial,
            isInternal: plan.desired.isInternal,
            capabilities: plan.desired.capabilities,
            redirectUris: plan.desired.redirectUris,
            scopes: plan.desired.scopes,
          })
          .returning();
        application = created;
      } else if (application && plan.changes.length > 0) {
        const mutable = toMutableApplication(application);
        applyApplicationPlan(mutable, plan, requireOwnerAccountId());
        const [updated] = await getDb()
          .update(applications)
          .set({
            status: mutable.status,
            type: mutable.type,
            isOfficial: mutable.isOfficial,
            isInternal: mutable.isInternal,
            ownerAccountId: mutable.ownerAccountId,
            redirectUris: mutable.redirectUris,
            scopes: mutable.scopes,
            capabilities: mutable.capabilities,
          })
          .where(eq(applications.id, application.id))
          .returning();
        application = updated;
      }
    }

    logger.info(
      dryRun ? 'Application registration plan (dry run — not written)' : 'Application registration applied',
      {
        dryRun,
        app: spec.name,
        action: applicationAction,
        changes: plan.changes,
      },
    );

    let credential =
      application && application.id !== DRY_RUN_PLACEHOLDER_ID
        ? (
            await getDb()
              .select()
              .from(applicationCredentials)
              .where(
                and(
                  eq(applicationCredentials.applicationId, application.id),
                  eq(applicationCredentials.type, 'public'),
                  eq(applicationCredentials.environment, 'production'),
                  eq(applicationCredentials.status, 'active'),
                ),
              )
              .limit(1)
          )[0] ?? null
        : null;

    const credentialAction: 'create' | 'reuse' = credential ? 'reuse' : 'create';

    if (!credential && !dryRun && application) {
      const [created] = await getDb()
        .insert(applicationCredentials)
        .values({
          applicationId: application.id,
          name: 'Production',
          publicKey: generatePublicKey(),
          secretHash: null,
          type: 'public',
          environment: 'production',
          status: 'active',
          createdByUserId: oxyId,
        })
        .returning();
      credential = created;
    }

    if (!dryRun && !credential) {
      throw new Error(`No production credential resolved for "${spec.name}"`);
    }

    mapping.push({
      key: spec.key,
      app: spec.name,
      type: spec.type,
      applicationId: application?.id ?? '(dry-run-would-create)',
      clientId: credential?.publicKey ?? '(dry-run-would-mint)',
      redirectUris: plan.desired.redirectUris,
      applicationAction,
      changes: plan.changes,
      credentialAction,
    });
  }

  const countAction = (action: RecordAction): number =>
    mapping.filter((row) => row.applicationAction === action).length;

  logger.info('Registration summary', {
    dryRun,
    clients: CLIENTS.length,
    appsCreated: countAction('create'),
    appsUpdated: countAction('update'),
    appsUnchanged: countAction('unchanged'),
    fieldChanges: mapping.reduce((total, row) => total + row.changes.length, 0),
    credentialsCreated: mapping.filter((row) => row.credentialAction === 'create').length,
    credentialsReused: mapping.filter((row) => row.credentialAction === 'reuse').length,
    ownerAccountAction,
    ownerMembershipAction,
  });

  const byKey = (key: ClientKey): string =>
    mapping.find((m) => m.key === key)?.clientId ?? 'ERROR-missing';

  /* eslint-disable no-console */
  console.log(`COMMONS_CLIENT_ID=${byKey('COMMONS_CLIENT_ID')}`);
  console.log(`AUTH_IDP_CLIENT_ID=${byKey('AUTH_IDP_CLIENT_ID')}`);
  console.log('OXY_SIGNIN_CLIENTS_JSON=' + JSON.stringify({ dryRun, clients: mapping }));
  /* eslint-enable no-console */
}

async function main(): Promise<void> {
  await connectPostgres();
  logger.info('Connected to Postgres');

  try {
    await register();
  } finally {
    await closePostgres();
    logger.info('Postgres connection closed');
  }
}

main().catch((error) => {
  logger.error('Client registration failed', error instanceof Error ? error : new Error(String(error)), {
    component: 'register-commons-clients',
    method: 'main',
  });
  process.exit(1);
});
