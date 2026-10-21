import { renderHook } from '@testing-library/react';
import {
  entitledAccountColors,
  resolveAccountColor,
  useAccountColor,
} from '../../src/ui/hooks/useAccountColor';

let mockUser: Record<string, unknown> | null = null;
let mockAuthenticated = true;
let mockCurrent = 'blue';
const mockSetColorPreset = jest.fn();
jest.mock('../../src/ui/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: mockAuthenticated, user: mockUser }),
}));
jest.mock('../../src/ui/hooks/mutations/useAccountMutations', () => ({
  useUpdateProfile: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('@oxy.so/contracts/client', () => ({
  USER_PROFILE_COLOR_PRESETS: ['blue', 'teal', 'mono', 'oxy', 'faircoin'],
  USER_PROFILE_COLORS: [
    { name: 'blue', gate: null },
    { name: 'teal', gate: null },
    { name: 'oxy', gate: 'handle' },
    { name: 'faircoin', gate: 'handle' },
    { name: 'mono', gate: 'premium' },
  ],
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  APP_COLOR_PRESETS: { blue: {}, teal: {}, mono: {}, oxy: {}, faircoin: {} },
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

describe('entitledAccountColors', () => {
  it('offers the free presets only to an ordinary account', () => {
    expect(entitledAccountColors({ username: 'ada' })).toEqual(['blue', 'teal']);
  });

  it('adds a handle preset only for the account with that handle, whatever the case', () => {
    expect(entitledAccountColors({ username: ' Oxy ' })).toEqual(['blue', 'teal', 'oxy']);
    expect(entitledAccountColors({ username: 'faircoin' })).toEqual(['blue', 'teal', 'faircoin']);
  });

  it('adds mono only while the benefit is allowed and unexpired', () => {
    const grant = (allowed: boolean, expiresAt: string | null) => ({
      username: 'ada',
      personalization: { mentionMono: { allowed, expiresAt } },
    });
    const now = Date.parse('2026-10-22T00:00:00Z');
    expect(entitledAccountColors(grant(true, null), now)).toContain('mono');
    expect(entitledAccountColors(grant(true, '2026-11-01T00:00:00Z'), now)).toContain('mono');
    expect(entitledAccountColors(grant(true, '2026-10-01T00:00:00Z'), now)).not.toContain('mono');
    expect(entitledAccountColors(grant(false, null), now)).not.toContain('mono');
  });
});
