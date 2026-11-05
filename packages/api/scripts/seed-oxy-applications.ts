#!/usr/bin/env bun
/**
 * Idempotent seed: register a first-party / internal `Application` record for
 * every official Oxy app in the ecosystem, owned by the platform user `oxy`.
 *
 * For each app this UPSERTS (never duplicates on re-run):
 *   - Application      keyed by exact `spec.id` when declared, otherwise by
 *                      (name + createdByUserId = oxyId), owned by the
 *                      root `oxy` account itself (ownerAccountId = oxyId) — app
 *                      access derives from it, with no per-app member row and no
 *                      intermediate organization account. An app declaring
 *                      `ownerAccountUsername` is owned by THAT account instead,
 *                      which is how an application gets its own line in the
 *                      cost-centre report; the account must already exist and
 *                      the run REFUSES rather than falling back.
 *   - ApplicationCredential  type:'public', environment:'production',
 *                            publicKey minted EXACTLY like the real create route
 *                            (`oxy_dk_` + 24 random bytes hex). A `public`
 *                            credential carries NO secret (secretHash absent),
 *                            mirroring `routes/applications.ts`. Existing public
 *                            prod credentials are REUSED — never re-minted.
 *
 *   - Operator permissions (ADR 0056): the application's vocabulary becomes
 *                      EXACTLY `spec.operatorPermissions` (absent = none), each
 *                      key held by the owning account's roles it names; every
 *                      per-person grant on the application is revoked. The run
 *                      logs each change, each grant revoked and, per key, who
 *                      holds it through which role.
 *
 *   - Trusted publishers (ADR 0057): the application's GitHub OTA publishers
 *                      become EXACTLY `spec.trustedPublishers` (absent = none);
 *                      an undeclared one is deleted and its tokens stop working.
 *
 * Safety:
 *   - No deletes (except an undeclared trusted publisher, above), no drops, no
 *     modification of unrelated documents.
 *   - Application web origins (`spec.webOrigins`, ADR 0045) in
 *                      `application_web_origins`, additive only: an origin staff
 *                      added is never removed, one that is another application's
 *                      aborts the run.
 *   - Re-running performs 0 inserts once seeded (verified by the summary).
 *   - DRY_RUN=true reports the plan without writing.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/seed-oxy-applications.ts
 *
 * Register/reconcile ONE application, leaving every other record untouched:
 *   ONLY_APPS='CrowdSource' bun run packages/api/scripts/seed-oxy-applications.ts
 *   ONLY_APP_IDS='68b7c4e19f2a6d0e3c8b5174' bun run packages/api/scripts/seed-oxy-applications.ts
 *
 * Scopes only, existing exact IDs, no metadata/client reconciliation:
 *   SCOPES_ONLY=true ONLY_APP_IDS=<id> DRY_RUN=true node packages/api/dist/scripts/seedOxyApplicationScopes.js
 *   Repeat with DRY_RUN=false EXPECTED_PLAN_SHA256=<reviewed-hash> to apply.
 *   The Bun wrapper delegates to that same implementation when SCOPES_ONLY is set.
 *
 * Env:
 *   DATABASE_URL  required (injected by ECS from SSM)
 *   OXY_USERNAME  owner username to resolve (default 'oxy')
 *   DRY_RUN=1|true  plan only, no writes
 *   ONLY_APPS     comma-separated application names this run may touch. Unset
 *                 seeds the whole list. Set-but-empty, or naming an application
 *                 that is not in SEED_APPS, ABORTS before any write — see
 *                 `src/scripts/seedEntrySelection.ts`. A spec with a declared
 *                 id cannot be selected here; use ONLY_APP_IDS for that spec.
 *   ONLY_APP_IDS  comma-separated exact immutable ids declared on SEED_APPS.
 *                 Mutually exclusive with ONLY_APPS. Empty, duplicate or
 *                 unknown ids ABORT before the database connection. Entries
 *                 without a declared id cannot be selected through this path.
 *
 * The canonical list itself is `src/scripts/seedOxyApplicationsSpecs.ts`, so the
 * scope and type decisions in it can be held by a test.
 */

