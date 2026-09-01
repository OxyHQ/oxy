import { userIdentityFields } from '../userTransform';

describe('userIdentityFields accepts both row shapes', () => {
  it('reads the nested Mongoose name object', () => {
    const r = userIdentityFields({ _id: 'a'.repeat(24), username: 'nate', name: { first: 'Nate', last: 'Isern' } });
    expect(r.name.displayName).toBe('Nate Isern');
  });

  it('reads the flat Drizzle name columns', () => {
    // Regression guard: this silently produced `name: {}` before, and
    // formatUserResponse takes `unknown`, so tsc could not catch it.
    const r = userIdentityFields({ id: 'b'.repeat(24), username: 'nate', nameFirst: 'Nate', nameLast: 'Isern' });
    expect(r.name.displayName).toBe('Nate Isern');
  });

  it('omits displayName when the account has no real name', () => {
    const r = userIdentityFields({ id: 'c'.repeat(24), username: 'handleonly' });
    expect(r.name.displayName).toBeUndefined();
  });
});
