/**
 * End the device (QR) sign-ins a non-official application received before
 * #2215 (`src/services/thirdPartyDeviceSignInRevocation.ts`). An OWNER step,
 * run once against production after the release that ships it, as a one-off
 * ECS task on the API's task definition:
 *
 *   bun run packages/api/scripts/revoke-third-party-device-signins.ts            # dry run
 *   bun run packages/api/scripts/revoke-third-party-device-signins.ts --apply    # writes
 *
 * `--auth-sessions-only` uses the precise `auth_sessions` record alone and
 * skips the durable session-label records.
 *
 * Before #2215 a third party's device sign-in ended in a session with no
 * application binding plus a device restore secret; both pass
 * `requireFirstPartyDeviceAccess`. This signs every account out of each such
 * device, revokes its restore secrets and ends its sessions, and writes one
 * entry on each affected account's security trail. It prints COUNTS only —
 * never an account, device, session, key or token. Idempotent.
 */
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { closeRedis, getRedisClient } from '../src/config/redis';
import { revokeThirdPartyDeviceSignIns } from '../src/services/thirdPartyDeviceSignInRevocation';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const authSessionsOnly = process.argv.includes('--auth-sessions-only');
  await connectPostgres();
  // Every ended session is announced to every API task's cache over Redis
  // (when configured); connect first so the shared tier is cleared too. Without
  // it, a cached session lives at most the cache's five minutes.
  await getRedisClient()
    ?.connect()
    .catch(() => undefined);
  try {
    const report = await revokeThirdPartyDeviceSignIns(getDb(), { apply, authSessionsOnly });
    console.log(JSON.stringify({ ...report, authSessionsOnly }));
  } finally {
    // The revocations are announced over Redis (when configured): close it so
    // the task exits.
    await closeRedis();
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'revocation failed');
  process.exitCode = 1;
});
