import { accountAuditQuerySchema } from '../account.schemas';

/**
 * `accountAuditQuerySchema`, and the one property a query schema in this API
 * cannot do without.
 *
 * `middleware/validate.ts` writes its parsed result back onto `req.query` and the
 * handler parses it AGAIN to get a typed value, so every query schema here is fed
 * its own output on the second pass. A schema that cannot read what it produced
 * raises `invalid_type` inside the handler — outside any validation boundary,
 * which is a 500 on a read rather than a 400. That is exactly how
 * `GET /billing/cost-centers` answered 500 on every request, including the
 * default one with no parameters, for as long as the route existed.
 */
describe('accountAuditQuerySchema', () => {
  it('parses its own output, in every position', () => {
    for (const input of [
      {},
      { limit: '1' },
      { limit: '200' },
      { cursor: 'abc' },
      { limit: '25', cursor: 'abc' },
    ] as const) {
      const once = accountAuditQuerySchema.parse(input);
      expect(accountAuditQuerySchema.parse(once)).toEqual(once);
    }
  });

  it('defaults the limit rather than reading everything', () => {
    // An audit union with no limit is an unbounded scan over two tables.
    expect(accountAuditQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('refuses a limit outside the server’s own bounds', () => {
    for (const limit of ['0', '-1', '201', 'lots']) {
      expect(accountAuditQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    // POSITIVE CONTROL: the boundary values themselves are accepted, so the
    // refusals above are about the bounds and not about coercion failing.
    expect(accountAuditQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(accountAuditQuerySchema.parse({ limit: '200' }).limit).toBe(200);
  });

  it('refuses an unknown parameter rather than ignoring it', () => {
    // `.strict()`: a caller who misspells `cursor` gets told, instead of silently
    // reading page one forever.
    expect(accountAuditQuerySchema.safeParse({ cursur: 'abc' }).success).toBe(false);
  });

  it('carries the cursor through opaquely, without inspecting it', () => {
    // The service refuses a cursor it did not issue and reads from the start.
    // Validating the shape here would turn a stale bookmark into an error page.
    expect(accountAuditQuerySchema.parse({ cursor: 'not-a-real-cursor' }).cursor).toBe(
      'not-a-real-cursor'
    );
  });
});
