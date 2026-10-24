import { act, renderHook } from '@testing-library/react';
import { useAccountTheme, useAccountThemeControls } from '../../src/ui/hooks/useAccountTheme';

let mockAuth: Record<string, unknown> = {};
const mockSetMode = jest.fn();
const mockMutateAsync = jest.fn();
const mockUseAccountColor = jest.fn();
jest.mock('../../src/ui/hooks/useAuth', () => ({ useAuth: () => mockAuth }));
jest.mock('../../src/ui/hooks/mutations/useAccountMutations', () => ({
  useUpdateProfile: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}));
jest.mock('../../src/ui/hooks/useAccountColor', () => ({
  useAccountColor: (options: unknown) => mockUseAccountColor(options),
  resolveAccountColor: () => 'blue',
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  useBloomTheme: () => ({ mode: 'light', colorPreset: 'blue', setMode: mockSetMode }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockMutateAsync.mockResolvedValue(undefined);
  mockAuth = {
    isAuthenticated: true,
    canUsePrivateApi: true,
    user: { id: 'u1', themePreference: { mode: 'dark', colorPreset: 'blue' } },
  };
});

describe('useAccountTheme', () => {
  it('applies the account mode on the account source and only the colour on the app source', () => {
    const canUse = () => true;
    renderHook(() => useAccountTheme({ canUse }));
    expect(mockSetMode).toHaveBeenCalledWith('dark');
    expect(mockUseAccountColor).toHaveBeenCalledWith({ canUse });

    const { result } = renderHook(() => useAccountThemeControls());
    mockSetMode.mockClear();
    act(() => result.current.changeThemeSource('app'));
    renderHook(() => useAccountTheme());
    expect(mockSetMode).not.toHaveBeenCalled();
    act(() => result.current.changeThemeSource('account'));
  });
});

describe('useAccountThemeControls', () => {
  it('writes a mode change to the account only while a session can reach it', async () => {
    const { result } = renderHook(() => useAccountThemeControls());
    await act(() => result.current.changeThemeMode('adaptive'));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      themePreference: { mode: 'system', colorPreset: 'blue' },
    });

    mockMutateAsync.mockClear();
    mockAuth = { ...mockAuth, canUsePrivateApi: false };
    const signedOut = renderHook(() => useAccountThemeControls());
    expect(signedOut.result.current.source).toBe('app');
    await act(() => signedOut.result.current.changeThemeMode('dark'));
    expect(mockSetMode).toHaveBeenLastCalledWith('dark');
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
