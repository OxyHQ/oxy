import { act, renderHook, waitFor } from '@testing-library/react';
import { deviceStorage } from '../../src/ui/data/deviceStorage';
import { useAccountTheme, useAccountThemeControls } from '../../src/ui/hooks/useAccountTheme';

let mockAuth: Record<string, unknown> = {};
const mockSetMode = jest.fn();
const mockMutateAsync = jest.fn();
const mockUseAccountColor = jest.fn();
jest.mock('../../src/ui/hooks/useAuth', () => ({ useAuth: () => mockAuth }));
jest.mock('../../src/ui/hooks/mutations/useAccountMutations', () => ({
  useUpdateProfile: () => ({ run: mockMutateAsync, isPending: false }),
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
  it('applies the account mode on the account source and only the colour on the app source', async () => {
    const canUse = () => true;
    renderHook(() => useAccountTheme({ canUse }));
    // Once the device's stored source is read (none: the account's).
    await waitFor(() => expect(mockSetMode).toHaveBeenCalledWith('dark'));
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

describe('the theme source', () => {
  it("is kept in the device's data, never the account's", async () => {
    const { result } = renderHook(() => useAccountThemeControls());
    act(() => result.current.changeThemeSource('app'));
    expect(result.current.source).toBe('app');
    await waitFor(async () =>
      expect(await deviceStorage().getItem('oxy.theme.source')).toBe('app'),
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
    act(() => result.current.changeThemeSource('account'));
  });
});
