#!/usr/bin/env bun
/**
 * Revoke named service credentials whose service now authenticates as its
 * workload (ADR 0026) — the last step of retiring a key pair.
 *
 * Deleting a pair's SSM parameters removes the deployed copy of its secret, but
 * the credential row stays `active`: any copy that ever left SSM (a laptop, a
 * CI log, a backup) would still mint a service token. This script is the
 * auditable way to close that, one exact credential id at a time.
 *
 * ## What it refuses
 *
 *   * An id that is not a `service` credential. Public clients, confidential
 *     OAuth clients and workload rows are someone else's lifecycle.
 *   * A credential used within `MIN_IDLE_MINUTES` (default 60). Something still
 *     presenting the key is a consumer this retirement has not accounted for;
 *     stop and find it rather than break it.
 *   * Any refusal refuses the whole batch: it runs in one transaction.
 *
 * An already-revoked id is reported and left alone, so a re-run is a no-op.
 *
 * ## Running it
 *
 *   CREDENTIAL_IDS=<id>,<id> ACTOR_USER_ID=<staff account> \
 *   REASON="<why>" bun run packages/api/scripts/retire-service-credentials.ts
 *
 * Without `APPLY=true` it is a dry run: it reports what it would revoke and
 * writes nothing. With it, each revocation and its `revoked` audit event land
 * in the same transaction. Nothing it prints is a secret.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { applicationCredentials } from '../src/db/schema/applicationCredentials';
import { recordCredentialLifecycleEvent } from '../src/services/applicationCredentialAudit.service';

const RESULT_PREFIX = 'RETIRE_SERVICE_CREDENTIALS_RESULT=';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function credentialIds(): string[] {
  const ids = [
    ...new Set(
      required('CREDENTIAL_IDS')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) throw new Error('CREDENTIAL_IDS names no credential');
  return ids;
}

function minIdleMinutes(): number {
  const raw = process.env.MIN_IDLE_MINUTES?.trim();
  if (!raw) return 60;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('MIN_IDLE_MINUTES must be a non-negative integer');
  }
  return value;
}

interface Outcome {
  id: string;
  disposition: 'revoke' | 'already_revoked';
}

async function main(): Promise<void> {
  const ids = credentialIds();
  const actorUserId = required('ACTOR_USER_ID');
  const reason = required('REASON');
  const apply = process.env.APPLY === 'true';
  const idleCutoff = new Date(Date.now() - minIdleMinutes() * 60_000);

  await connectPostgres();
  const outcomes = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select({
        id: applicationCredentials.id,
        applicationId: applicationCredentials.applicationId,
        type: applicationCredentials.type,
        status: applicationCredentials.status,
        environment: applicationCredentials.environment,
        lastUsedAt: applicationCredentials.lastUsedAt,
      })
      .from(applicationCredentials)
      .where(inArray(applicationCredentials.id, ids))
      .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));

    const planned: Outcome[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw new Error(`Credential ${id} does not exist`);
      if (row.type !== 'service') {
        throw new Error(`Credential ${id} is a ${row.type} credential, not a service one`);
      }
      if (row.status === 'revoked') {
        planned.push({ id, disposition: 'already_revoked' });
        continue;
      }
      if (row.lastUsedAt && row.lastUsedAt > idleCutoff) {
        throw new Error(
          `Credential ${id} was used at ${row.lastUsedAt.toISOString()}; something still presents it`,
        );
      }
      planned.push({ id, disposition: 'revoke' });
    }

    if (apply) {
      for (const outcome of planned) {
        if (outcome.disposition !== 'revoke') continue;
        const row = byId.get(outcome.id);
        if (!row) continue;
        await tx
          .update(applicationCredentials)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(applicationCredentials.id, row.id),
              eq(applicationCredentials.applicationId, row.applicationId),
            ),
          );
        await recordCredentialLifecycleEvent(tx, {
          applicationId: row.applicationId,
          credentialId: row.id,
          eventType: 'revoked',
          actorUserId,
          environment: row.environment,
          metadata: { reason, retiredFor: 'workload_identity' },
        });
      }
    }
    return planned;
  });

  console.log(
    RESULT_PREFIX + JSON.stringify({ mode: apply ? 'apply' : 'dry-run', credentials: outcomes }),
  );
}

main()
  .catch((error: unknown) => {
    console.log(
      RESULT_PREFIX +
        JSON.stringify({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    process.exitCode = 1;
  })
  .finally(() => closePostgres());
