import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const FIRST_PARTY_SCOPES = ['@oxy.so/'];
export const isFirstPartyPackage = (name) => FIRST_PARTY_SCOPES.some((scope) => name.startsWith(scope));

export function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function rangeIncludesVersion(range, version) {
  return range.split('||').some((alternative) => {
    const terms = alternative.trim().split(/\s+/).filter(Boolean);
    return terms.every((term) => {
      const target = term.match(/\d+\.\d+\.\d+/)?.[0];
      if (!target) return true;
      const comparison = compareVersions(version, target);
      if (term.startsWith('>=')) return comparison >= 0;
      if (term.startsWith('<=')) return comparison <= 0;
      if (term.startsWith('>')) return comparison > 0;
      if (term.startsWith('<')) return comparison < 0;
      if (term.startsWith('^')) {
        const [major, minor] = target.split('.').map(Number);
        const [candidateMajor, candidateMinor] = version.split('.').map(Number);
        return comparison >= 0 && candidateMajor === major && (major > 0 || candidateMinor === minor);
      }
      if (term.startsWith('~')) {
        const [major, minor] = target.split('.').map(Number);
        const [candidateMajor, candidateMinor] = version.split('.').map(Number);
        return comparison >= 0 && candidateMajor === major && candidateMinor === minor;
      }
      return comparison === 0;
    });
  });
}

export function lockfileVersions(lockfile, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`"(?:[^"\\n]+/)?${escaped}"\\s*:\\s*\\["${escaped}@([^"\\s]+)"`, 'g');
  return [...lockfile.matchAll(matcher)].map((match) => match[1]);
}

export async function findRepositoryRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No package.json found above ${start}`);
    current = parent;
  }
}

async function collectManifests(directory, depth = 0) {
  if (depth > 4) return [];
  const ignored = new Set(['.git', '.expo', '.turbo', '.worktrees', 'dist', 'lib', 'node_modules']);
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'package.json') manifests.push(join(directory, entry.name));
    if (entry.isDirectory() && !ignored.has(entry.name)) manifests.push(...await collectManifests(join(directory, entry.name), depth + 1));
  }
  return manifests;
}

export async function inspectRepository(root, fetchLatest) {
  const manifestPaths = await collectManifests(root);
  const usages = new Map();
  for (const path of manifestPaths) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!isFirstPartyPackage(name) || range === 'workspace:*' || range === 'catalog:') continue;
        const rows = usages.get(name) ?? [];
        rows.push({ manifest: path.slice(root.length + 1), section, range });
        usages.set(name, rows);
      }
    }
  }
  const lockPath = join(root, 'bun.lock');
  const lockfile = existsSync(lockPath) ? await readFile(lockPath, 'utf8') : null;
  const findings = [];
  if (!lockfile) findings.push({ severity: 'error', code: 'missing-lockfile', message: 'bun.lock is missing' });
  await Promise.all([...usages].map(async ([name, rows]) => {
    const latest = await fetchLatest(name);
    const installed = lockfile ? [...new Set(lockfileVersions(lockfile, name))] : [];
    if (installed.length > 1) findings.push({ severity: 'error', code: 'duplicate-version', package: name, installed, message: `${name} has multiple locked versions: ${installed.join(', ')}` });
    for (const row of rows) {
      if (!rangeIncludesVersion(row.range, latest)) findings.push({ severity: 'warning', code: 'outdated', package: name, latest, ...row, message: `${name} ${row.range} does not include ${latest} in ${row.manifest}` });
    }
  }));
  return { root, manifests: manifestPaths.length, packages: usages.size, findings };
}

export async function fetchLatestVersion(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
  const metadata = await response.json();
  if (typeof metadata.version !== 'string') throw new Error(`Registry returned no version for ${name}`);
  return metadata.version;
}
