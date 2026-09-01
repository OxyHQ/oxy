/**
 * Columns That Must Not Reach a Client — the `select: false` replacement
 *
 * A source model can mark a field so sensitive it is absent from every read
 * unless a caller asks for it by name. Drizzle enumerates columns
 * explicitly, so a naive port keeps no such guard at all: `db.select().from(users)`
 * returns every column, including a raw phone number or a live bearer
 * token, with nothing in the call site naming what leaked.
 *
 * This module is the replacement, decided once for every table rather than
 * per call site, with three parts:
 *
 *   1. **The registry is data** (`ProtectedColumnRegistry`), owned by the
 *      caller — it names the caller's own tables and columns, which nothing
 *      in a shared package may hard-code.
 *   2. **`publicColumns(table, registry)` is the sanctioned read.**
 *      `db.select(publicColumns(users, REGISTRY)).from(users)` omits every
 *      registered column from the result — and, when `REGISTRY` is declared
 *      `as const` (see this function's own doc comment for why that matters),
 *      omits it AT THE TYPE LEVEL too: the row type has no `phone` property
 *      at all, so a serializer that tries to read one fails `tsc` rather
 *      than shipping it.
 *   3. **`findImplicitWholeRowReads` scans source for the two shapes that
 *      return every column regardless of `publicColumns` even existing** — a
 *      bare `.select()` and the relational `db.query.<table>` API, both of
 *      which return every column, including whatever the registry protects,
 *      without naming any of them. `publicColumns` cannot defend against not
 *      being called; only a scan of the call sites can.
 *
 * Opting in to a protected column is deliberately unhelped: a path that
 * legitimately needs one names it explicitly —
 * `db.select({ id: users.id, phone: users.phone }).from(users)` — which
 * reads differently from an ordinary select and stays greppable.
 */

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { InvariantViolation } from './schemaInvariants';

/** A caller's own registry: SQL table name -> the columns it protects. */
export type ProtectedColumnRegistry = Readonly<Record<string, readonly string[]>>;

/** The protected property names of `T` under `Reg`, or `never` if none apply. */
type ProtectedNameOf<T extends PgTable, Reg extends ProtectedColumnRegistry> =
  T['_']['name'] extends keyof Reg ? Reg[T['_']['name']][number] : never;

/** `T`'s columns with every column `Reg` protects removed, at the type level. */
export type PublicColumns<T extends PgTable, Reg extends ProtectedColumnRegistry> = Omit<
  T['_']['columns'],
  ProtectedNameOf<T, Reg>
>;

/**
 * Every column of `table` a client may see, per `registry`.
 *
 * ```ts
 * const REGISTRY = { users: ['phone', 'hashedEmail'] } as const;
 * const rows = await db.select(publicColumns(users, REGISTRY)).from(users);
 * rows[0].phone; // Property 'phone' does not exist — a compile error, not a leak
 * ```
 *
 * A table with no registry entry gets all of its columns, so this is safe to
 * call for every table and stays correct the moment a column is added to the
 * registry.
 *
 * ## The type-level guarantee, and EXACTLY what it depends on
 *
 * `Reg` is declared `const Reg extends ProtectedColumnRegistry` (TypeScript's
 * `const` type parameter modifier), which is what lets a registry passed as
 * an ordinary object literal — `publicColumns(users, { users: ['phone'] })`,
 * with no explicit `as const` at the call site — still infer literal member
 * types and exclude `phone` from the return type. Confirmed directly against
 * `publicColumns.typetest.ts`: WITHOUT the `const` modifier, that identical
 * call collapses `PublicColumns<T, Reg>` to `{}` (every column, not just the
 * protected one, becomes type-inaccessible) — WITH it, only `phone` is
 * removed and every other column stays.
 *
 * The guarantee still has a real, narrow gap. `const` type-parameter
 * inference reads the type TypeScript would otherwise assign the argument
 * expression — so it is defeated the same way any other literal-type
 * inference is: by widening the registry to `ProtectedColumnRegistry` before
 * it reaches this call, whether via an explicit type annotation
 * (`const REGISTRY: ProtectedColumnRegistry = { users: ['phone'] }`) or by
 * passing it through an intermediate function parameter typed that way. Both
 * shapes are exercised in `publicColumns.typetest.ts`, and both collapse the
 * result to `{}` for the affected table — the SAME fail-closed direction as
 * the missing-modifier case above, never a leak: every column becomes
 * inaccessible, not just the ones actually withheld. The runtime filter
 * below is driven entirely by VALUES, never by this type, so it withholds
 * exactly the registered columns regardless of which of these cases applies
 * — only the compile-time guarantee narrows or disappears.
 *
 * A registry declared `as const` at its own definition (`export const
 * REGISTRY = { users: [...] } as const;`, never re-annotated with
 * `ProtectedColumnRegistry`) and passed straight through to this function is
 * the shape that keeps the full guarantee.
 */
