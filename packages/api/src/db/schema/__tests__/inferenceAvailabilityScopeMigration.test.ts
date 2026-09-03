/**
 * The first availability-rename delivery must be rolling-safe. Previous pods
 * must keep reading and writing `internal_alia` while the new image writes
 * `platform_internal`, so this migration may widen the CHECK but may not rewrite
 * a single row. Backfill and contraction belong to the separately deployed PR2.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '../../../../drizzle/0074_outstanding_brother_voodoo.sql'),
  'utf8'
);

it('expands the PRE constraint to both storage spellings without rewriting data', () => {
  expect(migration.split('\n', 1)[0]).toBe('-- oxy:deploy-phase=pre');

  const drop = migration.indexOf(
    'DROP CONSTRAINT "inference_deployments_availability_scope_check"'
  );
  const add = migration.indexOf(
    'ADD CONSTRAINT "inference_deployments_availability_scope_check"'
  );

  expect(drop).toBeGreaterThanOrEqual(0);
  expect(add).toBeGreaterThan(drop);
  expect(migration).not.toMatch(/\bUPDATE\s+"?inference_deployments"?/i);

  const finalConstraint = migration.slice(add);
  expect(finalConstraint).toContain("'platform_internal'");
  expect(finalConstraint).toContain("'internal_alia'");
});
