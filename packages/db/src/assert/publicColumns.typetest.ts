/**
 * Compile-time-only regression check for the type-level half of
 * {@link publicColumns} — see `database.typetest.ts` for why this file is
 * `.typetest.ts` (checked by `tsc`, excluded from every build config, never
 * emitted, and never executed by jest).
 *
 * Every claim in `publicColumns`'s own doc comment is asserted here, both
 * the cases that hold and the two documented cases that do not —
 * deliberately WITHOUT `@ts-expect-error`: an ordinary generic constraint
 * violation (`AssertTrue<T extends true>` rejecting a `false`) pins the
 * EXACT type the call resolves to, not merely "some error occurs somewhere
 * on this line". That distinction matters most for the two collapse cases
 * below: if either gap were ever silently fixed (or silently made worse),
 * the corresponding assertion flips from `true` to `false` and stops
 * compiling, which is what makes this a check on the type itself rather
 * than on the presence of a diagnostic.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import { publicColumns, type ProtectedColumnRegistry } from './protectedColumns';

type AssertTrue<T extends true> = T;
type Includes<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Excludes<T, K extends PropertyKey> = K extends keyof T ? false : true;

const users = pgTable('users', { id: text().primaryKey(), phone: text(), email: text() });
const posts = pgTable('posts', { id: text().primaryKey(), authorId: text() });

function holdsForRegistryDeclaredAsConst(): void {
  const REGISTRY = { users: ['phone'] } as const;
  const selected = publicColumns(users, REGISTRY);
  type _IdIncluded = AssertTrue<Includes<typeof selected, 'id'>>;
  type _EmailIncluded = AssertTrue<Includes<typeof selected, 'email'>>;
  type _PhoneExcluded = AssertTrue<Excludes<typeof selected, 'phone'>>;
}
void holdsForRegistryDeclaredAsConst;

function holdsForAnInlineLiteralRegistryWithNoExplicitAsConst(): void {
  // No `as const` anywhere in this call — relies entirely on the `const Reg`
  // type-parameter modifier inferring literal member types from the
  // argument expression itself.
  const selected = publicColumns(users, { users: ['phone'] });
  type _IdIncluded = AssertTrue<Includes<typeof selected, 'id'>>;
  type _PhoneExcluded = AssertTrue<Excludes<typeof selected, 'phone'>>;
}
void holdsForAnInlineLiteralRegistryWithNoExplicitAsConst;

function tableWithNoRegistryEntryKeepsEveryColumn(): void {
  const selected = publicColumns(posts, { users: ['phone'] } as const);
  type _IdIncluded = AssertTrue<Includes<typeof selected, 'id'>>;
  type _AuthorIdIncluded = AssertTrue<Includes<typeof selected, 'authorId'>>;
}
void tableWithNoRegistryEntryKeepsEveryColumn;

/**
 * The documented gap: a registry stored in a variable WITHOUT `as const`
 * loses literal member types, so `Reg[T['_']['name']][number]` widens to
 * `string` and `Omit<Columns, string>` removes every property — not just
 * the registered one. This is the fail-CLOSED direction (every column,
 * including legitimate ones, becomes type-inaccessible) rather than a leak,
 * but it means the type-level guarantee is lost entirely for this call, not
 * just weakened.
 */
function collapsesWhenTheRegistryVariableIsNotConstAsserted(): void {
  const REGISTRY_WITHOUT_AS_CONST = { users: ['phone'] };
  const selected = publicColumns(users, REGISTRY_WITHOUT_AS_CONST);
  // `id` is legitimate and still becomes inaccessible -- that is the gap.
  type _IdBecomesInaccessible = AssertTrue<Excludes<typeof selected, 'id'>>;
}
void collapsesWhenTheRegistryVariableIsNotConstAsserted;

/**
 * The second documented gap: annotating a registry constant with the
 * exported (necessarily widened) `ProtectedColumnRegistry` type throws away
 * the literal member types just as surely as omitting `as const` does, even
 * though the declaration itself uses no other widening.
 */
function collapsesWhenAnnotatedWithTheExportedRegistryType(): void {
  const REGISTRY_ANNOTATED: ProtectedColumnRegistry = { users: ['phone'] };
  const selected = publicColumns(users, REGISTRY_ANNOTATED);
  // Same collapse as above, via a different widening path.
  type _IdBecomesInaccessible = AssertTrue<Excludes<typeof selected, 'id'>>;
}
void collapsesWhenAnnotatedWithTheExportedRegistryType;
