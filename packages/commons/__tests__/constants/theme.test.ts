import { DomainColors, type DomainColorKey } from '@/constants/theme';

describe('DomainColors', () => {
  it('exposes both light and dark variants', () => {
    expect(DomainColors.light).toBeDefined();
    expect(DomainColors.dark).toBeDefined();
  });

  it('light and dark variants share the exact same keys', () => {
    const lightKeys = Object.keys(DomainColors.light).sort();
    const darkKeys = Object.keys(DomainColors.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  it('every colour value is a valid hex string', () => {
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    for (const [key, value] of Object.entries(DomainColors.light)) {
      expect(value).toMatch(hexPattern);
      expect(key.length).toBeGreaterThan(0);
    }
    for (const value of Object.values(DomainColors.dark)) {
      expect(value).toMatch(hexPattern);
    }
  });

  it('most domain colours differ between light and dark variants', () => {
    // A stray copy-paste of the light object into the dark slot must fail.
    const lightEntries = Object.entries(DomainColors.light) as [DomainColorKey, string][];
    const sameCount = lightEntries.filter(
      ([key, value]) => value === DomainColors.dark[key],
    ).length;
    expect(sameCount).toBeLessThan(lightEntries.length / 2);
  });
});
