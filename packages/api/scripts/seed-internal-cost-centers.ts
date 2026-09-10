#!/usr/bin/env bun
/**
 * Idempotent seed: register the internal cost centres Oxy books its own
 * first-party inference spend to — issue #972 workstream 14.
 *
 * A cost centre IS an account (`db/schema/internalCostCenters.ts`), so for each
 * entry in `src/scripts/internalCostCenterSpecs.ts` this:
 *
 *   1. Mints a `project` account under the platform owner, whose USERNAME is the
 *      centre's slug — or adopts one that already exists under that owner, or
 *      REFUSES if the handle belongs to anything else.
 *   2. Labels that account through `entitlement.service.ts`'s own
 *      `registerCostCenter`, so the seed and the staff API write cost centres
 *      exactly one way.
 *
 * It runs BEFORE `scripts/seed-oxy-applications.ts` for the Alia registration:
 * that seed refuses to register an application whose declared owner account does
 * not exist yet, rather than falling back to the platform owner and silently
 * merging Alia's spend into everybody else's.
 *
 * Safety:
 *   - No deletes, no drops, no retires. Taking a centre out of the picker is
 *     `DELETE /billing/cost-centers/:slug`, a deliberate act by a person.
 *   - Never renames or re-parents an existing account.
 *   - Re-running writes nothing once seeded (the summary reports it).
 *   - DRY_RUN=1|true computes and reports the same plan, and writes nothing —
 *     the plan is computed on ONE code path, so the dry run cannot
 *     under-report a write the real run is about to make.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   ONLY_COST_CENTERS='codea' bun run packages/api/scripts/seed-internal-cost-centers.ts
 *
 * Env:
 *   DATABASE_URL       required (injected by ECS from SSM)
 *   OXY_USERNAME       platform owner username to resolve (default 'oxy')
 *   DRY_RUN=1|true     plan only, no writes
 *   ONLY_COST_CENTERS  comma-separated cost-centre slugs this run may touch.
 *                      Unset seeds the whole list. Set-but-empty, or naming a
 *                      slug that is not registered, ABORTS before any write —
 *                      see `src/scripts/seedEntrySelection.ts`.
 */

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { internalCostCenters } from '../src/db/schema/internalCostCenters';
import { users } from '../src/db/schema/users';
import {
  computeCostCenterPlan,
  INTERNAL_COST_CENTERS,
  type CostCenterObservation,
  type InternalCostCenterSpec,
} from '../src/scripts/internalCostCenterSpecs';
import { selectSeedEntries } from '../src/scripts/seedEntrySelection';
import { accountService } from '../src/services/account.service';
import { listCostCenters, registerCostCenter } from '../src/services/entitlement.service';
import { logger } from '../src/utils/logger';

const DRY_RUN_PLACEHOLDER_ID = '(dry-run-not-minted)';

interface MappingRow {
  slug: string;
  label: string;
  accountId: string;
  createdAccount: boolean;
  registeredCostCenter: boolean;
  changes: string[];
}

async function findPlatformOwner(username: string): Promise<{ id: string } | null> {
  const [owner] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);
  return owner ?? null;
}

