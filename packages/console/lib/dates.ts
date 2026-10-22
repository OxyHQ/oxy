/**
 * The one date format of the Console: a short date, or a short date with the
 * time, in the active locale. Screens never call `toLocaleString` themselves,
 * so a table never mixes `10/22/2026, 3:19 PM` with `2026-10-22`.
 */

const DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
const SHORT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DATE_TIME: Intl.DateTimeFormatOptions = {
  ...DATE,
  hour: 'numeric',
  minute: '2-digit',
};

function parse(value: string | number | Date): Date | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `Oct 22, 2026` (`Oct 22` when `short`); the raw input when it is not a date. */
export function formatDate(
  value: string | number | Date,
  locale: string,
  style: 'long' | 'short' = 'long',
): string {
  const date = parse(value);
  if (date === undefined) return String(value);
  return date.toLocaleDateString(locale, style === 'short' ? SHORT : DATE);
}

/** `Oct 22, 2026, 3:19 PM`; the raw input when it is not a date. */
export function formatDateTime(value: string | number | Date, locale: string): string {
  const date = parse(value);
  return date === undefined ? String(value) : date.toLocaleString(locale, DATE_TIME);
}
