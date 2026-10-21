#!/usr/bin/env bun
/**
 * One-time repair: give every federated ActivityPub account the `kind` its
 * actor declares and the name that kind's policy keeps.
 *
 * Why it exists:
 *   Every federated row was stored as `personal`, and every remote name was
 *   cleaned by the person-name policy, which drops digits and punctuation — so a
 *   Mastodon account named "Acampada26s" was stored as "Acampada s". The import
 *   path now reads the actor `type` and `postingRestrictedToMods` (`accountKindForActor` in
 *   `@oxy.so/federation`, the one actor-type table) and cleans by kind
 *   (`untrustedNameColumns`); a row is repaired whenever it is refreshed, but a
 *   refresh only happens when somebody looks the account up and it is stale, so
 *   rows nobody resolves keep the old kind and name until this runs.
 *
 *   Neither the raw actor `type` nor the uncleaned remote name is stored
 *   anywhere in Oxy, so each actor is RE-FETCHED through the same signed,
 *   SSRF-safe client the refresh uses.
 *
 * Behavior (per row, `type = 'federated'`, not archived, `federation_actor_uri`
 * an `https:` ActivityPub actor — atproto and Instagram Graph sources declare no
 * kind, and their rows are `personal` already):
 *   - Dry run (DEFAULT): fetches the actor with the read-only signing key and
 *     reports the kind and name columns it WOULD write; writes nothing.
 *   - Apply: rows whose stored kind or name differ are re-registered through
 *     `resolveExternalActorIdentity` — the one persistence path every refresh
 *     uses, ownership and proof checks included. Unchanged rows are not touched.
 *     Idempotent: a second pass reports no changes.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/src/scripts/reclassify-federated-accounts.ts            # dry run
 *   bun run packages/api/src/scripts/reclassify-federated-accounts.ts --apply
 *
 * Env:
 *   DATABASE_URL   Postgres (required)
 *   DRY_RUN=false  Same as --apply; anything else is a dry run
 *   BATCH_SIZE     Rows per batch (default 200)
 *   CONCURRENCY    Actors fetched at once (default 4, max 16)
 *   AFTER          Resume after this user id (also `--after=<id>`)
 *   REDIS_URL      Optional; enables the cross-app cache invalidation broadcast
 */

import { and, asc, eq, gt, like, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import { closeRedis } from '../config/redis';
import { users } from '../db/schema/users';
import { federationService } from '../services/federation.service';
import { externalProfileKind } from '../services/federation/externalIdentityPolicy';
import { untrustedNameColumns } from '../utils/displayNameSanitize';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';

export interface ReclassifyFederatedAccountsResult {
  apply: boolean;
  scanned: number;
  /** Rows whose stored kind or name differ from what their actor now yields. */
  changed: number;
  /** Changed rows by `<stored kind>-><actor kind>`. */
  byKind: Record<string, number>;
  /** Rows whose actor could not be fetched, or whose re-registration refused. */
  refused: number;
  /** Resume cursor: the last user id visited. */
  after: string;
}

export interface ReclassifyFederatedAccountsOptions {
  apply?: boolean;
  batchSize?: number;
  concurrency?: number;
  after?: string;
  log?: (line: string) => void;
}

export async function reclassifyFederatedAccounts(
  opts: ReclassifyFederatedAccountsOptions = {},
): Promise<ReclassifyFederatedAccountsResult> {
  const apply = opts.apply === true;
  const batchSize = opts.batchSize ?? 200;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 4, 1), 16);
  const log = opts.log ?? (() => undefined);
  const result: ReclassifyFederatedAccountsResult = {
    apply,
    scanned: 0,
    changed: 0,
    byKind: {},
    refused: 0,
    after: opts.after ?? '',
  };

  for (;;) {
    const rows = await getDb()
      .select({
        id: users.id,
        actorUri: users.federationActorUri,
        kind: users.kind,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        nameDisplay: users.nameDisplay,
      })
      .from(users)
      .where(
        and(
          eq(users.type, 'federated'),
          ne(users.accountStatus, 'archived'),
          like(users.federationActorUri, 'https://%'),
          result.after ? gt(users.id, result.after) : undefined,
        ),
      )
      .orderBy(asc(users.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    await mapWithConcurrency(rows, concurrency, async (row) => {
      const actorUri = row.actorUri ?? '';
      result.scanned += 1;
      try {
        const fetched = await federationService.fetchActorProfileResult(actorUri, undefined, {
          readonlySigningKey: true,
        });
        if (!fetched.ok) {
          result.refused += 1;
          log(JSON.stringify({ userId: row.id, action: 'refused', ...fetched.failure }));
          return;
        }
        const kind = externalProfileKind(fetched.profile) ?? row.kind;
        const next = { kind, ...untrustedNameColumns(fetched.profile.displayName, kind) };
        const changes =
          next.kind !== row.kind ||
          next.nameFirst !== row.nameFirst ||
          next.nameLast !== row.nameLast ||
          next.nameDisplay !== row.nameDisplay;
        if (!changes) return;
        result.changed += 1;
        const transition = `${row.kind}->${kind}`;
        result.byKind[transition] = (result.byKind[transition] ?? 0) + 1;
        if (apply && !(await federationService.resolveExternalActorIdentity(actorUri))) {
          result.refused += 1;
          log(JSON.stringify({ userId: row.id, action: 'refused', reason: 'not_registered' }));
          return;
        }
        log(
          JSON.stringify({
            userId: row.id,
            action: apply ? 'reclassified' : 'would_reclassify',
            from: { kind: row.kind, nameFirst: row.nameFirst, nameDisplay: row.nameDisplay },
            to: next,
          }),
        );
      } catch {
        result.refused += 1;
        log(JSON.stringify({ userId: row.id, action: 'refused', reason: 'unexpected_failure' }));
      }
    });
    result.after = rows[rows.length - 1].id;
  }
  return result;
}

/** The report IS the output of this one-shot: one JSON line per change, then a summary. */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply =
    argv.includes('--apply') || (process.env.DRY_RUN ?? '').trim().toLowerCase() === 'false';
  const afterArg = argv.find((value) => value.startsWith('--after='))?.slice('--after='.length);
  await connectPostgres();
  try {
    const result = await reclassifyFederatedAccounts({
      apply,
      batchSize: positiveInt(process.env.BATCH_SIZE),
      concurrency: positiveInt(process.env.CONCURRENCY),
      after: afterArg ?? process.env.AFTER ?? undefined,
      log: print,
    });
    print(JSON.stringify({ summary: result }));
    if (result.refused) process.exitCode = 2;
  } finally {
    // Resolution invalidates user caches, opening a persistent Redis socket.
    try {
      await closePostgres();
    } finally {
      await closeRedis();
    }
  }
}

if (require.main === module) {
  void main()
    .catch((err: unknown) => {
      console.error(
        `Federated account reclassification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    })
    .then(async () => {
      // Detached avatar work belongs to the server lifecycle; a completed
      // one-shot must terminate once its report is flushed.
      await Promise.all(
        [process.stdout, process.stderr].map(
          (stream) =>
            new Promise<void>((resolve) => {
              stream.write('', () => resolve());
            }),
        ),
      );
      process.exit(process.exitCode ?? 0);
    });
}
