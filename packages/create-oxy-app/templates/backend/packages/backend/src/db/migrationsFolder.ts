import fs from 'node:fs';
import path from 'node:path';

/**
 * Absolute path to this package's `drizzle/` migrations folder.
 *
 * ## Why this is a module and not a `path.join` at the call site
 *
 * The obvious spelling — `path.join(__dirname, '..', '..', 'drizzle')` — is
 * correct in exactly one of the two places this code runs, and silently wrong in
 * the other. `tsconfig.json` compiles with `rootDir: "./"`, so the source tree's
 * layout is preserved under `dist/`:
 *
 *   src/db/migrate.ts        →  two levels below the package root
 *   dist/src/db/migrate.js   →  THREE levels below it
 *
 * A fixed number of `..` segments therefore resolves to the package root during
 * development (`bun run db:migrate`) and to `packages/` in the built image — and
 * the failure is not a crash at the point of the mistake. `readJournal` reports
 * a missing `_journal.json`, which reads as "the image was built without its
 * migrations" rather than "the path arithmetic is off by one", and that is a
 * genuinely hard thing to diagnose from a container log.
 *
 * So the folder is FOUND rather than computed: walk up from wherever this module
 * ended up until a directory contains a real `drizzle/meta/_journal.json`. That
 * is correct from any depth, under `bun` or `node`, from the repository or from
 * inside the Docker image.
 *
 * ## Why `__dirname` and not `import.meta.url`
 *
 * This package is CommonJS (`"type": "commonjs"`, and `@oxyhq/app-preset`'s
 * backend tsconfig compiles `module: "commonjs"`). `import.meta` is a syntax
 * error in a CommonJS module, so `fileURLToPath(import.meta.url)` — the spelling
 * an ESM backend would use — cannot be copied here.
 */
/**
 * The file whose presence identifies a real drizzle migrations folder.
 *
 * Declared BEFORE `MIGRATIONS_FOLDER`, and that ordering is load-bearing rather
 * than stylistic. `MIGRATIONS_FOLDER` is initialized at module evaluation time,
 * so it runs `resolveMigrationsFolder()` immediately — and while the function
 * DECLARATION hoists, a `const` does not initialize until its own statement runs.
 * With this below the export, the first call reads it inside its temporal dead
 * zone and the module throws `ReferenceError: Cannot access
 * 'JOURNAL_RELATIVE_PATH' before initialization` on import. TypeScript does not
 * flag it (the reference is inside a function body, which it cannot order), so
 * the build is green and every `db:migrate` fails.
 */
const JOURNAL_RELATIVE_PATH = path.join('drizzle', 'meta', '_journal.json');

export const MIGRATIONS_FOLDER = resolveMigrationsFolder();

function resolveMigrationsFolder(): string {
  let directory = __dirname;

  // `path.dirname('/')` is `'/'`, so the root is where climbing stops.
  for (;;) {
    if (fs.existsSync(path.join(directory, JOURNAL_RELATIVE_PATH))) {
      return path.join(directory, 'drizzle');
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `Could not find ${JOURNAL_RELATIVE_PATH} in any directory above ${__dirname}. ` +
          'The drizzle/ folder must ship next to the code that applies it — check ' +
          'that the Dockerfile copies packages/backend/drizzle/ into the runtime stage.',
      );
    }
    directory = parent;
  }
}
