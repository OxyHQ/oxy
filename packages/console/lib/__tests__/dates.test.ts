import { formatDate, formatDateTime } from '@/lib/dates';

describe('dates', () => {
  it('formats in the given locale', () => {
    const at = '2026-10-22T15:19:00Z';
    expect(formatDate(at, 'en-US')).toMatch(/Oct 22, 2026/);
    expect(formatDate(at, 'es-ES')).toMatch(/2026/);
    expect(formatDateTime(at, 'en-US')).toMatch(/2026/);
  });

  it('drops the year in the short style', () => {
    expect(formatDate(new Date(2026, 9, 22), 'en-US', 'short')).toBe('Oct 22');
  });

  it('returns the raw input when it is not a date', () => {
    expect(formatDate('not a date', 'en-US')).toBe('not a date');
    expect(formatDateTime('', 'en-US')).toBe('');
  });
});
