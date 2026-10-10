#!/usr/bin/env bun
/** Explicit operator-only two-row reconciliation. No HTTP route calls this. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { z } from 'zod';
import { connectPostgres, closePostgres } from '../src/config/postgres';
import {
  applyMercariaBillingAuthority,
  prepareMercariaBillingAuthority,
  rollbackMercariaBillingAuthority,
} from '../src/services/mercariaBillingAuthority.service';
const target = {
  applicationId: '6a37d0cc5d4b5f15482a9340',
  credentialId: '01a061cd-39a9-7bd6-ba31-70ef7590c953',
  ownerAccountId: '69b2d3df5d12f58c9800d651',
};
const row = z
  .object({
    scopes: z.array(z.string()),
    version: z.string().regex(/^\d+$/),
    updatedAt: z.string().min(1),
  })
  .strict();
const state = z.object({ application: row, credential: row }).strict();
const plan = z
  .object({
    kind: z.literal('mercaria-billing-authority-v1'),
    target: z
      .object({
        applicationId: z.literal(target.applicationId),
        credentialId: z.literal(target.credentialId),
        ownerAccountId: z.literal(target.ownerAccountId),
      })
      .strict(),
    before: state,
  })
  .strict();
const receipt = plan
  .extend({
    operation: z.literal('apply'),
    actor: z.string().min(1),
    after: state,
  })
  .strict();
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('invalid_operator_invocation');
  return value;
}
async function main() {
  const mode = z.enum(['prepare', 'apply', 'rollback']).parse(process.argv[2]);
  // AWS identity is verified by STS, not claimed through a user/account ID. This
  // is attribution for an already authorized DB operator, not an IAM→DB grant.
  const identity = z.object({ Account: z.literal('237343248947'), Arn: z.string().min(1) }).parse(
    JSON.parse(
      execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
  );
  if (identity.Arn !== required('EXPECTED_OPERATOR_ARN'))
    throw new Error('operator_identity_mismatch');
  const actor = { isPlatformStaff: true, describedAs: identity.Arn };
  let input: unknown;
  if (mode !== 'prepare') {
    const bytes = readFileSync(required('AUTHORITY_INPUT'));
    if (createHash('sha256').update(bytes).digest('hex') !== required('AUTHORITY_INPUT_SHA256'))
      throw new Error('input_hash_mismatch');
    input = JSON.parse(bytes.toString());
  }
  // Reserve before DB work, refuse overwrite. Pending survives uncertain commit
  // or receipt-write failure; it must be reconciled read-only, never auto-retried.
  const fd = openSync(required('AUTHORITY_OUTPUT'), 'wx', 0o600);
  let resultFd: number | undefined;
  try {
    resultFd = openSync(`${required('AUTHORITY_OUTPUT')}.result.json`, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify({ pending: true, mode, actor: identity.Arn, target })}\n`);
    fsyncSync(fd);
    await connectPostgres();
    const result =
      mode === 'prepare'
        ? await prepareMercariaBillingAuthority(target, actor)
        : mode === 'apply'
          ? await applyMercariaBillingAuthority(plan.parse(input), actor)
          : await rollbackMercariaBillingAuthority(receipt.parse(input), actor);
    // Separate immutable result, so the pending receipt is never mistaken for a
    // completed plan if the process terminates between commit and write/fsync.
    writeSync(resultFd, `${JSON.stringify(result, null, 2)}\n`);
    fsyncSync(resultFd);
    process.stdout.write(`MERCARIA_AUTHORITY_OK ${mode}\n`);
  } finally {
    if (resultFd !== undefined) closeSync(resultFd);
    closeSync(fd);
    await closePostgres();
  }
}
void main().catch(() => {
  process.stderr.write(
    'MERCARIA_AUTHORITY_FAILED: inspect private receipt and read-only database state; no automatic retry\n',
  );
  process.exitCode = 1;
});
