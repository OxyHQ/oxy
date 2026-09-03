#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/seed-oxy-applications.yml', 'utf8');
const seedScript = readFileSync('packages/api/scripts/seed-oxy-applications.ts', 'utf8');

function assertExactIdBoundary(workflowSource, seedSource) {
  assert.match(
    workflowSource,
    /\n      only_app_ids:\n[\s\S]*?description: "Comma-separated exact ids declared by the application seed registry"/,
    'workflow must expose the exact-id input',
  );
  assert.match(
    workflowSource,
    /if \[ -z "\$\{ONLY_APPS\/\/ \/\}" \] && \[ -z "\$\{ONLY_APP_IDS\/\/ \/\}" \]/,
    'workflow must reject an empty boundary before building an image',
  );
  assert.match(
    workflowSource,
    /if \[ -n "\$\{ONLY_APPS\/\/ \/\}" \] && \[ -n "\$\{ONLY_APP_IDS\/\/ \/\}" \]/,
    'workflow must reject simultaneous name and exact-id boundaries',
  );
  assert.match(
    workflowSource,
    /if \[\[ "\$ONLY_APP_IDS" == \*\[\[:space:\]\]\* \]\]/,
    'workflow must reject whitespace instead of normalizing exact ids',
  );
  assert.match(
    workflowSource,
    /if \$only_ids != "" then\s+\[\{name:"ONLY_APP_IDS", value:\$only_ids\}\]\s+else\s+\[\{name:"ONLY_APPS", value:\$only\}\]/,
    'ECS override must carry exactly the selected boundary variable',
  );
  assert.match(
    seedSource,
    /if \(onlyApps !== undefined && onlyAppIds !== undefined\)/,
    'seeder must reject ambiguous direct invocations too',
  );
  assert.match(
    seedSource,
    /selectSeedEntriesByExactIds\(SEED_APPS, onlyAppIds,/,
    'ONLY_APP_IDS must use the exact-id selector',
  );
  assert.doesNotMatch(
    seedSource,
    /selectSeedEntries\(SEED_APPS, onlyAppIds,/,
    'ONLY_APP_IDS must never enter the display-name selector',
  );
  assert.match(
    seedSource,
    /selectSeedEntriesByLegacyNames\(SEED_APPS, onlyApps, vocabulary, 'ONLY_APP_IDS'\)/,
    'ONLY_APPS must refuse specs that already declare immutable ids',
  );
}

assertExactIdBoundary(workflow, seedScript);

assert.throws(
  () =>
    assertExactIdBoundary(
      workflow.replace('{name:"ONLY_APP_IDS", value:$only_ids}', '{name:"ONLY_APPS", value:$only_ids}'),
      seedScript,
    ),
  /ECS override must carry exactly the selected boundary variable/,
  'mutation control: routing the exact value through ONLY_APPS must fail',
);
assert.throws(
  () =>
    assertExactIdBoundary(
      workflow.replace('if [[ "$ONLY_APP_IDS" == *[[:space:]]* ]]; then', 'if false; then'),
      seedScript,
    ),
  /workflow must reject whitespace instead of normalizing exact ids/,
  'mutation control: removing the byte-exact workflow guard must fail',
);
assert.throws(
  () =>
    assertExactIdBoundary(
      workflow,
      seedScript.replace(
        "selectSeedEntriesByLegacyNames(SEED_APPS, onlyApps, vocabulary, 'ONLY_APP_IDS')",
        'selectSeedEntries(SEED_APPS, onlyApps, vocabulary)',
      ),
    ),
  /ONLY_APPS must refuse specs that already declare immutable ids/,
  'mutation control: allowing the legacy name route to select Kaana must fail',
);
assert.throws(
  () =>
    assertExactIdBoundary(
      workflow,
      seedScript.replace('selectSeedEntriesByExactIds(SEED_APPS, onlyAppIds,', 'selectSeedEntries(SEED_APPS, onlyAppIds,'),
    ),
  /ONLY_APP_IDS must use the exact-id selector/,
  'mutation control: selecting an exact-id input by name must fail',
);
assert.throws(
  () =>
    assertExactIdBoundary(
      workflow.replace(
        'if [ -n "${ONLY_APPS// /}" ] && [ -n "${ONLY_APP_IDS// /}" ]; then',
        'if false; then',
      ),
      seedScript,
    ),
  /workflow must reject simultaneous name and exact-id boundaries/,
  'mutation control: removing the ambiguous-input refusal must fail',
);

process.stdout.write('Application seed workflow preserves the exact-id boundary through ECS.\n');