import crypto from 'crypto';
import { scopeSeedMain } from '../src/scripts/seedOxyApplicationScopes';
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import {
  applicationCredentials,
  excludeWorkloadRows,
} from '../src/db/schema/applicationCredentials';
import { applications } from '../src/db/schema/applications';
import { accountMembers } from '../src/db/schema/accountMembers';
import {
  applicationRoleGrants,
  applicationRolePermissions,
} from '../src/db/schema/applicationRoles';
import { userAncestors } from '../src/db/schema/userAncestors';
import { accountService } from '../src/services/account.service';
import {
  declareFirstPartyPermissions,
  type PermissionDeclaration,
} from '../src/services/applicationRoles.service';
import { operatorKeysHeldByAccountRole } from '../src/utils/accountRoles';
import { declareFirstPartyTrustedPublishers } from '../src/services/githubTrustedPublishing.service';
import {
  declareApplicationWebOrigins,
  undeclaredApplicationWebOrigins,
} from '../src/services/applicationRecognition.service';
import { users } from '../src/db/schema/users';
import {
  selectSeedEntriesByExactIds,
  selectSeedEntriesByLegacyNames,
} from '../src/scripts/seedEntrySelection';
import {
  applySeedApplicationPlan,
  computeSeedApplicationPlan,
  readSeedApplicationState,
} from '../src/scripts/seedOxyApplicationsPlan';
import {
  SEED_APPS,
  seedApplicationLookupIdentity,
  requiresPublicSeedCredential,
  type FirstPartyOperatorPermission,
  type SeedAppSpec,
  type SeedAppType,
} from '../src/scripts/seedOxyApplicationsSpecs';
import type { ApplicationScope } from '../src/utils/applicationScopes';
import { logger } from '../src/utils/logger';

/** Matches the Console's webhook-secret mint (`routes/applications.ts`). */
function newWebhookSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

// ── Mirror routes/applications.ts credential generation EXACTLY ──────────────
const CREDENTIAL_PUBLIC_KEY_PREFIX = 'oxy_dk_';
const PUBLIC_KEY_RANDOM_BYTES = 24;

function generatePublicKey(): string {
  return CREDENTIAL_PUBLIC_KEY_PREFIX + crypto.randomBytes(PUBLIC_KEY_RANDOM_BYTES).toString('hex');
}

type ApplicationRow = typeof applications.$inferSelect;

interface MappingRow {
  app: string;
  type: SeedAppType;
  applicationId: string;
  ownerAccountId: string;
  clientId: string | null;
  redirectUris: string[];
  websiteUrl?: string;
  createdApplication: boolean;
  createdCredential: boolean;
  webOriginsAdded: string[];
}

const DRY_RUN_PLACEHOLDER_ID = '000000000000000000000000';

async function findUserByUsername(username: string): Promise<{ id: string } | null> {
  const [owner] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);
  return owner ?? null;
}

/**
 * The account an application declaring `ownerAccountUsername` is owned by.
 *
 * REFUSES on anything it does not recognise, including in a dry run, and never
 * falls back to the platform owner. The fallback is the dangerous branch: an
 * application seeded onto the root account still works in every respect a smoke
 * test can see — it authenticates, it signs users in, it can invoke inference —
 * and the only symptom is that its spend rolls up with every other official
 * app's, which nobody discovers until a month-end report shows one number where
 * several were expected. A dry run refuses for the same reason: a plan the real
 * run cannot execute is a plan an operator acts on.
 *
 * The three conditions are the three ways the wrong account could be adopted:
 * a personal or organization account that happens to share the handle, a project
 * account belonging to somebody else's subtree, and an archived account whose
 * spend nobody is watching.
 */
