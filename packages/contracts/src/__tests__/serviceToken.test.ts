import { serviceTokenOptionsSchema, serviceTokenScopesSchema } from '../serviceToken';
it('normalizes an explicit scope subset without changing omitted defaults', () => {
  expect(serviceTokenOptionsSchema.parse({})).toEqual({});
  expect(serviceTokenScopesSchema.parse([' user:read ', 'files:read'])).toEqual([
    'files:read',
    'user:read',
  ]);
});
it.each([
  { scopes: [] },
  { scopes: [''] },
  { scopes: ['user:read', ' user:read '] },
  { scopes: Array.from({ length: 101 }, (_, i) => `scope:${i}`) },
])('rejects ambiguous or unbounded subsets $scopes', ({ scopes }) => {
  expect(serviceTokenScopesSchema.safeParse(scopes).success).toBe(false);
});
