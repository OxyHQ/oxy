import { is, SQL } from 'drizzle-orm';
import { PgDialect, pgTable } from 'drizzle-orm/pg-core';
import { createdAt, inList, numericInList, uuidv7 } from '../columns';
import { isLiveEntityId } from '../ids';

describe('uuidv7', () => {
  it('produces a v7 uuid', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('sorts lexicographically in generation order', () => {
    // A real tight loop does NOT discriminate here: 50 synchronous calls
    // typically land inside the same millisecond, where the low 74 bits are
    // pure randomness with no monotonic counter (verified empirically — the
    // untouched, correct implementation fails a same-millisecond tight loop
    // on effectively every run). What the id format actually guarantees is
    // ordering BY THE ENCODED TIMESTAMP, so the clock is mocked to hand out
    // 50 strictly increasing, widely-spaced instants — spaced far enough
    // apart (1e8 ms, ~1.15 days) to move more than the low timestamp byte, so
    // a byte-order mistake in the encoder breaks the sort rather than
    // surviving by coincidence.
    const nowSpy = jest.spyOn(Date, 'now');
    const base = 1_700_000_000_000;
    const STEP_MS = 100_000_000;
    let calls = 0;
    nowSpy.mockImplementation(() => base + calls++ * STEP_MS);

    const ids = Array.from({ length: 50 }, () => uuidv7());
    nowSpy.mockRestore();

    expect([...ids].sort()).toEqual(ids);
  });

  it('accepts its own output as a live entity id', () => {
    expect(isLiveEntityId(uuidv7())).toBe(true);
    expect(isLiveEntityId('not-an-id')).toBe(false);
  });
});

describe('createdAt', () => {
  it('defaults at JS millisecond precision, so a written row round-trips', () => {
    // Postgres stores microseconds and a JS Date holds milliseconds. A
    // `defaultNow()` default produces a value the application cannot reproduce.
    //
    // Two problems, not one, with reading `createdAt().default` directly, as
    // a first draft of this test did:
    //
    // 1. `createdAt()` alone is a column BUILDER, not a built column — its
    //    `.default` resolves to the inherited `default(value)` CONFIGURATION
    //    METHOD (a function), not the value passed to it, because the
    //    builder's `.default` and the eventual runtime column's `.default`
    //    are two unrelated members of two different classes. The value is
    //    only realized once the builder passes through `pgTable(...)`, which
    //    is why this builds a throwaway table around the column first.
    // 2. Even on the correctly-built column, `String(column.default)` is not
    //    a discriminator: every `sql` template tag produces an SQL object
    //    with no `toString` override, so both `defaultNow()`'s `sql\`now()\``
    //    and this column's own default coerce to the identical
    //    "[object Object]" — a naive string match passes identically either
    //    way. Rendering through the same `PgDialect` drizzle itself uses to
    //    build a migration reads the actual SQL text instead.
    const table = pgTable('t', { createdAt: createdAt() });
    const defaultValue = table.createdAt.default;
    expect(defaultValue).toBeDefined();
    if (!is(defaultValue, SQL)) {
      throw new Error('createdAt() default is expected to be a SQL expression');
    }
    const { sql: rendered } = new PgDialect().sqlToQuery(defaultValue);
    expect(rendered).not.toMatch(/^now\(\)$/i);
    expect(rendered).toMatch(/date_trunc/i);
  });
});

describe('inList', () => {
  it('renders a SQL value list a CHECK constraint can use', () => {
    expect(inList(['a', 'b'])).toBe("'a', 'b'");
  });

  it('does not sanitize its input — trusts the caller to pass only literal, non-runtime values', () => {
    // Verified against the real implementation: it performs no escaping or
    // rejection. It is safe only because every call site passes a
    // locally-declared `as const` tuple of identifier-shaped literals, never a
    // runtime value — a value containing a quote is interpolated verbatim
    // rather than refused. (A prior draft of this test asserted `inList`
    // throws on such a value; it does not, so that assertion would have
    // invented behaviour rather than verified it.)
    expect(inList(["a'; drop table users; --"])).toBe("'a'; drop table users; --'");
  });

  it('renders numbers without quoting them', () => {
    expect(numericInList([1, 2])).toBe('1, 2');
  });
});