async function resolveDedicatedOwnerAccount(
  username: string,
  appName: string,
  platformOwnerId: string,
): Promise<string> {
  const [account] = await getDb()
    .select({
      id: users.id,
      kind: users.kind,
      parentAccountId: users.parentAccountId,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);

  if (!account) {
    throw new Error(
      `Application "${appName}" is owned by the account "${username}", which does not exist. ` +
        'Run `scripts/seed-internal-cost-centers.ts` first — it mints the project accounts ' +
        'the cost-centre report is built from. Refusing to seed onto the platform owner.',
    );
  }
  if (account.kind !== 'project') {
    throw new Error(
      `Application "${appName}" is owned by the account "${username}", which is a ` +
        `"${account.kind}" account, not a project. Refusing: a handle collision must never ` +
        'silently re-point an official application at somebody else’s account.',
    );
  }
  if (account.parentAccountId !== platformOwnerId) {
    throw new Error(
      `Application "${appName}" is owned by the project account "${username}", which is not a ` +
        'child of the platform owner. Refusing: its spend would be reported under a subtree ' +
        'this seed does not own.',
    );
  }
  if (account.accountStatus !== 'active') {
    throw new Error(
      `Application "${appName}" is owned by the project account "${username}", which is ` +
        `"${account.accountStatus}". Refusing: spend booked to an archived account is spend ` +
        'nobody is watching.',
    );
  }

  return account.id;
}

async function retireLegacyApplication(
  application: ApplicationRow,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    return 0;
  }

  await getDb()
    .update(applications)
    .set({ status: 'suspended', redirectUris: [] })
    .where(eq(applications.id, application.id));

  const revoked = await getDb()
    .update(applicationCredentials)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(applicationCredentials.applicationId, application.id),
        ne(applicationCredentials.status, 'revoked'),
        // Retiring an application does not revoke its attested identities: a
        // workload row is not a credential, and flipping its status would leave a
        // row reading as revoked while the binding that actually authorises the
        // workload carried on. The `applications` suspension above is what stops
        // the mint, for both proofs at once.
        excludeWorkloadRows(),
      ),
    )
    .returning({ id: applicationCredentials.id });

  return revoked.length;
}

function operatorDeclarations(
  permissions: readonly FirstPartyOperatorPermission[],
): PermissionDeclaration[] {
  return permissions.map((permission) => ({
    key: permission.key,
    description: permission.description,
    heldByAccountRoles: permission.heldBy,
  }));
}

/**
 * Who holds each of `declarations` through their role over `ownerAccountId`:
 * every active person-member of the account or an ancestor, resolved by the
 * same `resolveEffectiveAccess` `roles/me` reads. Reported, never written.
 */
async function operatorHolders(
  ownerAccountId: string,
  declarations: readonly PermissionDeclaration[],
): Promise<{ userId: string; username: string | null; role: string; keys: string[] }[]> {
  const ancestors = await getDb()
    .select({ id: userAncestors.ancestorId })
    .from(userAncestors)
    .where(eq(userAncestors.userId, ownerAccountId));
  const members = await getDb()
    .selectDistinct({ userId: accountMembers.memberUserId, username: users.username })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.memberUserId))
    .where(
      and(
        inArray(accountMembers.accountId, [ownerAccountId, ...ancestors.map((row) => row.id)]),
        eq(accountMembers.status, 'active'),
        eq(users.kind, 'personal'),
      ),
    )
    .orderBy(accountMembers.memberUserId);

  const holders: { userId: string; username: string | null; role: string; keys: string[] }[] = [];
  for (const member of members) {
    const access = await accountService.resolveEffectiveAccess(member.userId, ownerAccountId);
    if (!access) continue;
    const keys = operatorKeysHeldByAccountRole(access.role, declarations);
    if (keys.length > 0) holders.push({ ...member, role: access.role, keys });
  }
  return holders;
}

/**
 * Every live per-person grant on one of Oxy's own applications, across the
 * WHOLE registry, not only this run's selection. After a full run this is
 * empty; a row here is an application whose registry entry has not been
 * applied since ADR 0056.
 */
async function liveGrantsOnOwnApplications(): Promise<
  { applicationId: string; permission: string; userId: string }[]
> {
  return getDb()
    .select({
      applicationId: applicationRolePermissions.applicationId,
      permission: applicationRolePermissions.key,
      userId: applicationRoleGrants.userId,
    })
    .from(applicationRoleGrants)
    .innerJoin(
      applicationRolePermissions,
      eq(applicationRolePermissions.id, applicationRoleGrants.permissionId),
    )
    .innerJoin(applications, eq(applications.id, applicationRolePermissions.applicationId))
    .where(and(isNull(applicationRoleGrants.revokedAt), ne(applications.type, 'third_party')))
    .orderBy(applicationRolePermissions.applicationId, applicationRolePermissions.key);
}

