#!/usr/bin/env bun
/**
 * @oxy.so/services against the OLDEST stack it declares: React Native 0.81,
 * React 19.1 and Expo SDK 54 (react-native-macos tops out at 0.83 and Astro
 * runs 0.81; react-native-web 0.21 is the web side).
 *
 * The packages are installed as an EXTERNAL consumer would get them: this
 * directory's package.json and bun.lock (the third-party stack, frozen) are
 * copied to a temporary directory OUTSIDE the repository, and the workspace
 * packages are packed with `bun pm pack` and unpacked into its node_modules.
 * Nothing can resolve to the monorepo's own React Native 0.88 by walking up
 * the directory tree, because there is no tree above it.
 *
 * Then, in that consumer:
 *   1. every peer @oxy.so/services declares is installed and SATISFIED by the
 *      Expo 54 stack (an optional peer only when installed), and every runtime
 *      dependency of each packed package resolves;
 *   2. `tsc` typechecks services' published `src/` (what Metro and a
 *      `react-native`-condition typecheck compile), and two canaries prove the
 *      typecheck saw the old types: React 19.2's `useEffectEvent` and React
 *      Native's `useAnimatedValueXY` (absent from 0.81's types, present in
 *      0.88's) must both FAIL to resolve;
 *   3. `jest-expo` renders <OxyProvider> on iOS (React Native 0.81) and on web
 *      (react-native-web 0.21) and its cold boot settles signed out with the
 *      network down, and the same render runs as macOS: `Platform.OS` is
 *      'macos' and every Expo module without a macOS podspec, and the SDK's
 *      own iOS/Android-only native modules, are absent;
 *   4. Metro bundles an app that mounts <OxyProvider> for iOS (and Expo
 *      compiles it to Hermes bytecode) and for macOS the way Astro resolves
 *      it (`react-native` -> react-native-macos, the `react-native` export
 *      condition), and the macOS bundle holds the macOS forks, not the
 *      modules they replace.
 *
 * Requires the workspace packages to be built first:
 *   bunx turbo run build --filter=@oxy.so/services...
 *
 * Usage: bun check.mjs [--keep]
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(here, '../../..');
const keep = process.argv.includes('--keep');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const FIXTURE_FILES = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'babel.config.js',
  'jest.config.js',
  '__tests__',
  'app.json',
  'index.tsx',
  'metro.config.js',
  'bundle-macos.mjs',
];
const WORKSPACE_PACKAGES = ['contracts', 'protocol', 'telemetry', 'core', 'services'];
const EXPECTED = {
  react: '19.1.',
  'react-native': '0.81.',
  'react-native-web': '0.21.',
  expo: '54.',
  '@types/react': '19.1.',
};

const consumer = readJson(join(here, 'package.json'));
const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`FAIL ${message}`);
};
const run = (cmd, args, cwd, options = {}) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });

const stage = realpathSync(mkdtempSync(join(tmpdir(), 'oxy-services-expo-54-')));
console.log(`staging an external consumer in ${stage}`);

try {
  for (const name of FIXTURE_FILES) {
    cpSync(join(here, name), join(stage, name), { recursive: true });
  }
  run('bun', ['install', '--frozen-lockfile', '--minimum-release-age=0'], stage);

  const packs = join(stage, '.packs');
  mkdirSync(packs);
  for (const name of WORKSPACE_PACKAGES) {
    const dir = join(packagesDir, name);
    const manifest = readJson(join(dir, 'package.json'));
    for (const entry of [manifest.types, manifest.main].filter(Boolean)) {
      if (!existsSync(join(dir, entry))) {
        throw new Error(
          `${manifest.name} is not built (${entry} is missing): run bunx turbo run build --filter=@oxy.so/services...`,
        );
      }
    }
    run('bun', ['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', packs], dir, {
      capture: true,
    });
    const tarball = readdirSync(packs).find((file) => file.startsWith(`oxy.so-${name}-`));
    const target = join(stage, 'node_modules', '@oxy.so', name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    run('tar', ['xzf', join(packs, tarball), '-C', target, '--strip-components=1'], stage);
  }

  const resolveFrom = (from, name) => {
    let dir = from;
    for (;;) {
      const candidate = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) return candidate;
      if (dir === stage || dir === dirname(dir)) return null;
      dir = dirname(dir);
    }
  };
  const installedVersion = (from, name) => {
    const manifest = resolveFrom(from, name);
    return manifest ? readJson(manifest).version : null;
  };

  for (const [name, prefix] of Object.entries(EXPECTED)) {
    const version = installedVersion(stage, name);
    console.log(`  ${name}@${version}`);
    if (!version?.startsWith(prefix)) fail(`${name} is ${version}, this check is for ${prefix}x`);
  }

  console.log('\n1. dependency and peer ranges against the Expo 54 stack');
  for (const name of WORKSPACE_PACKAGES) {
    const dir = join(stage, 'node_modules', '@oxy.so', name);
    const manifest = readJson(join(dir, 'package.json'));
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      const version = installedVersion(dir, dep);
      if (!version)
        fail(
          `${manifest.name} depends on ${dep}@${range}, which this consumer does not have: add it to compat/expo-54/package.json`,
        );
      else if (!Bun.semver.satisfies(version, range))
        fail(`${manifest.name} depends on ${dep}@${range}, installed ${version}`);
    }
    const optional = manifest.peerDependenciesMeta ?? {};
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (peer.startsWith('@types/')) continue;
      // An optional peer counts only when this consumer installs it on purpose:
      // core's optional `express`, for one, is whatever Expo's CLI pulled in.
      const required = !optional[peer]?.optional;
      if (!required && !(peer in consumer.dependencies)) continue;
      const version = installedVersion(dir, peer);
      if (!version) {
        fail(
          `${manifest.name} requires peer ${peer}@${range}, not installed in the Expo 54 consumer`,
        );
        continue;
      }
      if (!Bun.semver.satisfies(version, range))
        fail(
          `${manifest.name} peer ${peer}@"${range}" does not admit the Expo 54 stack's ${version}`,
        );
      else console.log(`  ok ${manifest.name} peer ${peer}@"${range}" admits ${version}`);
    }
  }

  console.log('\n2. typecheck services src against React Native 0.81 / React 19.1 / Expo 54 types');
  const tsc = join(stage, 'node_modules', '.bin', 'tsc');
  try {
    run(tsc, ['-p', '.'], stage);
  } catch {
    fail('tsc reported errors in @oxy.so/services against the Expo 54 stack');
  }
  const files = run(tsc, ['-p', '.', '--listFilesOnly'], stage, { capture: true })
    .split('\n')
    .filter(Boolean);
  const outside = files.filter((file) => !realpathSync(file).startsWith(stage + sep));
  if (outside.length > 0)
    fail(`tsc read ${outside.length} files from outside the consumer, e.g. ${outside[0]}`);
  const count = (pkg) =>
    files.filter((file) => file.includes(`${sep}node_modules${sep}${pkg}${sep}`)).length;
  const counts = {
    '@oxy.so/services': count('@oxy.so/services'),
    'react-native': count('react-native'),
    '@types/react': count('@types/react'),
  };
  console.log(`  read ${files.length} files: ${JSON.stringify(counts)}`);
  if (counts['@oxy.so/services'] < 200)
    fail(`tsc saw only ${counts['@oxy.so/services']} services files`);
  if (counts['react-native'] < 50)
    fail(`tsc saw only ${counts['react-native']} react-native type files`);

  const canaries = {
    'canary-react.ts':
      "import { useEffectEvent } from 'react';\nexport const canary = useEffectEvent;\n",
    'canary-react-native.ts':
      "import { useAnimatedValueXY } from 'react-native';\nexport const canary = useAnimatedValueXY;\n",
  };
  for (const [file, source] of Object.entries(canaries)) {
    writeFileSync(join(stage, file), source);
    writeFileSync(
      join(stage, 'tsconfig.canary.json'),
      JSON.stringify({ extends: './tsconfig.json', include: [file] }),
    );
    let output = '';
    try {
      run(tsc, ['-p', 'tsconfig.canary.json'], stage, { capture: true });
    } catch (error) {
      output = `${error.stdout ?? ''}`;
    }
    const name = /import \{ (\w+) \}/.exec(source)[1];
    if (!new RegExp(`error TS(2305|2724).*'${name}'`).test(output))
      fail(`canary ${file} typechecked: the check is not reading the old types`);
    else console.log(`  canary ${file} fails as it must`);
  }

  console.log('\n3. render <OxyProvider> on iOS (RN 0.81), web (react-native-web 0.21) and macOS');
  try {
    run(join(stage, 'node_modules', '.bin', 'jest'), ['--ci', '--forceExit'], stage);
  } catch {
    fail('OxyProvider did not render and settle on the Expo 54 stack');
  }

  console.log(
    '\n4. bundle with Metro: iOS (compiled to Hermes bytecode) and macOS (react-native-macos)',
  );
  try {
    run(
      join(stage, 'node_modules', '.bin', 'expo'),
      ['export', '--platform', 'ios', '--output-dir', 'dist-ios'],
      stage,
      {
        env: { CI: '1', EXPO_NO_TELEMETRY: '1' },
      },
    );
    const bytecode = readdirSync(join(stage, 'dist-ios', '_expo', 'static', 'js', 'ios')).filter(
      (file) => file.endsWith('.hbc'),
    );
    if (bytecode.length !== 1)
      fail(`the iOS export holds ${bytecode.length} Hermes bundles, expected 1`);
    else console.log(`  iOS: ${bytecode[0]}`);
  } catch {
    fail('Metro could not bundle an app mounting OxyProvider for iOS on React Native 0.81');
  }
  try {
    run('node', ['bundle-macos.mjs'], stage, { env: { CI: '1' } });
    const bundle = readFileSync(join(stage, 'dist-macos', 'index.macos.js'), 'utf8');
    const has = (path) => bundle.includes(`"${path}`);
    const expectations = [
      [
        'react-native-macos is the React Native in the bundle',
        has('node_modules/react-native-macos/Libraries/'),
        true,
      ],
      ["react-native's own Libraries are not", has('node_modules/react-native/Libraries/'), false],
      [
        'the keyboard boundary is the macOS fork',
        has('node_modules/@oxy.so/services/src/ui/components/KeyboardBoundary.macos.tsx'),
        true,
      ],
      [
        'the native keyboard boundary is not bundled',
        has('node_modules/@oxy.so/services/src/ui/components/KeyboardBoundary.native.tsx'),
        false,
      ],
      [
        'images draw through the macOS fork',
        has('node_modules/@oxy.so/services/src/ui/components/ExpoImage.macos.tsx'),
        true,
      ],
      [
        'image sizes come from the macOS fork',
        has('node_modules/@oxy.so/services/src/ui/utils/imageSize.macos.ts'),
        true,
      ],
    ];
    for (const [claim, actual, expected] of expectations) {
      if (actual !== expected) fail(`macOS bundle: expected that ${claim}`);
      else console.log(`  macOS: ${claim}`);
    }
  } catch (error) {
    fail(`Metro could not bundle an app mounting OxyProvider for macOS: ${error.message}`);
  }
} catch (error) {
  fail(error.message);
} finally {
  if (keep) console.log(`kept ${stage}`);
  else rmSync(stage, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\n@oxy.so/services works on React Native 0.81 / React 19.1 / Expo SDK 54');
