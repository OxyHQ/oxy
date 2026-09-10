#!/usr/bin/env node
import { fetchLatestVersion, findRepositoryRoot, inspectRepository } from './checks.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('oxy-doctor [--ci] [--json]\n\nRead-only checks for Oxy ecosystem dependency health.');
  process.exit(0);
}
try {
  const report = await inspectRepository(await findRepositoryRoot(), fetchLatestVersion);
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Oxy Doctor: ${report.packages} first-party packages across ${report.manifests} manifests`);
    if (report.findings.length === 0) console.log('✓ No dependency-health findings');
    for (const finding of report.findings) console.log(`${finding.severity === 'error' ? '✗' : '!'} ${finding.message}`);
  }
  if (args.has('--ci') && report.findings.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Oxy Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