/** What the database holds for one spec today. */
async function observe(spec: InternalCostCenterSpec): Promise<CostCenterObservation> {
  const db = getDb();

  const [costCenter] = await db
    .select({
      accountId: internalCostCenters.accountId,
      label: internalCostCenters.label,
      status: internalCostCenters.status,
    })
    .from(internalCostCenters)
    .where(eq(internalCostCenters.slug, spec.name))
    .limit(1);

  const [usernameHolder] = await db
    .select({
      id: users.id,
      kind: users.kind,
      parentAccountId: users.parentAccountId,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${spec.name}))`)
    .limit(1);

  return {
    costCenter: costCenter ?? null,
    usernameHolder: usernameHolder ?? null,
  };
}

/**
 * Mint the project account for a centre.
 *
 * The username IS the slug: an account addressed by one string and a report by
 * another is not a cost centre, it is two records. `computeCostCenterPlan`
 * refuses a collision before reaching this point, and the only remaining way to
 * lose the handle is a row inserted between that observation and this write.
 *
 * That race used to need catching HERE, by reading the stored username back:
 * `createChildAccount` would allocate `codea1` when `codea` was taken and report
 * success. It no longer adapts — a taken handle is a `ConflictError` from the
 * probe and from the lost race alike — so the collision now aborts the run
 * BEFORE the account exists, instead of after. That is strictly better: the
 * read-back could only report an orphan it had already created.
 */
async function createCostCenterAccount(
  spec: InternalCostCenterSpec,
  platformOwnerId: string
): Promise<string> {
  const { account } = await accountService.createChildAccount(platformOwnerId, platformOwnerId, {
    kind: 'project',
    username: spec.name,
    name: { displayName: spec.displayName },
    description: spec.description,
  });

  return account.id;
}

async function seed(specs: readonly InternalCostCenterSpec[]): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const ownerUsername = process.env.OXY_USERNAME || 'oxy';

  if (dryRun) {
    logger.info('DRY RUN — no writes will be performed');
  }

  logger.info('Seeding internal cost centres', {
    selected: specs.map((spec) => spec.name),
    of: INTERNAL_COST_CENTERS.length,
    filtered: specs.length !== INTERNAL_COST_CENTERS.length,
  });

  const owner = await findPlatformOwner(ownerUsername);
  if (!owner) {
    throw new Error(
      `Platform owner "${ownerUsername}" not found — refusing to seed. ` +
        'Set OXY_USERNAME to the correct platform owner username.'
    );
  }
  logger.info('Resolved platform owner', { username: ownerUsername, ownerId: owner.id });

  const mapping: MappingRow[] = [];
  let accountsCreated = 0;
  let accountsAdopted = 0;
  let costCentersRegistered = 0;
  let unchanged = 0;

  for (const spec of specs) {
    const plan = computeCostCenterPlan(spec, await observe(spec), owner.id);

    if (plan.action.kind === 'refuse') {
      // The whole run fails, not just this centre. Partial success is the
      // dangerous outcome: the operator reads "done" and the centre they cared
      // about was never registered.
      throw new Error(`Refusing to seed cost centre "${spec.name}": ${plan.action.reason}`);
    }

    logger.info('Cost centre plan', {
      slug: spec.name,
      action: plan.action.kind,
      changes: plan.changes.map((change) => `${change.field}: ${change.from} → ${change.to}`),
    });

    if (plan.changes.length === 0) {
      unchanged += 1;
    }

    let accountId =
      plan.action.kind === 'create' ? DRY_RUN_PLACEHOLDER_ID : plan.action.accountId;
    let createdAccount = false;
    let registeredCostCenter = false;

    if (!dryRun) {
      if (plan.action.kind === 'create') {
        accountId = await createCostCenterAccount(spec, owner.id);
        createdAccount = true;
        accountsCreated += 1;
      } else if (plan.action.kind === 'adopt') {
        accountsAdopted += 1;
      }

      if (plan.changes.length > 0) {
        // The staff API's own writer, never a second INSERT here: a seed with
        // its own upsert is a second place the slug-uniqueness rule lives.
        const result = await registerCostCenter({
          accountId,
          slug: spec.name,
          label: spec.label,
        });
        switch (result.status) {
          case 'registered':
            registeredCostCenter = true;
            costCentersRegistered += 1;
            break;
          case 'unknown-account':
            throw new Error(
              `Cost centre "${spec.name}" names account ${result.accountId}, which does not ` +
                'exist. Nothing was labelled.'
            );
          case 'slug-taken':
            throw new Error(
              `The slug "${result.slug}" already names a different account. A slug is how ` +
                'historical reports address a cost centre and must never move.'
            );
        }
      }
    } else if (plan.action.kind === 'create') {
      createdAccount = true;
    }

    mapping.push({
      slug: spec.name,
      label: spec.label,
      accountId,
      createdAccount,
      registeredCostCenter,
      changes: plan.changes.map((change) => change.field),
    });
  }

  logger.info('Seed summary', {
    dryRun,
    costCenters: specs.length,
    accountsCreated,
    accountsAdopted,
    costCentersRegistered,
    unchanged,
  });

  // Read-back: what the table actually holds now, retired centres included, so a
  // run that wrote nothing is distinguishable from a run against an empty table.
  const registered = await listCostCenters(true);
  logger.info('Read-back: registered cost centres', {
    count: registered.length,
    slugs: registered.map((center) => center.slug),
  });

  // eslint-disable-next-line no-console
  console.log('OXY_COST_CENTER_MAPPING_JSON=' + JSON.stringify(mapping));
}

async function main(): Promise<void> {
  const specs = selectSeedEntries(INTERNAL_COST_CENTERS, process.env.ONLY_COST_CENTERS, {
    envVar: 'ONLY_COST_CENTERS',
    singular: 'cost centre',
    plural: 'cost centres',
  });

  await connectPostgres();
  logger.info('Connected to Postgres');

  try {
    await seed(specs);
  } finally {
    await closePostgres();
    logger.info('Postgres connection closed');
  }
}

main().catch((error) => {
  logger.error(
    'Cost centre seed failed',
    error instanceof Error ? error : new Error(String(error)),
    { component: 'seed-internal-cost-centers', method: 'main' }
  );
  process.exit(1);
});
