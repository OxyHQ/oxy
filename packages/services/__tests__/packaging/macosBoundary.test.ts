/**
 * Importing @oxy.so/services must not throw on react-native-macos.
 *
 * Astro, Oxy's browser, runs the SDK on react-native-macos, where the packages
 * below have no native implementation (their podspecs declare no `:osx`
 * platform in Expo SDK 54). Several throw the moment they are imported:
 * expo-image calls `requireNativeModule('ExpoImage')` at module scope and
 * react-native-keyboard-controller builds a `NativeEventEmitter` over a proxy
 * that throws "doesn't seem to be linked". One static import of either,
 * anywhere on the root barrel's graph, took the whole SDK down on macOS.
 *
 * So a file that STATICALLY imports one of them must have a react-native-macos
 * fork beside it (`<name>.macos.tsx`, which Metro picks for the macOS platform
 * before `.native` and the default) that does not. Dynamic loads inside a
 * `try` are fine: they reject and the caller degrades
 * (`optionalPeerLoads.test.ts`). The render that proves it is
 * `compat/expo-54` (`bun check.mjs`), which mounts `<OxyProvider>` on
 * react-native-macos 0.81 with every one of these modules absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const srcRoot = path.resolve(__dirname, '../../src');

const NO_MACOS_IMPLEMENTATION = [
  '@expo/app-integrity',
  'expo-blur',
  'expo-clipboard',
  'expo-document-picker',
  'expo-haptics',
  'expo-image',
  'expo-image-manipulator',
  'expo-image-picker',
  'expo-linear-gradient',
  'expo-notifications',
  'expo-secure-store',
  'expo-video',
  'react-native-keyboard-controller',
  'react-native-screens',
];

/** Static importers with no fork, each a decision with its reason. */
const EXEMPT: Record<string, string> = {
  // Its own opt-in subpath (`@oxy.so/services/ui/one-video`), never reached from
  // an entry point; it plays a video, which needs expo-video.
  'ui/one-video.tsx': 'opt-in video subpath',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function packageOf(specifier: string): string | null {
  return (
    NO_MACOS_IMPLEMENTATION.find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    ) ?? null
  );
}

/** Packages a file loads at import time: value imports and re-exports, not `import type`. */
function staticLoads(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (typeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = packageOf(statement.moduleSpecifier.text);
      if (name) found.add(name);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const name = packageOf(statement.moduleSpecifier.text);
      if (name) found.add(name);
    }
  }
  return [...found];
}

/** `a/B.native.tsx` and `a/B.tsx` -> `a/B.macos.tsx` (or `.ts`). */
function macosForkOf(rel: string): string | null {
  const match = /^(.*?)(\.native)?\.(tsx?)$/.exec(rel);
  if (!match) return null;
  for (const extension of ['tsx', 'ts']) {
    const fork = `${match[1]}.macos.${extension}`;
    if (fs.existsSync(path.join(srcRoot, fork))) return fork;
  }
  return null;
}

/** Files Metro never picks for the macOS platform. */
const otherPlatform = (rel: string) => /\.(web|ios|android|macos)\.tsx?$/.test(rel);

describe('react-native-macos boundary', () => {
  const files = sourceFiles(srcRoot).map((file) => path.relative(srcRoot, file));

  it('walks the real source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the detector sees every shape it guards', () => {
    expect(staticLoads('a.tsx', "import { Image } from 'expo-image';")).toEqual(['expo-image']);
    expect(
      staticLoads(
        'a.tsx',
        "import {\n  KeyboardProvider,\n} from 'react-native-keyboard-controller';",
      ),
    ).toEqual(['react-native-keyboard-controller']);
    expect(staticLoads('a.tsx', "export { Image as ExpoImage } from 'expo-image';")).toEqual([
      'expo-image',
    ]);
    expect(staticLoads('a.tsx', "import 'expo-video';")).toEqual(['expo-video']);
    expect(staticLoads('a.tsx', "import type { ImageProps } from 'expo-image';")).toEqual([]);
    expect(staticLoads('a.tsx', "import { type ImageProps } from 'expo-image';")).toEqual([]);
    expect(staticLoads('a.tsx', "const m = await import('expo-image');")).toEqual([]);
    expect(macosForkOf('ui/components/KeyboardBoundary.native.tsx')).toBe(
      'ui/components/KeyboardBoundary.macos.tsx',
    );
  });

  it('every static importer of a package macOS lacks has a macOS fork that does not import it', () => {
    const importers = files
      .filter((rel) => !otherPlatform(rel))
      .map((rel) => ({
        rel,
        loads: staticLoads(rel, fs.readFileSync(path.join(srcRoot, rel), 'utf8')),
      }))
      .filter(({ loads }) => loads.length > 0);
    expect(importers.map(({ rel }) => rel)).toEqual(
      expect.arrayContaining([
        'ui/components/ExpoImage.tsx',
        'ui/components/KeyboardBoundary.native.tsx',
      ]),
    );

    const unforked = importers
      .filter(({ rel }) => !(rel in EXEMPT))
      .map(({ rel, loads }) => {
        const fork = macosForkOf(rel);
        if (!fork) return `${rel} imports ${loads.join(', ')} and has no .macos fork`;
        const forkLoads = staticLoads(fork, fs.readFileSync(path.join(srcRoot, fork), 'utf8'));
        return forkLoads.length > 0 ? `${fork} still imports ${forkLoads.join(', ')}` : null;
      })
      .filter(Boolean);
    expect(unforked).toEqual([]);
  });

  it('every exemption still names a real importer', () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(
        staticLoads(rel, fs.readFileSync(path.join(srcRoot, rel), 'utf8')).length,
      ).toBeGreaterThan(0);
    }
  });
});
