import { calendarDaysBetween } from '../date';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The hand-written version found in Inbox and oxy's accounts app. */
function flooredDaysBetween(from: Date, to: Date): number {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.floor((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

/** Local wall-clock time; months are 1-based here for readability. */
function local(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe('calendarDaysBetween', () => {
  it('is 0 within one calendar day, whatever the times', () => {
    expect(calendarDaysBetween(local(2026, 5, 14, 0, 0), local(2026, 5, 14, 23, 59))).toBe(0);
    expect(calendarDaysBetween(local(2026, 5, 14, 23, 59), local(2026, 5, 14, 0, 0))).toBe(0);
  });

  it('counts calendar days, not 24-hour periods', () => {
    // Two minutes apart, one calendar day apart.
    expect(calendarDaysBetween(local(2026, 5, 14, 23, 59), local(2026, 5, 15, 0, 1))).toBe(1);
    // Nearly 48 hours apart, still one calendar day apart.
    expect(calendarDaysBetween(local(2026, 5, 14, 0, 0), local(2026, 5, 15, 23, 59))).toBe(1);
  });

  it('is signed: negative when `to` is before `from`', () => {
    expect(calendarDaysBetween(local(2026, 5, 15), local(2026, 5, 14))).toBe(-1);
    expect(calendarDaysBetween(local(2026, 5, 15), local(2026, 5, 8))).toBe(-7);
  });

  it('crosses month and year boundaries', () => {
    expect(calendarDaysBetween(local(2026, 1, 31), local(2026, 2, 1))).toBe(1);
    expect(calendarDaysBetween(local(2026, 2, 28), local(2026, 3, 1))).toBe(1);
    expect(calendarDaysBetween(local(2028, 2, 28), local(2028, 3, 1))).toBe(2); // leap year
    expect(calendarDaysBetween(local(2025, 12, 31, 23, 30), local(2026, 1, 1, 0, 30))).toBe(1);
    expect(calendarDaysBetween(local(2026, 1, 1), local(2025, 12, 25))).toBe(-7);
    expect(calendarDaysBetween(local(2025, 1, 1), local(2026, 1, 1))).toBe(365);
  });

  describe('across a daylight-saving transition', () => {
    // jest.config.cjs pins TZ=America/New_York, where clocks went forward at
    // 02:00 on 2026-03-08 and go back at 02:00 on 2026-11-01. Asserted first,
    // so a runner that ignored the pin fails loudly instead of passing a test
    // that no longer crosses anything.
    it('runs in a zone where the transitions exist', () => {
      expect(local(2026, 3, 9, 0).getTime() - local(2026, 3, 8, 0).getTime()).toBe(23 * HOUR_MS);
      expect(local(2026, 11, 2, 0).getTime() - local(2026, 11, 1, 0).getTime()).toBe(25 * HOUR_MS);
    });

    it('files yesterday as yesterday across the spring-forward night', () => {
      const yesterday = local(2026, 3, 8, 18); // Sunday evening
      const now = local(2026, 3, 9, 9); //        Monday morning
      expect(calendarDaysBetween(yesterday, now)).toBe(1);
      // The hand-written floor sees a 23-hour day and calls it "Today".
      expect(flooredDaysBetween(yesterday, now)).toBe(0);
    });

    it('files tomorrow as tomorrow looking forward across it', () => {
      // ReminderRow's direction: a reminder for tomorrow morning.
      const now = local(2026, 3, 8, 9);
      const reminder = local(2026, 3, 9, 9);
      expect(calendarDaysBetween(now, reminder)).toBe(1);
      expect(flooredDaysBetween(now, reminder)).toBe(0);
    });

    it('counts a week that contains the transition as a week', () => {
      expect(calendarDaysBetween(local(2026, 3, 5), local(2026, 3, 12))).toBe(7);
      expect(calendarDaysBetween(local(2026, 3, 12), local(2026, 3, 5))).toBe(-7);
    });

    it('is unaffected by the 25-hour fall-back day', () => {
      expect(calendarDaysBetween(local(2026, 11, 1, 0, 30), local(2026, 11, 2, 0, 30))).toBe(1);
      expect(calendarDaysBetween(local(2026, 10, 31), local(2026, 11, 2))).toBe(2);
      // Two instants on the repeated 01:00–02:00 hour are the same calendar day.
      const firstOneThirty = local(2026, 11, 1, 1, 30);
      const secondOneThirty = new Date(firstOneThirty.getTime() + HOUR_MS);
      expect(calendarDaysBetween(firstOneThirty, secondOneThirty)).toBe(0);
    });
  });

  it('yields NaN for an invalid Date rather than throwing', () => {
    const invalid = new Date('not a date');
    expect(calendarDaysBetween(invalid, local(2026, 5, 14))).toBeNaN();
    expect(calendarDaysBetween(local(2026, 5, 14), invalid)).toBeNaN();
    // Every bucketing caller compares the result; NaN fails each comparison and
    // falls through to the absolute-date branch.
    const days = calendarDaysBetween(invalid, local(2026, 5, 14));
    expect(days === 0 || days === 1 || days < 7).toBe(false);
  });
});
