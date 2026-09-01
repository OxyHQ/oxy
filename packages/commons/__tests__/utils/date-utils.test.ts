import { formatDate, getDisplayName, getDisplayNameOrNull } from '@/utils/date-utils';

describe('formatDate', () => {
  it('returns empty string for undefined input', () => {
    expect(formatDate(undefined)).toBe('');
  });

  it('returns empty string for null input', () => {
    expect(formatDate(null)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(formatDate('')).toBe('');
  });

  it('returns empty string for unparseable date strings', () => {
    expect(formatDate('not a real date')).toBe('');
  });

  it('formats a valid ISO date string in en-US format', () => {
    // Use a noon UTC time to dodge timezone-induced day shifts on the host.
    const formatted = formatDate('2025-02-21T12:00:00Z');
    expect(formatted).toBe('Feb 21, 2025');
  });

  it('formats epoch as Jan 1, 1970', () => {
    expect(formatDate('1970-01-01T12:00:00Z')).toBe('Jan 1, 1970');
  });
});

describe('getDisplayName', () => {
  it('returns translated "Unnamed" for null', () => {
    expect(getDisplayName(null)).toBe('Unnamed');
  });

  it('returns translated "Unnamed" for undefined', () => {
    expect(getDisplayName(undefined)).toBe('Unnamed');
  });

  it('returns explicit displayName when present', () => {
    expect(getDisplayName({ name: { displayName: 'Jane Doe' } })).toBe('Jane Doe');
  });

  it('does not compose first/last when displayName is absent', () => {
    expect(getDisplayName({ name: { first: 'Jane', last: 'Doe' }, username: 'janed' })).toBe(
      'janed',
    );
  });

  it('falls back to username when displayName is absent', () => {
    expect(getDisplayName({ username: 'janed' })).toBe('janed');
  });

  it('returns translated "Unnamed" when no identifying fields are present', () => {
    expect(getDisplayName({})).toBe('Unnamed');
  });

  it('prefers displayName over username', () => {
    expect(
      getDisplayName({ name: { displayName: 'Jane', first: 'Jane', last: 'Doe' }, username: 'janed' }),
    ).toBe('Jane');
  });

  it('reads displayName when name is a structured object', () => {
    expect(getDisplayName({ name: { displayName: 'Renée' } })).toBe('Renée');
  });

  it('ignores string-shaped name values for displayName access', () => {
    expect(getDisplayName({ name: 'Legacy String', username: 'janed' })).toBe('janed');
  });
});

describe('getDisplayNameOrNull', () => {
  it('returns null when no identifying fields are present', () => {
    expect(getDisplayNameOrNull({})).toBeNull();
  });

  it('returns the normalized handle without an Unnamed fallback', () => {
    expect(getDisplayNameOrNull({ username: 'janed' })).toBe('janed');
  });
});
