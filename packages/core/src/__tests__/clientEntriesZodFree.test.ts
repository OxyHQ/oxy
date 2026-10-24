/**
 * The client entries of `@oxy.so/core` ship no Zod.
 *
 * Zod's runtime is ~120 KB of JavaScript (~25 KB gzipped), evaluated at startup
 * by every app that bundles the SDK. Core used to reach it on every API call
 * and on the startup session path, because it checked responses with the
 * contracts' Zod schemas. It now checks them with `@oxy.so/contracts/client`,
 * whose checks are tied to those schemas by contracts' own parity test.
 *
 * This walks the STATIC value-import graph of each client entry — the graph
 * every bundler, Metro included, must load — following the workspace packages
 * core depends on (`@oxy.so/contracts`, `@oxy.so/protocol`, `@oxy.so/telemetry`)
 * into their source, and asserts no module on it imports a Zod runtime. A source-text
 * grep would miss a re-export chain; resolving the graph does not.
 */
import { join, relative, resolve } from 'node:path';
import { resolveSource, walkImportGraph } from './fixtures/importGraph';

const SRC = resolve(__dirname, '..');
const PACKAGES = resolve(SRC, '..', '..');
const WORKSPACE = /^@oxy\.so\/(contracts|protocol|telemetry)(?:\/(.+))?$/;

/** A workspace package import → its source file; anything else stays external. */
function resolveWorkspace(specifier: string): string | null {
  const match = WORKSPACE.exec(specifier);
  if (!match) return null;
  const [, name, subpath] = match;
  return resolveSource(join(PACKAGES, name, 'src', subpath ?? 'index'));
}

/** Who (relative to packages/) imports Zod on the static graph of `entry`. */
function zodImporters(entry: string): string[] {
  const { external } = walkImportGraph(join(SRC, entry), resolveWorkspace);
  return [...external.entries()]
    .filter(([specifier]) => /^(?:zod|@oxy\.so\/zod[34])(?:\/.*)?$/.test(specifier))
    .flatMap(([, importers]) => importers.map((file) => relative(PACKAGES, file)))
    .sort();
}

describe('@oxy.so/core client entries do not reach Zod', () => {
  it.each([
    ['`.`', 'index.ts'],
    ['`./session`', 'session/index.ts'],
    ['`./crypto`', 'crypto/index.ts'],
    ['`./civic`', 'civic/index.ts'],
    ['`./logger`', 'logger/index.ts'],
  ])('%s imports no zod', (_entry, file) => {
    expect(zodImporters(file)).toEqual([]);
  });

  it('the walk follows workspace packages into their source (the control)', () => {
    // `./server` validates with the Zod schemas on purpose; if the probe could
    // not see that, an empty list above would prove nothing.
    expect(zodImporters('server/index.ts')).toEqual(
      expect.arrayContaining(['contracts/src/deviceSession.ts']),
    );
  });
});
