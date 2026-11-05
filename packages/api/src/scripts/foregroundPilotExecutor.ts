/** Cleanup of historical I05 credentials only; never creates scope-based workload authority. */
import { closePostgres, connectPostgres } from '../config/postgres';
import {
  type ForegroundPilotPlan,
  retireEphemeralRegistrarCredentials,
} from './foregroundPilotConfiguration';

export async function main(args = process.argv.slice(2)) {
  const [operation, encoded, ...rest] = args;
  if (operation !== 'retire')
    throw new Error(
      'I05 provisioning and rollback are retired; only bounded credential retirement remains.',
    );
  if (!encoded || rest.length || encoded.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error('I05 exact retirement operation and base64url historical plan required');
  const plan = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as ForegroundPilotPlan;
  try {
    await connectPostgres();
    await retireEphemeralRegistrarCredentials(plan);
    console.log(
      JSON.stringify({
        kind: 'i05-foreground-operation',
        nonce: plan.nonce,
        operation,
        status: 'confirmed',
      }),
    );
  } finally {
    await closePostgres();
  }
}
if (require.main === module) {
  void main().catch(() => {
    console.error('I05_FOREGROUND_OPERATION_FAILED_RECONCILE_REQUIRED');
    process.exitCode = 1;
  });
}
