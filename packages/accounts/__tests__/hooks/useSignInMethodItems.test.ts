/**
 * "How you sign in" for an account WITHOUT a key: its email, the optional
 * password, the authenticator app, and linking Commons — each row opening the
 * SDK's own panel. A Commons account gets none of them (it signs in with its
 * key). Passkeys are gone from here.
 */
import { renderHook } from '@testing-library/react';
import type { SignInMethods } from '@oxy.so/contracts';

const showBottomSheet = jest.fn();
let user: { id: string; email?: string; publicKey?: string } | null = { id: 'u1', email: 'ada@example.com' };
let methods: SignInMethods | undefined = { hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 };
const useSignInMethods = jest.fn((_options?: { enabled?: boolean }) => ({ data: methods }));

jest.mock('@oxy.so/services', () => ({
  __esModule: true,
  useOxy: () => ({ user, showBottomSheet }),
  useSignInMethods: (options?: { enabled?: boolean }) => useSignInMethods(options),
}));

jest.mock('@/lib/i18n', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

// eslint-disable-next-line import/first
import { useSignInMethodItems } from '@/components/security/useSignInMethodItems';
// eslint-disable-next-line import/first
import { useOpenLinkCommons } from '@/hooks/useIdentityRootStatus';

beforeEach(() => {
  jest.clearAllMocks();
  user = { id: 'u1', email: 'ada@example.com' };
  methods = { hasEmail: true, hasPassword: false, totpEnabled: false, backupCodesRemaining: 0 };
});

describe('useSignInMethodItems', () => {
  it('lists the email, the password, the authenticator and Commons, each opening its panel', () => {
    const { result } = renderHook(() => useSignInMethodItems());
    const ids = result.current.map((item) => item.id);
    expect(ids).toEqual(['email-sign-in', 'password', 'authenticator', 'link-commons']);
    expect(ids.some((id) => id.includes('passkey'))).toBe(false);

    const [email, password, authenticator, linkCommons] = result.current;
    expect(email.subtitle).toBe('ada@example.com');
    expect(password.subtitle).toBe('security.signInMethods.passwordNotSet');
    expect(authenticator.subtitle).toBe('security.signInMethods.authenticatorOff');

    password.onPress?.();
    expect(showBottomSheet).toHaveBeenLastCalledWith('SignInPassword');
    authenticator.onPress?.();
    expect(showBottomSheet).toHaveBeenLastCalledWith('SignInAuthenticator');
    linkCommons.onPress?.();
    expect(showBottomSheet).toHaveBeenLastCalledWith('LinkCommons');
  });

  it('says what is on: the password, and the backup codes left', () => {
    methods = { hasEmail: true, hasPassword: true, totpEnabled: true, backupCodesRemaining: 8 };
    const { result } = renderHook(() => useSignInMethodItems());
    expect(result.current.find((item) => item.id === 'password')?.subtitle).toBe('security.signInMethods.passwordSet');
    expect(result.current.find((item) => item.id === 'authenticator')?.subtitle).toBe(
      'security.signInMethods.authenticatorOn {"count":8}',
    );
  });

  it('shows nothing for a Commons account, and does not ask for its methods', () => {
    user = { id: 'u1', publicKey: '04ab' };
    const { result } = renderHook(() => useSignInMethodItems());
    expect(result.current).toEqual([]);
    expect(useSignInMethods).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows nothing while the methods load', () => {
    methods = undefined;
    const { result } = renderHook(() => useSignInMethodItems());
    expect(result.current).toEqual([]);
  });
});

describe('useOpenLinkCommons', () => {
  it("opens the SDK's panel in this app, never auth.oxy.so", () => {
    const { result } = renderHook(() => useOpenLinkCommons());
    result.current();
    expect(showBottomSheet).toHaveBeenCalledWith('LinkCommons');
  });
});
