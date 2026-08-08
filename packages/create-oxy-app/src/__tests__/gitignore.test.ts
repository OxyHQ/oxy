import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRenderContext } from '../context';
import { renderTree } from '../render';

/**
 * The template must not ignore its own source.
 *
 * `.gitignore` shipped `lib/` under "Build output" while the frontend template
 * ships `packages/frontend/lib` — config, queryClient, themePersistence, i18n.
 * Every generated app therefore committed without the modules behind its
 * `@/lib/*` alias, and nothing said so: `git status` was clean after the commit,
 * `bun run typecheck` passed locally because the files are on disk, and the
 * first sign was CI failing to resolve modules that plainly exist.
 *
 * The check runs git rather than reimplementing its pattern matching, because a
 * hand-rolled matcher would be a second opinion about the rules and this needs
 * the real one.
 */

const TEMPLATES = path.join(import.meta.dir, '..', '..', 'templates');

// The CLI's own context builder, not a hand-written token map: a template that
// starts using a new `{{v.*}}` token would otherwise fail this test for a reason
// that has nothing to do with what it checks.
const ctx = buildRenderContext({
  name: 'My App',
  slug: 'my-app',
  scheme: 'myapp',
  bundleId: 'com.example.myapp',
  domain: 'api.example.com',
  backend: true,
  deploy: true,
  demo: true,
});

/** Render the base template into a throwaway directory. */
async function renderBase(): Promise<string> {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'oxy-scaffold-gitignore-'));
  await renderTree(path.join(TEMPLATES, 'base'), dest, ctx);
  return dest;
}

/** Every path git would refuse to add, given the rendered `.gitignore`. */
async function ignoredFiles(dir: string): Promise<string[]> {
  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  };

  await run(['git', 'init', '-q']);
  // `--others --ignored` lists exactly what is present and excluded, which is
  // the question — not what is merely matched by some pattern.
  const listed = await run([
    'git',
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ]);
  return listed.split('\n').filter(Boolean);
}

describe('the template does not ignore its own source', () => {
  test('every rendered file is addable', async () => {
    const dir = await renderBase();
    try {
      const ignored = await ignoredFiles(dir);

      // A vacuity floor: if rendering or git listing silently produced nothing,
      // an empty `ignored` would read as a pass. Assert the template actually
      // rendered the directory this regression was about.
      const libExists = await fs
        .stat(path.join(dir, 'packages', 'frontend', 'lib'))
        .then(() => true)
        .catch(() => false);
      expect(libExists).toBe(true);

      expect(ignored).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('`lib/` is not ignored, which is the specific regression', async () => {
    const ignore = await fs.readFile(path.join(TEMPLATES, 'base', 'DOT_gitignore'), 'utf8');
    const patterns = ignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    expect(patterns).not.toContain('lib/');
    expect(patterns).not.toContain('lib');
  });
});
