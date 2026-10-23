/** Offline, synthetic Git repositories. Never writes or overrides the live policy. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DECISION_PATH } from './forge-audit-policy.mjs';

export const SYNTHETIC_INACTIVE = Object.freeze({
  schemaVersion: 1,
  status: 'INACTIVE',
  targetSourceHead: null,
  expiresAt: null,
  authorizationRecord: null,
  independentEvidence: null,
});
export function policyTestRepository(decision = SYNTHETIC_INACTIVE) {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..');
  const root = mkdtempSync(join(tmpdir(), 'forge-policy-offline-fixture-'));
  const paths = [
    'scripts/check-dependency-audit.mjs',
    'scripts/zod-audit-paths.mjs',
    'scripts/forge-audit-policy.mjs',
    'scripts/forge-remediation-proof-proposal.mjs',
    'scripts/forge-source-topology.mjs',
    'scripts/forge-final-image-binding.mjs',
    'scripts/forge-final-image-collector.mjs',
    'scripts/forge-policy-record.mjs',
    'scripts/forge-candidate-image-roots.mjs',
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(source, path)));
  }
  writeFileSync(
    join(root, 'bun.lock'),
    JSON.stringify({
      workspaces: {
        'packages/api': {
          name: '@oxy.so/api',
          dependencies: { '@atproto/oauth-client-node': '0.5.7' },
        },
      },
      packages: {
        '@atproto/oauth-client-node': [
          '@atproto/oauth-client-node@0.5.7',
          '',
          { dependencies: { '@atproto/oauth-types': '0.7.6' } },
        ],
        '@atproto/oauth-types': [
          '@atproto/oauth-types@0.7.6',
          '',
          { dependencies: { zod: '3.25.76' } },
        ],
        '@atproto/oauth-types/zod': ['zod@3.25.76', '', {}],
        zod: ['zod@4.6.7', '', {}],
      },
    }),
  );
  mkdirSync(dirname(join(root, DECISION_PATH)), { recursive: true });
  writeFileSync(join(root, DECISION_PATH), JSON.stringify(decision) + '\n');
  const git = (...args) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-C',
        root,
        '-c',
        'user.name=Synthetic Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init', '-q');
  git('add', '--', ...paths, DECISION_PATH);
  git('commit', '-qm', 'Synthetic policy fixture only');
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}