async function seed(seedApps: readonly SeedAppSpec[]): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const ownerUsername = process.env.OXY_USERNAME || 'oxy';

  if (dryRun) {
    logger.info('DRY RUN — no writes will be performed');
  }

  logger.info('Seeding applications', {
    selected: seedApps.map((spec) => spec.name),
    of: SEED_APPS.length,
    filtered: seedApps.length !== SEED_APPS.length,
  });

  const owner = await findUserByUsername(ownerUsername);
  if (!owner) {
    throw new Error(
      `Owner user "${ownerUsername}" not found — refusing to seed. ` +
        `Set OXY_USERNAME to the correct platform owner username.`,
    );
  }
  const oxyId = owner.id;
  logger.info('Resolved owner user', { username: ownerUsername, oxyId });

  // Official apps are owned by the ROOT `oxy` account itself. This used to mint a
  // child `oxy-org` organization under it, which put every official app on an
  // account the operator never sees when signed in as `oxy` — so the apps looked
  // missing in the Console and got re-registered by hand as self-service
  // `third_party` duplicates. One account, one place to find them.
  const oxyOrgId = oxyId;
  logger.info('Oxy owner account', { username: ownerUsername, ownerAccountId: oxyOrgId });

  const mapping: MappingRow[] = [];

  let appsCreated = 0;
  let appsUpdated = 0;
  let legacyAppsRetired = 0;
  let credentialsCreated = 0;
  let legacyCredentialsRevoked = 0;
  let credentialsReused = 0;
  let webOriginsDeclared = 0;
  let operatorKeysAdded = 0;
  let operatorKeysRetired = 0;
  let operatorGrantsRevoked = 0;
  let trustedPublishersAdded = 0;
  let trustedPublishersRemoved = 0;

  for (const spec of seedApps) {
    let createdApplication = false;
    let createdCredential = false;
    const lookupIdentity = seedApplicationLookupIdentity(spec, oxyId);

    let application =
      (
        await getDb()
          .select()
          .from(applications)
          .where(
            lookupIdentity.kind === 'id'
              ? eq(applications.id, lookupIdentity.id)
              : and(
                  eq(applications.name, lookupIdentity.name),
                  eq(applications.createdByUserId, lookupIdentity.createdByUserId),
                ),
          )
          .limit(1)
      )[0] ?? null;

    if (application && spec.id !== undefined && application.createdByUserId !== oxyId) {
      throw new Error(
        `Exact application id ${spec.id} is already owned by another account; refusing to rebind it`,
      );
    }
    if (application && application.name !== spec.name) {
      throw new Error(
        `Exact application id ${spec.id} is named "${application.name}", not "${spec.name}"; ` +
          'refusing to select or rename it by display name',
      );
    }
    if (!application && spec.id !== undefined) {
      const [nameCollision] = await getDb()
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.name, spec.name), eq(applications.createdByUserId, oxyId)))
        .limit(1);
      if (nameCollision) {
        throw new Error(
          `Application "${spec.name}" already exists as ${nameCollision.id}, but its canonical id is ` +
            `${spec.id}; refusing a name-based adoption`,
        );
      }
    }

    const legacyApplications =
      spec.legacyNames && spec.legacyNames.length > 0
        ? await getDb()
            .select()
            .from(applications)
            .where(
              and(
                inArray(applications.name, spec.legacyNames),
                eq(applications.createdByUserId, oxyId),
              ),
            )
        : [];

    if (!application && legacyApplications.length > 0) {
      application = legacyApplications[0];
      if (!dryRun) {
        await getDb()
          .update(applications)
          .set({ name: spec.name })
          .where(eq(applications.id, application.id));
        application = { ...application, name: spec.name };
      }
    }

    const ownerAccountId =
      spec.ownerAccountUsername === undefined
        ? oxyOrgId
        : await resolveDedicatedOwnerAccount(spec.ownerAccountUsername, spec.name, oxyId);

    const desiredScopes = spec.scopes ?? (['user:read'] as ApplicationScope[]);
    const desiredCapabilities = spec.capabilities ?? [];
    const plan = computeSeedApplicationPlan(
      application ? readSeedApplicationState(application) : null,
      {
        description: spec.description,
        websiteUrl: spec.websiteUrl,
        webhookUrl: spec.webhookUrl,
        type: spec.type,
        ownerAccountId,
        redirectUris: spec.redirectUris,
        scopes: desiredScopes,
        capabilities: desiredCapabilities,
      },
    );

    // The plan, field by field, so a dry run shows WHAT an update would write
    // and an operator can confirm nothing beyond the intended change moves.
    if (plan.changes.length > 0) {
      logger.info('Planned application changes', {
        app: spec.name,
        creates: plan.creates,
        changes: plan.changes,
      });
    }

    if (plan.creates) {
      createdApplication = true;
      appsCreated += 1;
      if (!dryRun) {
        const [created] = await getDb()
          .insert(applications)
          .values({
            ...(spec.id === undefined ? {} : { id: spec.id }),
            name: spec.name,
            createdByUserId: oxyId,
            ...plan.desired,
            webhookSecret: plan.desired.webhookUrl ? newWebhookSecret() : null,
          })
          .returning();
        application = created;
      }
    } else if (plan.changes.length > 0) {
      appsUpdated += 1;
      if (!dryRun && application) {
        const mutable = { ...readSeedApplicationState(application) };
        const written = applySeedApplicationPlan(mutable, plan);
        // Same invariant as the Console's PATCH: a changed webhook URL gets a
        // fresh secret, so a secret never outlives the endpoint it was for.
        const webhookSecret = written.includes('webhookUrl')
          ? { webhookSecret: mutable.webhookUrl ? newWebhookSecret() : null }
          : {};
        const [updated] = await getDb()
          .update(applications)
          .set({ ...mutable, ...webhookSecret })
          .where(eq(applications.id, application.id))
          .returning();
        application = updated;
      }
    }

    for (const legacyApplication of legacyApplications) {
      if (application && legacyApplication.id === application.id) {
        continue;
      }

      legacyCredentialsRevoked += await retireLegacyApplication(legacyApplication, dryRun);
      legacyAppsRetired += 1;
    }

    const applicationId = application?.id ?? spec.id ?? DRY_RUN_PLACEHOLDER_ID;

    let credential: typeof applicationCredentials.$inferSelect | null = null;
    if (requiresPublicSeedCredential(spec)) {
      if (application && application.id !== DRY_RUN_PLACEHOLDER_ID) {
        credential =
          (
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
          )[0] ?? null;
      }

      if (!credential) {
        createdCredential = true;
        if (!dryRun && application) {
          const [created] = await getDb()
            .insert(applicationCredentials)
            .values({
              applicationId: application.id,
              name: 'Production',
              publicKey: generatePublicKey(),
              secretHash: null,
              type: 'public',
              environment: 'production',
              scopes: [],
              status: 'active',
              createdByUserId: oxyId,
            })
            .returning();
          credential = created;
          credentialsCreated += 1;
        }
      } else {
        credentialsReused += 1;
      }
    }

    // ADR 0045: a web app proves itself by its `Origin`, so the origins the spec
    // declares must be registered or every `POST /apps/assertions` from the app
    // is a 403. Additive; a dry run reports what a real run would add.
    const webOrigins = spec.webOrigins ?? [];
    const webOriginsAdded =
      application && application.id !== DRY_RUN_PLACEHOLDER_ID
        ? dryRun
          ? await undeclaredApplicationWebOrigins(application.id, webOrigins)
          : await declareApplicationWebOrigins(application.id, webOrigins)
        : webOrigins;
    webOriginsDeclared += webOriginsAdded.length;

    // ADR 0056: the operator vocabulary is exactly the registry entry, held by
    // role; a dry run plans it under the same lock and writes nothing.
    const declarations = operatorDeclarations(spec.operatorPermissions ?? []);
    if (application && application.id !== DRY_RUN_PLACEHOLDER_ID) {
      const operator = await declareFirstPartyPermissions({
        applicationId: application.id,
        declared: declarations,
        dryRun,
      });
      operatorKeysAdded += operator.plan.add.length;
      operatorKeysRetired += operator.plan.retire.length;
      operatorGrantsRevoked += operator.revokedGrants.length;
      if (
        operator.plan.add.length + operator.plan.retire.length + operator.plan.describe.length >
          0 ||
        operator.revokedGrants.length > 0
      ) {
        logger.info('Planned operator permission changes', {
          app: spec.name,
          applicationId: application.id,
          add: operator.plan.add.map(({ key, heldByAccountRoles }) => ({
            key,
            heldByAccountRoles,
          })),
          retire: operator.plan.retire.map(({ key, heldByAccountRoles }) => ({
            key,
            heldByAccountRoles,
          })),
          describe: operator.plan.describe.map(({ row }) => row.key),
          revokeGrants: operator.revokedGrants.map(({ userId, permission }) => ({
            userId,
            permission,
          })),
        });
      }
      if (declarations.length > 0) {
        logger.info('Operator permission holders', {
          app: spec.name,
          applicationId: application.id,
          ownerAccountId,
          holders: await operatorHolders(ownerAccountId, declarations),
        });
      }
    } else if (declarations.length > 0) {
      operatorKeysAdded += declarations.length;
      logger.info('Planned operator permission changes', {
        app: spec.name,
        add: declarations.map(({ key, heldByAccountRoles }) => ({ key, heldByAccountRoles })),
      });
    }

    // ADR 0057: the OTA publishers are exactly the registry entry. A removed
    // rule is deleted, and the tokens it minted stop at their next request.
    const declaredPublishers = spec.trustedPublishers ?? [];
    if (application && application.id !== DRY_RUN_PLACEHOLDER_ID) {
      const publishers = await declareFirstPartyTrustedPublishers({
        applicationId: application.id,
        declared: declaredPublishers,
        actorUserId: oxyId,
        dryRun,
      });
      trustedPublishersAdded += publishers.add.length;
      trustedPublishersRemoved += publishers.remove.length;
      if (publishers.add.length + publishers.rename.length + publishers.remove.length > 0) {
        logger.info('Planned trusted publisher changes', {
          app: spec.name,
          applicationId: application.id,
          add: publishers.add,
          rename: publishers.rename,
          remove: publishers.remove,
        });
      }
    } else if (declaredPublishers.length > 0) {
      trustedPublishersAdded += declaredPublishers.length;
      logger.info('Planned trusted publisher changes', { app: spec.name, add: declaredPublishers });
    }

    mapping.push({
      webOriginsAdded,
      app: spec.name,
      type: spec.type,
      applicationId,
      // Reported per row, not just per run: an application owned by its own
      // project account is the difference between one line in the cost-centre
      // report and five, and the mapping is where an operator can see which it
      // got without a second query.
      ownerAccountId,
      clientId: requiresPublicSeedCredential(spec)
        ? (credential?.publicKey ?? (dryRun ? '(dry-run-not-minted)' : 'ERROR'))
        : null,
      redirectUris: spec.redirectUris,
      websiteUrl: spec.websiteUrl,
      createdApplication,
      createdCredential,
    });
  }

  logger.info('Seed summary', {
    dryRun,
    apps: seedApps.length,
    appsCreated,
    appsUpdated,
    credentialsCreated,
    legacyAppsRetired,
    legacyCredentialsRevoked,
    credentialsReused,
    webOriginsDeclared,
    operatorKeysAdded,
    operatorKeysRetired,
    operatorGrantsRevoked,
    trustedPublishersAdded,
    trustedPublishersRemoved,
  });

  const leftoverGrants = await liveGrantsOnOwnApplications();
  logger.info('Read-back: live per-person grants on Oxy applications (ADR 0056)', {
    count: leftoverGrants.length,
    grants: leftoverGrants,
  });

  const [{ value: ownedAppCount }] = await getDb()
    .select({ value: count() })
    .from(applications)
    .where(eq(applications.createdByUserId, oxyId));
  logger.info('Read-back: applications owned by oxy', { count: ownedAppCount });

  console.log('OXY_APP_MAPPING_JSON=' + JSON.stringify(mapping));
}

