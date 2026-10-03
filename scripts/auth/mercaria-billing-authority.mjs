/** External operator entrypoint, embedded verbatim into a digest-pinned API image.
 * No AWS/HTTP client and no dotenv loader. Attribution is verified by the local
 * launcher, not cryptographically authenticated inside this DB-only process.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve('package.json'));
const { z } = require('zod');
const target = {
  applicationId: '6a37d0cc5d4b5f15482a9340',
  credentialId: '01a061cd-39a9-7bd6-ba31-70ef7590c953',
  ownerAccountId: '69b2d3df5d12f58c9800d651',
};
const row = z.object({ scopes: z.array(z.string().max(100)).max(32), version: z.string().regex(/^\d+$/), updatedAt: z.string().min(1).max(100) }).strict();
const state = z.object({ application: row, credential: row }).strict();
const plan = z.object({
  kind: z.literal('mercaria-billing-authority-v1'),
  target: z.object(Object.fromEntries(Object.entries(target).map(([key, value]) => [key, z.literal(value)]))).strict(),
  before: state,
}).strict();
const receipt = plan.extend({ operation: z.literal('apply'), actor: z.string().min(1).max(512), after: state }).strict();
const common = z.object({
  schemaVersion: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  operator: z.object({ account: z.literal('237343248947'), arn: z.string().max(512).regex(/^arn:aws:(?:iam|sts)::237343248947:/), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
});
const requestSchema = z.discriminatedUnion('mode', [
  common.extend({ mode: z.literal('prepare') }).strict(),
  common.extend({ mode: z.literal('apply'), input: plan }).strict(),
  common.extend({ mode: z.literal('rollback'), input: receipt }).strict(),
]);
async function main() {
  const [flag, bytes, hash] = process.argv.slice(-3);
  if (flag !== '--execute' || !bytes || bytes.length > 16384 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('invalid_invocation');
  const request = requestSchema.parse(JSON.parse(bytes));
  // Imports are fixed and occur only after strict validation. Existing compiled
  // CAS owns locks, status/fence checks, xmin and atomic apply/rollback.
  const { connectPostgres, closePostgres } = require(resolve('dist/config/postgres.js'));
  const service = require(resolve('dist/services/mercariaBillingAuthority.service.js'));
  const actor = { isPlatformStaff: true, describedAs: request.operator.arn };
  try {
    await connectPostgres();
    const result = request.mode === 'prepare'
      ? await service.prepareMercariaBillingAuthority(target, actor)
      : request.mode === 'apply'
        ? await service.applyMercariaBillingAuthority(request.input, actor)
        : await service.rollbackMercariaBillingAuthority(request.input, actor);
    const validated = request.mode === 'prepare' ? plan.parse(result)
      : receipt.extend({ operation: z.literal(request.mode) }).parse(result);
    process.stdout.write(`OXY_BILLING_AUTHORITY_RESULT ${JSON.stringify({ schemaVersion: 1, nonce: request.nonce, mode: request.mode, operatorReceiptSha256: request.operator.receiptSha256, result: validated })}\n`);
  } finally {
    await closePostgres();
  }
}
await main().catch(() => {
  process.stderr.write('OXY_BILLING_AUTHORITY_FAILED: reconcile exact target and attempt; no automatic retry\n');
  process.exitCode = 1;
});
