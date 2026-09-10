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
 * Safety:
 *   - No deletes, no drops, no modification of unrelated documents.
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
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { applicationCredentials } from '../src/db/schema/applicationCredentials';
import { applications } from '../src/db/schema/applications';
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
  type SeedAppSpec,
  type SeedAppType,
} from '../src/scripts/seedOxyApplicationsSpecs';
import type { ApplicationScope } from '../src/utils/applicationScopes';
import { logger } from '../src/utils/logger';

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
  clientId: string;
  redirectUris: string[];
  websiteUrl?: string;
  createdApplication: boolean;
  createdCredential: boolean;
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
      ),
    )
    .returning({ id: applicationCredentials.id });

  return revoked.length;
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
        type: spec.type,
        ownerAccountId,
        redirectUris: spec.redirectUris,
        scopes: desiredScopes,
        capabilities: desiredCapabilities,
      },
    );

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
          })
          .returning();
        application = created;
      }
    } else if (plan.changes.length > 0) {
      appsUpdated += 1;
      if (!dryRun && application) {
        const mutable = { ...readSeedApplicationState(application) };
        applySeedApplicationPlan(mutable, plan);
        const [updated] = await getDb()
          .update(applications)
          .set(mutable)
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
            scopes: ['user:read'],
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

    mapping.push({
      app: spec.name,
      type: spec.type,
      applicationId,
      // Reported per row, not just per run: an application owned by its own
      // project account is the difference between one line in the cost-centre
      // report and five, and the mapping is where an operator can see which it
      // got without a second query.
      ownerAccountId,
      clientId: credential?.publicKey ?? (dryRun ? '(dry-run-not-minted)' : 'ERROR'),
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
  });

  const [{ value: ownedAppCount }] = await getDb()
    .select({ value: count() })
    .from(applications)
    .where(eq(applications.createdByUserId, oxyId));
  logger.info('Read-back: applications owned by oxy', { count: ownedAppCount });

  // eslint-disable-next-line no-console
  console.log('OXY_APP_MAPPING_JSON=' + JSON.stringify(mapping));
}

async function main(): Promise<void> {
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
  logger.error(
    'Seed failed',
    error instanceof Error ? error : new Error(String(error)),
    { component: 'seed-oxy-applications', method: 'main' },
  );
  process.exit(1);
});
