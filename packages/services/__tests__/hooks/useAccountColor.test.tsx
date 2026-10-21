import { renderHook } from '@testing-library/react';
import { resolveAccountColor, useAccountColor } from '../../src/ui/hooks/useAccountColor';

let mockUser: Record<string, unknown> | null = null;
let mockAuthenticated = true;
let mockCurrent = 'blue';
const mockSetColorPreset = jest.fn();
jest.mock('../../src/ui/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: mockAuthenticated, user: mockUser }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  APP_COLOR_PRESETS: { blue: {}, teal: {}, mono: {} },
  useBloomTheme: () => ({ colorPreset: mockCurrent, setColorPreset: mockSetColorPreset }),
}));

beforeEach(() => {
  mockUser = null;
  mockAuthenticated = true;
  mockCurrent = 'blue';
  mockSetColorPreset.mockClear();
});

describe('resolveAccountColor', () => {
  it('prefers the account colour over the portable theme preference', () => {
    expect(
      resolveAccountColor({
        color: 'teal',
        themePreference: { mode: 'dark', colorPreset: 'blue' },
      }),
    ).toBe('teal');
  });

  it('falls back to the theme preference and ignores names Bloom does not know', () => {
    expect(
      resolveAccountColor({ color: null, themePreference: { mode: 'dark', colorPreset: 'mono' } }),
    ).toBe('mono');
    expect(resolveAccountColor({ color: '#ff0000' })).toBeNull();
    expect(resolveAccountColor({ color: 'constructor' })).toBeNull();
  });
});

describe('useAccountColor', () => {
  it('applies the account colour to the Bloom theme', () => {
    mockUser = { color: 'teal' };
    renderHook(() => useAccountColor());
    expect(mockSetColorPreset).toHaveBeenCalledWith('teal');
  });

  it('does nothing when signed out or already wearing the colour', () => {
    mockUser = { color: 'teal' };
    mockAuthenticated = false;
    renderHook(() => useAccountColor());
    mockAuthenticated = true;
    mockCurrent = 'teal';
    renderHook(() => useAccountColor());
    expect(mockSetColorPreset).not.toHaveBeenCalled();
  });

  it('leaves a colour the app refuses unapplied', () => {
    mockUser = { color: 'mono' };
    renderHook(() => useAccountColor({ canUse: (name) => name !== 'mono' }));
    expect(mockSetColorPreset).not.toHaveBeenCalled();
  });
});
