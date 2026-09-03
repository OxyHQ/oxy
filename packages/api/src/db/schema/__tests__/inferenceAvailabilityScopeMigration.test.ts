/**
 * The availability rename is a data migration, not only a new CHECK. Drizzle
 * can generate the constraint change but cannot infer that existing rows must
 * be rewritten between dropping the old constraint and installing the new one.
 * This reads the shipped SQL so omitting or reordering that rewrite fails CI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(__dirname, '../../../../drizzle/0074_outstanding_brother_voodoo.sql'),
  'utf8'
);

it('rewrites every legacy Alia scope before enforcing platform_internal', () => {
  const drop = migration.indexOf(
    'DROP CONSTRAINT "inference_deployments_availability_scope_check"'
  );
  const rewrite = migration.indexOf(
    'SET "availability_scope" = \'platform_internal\'\nWHERE "availability_scope" = \'internal_alia\''
  );
  const add = migration.indexOf(
    'ADD CONSTRAINT "inference_deployments_availability_scope_check"'
  );

  expect(drop).toBeGreaterThanOrEqual(0);
  expect(rewrite).toBeGreaterThan(drop);
  expect(add).toBeGreaterThan(rewrite);

  const finalConstraint = migration.slice(add);
  expect(finalConstraint).toContain("'platform_internal'");
  expect(finalConstraint).not.toContain("'internal_alia'");
});
