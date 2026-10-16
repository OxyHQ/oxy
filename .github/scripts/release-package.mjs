// The checks `release-packages.yml` runs around one public workspace package.
//
//   resolve <name>        prints the package's directory; refuses a name that is
//                         not a public (non-`private`) workspace package
//   dependencies <name>   prints, dependencies first, the workspace packages it
//                         links with `workspace:` (any dependency field): what a
//                         fresh checkout must build before the package builds.
//                         Not `turbo --filter=<name>^...`: Turbo counts the root
//                         package.json's own devDependencies (core, services) as
//                         every package's dependencies and builds them all
//   inspect <tgz> <dir>   checks the packed tarball: it is that package at that
//                         version, bun rewrote every `workspace:`/`catalog:`
//                         range, every entry point it declares is inside it, and
//                         every `@oxy.so/*` range it depends on already resolves
//                         on the registry (a consumer could not install it
//                         otherwise)
//
// Registry reads are anonymous (`--userconfig /dev/null`): nothing here holds a
// credential, and the publish job's OIDC exchange happens only in `npm publish`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
];

export function workspacePackages(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return manifest.workspaces.packages.map((directory) => ({
    directory,
    manifest: JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')),
  }));
}

export function resolveWorkspace(name, workspaces) {
  const releasable = workspaces.filter(({ manifest }) => manifest.private !== true);
  const match = releasable.find(({ manifest }) => manifest.name === name);
  if (!match) {
    const names = releasable.map(({ manifest }) => manifest.name).join(', ');
    throw new Error(`${name} is not a public workspace package; releasable: ${names}`);
  }
  return match.directory;
}

export function workspaceDependencies(name, workspaces) {
  const byName = new Map(workspaces.map(({ manifest }) => [manifest.name, manifest]));
  const order = [];
  const visit = (current, path) => {
    if (path.includes(current))
      throw new Error(`workspace cycle: ${[...path, current].join(' -> ')}`);
    if (order.includes(current)) return;
    for (const field of DEPENDENCY_FIELDS)
      for (const [dependency, range] of Object.entries(byName.get(current)[field] ?? {}))
        if (range.startsWith('workspace:') && byName.has(dependency))
          visit(dependency, [...path, current]);
    order.push(current);
  };
  visit(name, []);
  return order.filter((dependency) => dependency !== name);
}

function entryTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(entryTargets);
}

/** Every problem with a packed manifest and its file list; empty when it can ship. */
export function manifestProblems(packed, source, entries) {
  const problems = [];
  if (packed.name !== source.name || packed.version !== source.version)
    problems.push(
      `packed ${packed.name}@${packed.version}, the workspace is ${source.name}@${source.version}`,
    );
  for (const field of DEPENDENCY_FIELDS)
    for (const [dependency, range] of Object.entries(packed[field] ?? {}))
      if (/^(workspace|catalog):/.test(range))
        problems.push(`${field}.${dependency} is the unresolvable "${range}": pack with bun`);
  const files = new Set(entries.map((entry) => entry.replace(/^package\//, '')));
  const declared = [
    packed.main,
    packed.module,
    packed.types,
    ...entryTargets(packed.bin),
    ...entryTargets(packed.exports),
  ];
  for (const target of declared)
    if (
      typeof target === 'string' &&
      !target.includes('*') &&
      !files.has(target.replace(/^\.\//, ''))
    )
      problems.push(`declares ${target}, which is not in the tarball`);
  return problems;
}

/** The first-party ranges the packed package asks its consumers to resolve. */
export function firstPartyRanges(packed) {
  return ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
    Object.entries(packed[field] ?? {})
      .filter(([dependency]) => dependency.startsWith('@oxy.so/'))
      .map(([dependency, range]) => `${dependency}@${range}`),
  );
}

/** npm answers a range nothing satisfies with an empty body, and an unknown name with E404. */
function resolvesOnRegistry(spec) {
  try {
    const out = execFileSync(
      'npm',
      ['view', spec, 'version', '--json', '--userconfig', '/dev/null'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return out !== '' && out !== '[]';
  } catch {
    return false;
  }
}

function inspect(tarball, directory) {
  const source = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const packed = JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const problems = manifestProblems(packed, source, entries);
  for (const spec of firstPartyRanges(packed))
    if (!resolvesOnRegistry(spec))
      problems.push(`depends on ${spec}, which nothing on the registry satisfies yet`);
  if (problems.length) {
    console.error(
      `${packed.name}@${packed.version} cannot be released:\n- ${problems.join('\n- ')}`,
    );
    process.exit(1);
  }
  console.log(`${packed.name}@${packed.version}: ${entries.length} files, every check passed`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'resolve' || command === 'dependencies') {
    try {
      const workspaces = workspacePackages(process.cwd());
      const directory = resolveWorkspace(args[0], workspaces);
      console.log(
        command === 'resolve' ? directory : workspaceDependencies(args[0], workspaces).join('\n'),
      );
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (command === 'inspect') {
    inspect(resolve(args[0]), resolve(args[1]));
  } else {
    console.error(
      'usage: release-package.mjs resolve <name> | dependencies <name> | inspect <tgz> <directory>',
    );
    process.exit(2);
  }
}
