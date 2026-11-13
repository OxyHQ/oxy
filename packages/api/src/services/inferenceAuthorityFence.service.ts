/** Explicit, permanent Oxy admission barrier and content-free legacy-key export.
 * This module has no runtime activation path. Activation is an explicit operator command; export never activates.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@oxy.so/protocol';
import { executeRows } from '@oxy.so/db';
import type { InferenceEnvironment } from '@oxy.so/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../config/postgres';
import { inferenceAuthorityFences } from '../db/schema/inferenceAuthorityFences';
import { applications } from '../db/schema/applications';
import { INTERNAL_METERED_RELATIONSHIPS } from '../config/inferenceEconomicPolicy';
import { readMeteredCapacity } from './inferenceCapacity.service';
import { readApplicationInferenceLimits } from './applicationInferenceLimits.service';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { resolveLiveAgencyWorkloadByHandle } from './agencyServicePrincipal.service';

export interface InferenceAuthorityPopulation {
  readonly applicationId: string;
  readonly ownerAccountId: string;
  readonly environment: InferenceEnvironment;
  readonly credentialKind: 'application';
}

export function isInferenceAuthorityFenceError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if (Reflect.get(current, 'code') === 'P0AF1') return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

async function lock(tx: Transaction, p: InferenceAuthorityPopulation): Promise<void> {
  await tx.execute(
    sql`select oxy_inference_authority_lock(${p.applicationId}, ${p.ownerAccountId}, ${p.environment})`,
  );
}

const populationWhere = (p: InferenceAuthorityPopulation) =>
  and(
    eq(inferenceAuthorityFences.applicationId, p.applicationId),
    eq(inferenceAuthorityFences.ownerAccountId, p.ownerAccountId),
    eq(inferenceAuthorityFences.environment, p.environment),
    eq(inferenceAuthorityFences.credentialKind, p.credentialKind),
  );

/** The same live identity verifier used by authenticated service requests.
 * The attribution row's status, expiry and environment are inert history.
 */
async function eligibleWorkloadCredentials(
  tx: Transaction,
  p: InferenceAuthorityPopulation,
): Promise<string[]> {
  const candidates = await tx
    .select({ id: applicationCredentials.id })
    .from(applicationCredentials)
    .where(
      and(
        eq(applicationCredentials.applicationId, p.applicationId),
        eq(applicationCredentials.type, 'workload'),
      ),
    );
  const eligible: string[] = [];
  const now = new Date();
  for (const candidate of candidates) {
    const principal = await resolveLiveAgencyWorkloadByHandle(
      p.applicationId,
      candidate.id,
      now,
      tx,
    );
    if (principal?.ownerAccountId === p.ownerAccountId && principal.environment === p.environment)
      eligible.push(candidate.id);
  }
  return eligible.sort();
}

/** Only reviewed operator execution calls this. No automatic policy enrollment. */
export async function activateInferenceAuthorityFence(p: InferenceAuthorityPopulation) {
  return getDb().transaction(async (tx) => {
    await lock(tx, p);
    const [application] = await tx
      .select({ owner: applications.ownerAccountId })
      .from(applications)
      .where(eq(applications.id, p.applicationId))
      .for('share');
    if (application?.owner !== p.ownerAccountId) throw new Error('Application ownership mismatch');
    if ((await eligibleWorkloadCredentials(tx, p)).length === 0) {
      throw new Error('No matching active first-party workload population');
    }
    await dailyLimit(tx, p);
    await tx.insert(inferenceAuthorityFences).values(p).onConflictDoNothing();
    const [fence] = await tx.select().from(inferenceAuthorityFences).where(populationWhere(p));
    if (!fence) throw new Error('Admission fence was not persisted');
    return fence;
  });
}

export interface LegacyInferenceFenceEntry {
  readonly credentialId: string;
  readonly keyKind: 'idempotency_key' | 'request_id';
  readonly key: string;
  readonly legacyAdmissionId: string;
  readonly requestId: string;
  readonly bodyDigest: null;
  readonly digestDomain: 'unknown';
}

type LegacyRow = {
  credential_id: string;
  ledger_key: string;
  legacy_id: string;
  request_id: string;
};

