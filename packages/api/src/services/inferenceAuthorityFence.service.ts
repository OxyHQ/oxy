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

export interface InferenceAuthorityPopulation {
  readonly applicationId: string;
  readonly ownerAccountId: string;
  readonly environment: InferenceEnvironment;
  readonly credentialKind: 'workload';
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

/** Only reviewed operator execution calls this. No automatic policy enrollment. */
export async function activateInferenceAuthorityFence(p: InferenceAuthorityPopulation) {
  return getDb().transaction(async (tx) => {
    await lock(tx, p);
    const [valid] = await executeRows<{ present: boolean }>(
      tx,
      sql`
      select exists (select 1 from applications a
        join application_credentials c on c.application_id = a.id
        join application_workload_identities w on w.id = c.workload_identity_id
        where a.id = ${p.applicationId} and a.owner_account_id = ${p.ownerAccountId}
          and a.status = 'active' and (a.type in ('internal', 'first_party', 'system') or a.is_internal = true)
          and c.type = 'workload' and c.environment = ${p.environment} and c.status = 'active'
          and (c.expires_at is null or c.expires_at > now())
          and w.application_id = a.id and w.environment = ${p.environment}
          and (w.expires_at is null or w.expires_at > now())) as present`,
    );
    if (!valid?.present) throw new Error('No matching active first-party workload population');
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

/** Actual terminal status, never wall-clock expiry, establishes drain completion. */
export async function exportInferenceAuthorityFence(p: InferenceAuthorityPopulation) {
  return getDb().transaction(
    async (tx) => {
      const [fence] = await tx.select().from(inferenceAuthorityFences).where(populationWhere(p));
      if (!fence) throw new Error('Activate and drain the exact population before exporting');
      const [counts] = await executeRows<{ admissions: number; grants: number; holds: number }>(
        tx,
        sql`
      with credentials as (select id from application_credentials where type = 'workload')
      select
        (select count(*)::int from inference_metered_usage where application_id = ${p.applicationId}
          and account_id = ${p.ownerAccountId} and environment = ${p.environment}
          and application_credential_id in (select id from credentials) and status = 'admitted') as admissions,
        (select count(*)::int from kaana_grants where application_id = ${p.applicationId}
          and account_id = ${p.ownerAccountId} and environment = ${p.environment}
          and application_credential_id in (select id from credentials) and status = 'issued') as grants,
        (select count(*)::int from usage_reservations where application_id = ${p.applicationId}
          and account_id = ${p.ownerAccountId} and environment = ${p.environment}
          and application_credential_id in (select id from credentials) and status = 'held') as holds`,
      );
      if (counts?.admissions !== 0 || counts.grants !== 0 || counts.holds !== 0) {
        throw new Error('Legacy admissions, grants or holds remain unresolved');
      }
      const rows = await executeRows<LegacyRow>(
        tx,
        sql`
      with credentials as (select id from application_credentials where type = 'workload'),
      metered as (select id, application_credential_id, idempotency_key, request_id
        from inference_metered_usage where application_id = ${p.applicationId}
          and account_id = ${p.ownerAccountId} and environment = ${p.environment}
          and application_credential_id in (select id from credentials) and status <> 'refused')
      select application_credential_id as credential_id, idempotency_key as ledger_key,
        'metered:' || id as legacy_id, request_id from metered
      union all
      select r.application_credential_id, r.idempotency_key,
        coalesce('metered:' || m.id, 'reservation:' || r.id), r.request_id
      from usage_reservations r left join metered m on m.idempotency_key = r.idempotency_key
      where r.application_id = ${p.applicationId} and r.account_id = ${p.ownerAccountId}
        and r.environment = ${p.environment} and r.application_credential_id in (select id from credentials)
      union all
      select g.application_credential_id, m.idempotency_key, 'metered:' || m.id, g.request_id
      from kaana_grants g join inference_metered_usage m on m.id = g.metered_usage_id
      where g.application_id = ${p.applicationId} and g.account_id = ${p.ownerAccountId}
        and g.environment = ${p.environment} and g.application_credential_id in (select id from credentials)`,
      );
      // Enrollment is narrower than the historical tombstone population: only
      // currently verified live workload handles may authorize a new native policy.
      const eligible = await executeRows<{ id: string }>(
        tx,
        sql`
        select c.id from application_credentials c
        join application_workload_identities w on w.id = c.workload_identity_id
        join applications a on a.id = c.application_id
        where a.id = ${p.applicationId} and a.owner_account_id = ${p.ownerAccountId}
          and a.status = 'active' and (a.type in ('internal', 'first_party', 'system') or a.is_internal = true)
          and c.type = 'workload' and c.environment = ${p.environment} and c.status = 'active'
          and (c.expires_at is null or c.expires_at > now())
          and w.application_id = a.id and w.environment = ${p.environment}
          and (w.expires_at is null or w.expires_at > now())`,
      );
      const credentialIds = eligible.map(({ id }) => id).sort();
      const manifest = {
        schemaVersion: 1 as const,
        authority: 'oxy' as const,
        fenceId: fence.id,
        activatedAt: fence.createdAt.toISOString(),
        exportedAt: new Date().toISOString(),
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
