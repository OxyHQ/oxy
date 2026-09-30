#!/usr/bin/env node
import { DEFAULT_GRACE_DAYS, fetchLatestRelease, findRepositoryRoot, inspectRepository } from './checks.mjs';

const argv = process.argv.slice(2);
const args = new Set(argv);
if (args.has('--help') || args.has('-h')) {
  console.log(`oxy-doctor [--ci] [--json] [--grace-days=N]\n\nRead-only checks for Oxy ecosystem dependency health.\nA newer @oxy.so release is a warning for N days after it is published (default ${DEFAULT_GRACE_DAYS}), then an error.\n--ci exits 1 on errors only.`);
  process.exit(0);
}
const graceArg = argv.find((value) => value.startsWith('--grace-days='));
const graceDays = graceArg === undefined ? DEFAULT_GRACE_DAYS : Number(graceArg.slice('--grace-days='.length));
if (!Number.isInteger(graceDays) || graceDays < 0) {
  console.error('Oxy Doctor failed: --grace-days must be a non-negative integer');
  process.exit(2);
}
try {
  const report = await inspectRepository(await findRepositoryRoot(), fetchLatestRelease, { graceDays });
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Oxy Doctor: ${report.packages} first-party packages across ${report.manifests} manifests`);
    if (report.findings.length === 0) console.log('✓ No dependency-health findings');
    for (const finding of report.findings) console.log(`${finding.severity === 'error' ? '✗' : '!'} ${finding.message}`);
  }
  if (args.has('--ci') && report.findings.some((finding) => finding.severity === 'error')) process.exitCode = 1;
} catch (error) {
  console.error(`Oxy Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
