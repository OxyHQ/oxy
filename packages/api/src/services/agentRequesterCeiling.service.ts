/**
 * Agent requester ceilings (ADR 0042) — what an agent may do in one app for
 * WHOEVER uses it, published by a person who operates the agent's bot.
 *
 * A ceiling is the same shape as a delegation grant's authority (packages,
 * explicit capabilities, tool overrides, limits, autonomy) and is validated by
 * the same `capabilityGrantError`, at the catalogue's account root: there is one
 * rule for "may this tool run" whether the bound came from an owner's grant or
 * from an owner's ceiling. What differs is WHOSE data it reaches: a grant
 * reaches the granting owner's resource; a ceiling reaches only the account of
 * the person present, and only when that person's own execution authorization
 * names it.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  AgentRequesterCeiling,
  AgentRequesterCeilingWrite,
  AppCapabilityCatalog,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import {
  agentRequesterCeilings,
  appCapabilityCatalogRegistrations,
  type AgentRequesterCeilingRow,
} from '../db/schema/agency';
import { activeCapabilityCatalog } from './capabilityCatalog.service';
import { capabilityGrantError } from './capabilityGrantPolicy';

export interface LiveCeiling {
  row: AgentRequesterCeilingRow;
  /** The catalogue the ceiling was written against, for tool-shape checks on overrides. */
  boundCatalog: AppCapabilityCatalog;
}

export type CeilingWriteResult =
  | { ok: true; ceiling: AgentRequesterCeiling; created: boolean }
  | { ok: false; error: string };

async function bindingOf(registrationId: string) {
  const [registration] = await getDb()
    .select({
      id: appCapabilityCatalogRegistrations.id,
      version: appCapabilityCatalogRegistrations.version,
      digest: appCapabilityCatalogRegistrations.digest,
    })
    .from(appCapabilityCatalogRegistrations)
    .where(eq(appCapabilityCatalogRegistrations.id, registrationId))
    .limit(1);
  if (!registration) throw new Error(`Catalogue registration ${registrationId} is missing`);
  return {
    registrationId: registration.id,
    version: registration.version,
    digest: registration.digest,
  };
}

export async function ceilingContract(
  row: AgentRequesterCeilingRow,
): Promise<AgentRequesterCeiling> {
  return {
    id: row.id,
    agentAccountId: row.agentAccountId,
    appId: row.appSlug,
    catalog: await bindingOf(row.catalogRegistrationId),
    capabilityPackages: row.capabilityPackages,
    capabilities: row.capabilities,
    toolOverrides: row.toolOverrides,
    limits: row.limits,
    maximumAutonomy: row.maximumAutonomy,
    version: row.version,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Publish (or replace) the ceiling for one agent and app. The caller has
 * already proved the operator holds `account:act_as` over the bot.
 */
export async function writeAgentRequesterCeiling(input: {
  agentAccountId: string;
  appId: string;
  ceiling: AgentRequesterCeilingWrite;
  operatorAccountId: string;
}): Promise<CeilingWriteResult> {
  const registration = await activeCapabilityCatalog(input.appId);
  if (!registration) return { ok: false, error: 'catalog_not_registered' };
  const error = capabilityGrantError(
    {
      resourceType: registration.catalog.accountResourceType,
      capabilityPackages: input.ceiling.capabilityPackages,
      capabilities: input.ceiling.capabilities,
      toolOverrides: input.ceiling.toolOverrides,
      limits: input.ceiling.limits,
      maximumAutonomy: input.ceiling.maximumAutonomy,
    },
    registration.catalog,
  );
  if (error) return { ok: false, error };

  const values = {
    catalogRegistrationId: registration.id,
    capabilityPackages: [...new Set(input.ceiling.capabilityPackages)],
    capabilities: [...new Set(input.ceiling.capabilities)],
    toolOverrides: input.ceiling.toolOverrides,
    limits: input.ceiling.limits,
    maximumAutonomy: input.ceiling.maximumAutonomy,
    updatedByUserId: input.operatorAccountId,
  };
  const { row, created } = await getDb().transaction(async (tx) => {
    const [live] = await tx
      .select({ id: agentRequesterCeilings.id, version: agentRequesterCeilings.version })
      .from(agentRequesterCeilings)
      .where(
        and(
          eq(agentRequesterCeilings.agentAccountId, input.agentAccountId),
          eq(agentRequesterCeilings.appSlug, input.appId),
          isNull(agentRequesterCeilings.revokedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (live) {
      const revokedAt = new Date();
      const [revoked] = await tx
        .update(agentRequesterCeilings)
        .set({ revokedAt, updatedByUserId: input.operatorAccountId })
        .where(eq(agentRequesterCeilings.id, live.id))
        .returning({ id: agentRequesterCeilings.id });
      if (!revoked) throw new Error('Agent requester ceiling was not revoked');

      const [replacement] = await tx
        .insert(agentRequesterCeilings)
        .values({
          ...values,
          agentAccountId: input.agentAccountId,
          appSlug: input.appId,
          version: live.version + 1,
          createdByUserId: input.operatorAccountId,
        })
        .returning();
      if (!replacement) throw new Error('Agent requester ceiling replacement was not persisted');
      return { row: replacement, created: false };
    }
    const [inserted] = await tx
      .insert(agentRequesterCeilings)
      .values({
        ...values,
        agentAccountId: input.agentAccountId,
        appSlug: input.appId,
        createdByUserId: input.operatorAccountId,
      })
      .returning();
    if (!inserted) throw new Error('Agent requester ceiling was not persisted');
    return { row: inserted, created: true };
  });
  return { ok: true, ceiling: await ceilingContract(row), created };
}

/** Revoke the live ceiling; the row stays so tickets that named it are refused by id. */
export async function revokeAgentRequesterCeiling(
  agentAccountId: string,
  appId: string,
): Promise<boolean> {
  const revoked = await getDb()
    .update(agentRequesterCeilings)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentRequesterCeilings.agentAccountId, agentAccountId),
        eq(agentRequesterCeilings.appSlug, appId),
        isNull(agentRequesterCeilings.revokedAt),
      ),
    )
    .returning({ id: agentRequesterCeilings.id });
  return revoked.length > 0;
}

export async function listLiveAgentRequesterCeilings(
  agentAccountId: string,
): Promise<AgentRequesterCeilingRow[]> {
  return getDb()
    .select()
    .from(agentRequesterCeilings)
    .where(
      and(
        eq(agentRequesterCeilings.agentAccountId, agentAccountId),
        isNull(agentRequesterCeilings.revokedAt),
      ),
    )
    .orderBy(asc(agentRequesterCeilings.appSlug));
}

/** The live ceiling with this id, with the catalogue it was written against; `null` once revoked. */
export async function loadLiveCeiling(ceilingId: string): Promise<LiveCeiling | null> {
  const [found] = await getDb()
    .select({ row: agentRequesterCeilings, catalog: appCapabilityCatalogRegistrations.catalog })
    .from(agentRequesterCeilings)
    .innerJoin(
      appCapabilityCatalogRegistrations,
      eq(appCapabilityCatalogRegistrations.id, agentRequesterCeilings.catalogRegistrationId),
    )
    .where(and(eq(agentRequesterCeilings.id, ceilingId), isNull(agentRequesterCeilings.revokedAt)))
    .limit(1);
  return found ? { row: found.row, boundCatalog: found.catalog } : null;
}
