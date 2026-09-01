import { sql } from 'drizzle-orm';
import { pgTable, PgDialect, text, timestamp } from 'drizzle-orm/pg-core';
import { DATABASE_CASING, qualified, sqlColumnName } from '../casing';

const sessions = pgTable('sessions', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true, mode: 'date' }),
  legacy: text('legacy_name'),
});

describe('casing', () => {
  it('uses snake_case as the one naming convention', () => {
    expect(DATABASE_CASING).toBe('snake_case');
  });

  it('derives the SQL name from the TypeScript property', () => {
    // The trap: `column.name` is `expiresAt`, which no Postgres column is called.
    expect(sqlColumnName(sessions.expiresAt)).toBe('expires_at');
  });

  it('honours an explicitly named column instead of re-deriving it', () => {
    expect(sqlColumnName(sessions.legacy)).toBe('legacy_name');
  });

  it('qualifies a column with its table, so a correlated subquery cannot rebind it', () => {
    // Render through drizzle's real dialect rather than counting query chunks:
    // a bare `"expires_at"` and a qualified `"sessions"."expires_at"` are both
    // non-empty SQL, so only the rendered TEXT can tell a regression apart from
    // the fix this function exists to guarantee.
    const dialect = new PgDialect({ casing: DATABASE_CASING });
    const chunk = qualified(sessions.expiresAt);
    const rendered = sql`select 1 where ${chunk} is null`;
    expect(dialect.sqlToQuery(rendered).sql).toBe('select 1 where "sessions"."expires_at" is null');
  });
});