export function publicColumns<T extends PgTable, const Reg extends ProtectedColumnRegistry>(
  table: T,
  registry: Reg
): PublicColumns<T, Reg> {
  const name = getTableName(table);
  const withheld = new Set<string>(name in registry ? registry[name] : []);

  const selection: Record<string, PgColumn> = {};
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    if (withheld.has(property)) continue;
    selection[property] = column;
  }

  // The one cast in this module: the loop above removes exactly the keys
  // `PublicColumns<T, Reg>` removes, which the type system cannot follow
  // through `Object.entries`. The runtime tests re-check the equivalence
  // (`Object.keys(...)`) so the cast cannot quietly become a lie.
  return selection as PublicColumns<T, Reg>;
}

export interface ImplicitReadScanOptions {
  /** Root of the caller's own source tree to scan — never this package's. */
  readonly sourceDir: string;
  readonly registry: ProtectedColumnRegistry;
}

/** Every `.ts` file under `directory`, excluding tests and `node_modules`. */
async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...(await sourceFiles(path)));
      continue;
    }
    if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Blank out comments, preserving line structure.
 *
 * Without this, the scan flags documentation that quotes the offending
 * shapes on purpose (this file's own doc comment above does exactly that) —
 * a scanner that cries wolf on the comment explaining the rule is a scanner
 * someone deletes.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
}

/** Escape a literal string for use inside a hand-built `RegExp` source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `auth_sessions` -> `authSessions`.
 *
 * The registry is keyed by SQL table name (what `publicColumns` looks up via
 * `getTableName`), but call sites reference a table by its TypeScript
 * identifier — conventionally the camelCase form of that same name. A scan
 * built only from the literal registry key matches a single-word table
 * (`users`, `sessions`) by coincidence, and silently never matches a
 * multi-word one: `.from(authSessions)` contains no substring `auth_sessions`
 * at all. Both spellings are matched (see {@link tableIdentifierAlternatives})
 * so a call site is caught regardless of which one a table happens to use.
 */
function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** Every identifier spelling worth matching for each registered table. */
function tableIdentifierAlternatives(registry: ProtectedColumnRegistry): string[] {
  const alternatives = new Set<string>();
  for (const tableName of Object.keys(registry)) {
    alternatives.add(escapeRegExp(tableName));
    alternatives.add(escapeRegExp(snakeToCamel(tableName)));
  }
  return [...alternatives];
}

/**
 * `file:line` for every match of `pattern` — reported as the violation's
 * `subject` (a plain, greppable location), with the matched text itself in
 * `detail`.
 *
 * Matched against the WHOLE file, not line by line: a chained call routinely
 * wraps its `.select()` and `.from(...)` onto different lines, and a
 * per-line scan would miss exactly that formatting.
 */
async function findPatternViolations(
  check: string,
  pattern: RegExp,
  files: readonly string[],
  sourceDir: string
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const source = withoutComments(raw);
    const scan = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);

    for (const match of source.matchAll(scan)) {
      const before = source.slice(0, match.index);
      const line = before.split('\n').length;
      // The whole matched text, never a truncated capture group: a
      // truncated match is how a scanner's evidence stops being readable
      // and then gets trusted anyway.
      const shown = match[0].replace(/\s+/g, ' ').trim();
      violations.push({
        check,
        subject: `${relative(sourceDir, file)}:${line}`,
        detail: shown,
      });
    }
  }
  return violations;
}

/**
 * Scan `options.sourceDir` for the two shapes that return every column of a
 * registered table implicitly, regardless of whether `publicColumns` exists:
 * a bare `.select()` and the relational `db.query.<table>` API. Returns an
 * empty array for a clean tree.
 *
 * A `vacuity` violation is reported if the traversal finds not a single
 * `.ts` file — a broken `sourceDir`, not a healthy tree. This is a floor of
 * one, not a substitute for a caller's own project-specific floor (a
 * consumer with hundreds of source files should assert its own minimum
 * count alongside calling this, since only the consumer knows how large its
 * own tree should be).
 */
export async function findImplicitWholeRowReads(
  options: ImplicitReadScanOptions
): Promise<InvariantViolation[]> {
  const files = await sourceFiles(options.sourceDir);

  if (files.length === 0) {
    return [
      {
        check: 'vacuity',
        subject: 'files',
        detail: `found 0 .ts source files under ${options.sourceDir}`,
      },
    ];
  }

  const tableNames = tableIdentifierAlternatives(options.registry);
  if (tableNames.length === 0) return [];

  // `db.select().from(users)` / `.select().from(users,` — the argument-less
  // form returns EVERY column.
  const bareSelectPattern = new RegExp(
    `\\.select\\(\\s*\\)[\\s\\S]{0,120}?\\.from\\(\\s*(?:${tableNames.join('|')})\\s*[,)]`
  );
  // `db.query.users.findFirst()` also returns every column unless a
  // `columns:` projection is passed, and that projection is easy to omit
  // and invisible when it is.
  const relationalQueryPattern = new RegExp(`\\.query\\.(?:${tableNames.join('|')})\\b`);

  return [
    ...(await findPatternViolations('implicit_select_all', bareSelectPattern, files, options.sourceDir)),
    ...(await findPatternViolations(
      'implicit_relational_query',
      relationalQueryPattern,
      files,
      options.sourceDir
    )),
  ];
}
