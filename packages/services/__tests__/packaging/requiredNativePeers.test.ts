/**
 * Every native module the SDK needs on iOS/Android is a REQUIRED peer of
 * `@oxy.so/services`.
 *
 * Expo's autolinking (expo-modules-autolinking 58,
 * `build/dependencies/resolution.js`) links what the app depends on, the root's
 * devDependencies, and the NON-optional peers of every package it walks. It
 * skips optional peers on purpose: "optional peer dependencies don't
 * auto-install and we can skip them". So a native module that only an optional
 * peer names is linked only if the app lists it itself.
 *
 * `expo-crypto` was that module. It is an optional peer of `@oxy.so/core` and
 * `@oxy.so/protocol` (they also run in Node and on the web), services did not
 * name it, and on a Pixel 10 Pro Allo's release APK died with
 * `[oxy.protocol.crypto] 'expo-crypto' is not installed, so the React Native
 * CSPRNG (crypto.getRandomValues) is unavailable … Cannot find native module
 * 'ExpoCrypto'`. The JavaScript was in node_modules (something else had pulled
 * it in); the native module was never linked. "Sign in with Oxy" failed the same
 * way, at `generateChallenge()`.
 *
 * This gate reads every runtime load (value import, `import()`, `require()` of
 * a literal) in services', core's and protocol's source, keeps the packages that
 * ship native code, and requires each to be a required peer of services, or a
 * GRACEFUL optional peer recorded below with the path that keeps the SDK
 * working without it. A native module nobody classified fails here, before it
 * fails on a phone.
 */
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const packagesDir = path.resolve(__dirname, '../../..');
const servicesRoot = path.join(packagesDir, 'services');

/** The sources whose loads reach a React Native app through services. */
const SOURCE_ROOTS = ['services', 'core', 'protocol'];

interface Manifest {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(servicesRoot, 'package.json'), 'utf8'),
) as Manifest;
const isOptionalPeer = (name: string) => manifest.peerDependenciesMeta?.[name]?.optional === true;
const REQUIRED_PEERS = new Set(
  Object.keys(manifest.peerDependencies ?? {}).filter((name) => !isOptionalPeer(name)),
);

/**
 * Native modules that stay OPTIONAL peers, each with the path that keeps every
 * core flow (sign-in, session, crypto, storage) working without it. A new
 * entry needs the same: a feature that degrades, never one that throws.
 */
const GRACEFUL_OPTIONAL_NATIVE_PEERS: Record<string, string> = {
  'expo-modules-core':
    'linked through `expo`, which depends on it, and a required peer of @oxy.so/protocol; Expo apps never list it',
  'expo-clipboard': 'copy buttons only; clipboard.native.ts loads it in a try and reports failure',
  'expo-haptics': 'haptic feedback only; a no-op without it',
  'expo-image-picker': 'avatar/file upload screens; they report the picker as unavailable',
  'expo-image-manipulator': 'avatar crop; uploads the uncropped image without it',
  'expo-document-picker': 'file management upload; reports the picker as unavailable',
  'expo-notifications': 'push, behind the `@oxy.so/services/notifications` subpath only',
  'expo-constants': 'push project id, behind the `@oxy.so/services/notifications` subpath only',
  'expo-web-browser':
    'third-party OAuth only (first-party apps sign in by device flow); falls back to Linking.openURL',
  'expo-video': 'the opt-in `@oxy.so/services/ui/one-video` subpath only',
};

/** Packages that are the app itself, never a peer to add. */
const HOST_PACKAGES = new Set(['react-native']);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      // The web variants never run on a phone.
      !/\.web\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null;
  }
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  if (name.startsWith('@oxy.so/') || builtinModules.includes(name)) return null;
  return name;
}

interface Load {
  pkg: string;
  where: string;
}

