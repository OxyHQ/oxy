import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { encodeInventory, readInventory } from './read-internal-pilot-readiness.mjs';

// The owned launcher supplies a fresh database; these schema fragments test the
// actual SQL projection/receiver, not production catalogue eligibility or DDL.
const require = createRequire(`${process.cwd()}/package.json`);
const postgres = require('postgres');
const client = postgres(process.env.DATABASE_URL, { max: 1 });
let passed = 0;
const marker = 'NEVER_PROJECT_THIS';
try {
  await assert.rejects(
    readInventory('untrusted-profile', 'never-connect'),
    /Invalid fixed inventory profile/,
  );
  passed++;
  const absent = await readInventory('oxy', process.env.DATABASE_URL);
  assert.equal(absent.kind, 'inference-pilot-readiness');
  assert.equal(absent.readOnly, true);
  assert.equal(absent.isolation, 'repeatable read');
  assert(
    Object.values(absent.tables).every(
      (table) => table.status === 'missing' && table.count === null,
    ),
  );
  passed++;
  await client`CREATE TABLE inference_deployments (id text PRIMARY KEY, model_revision_id text, provider_slug text, regions text[], availability_scope text, commercial_permission text, permission_state text, legal_review_status text, status text, price_version_id text, platform_fee_price_version_id text, accepted_parameters text[], retains_payloads boolean, retention_days integer, trains_on_customer_data boolean, zero_data_retention_available boolean, internal_route_id text, legal_review_evidence_ref text, wholesale_cost_per_unit numeric)`;
  await client`INSERT INTO inference_deployments VALUES ('database-deployment-uuid','revision-fixture','groq',ARRAY[]::text[],'internal_alia','internal_only','approved','approved','active',NULL,NULL,ARRAY['maxOutputTokens'],false,0,false,true,'dep_groq_openai_gpt_oss_120b_observed_2026_09_01',${marker},123)`;
  await client`INSERT INTO inference_deployments (id,internal_route_id) VALUES ('different-pilot',${marker})`;
  const route = await readInventory('oxy', process.env.DATABASE_URL);
  assert.equal(route.tables.inference_deployments.count, 1);
  const row = route.tables.inference_deployments.rows[0];
  assert.equal(
    row.internal_route_id_digest,
    createHash('sha256').update('dep_groq_openai_gpt_oss_120b_observed_2026_09_01').digest('hex'),
  );
  assert.equal(row.price_version_id, null);
  assert.equal(row.availability_scope, 'internal_alia'); // raw storage fact, never normalized to approval
  assert.deepEqual(row.regions, []);
  assert(!JSON.stringify(route).includes(marker));
  assert(!JSON.stringify(route).includes('dep_groq_openai_gpt_oss_120b_observed_2026_09_01'));
  passed++;
  await client`CREATE TABLE price_versions (id text PRIMARY KEY, status text, model_reference text, provider text, currency text, effective_from timestamptz, effective_until timestamptz, private_note text)`;
  await client`CREATE TABLE price_version_unit_prices (price_version_id text, unit text, amount numeric, per bigint, private_note text)`;
  await client`INSERT INTO price_versions VALUES ('pilot-price','active','openai/gpt-oss-120b@observed-2026-09-01','groq','usd','2026-10-01',NULL,${marker}),('foreign-price','active','other/model','groq','usd','2026-10-01',NULL,${marker})`;
  await client`INSERT INTO price_version_unit_prices VALUES ('pilot-price','input_tokens',0.123456,1000000,${marker}),('foreign-price','input_tokens',9,1,${marker})`;
  const prices = await readInventory('oxy', process.env.DATABASE_URL);
  assert.equal(prices.tables.price_versions.count, 1);
  assert.equal(prices.tables.price_version_unit_prices.count, 1);
  assert.equal(prices.tables.price_version_unit_prices.rows[0].amount, '0.123456');
  assert(!JSON.stringify(prices).includes(marker));
  passed++;
  // Referenced unit prices are selected by IDs, even when the platform fee
  // provider/model label is different from the inference deployment.
  await client`INSERT INTO price_versions VALUES ('explicit-model-price','active','unrelated-label','different-provider','usd','2026-10-01',NULL,${marker}),('explicit-platform-fee','active','platform/service','platform','usd','2026-10-01',NULL,${marker})`;
  await client`INSERT INTO price_version_unit_prices VALUES ('explicit-model-price','output_tokens',0.42,1000000,${marker}),('explicit-platform-fee','request',0.01,1,${marker})`;
  await client`UPDATE inference_deployments SET price_version_id='explicit-model-price', platform_fee_price_version_id='explicit-platform-fee' WHERE id='database-deployment-uuid'`;
  const boundPrices = await readInventory('oxy', process.env.DATABASE_URL);
  assert.deepEqual(boundPrices.tables.price_versions.rows.map((row) => row.id).sort(), [
    'explicit-model-price',
    'explicit-platform-fee',
    'pilot-price',
  ]);
  assert.deepEqual(
    boundPrices.tables.price_version_unit_prices.rows.map((row) => row.price_version_id).sort(),
    ['explicit-model-price', 'explicit-platform-fee', 'pilot-price'],
  );
  assert(!JSON.stringify(boundPrices).includes(marker));
  passed++;
  await client`CREATE TABLE inference_models (id text PRIMARY KEY, model_id text, input_modalities text[], output_modalities text[], max_context_tokens bigint, max_output_tokens bigint, supports_streaming boolean, api_formats text[], deprecation_status text)`;
  await client`CREATE TABLE inference_model_revisions (id text PRIMARY KEY, model_id text, revision text, is_current boolean, released_at timestamptz, retired_at timestamptz)`;
  await client`INSERT INTO inference_models (id,model_id) VALUES ('model-fixture','openai/gpt-oss-120b'),('foreign-model','foreign/model')`;
  await client`INSERT INTO inference_model_revisions (id,model_id,revision) VALUES ('revision-fixture','model-fixture','observed-2026-09-01'),('foreign-revision','foreign-model','observed-2026-09-01')`;
  await client`UPDATE inference_deployments SET model_revision_id='foreign-revision' WHERE id='different-pilot'`;
  await client`INSERT INTO inference_deployments (id,model_revision_id,internal_route_id,price_version_id) VALUES ('related-unapproved','revision-fixture','private-unapproved-route','foreign-price')`;
  const related = await readInventory('oxy_related', process.env.DATABASE_URL);
  assert.equal(related.tables.inference_deployments.count, 2);
  assert.deepEqual(
    related.tables.inference_deployments.rows.map((row) => [row.id, row.exact_pilot_route_match]),
    [
      ['database-deployment-uuid', true],
      ['related-unapproved', false],
    ],
  );
  assert.deepEqual(related.tables.price_versions.rows.map((row) => row.id).sort(), [
    'explicit-model-price',
    'explicit-platform-fee',
    'foreign-price',
  ]);
  assert.equal(related.tables.price_version_unit_prices.count, 3);
  assert(!JSON.stringify(related).includes('private-unapproved-route'));
  assert(!JSON.stringify(related).includes('dep_groq_openai_gpt_oss_120b_observed_2026_09_01'));
  passed++;
  await client`DROP TABLE inference_models`;
  const relatedMissing = await readInventory('oxy_related', process.env.DATABASE_URL);
  assert.equal(relatedMissing.tables.inference_models.count, null);
  assert.equal(relatedMissing.tables.inference_model_revisions.status, 'dependency_missing');
  // Missing model dependency must stop nested relational SQL too.
  passed++;
  await client`ALTER TABLE inference_deployments DROP COLUMN internal_route_id`;
  const mismatch = await readInventory('oxy', process.env.DATABASE_URL);
  assert.equal(mismatch.tables.inference_deployments.status, 'schema_mismatch');
  assert.equal(mismatch.tables.inference_deployments.count, null);
  assert.deepEqual(mismatch.tables.inference_deployments.missing, ['internal_route_id']);
  passed++;
  await client`DROP TABLE price_versions`;
  const dependency = await readInventory('oxy', process.env.DATABASE_URL);
  assert.equal(dependency.tables.price_version_unit_prices.status, 'dependency_missing');
  assert.equal(dependency.tables.price_version_unit_prices.count, null);
  passed++;
  await assert.rejects(
    client.begin(
      'isolation level repeatable read read only',
      (tx) => tx`DELETE FROM inference_deployments`,
    ),
    { code: '25006' },
  );
  assert.equal((await client`SELECT count(*)::text AS n FROM inference_deployments`)[0].n, '3');
  passed++;
  const packets = encodeInventory(prices, 'a'.repeat(32));
  assert(packets.every((packet) => packet.startsWith('OXY_BILLING_INVENTORY ')));
  assert.throws(() => encodeInventory(prices, 'untrusted'));
  passed++;
  const source = readFileSync(
    new URL('./read-internal-pilot-readiness.mjs', import.meta.url),
    'utf8',
  );
  const invocation = `\nconst result=await readInventory('oxy',process.env.DATABASE_URL);for(const line of encodeInventory(result,'${'b'.repeat(32)}'))console.log(line);`;
  const receiver = spawnSync(process.execPath, ['--input-type=module', '-e', source + invocation], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(receiver.status, 0, receiver.stderr);
  assert(receiver.stdout.startsWith('OXY_BILLING_INVENTORY '));
  assert(!receiver.stdout.includes(marker));
  passed++;
  console.log(
    `I09 readiness SQL/Node receiver: ${passed} passed; owned schema fragments, no eligibility verdict.`,
  );
} finally {
  await client.end({ timeout: 5 });
}
