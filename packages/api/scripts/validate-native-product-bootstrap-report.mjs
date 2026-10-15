import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const prefix = 'NATIVE_PRODUCT_AGENTS_RESULT=';
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const canonicalize = (value) =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, nested]) => [key, canonicalize(nested)]),
        )
      : value;

/** Only the bootstrap's explicit non-secret projections may cross the task boundary. */
export function validateBootstrapReport(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 262144 || !line.startsWith(prefix))
    throw new Error('Invalid bootstrap report');
  const report = JSON.parse(line.slice(prefix.length));
  if (
    !exactKeys(report, ['mode', 'direction', 'planSha256', 'plan']) ||
    !['dry-run', 'apply'].includes(report.mode) ||
    !['bootstrap', 'rollback'].includes(report.direction) ||
    !/^[a-f0-9]{64}$/.test(report.planSha256)
  )
    throw new Error('Invalid bootstrap report');
  const plan = report.plan;
  if (
    !exactKeys(plan, [
      'manifestVersion',
      'direction',
      'desired',
      'before',
      'after',
      'aliaManifest',
      'operations',
    ]) ||
    plan.direction !== report.direction ||
    !Number.isSafeInteger(plan.manifestVersion) ||
    plan.manifestVersion < 1 ||
    !Array.isArray(plan.operations) ||
    plan.operations.length > 1000 ||
    plan.operations.some((item) => typeof item !== 'string' || item.length > 2048)
  )
    throw new Error('Invalid bootstrap plan');
  let nodes = 0;
  function inspect(value) {
    if (++nodes > 20000) throw new Error('Bootstrap plan is too large');
    if (typeof value === 'string' && value.length > 8192)
      throw new Error('Bootstrap plan value is too large');
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        // publicKey/clientId identify a credential; they are not secret material.
        if (
          /secret|password|access.?token|refresh.?token|private.?key|authorization|cookie/i.test(
            key,
          )
        )
          throw new Error('Secret material is forbidden in bootstrap plans');
        inspect(nested);
      }
    }
  }
  inspect(plan);
  if (
    createHash('sha256')
      .update(JSON.stringify(canonicalize(plan)))
      .digest('hex') !== report.planSha256
  )
    throw new Error('Bootstrap plan hash differs');
  return report;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const report = validateBootstrapReport(readFileSync(0, 'utf8').trimEnd());
    if (process.argv[2] !== '--check') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.exitCode = 1;
  }
}
