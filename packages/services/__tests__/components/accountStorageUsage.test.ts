import {
  accountStorageUsage,
  formatStorageSize,
  shouldShowStorageActions,
} from '../../src/ui/components/authChooser/storageUsage';
const colors = {
  primary: '#123456',
  info: '#234567',
  success: '#345678',
  warning: '#456789',
  secondary: '#56789a',
  textTertiary: '#6789ab',
};
const t = (key: string) => key;
const category = (bytes: number) => ({ bytes, count: 1 });

describe('account storage breakdown', () => {
  it('keeps category bytes and colors, omits zero categories, and accounts for unattributed bytes', () => {
    const usage = accountStorageUsage(
      {
        usedBytes: 100,
        limitBytes: 200,
        categories: {
          photosVideos: category(40),
          documents: category(25),
          recordings: category(10),
          mail: category(5),
          family: category(0),
          other: category(10),
        },
      },
      colors,
      t,
    );
    expect(
      usage?.segments.map(({ label, value, color }) => [label.split('.').pop(), value, color]),
    ).toEqual([
      ['photosVideos', 40, colors.primary],
      ['documents', 25, colors.info],
      ['recordings', 10, colors.success],
      ['mail', 5, colors.warning],
      ['other', 20, colors.textTertiary],
    ]);
    expect(usage?.segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(100);
  });
  it('uses the authoritative total when categories are unavailable or inconsistent', () => {
    for (const categories of [
      undefined,
      { documents: category(101) },
      { recordings: category(-1) },
    ]) {
      expect(
        accountStorageUsage({ usedBytes: 100, limitBytes: 200, categories }, colors, t)?.segments,
      ).toEqual([{ label: 'accountMenu.storage.used', value: 100 }]);
    }
  });
  it('retains over-quota usage and does not invent data for unknown quota', () => {
    expect(
      accountStorageUsage(
        { usedBytes: 200, limitBytes: 100, categories: { documents: category(200) } },
        colors,
        t,
      )?.segments[0].value,
    ).toBe(200);
    expect(accountStorageUsage({ usedBytes: 100, limitBytes: 0 }, colors, t)).toBeUndefined();
    expect(accountStorageUsage(null, colors, t)).toBeUndefined();
    expect(
      accountStorageUsage({ usedBytes: 0, limitBytes: 100, categories: {} }, colors, t)?.segments,
    ).toEqual([]);
  });
  it('formats small and large categories with readable units', () => {
    expect(
      [0, 32, 1024, 2.5 * 1024 ** 2, 15 * 1024 ** 3, 2 * 1024 ** 4].map(formatStorageSize),
    ).toEqual(['0 B', '32 B', '1 KB', '2.5 MB', '15 GB', '2 TB']);
  });
});

describe('storage action threshold', () => {
  it('shows capacity actions strictly above 85%, never for unknown quotas', () => {
    for (const usedBytes of [0, 84, 85])
      expect(shouldShowStorageActions({ usedBytes, limitBytes: 100 })).toBe(false);
    for (const usedBytes of [85.01, 100, 120])
      expect(shouldShowStorageActions({ usedBytes, limitBytes: 100 })).toBe(true);
    expect(shouldShowStorageActions(null)).toBe(false);
    expect(shouldShowStorageActions({ usedBytes: 100, limitBytes: 0 })).toBe(false);
  });
});
