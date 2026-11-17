import { fromCalendarDate, toCalendarDate } from '../calendarDate';

describe('calendarDate', () => {
  it('writes the day the person picked, in the device zone', () => {
    expect(toCalendarDate(new Date(2012, 0, 5))).toBe('2012-01-05');
    expect(toCalendarDate(new Date(1999, 11, 31, 23, 59))).toBe('1999-12-31');
  });

  it('reads an ISO calendar date back to the same local day', () => {
    const date = fromCalendarDate('2012-01-05');
    expect(date?.getFullYear()).toBe(2012);
    expect(date?.getMonth()).toBe(0);
    expect(date?.getDate()).toBe(5);
  });

  it('round-trips', () => {
    expect(toCalendarDate(fromCalendarDate('2008-02-29') as Date)).toBe('2008-02-29');
  });

  it('reads nothing from an empty or malformed value', () => {
    expect(fromCalendarDate('')).toBeNull();
    expect(fromCalendarDate(null)).toBeNull();
    expect(fromCalendarDate(undefined)).toBeNull();
    expect(fromCalendarDate('5 January 2012')).toBeNull();
  });
});