/** Exact prefixes only; an unrecognized ledger key prevents an incomplete export. */
export function legacyInferenceFenceEntries(
  rows: readonly LegacyRow[],
): LegacyInferenceFenceEntry[] {
  const entries = new Map<string, LegacyInferenceFenceEntry>();
  const add = (row: LegacyRow, keyKind: LegacyInferenceFenceEntry['keyKind'], key: string) => {
    const identity = canonicalize([row.credential_id, keyKind, key]);
    const entry: LegacyInferenceFenceEntry = {
      credentialId: row.credential_id,
      keyKind,
      key,
      legacyAdmissionId: row.legacy_id,
      requestId: row.request_id,
      bodyDigest: null,
      digestDomain: 'unknown',
    };
    const existing = entries.get(identity);
    if (
      existing &&
      (existing.requestId !== entry.requestId ||
        existing.legacyAdmissionId !== entry.legacyAdmissionId)
    ) {
      throw new Error('Conflicting legacy idempotency ownership');
    }
    entries.set(identity, entry);
  };
  for (const row of rows) {
    const prefix = `oxy-edge:idem:${row.credential_id}:`;
    if (row.ledger_key.startsWith(prefix) && row.ledger_key.length > prefix.length) {
      add(row, 'idempotency_key', row.ledger_key.slice(prefix.length));
    } else if (
      row.ledger_key !== `oxy-edge:req:${row.request_id}` &&
      row.ledger_key !== `kaana-grant:req:${row.request_id}`
    ) {
      throw new Error('Unrecognized legacy idempotency namespace');
    }
    add(row, 'request_id', row.request_id);
  }
  return [...entries.values()].sort((a, b) => {
    const left = canonicalize([a.credentialId, a.keyKind, a.key]);
    const right = canonicalize([b.credentialId, b.keyKind, b.key]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** The source relationship and Console settings are read, never guessed from a product name. */
async function dailyLimit(tx: Transaction, p: InferenceAuthorityPopulation): Promise<number> {
  const relationships = INTERNAL_METERED_RELATIONSHIPS.filter(
    (relationship) =>
      relationship.consumerApplicationId === p.applicationId &&
      relationship.environments.includes(p.environment) &&
      relationship.lane === 'service_token',
  );
  const relationship = relationships[0];
  if (relationships.length !== 1 || !relationship || relationship.capacity.scope !== undefined)
    throw new Error('A unique reviewed application-wide daily limit is required');
  const consoleLimits = await readApplicationInferenceLimits(p.applicationId, tx);
  const limit = consoleLimits.maxRequestsPerUtcDay ?? relationship.capacity.maxRequestsPerUtcDay;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid reviewed daily limit');
  return limit;
}

/** Actual terminal status, never wall-clock expiry, establishes drain completion. */
export async function exportInferenceAuthorityFence(p: InferenceAuthorityPopulation) {
  return getDb().transaction(
    async (tx) => {
      const [fence] = await tx.select().from(inferenceAuthorityFences).where(populationWhere(p));
      if (!fence) throw new Error('Activate and drain the exact population before exporting');
      const [clock] = await executeRows<{ at: string; day: string }>(
        tx,
        sql`
        select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
          to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day`,
      );
      if (!clock) throw new Error('Missing database snapshot clock');
      const capacity = await readMeteredCapacity(tx, p.applicationId, p.environment);
      const dailyUsage = {
        scope: 'application_environment' as const,
        utcDay: clock.day,
        admitted: capacity.dailyAdmissions,
        maxRequestsPerUtcDay: await dailyLimit(tx, p),
      };
      const [counts] = await executeRows<{ admissions: number; grants: number; holds: number }>(
        tx,
        sql`
      select
        (select count(*)::int from inference_metered_usage where application_id = ${p.applicationId}
          and environment = ${p.environment}
          and status = 'admitted') as admissions,
        (select count(*)::int from kaana_grants where application_id = ${p.applicationId}
          and environment = ${p.environment}
          and status = 'issued') as grants,
        (select count(*)::int from usage_reservations where application_id = ${p.applicationId}
          and environment = ${p.environment}
          and status = 'held') as holds`,
      );
      if (counts?.admissions !== 0 || counts.grants !== 0 || counts.holds !== 0) {
        throw new Error('Legacy admissions, grants or holds remain unresolved');
      }
      const rows = await executeRows<LegacyRow>(
        tx,
        sql`
      with metered as (select id, application_credential_id, idempotency_key, request_id
        from inference_metered_usage where application_id = ${p.applicationId}
          and environment = ${p.environment}
          and status <> 'refused')
      select application_credential_id as credential_id, idempotency_key as ledger_key,
        'metered:' || id as legacy_id, request_id from metered
      union all
      select r.application_credential_id, r.idempotency_key,
        coalesce('metered:' || m.id, 'reservation:' || r.id), r.request_id
      from usage_reservations r left join metered m on m.idempotency_key = r.idempotency_key
      where r.application_id = ${p.applicationId}
        and r.environment = ${p.environment}
      union all
      select g.application_credential_id, m.idempotency_key, 'metered:' || m.id, g.request_id
      from kaana_grants g join inference_metered_usage m on m.id = g.metered_usage_id
      where g.application_id = ${p.applicationId}
        and g.environment = ${p.environment} `,
      );
      // Enrollment is narrower than the historical tombstone population: only
      // currently verified live workload handles may authorize a new native policy.
      const credentialIds = await eligibleWorkloadCredentials(tx, p);
      const manifest = {
        schemaVersion: 2 as const,
        authority: 'oxy' as const,
        fenceId: fence.id,
        activatedAt: fence.createdAt.toISOString(),
        exportedAt: clock.at,
        dailyUsage,
        population: { ...p, credentialIds },
        unresolved: counts,
        entries: legacyInferenceFenceEntries(rows),
      };
      return {
        ...manifest,
        sha256: createHash('sha256').update(canonicalize(manifest)).digest('hex'),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
