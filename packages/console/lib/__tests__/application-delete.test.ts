import { isDeleteConfirmed } from '../application-delete';

describe('isDeleteConfirmed', () => {
  it('accepts the exact name, trimmed', () => {
    expect(isDeleteConfirmed('Acme Photos', 'Acme Photos')).toBe(true);
    expect(isDeleteConfirmed('  Acme Photos ', 'Acme Photos')).toBe(true);
  });

  it('refuses another case, a prefix and nothing', () => {
    expect(isDeleteConfirmed('acme photos', 'Acme Photos')).toBe(false);
    expect(isDeleteConfirmed('Acme', 'Acme Photos')).toBe(false);
    expect(isDeleteConfirmed('', 'Acme Photos')).toBe(false);
    expect(isDeleteConfirmed('   ', '   ')).toBe(false);
  });
});
