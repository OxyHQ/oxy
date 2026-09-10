import { describe, expect, test } from 'bun:test';
import { compareVersions, isFirstPartyPackage, lockfileVersions, rangeIncludesVersion } from '../src/checks.mjs';

describe('Oxy Doctor checks', () => {
  test('recognizes ecosystem package scopes', () => {
    expect(isFirstPartyPackage('@oxy.so/core')).toBe(true);
    expect(isFirstPartyPackage('@oxyhq/core')).toBe(false);
    expect(isFirstPartyPackage('@clarity.surf/sdk')).toBe(false);
    expect(isFirstPartyPackage('@alia.onl/sdk')).toBe(false);
    expect(isFirstPartyPackage('react')).toBe(false);
  });
  test('compares stable semantic versions', () => {
    expect(compareVersions('30.2.5', '31.0.0')).toBe(-1);
    expect(compareVersions('23.3.4', '23.3.4')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });
  test('understands the range forms used by ecosystem manifests', () => {
    expect(rangeIncludesVersion('^20.1.0 || ^23.0.0', '23.3.4')).toBe(true);
    expect(rangeIncludesVersion('>=0.59.0 <2.0.0', '1.14.3')).toBe(true);
    expect(rangeIncludesVersion('>=0.37.0 <0.41.0', '0.41.0')).toBe(false);
    expect(rangeIncludesVersion('31.0.0', '31.0.3')).toBe(false);
  });
  test('finds top-level and nested Bun lockfile resolutions', () => {
    const lock = `"@oxyhq/services": ["@oxyhq/services@31.0.3", ""],\n"consumer/@oxyhq/services": ["@oxyhq/services@30.2.0", ""]`;
    expect(lockfileVersions(lock, '@oxyhq/services')).toEqual(['31.0.3', '30.2.0']);
  });
});
