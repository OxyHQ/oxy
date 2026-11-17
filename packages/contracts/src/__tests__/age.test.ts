import {
  AGE_BANDS,
  ageBandOf,
  ageInYears,
  isSelfServiceBandChange,
  type AgeBand,
} from '../client/age';

const on = (date: string) => new Date(`${date}T12:00:00.000Z`);

describe('ageInYears', () => {
  it('counts whole years, turning on the birthday itself', () => {
    expect(ageInYears('2010-06-15', on('2023-06-14'))).toBe(12);
    expect(ageInYears('2010-06-15', on('2023-06-15'))).toBe(13);
    expect(ageInYears('2010-06-15', on('2023-06-16'))).toBe(13);
  });

  it('reads today in UTC, not in the zone of the machine', () => {
    // 23:30 UTC on the 14th is already the 15th east of UTC; the band must not move early.
    expect(ageInYears('2010-06-15', new Date('2023-06-14T23:30:00.000Z'))).toBe(12);
    expect(ageInYears('2010-06-15', new Date('2023-06-15T00:00:00.000Z'))).toBe(13);
  });

  it('counts a 29 February birthday on 1 March in a year without one', () => {
    expect(ageInYears('2012-02-29', on('2025-02-28'))).toBe(12);
    expect(ageInYears('2012-02-29', on('2025-03-01'))).toBe(13);
    expect(ageInYears('2012-02-29', on('2028-02-29'))).toBe(16);
  });

  it('is zero for someone born today', () => {
    expect(ageInYears('2023-06-15', on('2023-06-15'))).toBe(0);
  });
});

describe('ageBandOf', () => {
  const today = on('2026-11-17');

  it.each<[string, AgeBand]>([
    ['2020-01-01', 'under13'],
    ['2013-11-18', 'under13'],
    ['2013-11-17', 'teen'],
    ['2008-11-18', 'teen'],
    ['2008-11-17', 'adult'],
    ['1950-01-01', 'adult'],
  ])('puts %s in %s', (dateOfBirth, band) => {
    expect(ageBandOf(dateOfBirth, today)).toBe(band);
  });
});

describe('isSelfServiceBandChange', () => {
  it('lets a first date name any band', () => {
    for (const band of AGE_BANDS) expect(isSelfServiceBandChange(undefined, band)).toBe(true);
  });

  it('lets a band stay or get younger, never older', () => {
    expect(isSelfServiceBandChange('adult', 'adult')).toBe(true);
    expect(isSelfServiceBandChange('adult', 'teen')).toBe(true);
    expect(isSelfServiceBandChange('teen', 'under13')).toBe(true);
    expect(isSelfServiceBandChange('teen', 'adult')).toBe(false);
    expect(isSelfServiceBandChange('under13', 'teen')).toBe(false);
    expect(isSelfServiceBandChange('under13', 'adult')).toBe(false);
  });
});
