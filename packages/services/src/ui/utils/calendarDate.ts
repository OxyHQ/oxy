/**
 * A calendar date with no time of day (`YYYY-MM-DD`), to and from the local
 * `Date` a picker works with.
 *
 * Local calendar components on purpose: `toISOString()` would shift the day for
 * anyone east or west of UTC at the wrong hour, and the person picked a day on
 * a calendar, not an instant.
 */

/** The ISO calendar date of a picker's `Date`, read in the device's own zone. */
export function toCalendarDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The local `Date` of an ISO calendar date, or `null` for anything else. */
export function fromCalendarDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}
