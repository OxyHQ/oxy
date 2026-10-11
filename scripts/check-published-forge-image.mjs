/** Future ACTIVE resolver companion. Read-only audit/GitHub/ECR; never publishes. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { inspectForgeAuditPolicy, readCommittedPolicyStatus } from './forge-audit-policy.mjs';
const prepublish = process.argv.length === 3 && process.argv[2] === 'prepublish';
if (process.argv.length !== 2 && !prepublish)
  throw new Error(
    'Only exact prepublish phase accepted; no source, payload, evidence or clock overrides',
  );
if (readCommittedPolicyStatus() !== 'ACTIVE')
  throw new Error('This companion requires an explicit reviewed ACTIVE source policy');
const taskHome = userInfo().homedir;
const bun = ['/usr/local/bin/bun', '/usr/bin/bun', `${taskHome}/.bun/bin/bun`].find(existsSync);
if (!bun) throw new Error('Fixed Bun binary unavailable');
const env = { ...process.env, HOME: taskHome };
for (const key of Object.keys(env))
  if (/^(GH_|GITHUB_|GIT_|BUN_|NPM_CONFIG_|XDG_CONFIG_HOME$|DEPENDENCY_AUDIT_)/i.test(key))
    delete env[key];
let audit;
try {
  audit = JSON.parse(
    execFileSync(bun, ['audit', '--json'], {
      env,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  if (!error.stdout?.length) throw error;
  audit = JSON.parse(error.stdout);
}
const policy = inspectForgeAuditPolicy(audit, { publishedImage: !prepublish });
if (policy.remediated !== true)
  throw new Error(`Source audit policy fails closed: ${policy.reason}`);
const final = policy.finalImageProof;
if (!final?.authenticatedProvenance)
  throw new Error('Own authenticated final-image evidence required');
if (!final.machineChecksPassed)
  throw new Error(`Published image fails closed: ${final.errors.join('; ')}`);
console.log(JSON.stringify(final));