async function main(): Promise<void> {
  if (process.env.SCOPES_ONLY !== undefined) {
    await scopeSeedMain();
    return;
  }
  const onlyApps = process.env.ONLY_APPS;
  const onlyAppIds = process.env.ONLY_APP_IDS;
  if (onlyApps !== undefined && onlyAppIds !== undefined) {
    throw new Error(
      'ONLY_APPS and ONLY_APP_IDS are mutually exclusive; refusing an ambiguous seed boundary',
    );
  }

  const vocabulary = {
    envVar: 'ONLY_APPS',
    singular: 'application',
    plural: 'applications',
  };
  const seedApps =
    onlyAppIds === undefined
      ? selectSeedEntriesByLegacyNames(SEED_APPS, onlyApps, vocabulary, 'ONLY_APP_IDS')
      : selectSeedEntriesByExactIds(SEED_APPS, onlyAppIds, {
          ...vocabulary,
          envVar: 'ONLY_APP_IDS',
        });

  await connectPostgres();
  logger.info('Connected to Postgres');

  try {
    await seed(seedApps);
  } finally {
    await closePostgres();
    logger.info('Postgres connection closed');
  }
}

main().catch((error) => {
  logger.error('Seed failed', error instanceof Error ? error : new Error(String(error)), {
    component: 'seed-oxy-applications',
    method: 'main',
  });
  process.exit(1);
});
