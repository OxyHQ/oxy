import { MINOR_QUIET_HOURS, isWithinQuietHours, localTimeIn, protectionsFor } from '../client/age';

describe('protectionsFor', () => {
  it('protects both bands of minors the same way', () => {
    for (const band of ['under13', 'teen'] as const) {
      expect(protectionsFor(band)).toEqual({
        feedProfile: 'protected',
        autoplay: 'never',
        quietHours: MINOR_QUIET_HOURS,
      });
    }
  });

  it('gives an adult, and an account of unknown age, the standard profile', () => {
    const standard = { feedProfile: 'standard', autoplay: 'personal', quietHours: null };
    expect(protectionsFor('adult')).toEqual(standard);
    expect(protectionsFor(undefined)).toEqual(standard);
  });
});

describe('isWithinQuietHours', () => {
  it('covers a window that crosses midnight, start included and end excluded', () => {
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '21:59')).toBe(false);
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '22:00')).toBe(true);
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '23:59')).toBe(true);
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '00:00')).toBe(true);
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '06:59')).toBe(true);
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '07:00')).toBe(false);
    expect(isWithinQuietHours(MINOR_QUIET_HOURS, '12:00')).toBe(false);
  });

  it('covers a window inside one day', () => {
    const afternoon = { start: '13:00', end: '15:00' };
    expect(isWithinQuietHours(afternoon, '12:59')).toBe(false);
    expect(isWithinQuietHours(afternoon, '13:00')).toBe(true);
    expect(isWithinQuietHours(afternoon, '15:00')).toBe(false);
  });

  it('is never quiet when there are no quiet hours', () => {
    expect(isWithinQuietHours(null, '03:00')).toBe(false);
  });
});

describe('localTimeIn', () => {
  const at = new Date('2026-11-17T22:30:00.000Z');

  it('reads the wall clock of the zone', () => {
    expect(localTimeIn('UTC', at)).toBe('22:30');
    expect(localTimeIn('Europe/Madrid', at)).toBe('23:30');
    expect(localTimeIn('America/New_York', at)).toBe('17:30');
    expect(localTimeIn('Asia/Tokyo', at)).toBe('07:30');
  });

  it('writes midnight as 00, not 24', () => {
    expect(localTimeIn('UTC', new Date('2026-11-18T00:05:00.000Z'))).toBe('00:05');
  });

  it('reads an unknown or missing zone as UTC', () => {
    expect(localTimeIn(null, at)).toBe('22:30');
    expect(localTimeIn(undefined, at)).toBe('22:30');
    expect(localTimeIn('Not/AZone', at)).toBe('22:30');
  });
});
