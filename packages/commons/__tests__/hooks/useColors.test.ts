import { renderHook } from '@testing-library/react';
import { __setBloomThemeMode } from '@/__mocks__/bloom-theme';
import { useColors } from '@/hooks/useColors';
import { DomainColors } from '@/constants/theme';

describe('useColors', () => {
  it('returns Bloom theme colours merged with light DomainColors when mode is light', () => {
    __setBloomThemeMode('light');
    const { result } = renderHook(() => useColors());

    // Bloom palette must be present.
    expect(typeof result.current.background).toBe('string');
    expect(typeof result.current.text).toBe('string');
    // Light-mode domain palette must be present.
    expect(result.current.identityIconPublicKey).toBe(DomainColors.light.identityIconPublicKey);
    expect(result.current.iconSuccess).toBe(DomainColors.light.iconSuccess);
  });

  it('returns dark DomainColors when mode is dark', () => {
    __setBloomThemeMode('dark');
    const { result } = renderHook(() => useColors());
    expect(result.current.identityIconPublicKey).toBe(DomainColors.dark.identityIconPublicKey);
    expect(result.current.iconWarning).toBe(DomainColors.dark.iconWarning);
  });

  it('exposes every key from DomainColors.light when mode is light', () => {
    __setBloomThemeMode('light');
    const { result } = renderHook(() => useColors());
    for (const key of Object.keys(DomainColors.light) as (keyof typeof DomainColors.light)[]) {
      expect(result.current[key]).toBe(DomainColors.light[key]);
    }
  });

  it('exposes every key from DomainColors.dark when mode is dark', () => {
    __setBloomThemeMode('dark');
    const { result } = renderHook(() => useColors());
    for (const key of Object.keys(DomainColors.dark) as (keyof typeof DomainColors.dark)[]) {
      expect(result.current[key]).toBe(DomainColors.dark[key]);
    }
  });

  it('returns a different identityIconPublicKey value in light vs dark', () => {
    __setBloomThemeMode('light');
    const lightValue = renderHook(() => useColors()).result.current.identityIconPublicKey;
    __setBloomThemeMode('dark');
    const darkValue = renderHook(() => useColors()).result.current.identityIconPublicKey;
    expect(lightValue).not.toBe(darkValue);
  });
});