/** Runtime loads: value imports and re-exports, `import()` and `require()` of a literal. */
function loadsIn(file: string): Load[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const loads: Load[] = [];
  const add = (specifier: string, node: ts.Node) => {
    const pkg = packageNameOf(specifier);
    if (!pkg) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    loads.push({ pkg, where: `${path.relative(packagesDir, file)}:${line}` });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const isLoad =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      const [arg] = node.arguments;
      if (isLoad && arg && ts.isStringLiteralLike(arg)) add(arg.text, node);
    } else if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

/** The installed package directory, found the way Node and Metro walk node_modules. */
function packageDir(name: string, from: string): string | null {
  let dir = from;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Ships native code that autolinking has to link: the markers Expo and the RN CLI read. */
function isNativeModule(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'expo-module.config.json')) ||
    fs.existsSync(path.join(dir, 'react-native.config.js')) ||
    fs.existsSync(path.join(dir, 'android')) ||
    fs.existsSync(path.join(dir, 'ios')) ||
    fs.readdirSync(dir).some((entry) => entry.endsWith('.podspec'))
  );
}

describe('required native peers', () => {
  const loads = SOURCE_ROOTS.flatMap((root) =>
    sourceFiles(path.join(packagesDir, root, 'src')).flatMap(loadsIn),
  );
  const byPackage = new Map<string, string[]>();
  for (const load of loads) {
    byPackage.set(load.pkg, [...(byPackage.get(load.pkg) ?? []), load.where]);
  }
  const unresolved: string[] = [];
  const native = new Map<string, string[]>();
  for (const [pkg, where] of byPackage) {
    const owner = path.join(packagesDir, where[0].split(path.sep)[0]);
    const dir = packageDir(pkg, owner) ?? packageDir(pkg, servicesRoot);
    if (!dir) unresolved.push(`${pkg} (${where[0]})`);
    else if (!HOST_PACKAGES.has(pkg) && isNativeModule(dir)) native.set(pkg, where);
  }

  it('walks all three packages and finds the loads that matter', () => {
    // Vacuity floor: a broken walk would find nothing and pass.
    expect(loads.length).toBeGreaterThan(200);
    const wheres = (pkg: string) => native.get(pkg) ?? [];
    expect(wheres('expo-crypto').some((w) => w.startsWith(`protocol${path.sep}`))).toBe(true);
    expect(wheres('expo-secure-store').some((w) => w.startsWith(`protocol${path.sep}`))).toBe(true);
    expect(wheres('expo-secure-store').some((w) => w.startsWith(`services${path.sep}`))).toBe(true);
    expect(wheres('react-native-keyboard-controller').length).toBeGreaterThan(0);
  });

  it('can classify every package it found (install it as a devDependency of services)', () => {
    expect(unresolved).toEqual([]);
  });

  it('declares every native module as a required peer, or records why it is optional', () => {
    const unclassified = [...native]
      .filter(([pkg]) => !REQUIRED_PEERS.has(pkg) && !(pkg in GRACEFUL_OPTIONAL_NATIVE_PEERS))
      .map(([pkg, where]) => `${pkg} <- ${where.join(', ')}`);
    expect(unclassified).toEqual([]);
  });

  it('keeps every recorded optional native module an optional peer of services', () => {
    const wrong = Object.keys(GRACEFUL_OPTIONAL_NATIVE_PEERS).filter(
      (pkg) => !(manifest.peerDependencies?.[pkg] && isOptionalPeer(pkg)),
    );
    expect(wrong).toEqual([]);
  });

  it('never leaves core or protocol depending on a graceful optional one', () => {
    // core and protocol throw when a peer they load is missing; anything they
    // load on a phone is a core flow and so a required peer of services.
    const leaks = [...native]
      .filter(([pkg]) => pkg in GRACEFUL_OPTIONAL_NATIVE_PEERS && pkg !== 'expo-modules-core')
      .flatMap(([pkg, where]) =>
        where.filter((w) => !w.startsWith(`services${path.sep}`)).map((w) => `${pkg} <- ${w}`),
      );
    expect(leaks).toEqual([]);
  });

  it('requires the modules sign-in, the session and the CSPRNG need', () => {
    // The regression, named: these were optional or undeclared until 13.5.0.
    for (const pkg of [
      'expo-crypto',
      'expo-secure-store',
      'react-native-keyboard-controller',
      '@react-native-async-storage/async-storage',
    ]) {
      expect({ pkg, required: REQUIRED_PEERS.has(pkg) }).toEqual({ pkg, required: true });
    }
  });
});
