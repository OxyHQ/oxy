/**
 * Moving a capability catalog to the application that serves it now.
 *
 * A catalog namespace (`appSlug`) belongs to the first application that
 * registers it (`registerCapabilityCatalog` refuses anybody else), which is
 * what stops one service publishing tools under another's name. When the
 * tools move — Noted's notes, and so its `noted` catalog, now served by Nilo —
 * that ownership has to move with them, deliberately: grants, Alia's tool
 * references and an MCP client's resource all name the namespace, and a new
 * one would strand every one of them.
 *
 * The move is a staff act, run from a terminal against the environment's
 * database (`scripts/transfer-capability-catalog.ts`), like a workload binding.
 * It refuses a target that is not an active application holding the
 * staff-granted `catalog:<slug>` capability, so it can never hand a namespace
 * to a service that could not have registered it. Every registration of the
 * namespace moves, current and past, so the next registration by the new
 * owner is accepted and the old owner can neither register nor introspect or
 * audit tickets under it any more. Re-running is a no-op.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appCapabilityCatalogRegistrations } from '../db/schema/agency';
import { applications } from '../db/schema/applications';
import {
  catalogApplicationCapability,
  hasApplicationCapability,
} from '../utils/applicationCapabilities';

export type CatalogTransferRefusal =
  | 'unknown_catalog'
  | 'unknown_application'
  | 'inactive_application'
  | 'missing_catalog_capability';

export class CatalogTransferError extends Error {
  constructor(
    readonly reason: CatalogTransferRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogTransferError';
  }
}

export interface CatalogTransferResult {
  appSlug: string;
  toApplicationId: string;
  /** The applications that owned registrations of the namespace before. */
  previousOwners: string[];
  /** Registrations whose owner changed (or would, on a dry run). */
  moved: number;
  outcome: 'transferred' | 'unchanged';
  dryRun: boolean;
}

export async function transferCapabilityCatalogOwnership(input: {
  appSlug: string;
  toApplicationId: string;
  dryRun?: boolean;
}): Promise<CatalogTransferResult> {
  const capability = catalogApplicationCapability(input.appSlug);
  const dryRun = input.dryRun === true;
  return getDb().transaction(async (tx) => {
    // The lock `registerCapabilityCatalog` takes: no registration interleaves.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`capability-catalog:${input.appSlug}`}, 0))`,
    );
    const [target] = await tx
      .select({
        id: applications.id,
        status: applications.status,
        capabilities: applications.capabilities,
      })
      .from(applications)
      .where(eq(applications.id, input.toApplicationId))
      .limit(1);
    if (!target) {
      throw new CatalogTransferError(
        'unknown_application',
        `No application ${input.toApplicationId}`,
      );
    }
    if (target.status !== 'active') {
      throw new CatalogTransferError(
        'inactive_application',
        `Application ${target.id} is ${target.status}`,
      );
    }
    if (!hasApplicationCapability(target, capability)) {
      throw new CatalogTransferError(
        'missing_catalog_capability',
        `Application ${target.id} does not hold ${capability}`,
      );
    }

    const owners = await tx
      .selectDistinct({ id: appCapabilityCatalogRegistrations.registeredByApplicationId })
      .from(appCapabilityCatalogRegistrations)
      .where(eq(appCapabilityCatalogRegistrations.appSlug, input.appSlug));
    if (owners.length === 0) {
      throw new CatalogTransferError(
        'unknown_catalog',
        `No registration of the ${input.appSlug} catalog`,
      );
    }
    const previousOwners = owners.map((owner) => owner.id).sort();
    const others = and(
      eq(appCapabilityCatalogRegistrations.appSlug, input.appSlug),
      ne(appCapabilityCatalogRegistrations.registeredByApplicationId, target.id),
    );
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(appCapabilityCatalogRegistrations)
      .where(others);
    if (count > 0 && !dryRun) {
      await tx
        .update(appCapabilityCatalogRegistrations)
        .set({ registeredByApplicationId: target.id, updatedAt: new Date() })
        .where(others);
    }
    return {
      appSlug: input.appSlug,
      toApplicationId: target.id,
      previousOwners,
      moved: count,
      outcome: count > 0 ? 'transferred' : 'unchanged',
      dryRun,
    };
  });
}

/** `--app-id <slug> --to-application-id <id> [--dry-run]`. */
export function parseTransferCatalogArgv(argv: readonly string[]): {
  appSlug: string;
  toApplicationId: string;
  dryRun: boolean;
} {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const [flag, inline] = arg.split('=', 2) as [string, string | undefined];
    if (flag !== '--app-id' && flag !== '--to-application-id') {
      throw new Error(`Unknown argument ${arg}`);
    }
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
  }
  const appSlug = values.get('--app-id');
  const toApplicationId = values.get('--to-application-id');
  if (!appSlug || !toApplicationId) {
    throw new Error(
      'Usage: transfer-capability-catalog.ts --app-id <slug> --to-application-id <id> [--dry-run]',
    );
  }
  catalogApplicationCapability(appSlug);
  return { appSlug, toApplicationId, dryRun };
}
