/**
 * Tests for the onboarding-complete milestone: its marker mirror (write path)
 * and its self-heal fallback (read path).
 *
 * The milestone is what lets a returning user reach the vault with zero network.
 * A SecureStore-only flag can be lost independently of the identity (e.g. a
 * keystore reset that wipes SecureStore but not AsyncStorage), so the flag is
 * mirrored into the AndroidKeyStore-independent identity marker and self-heals
 * from it — a lost flag must never re-route a fully-onboarded identity back into
 * the onboarding wizard.
 */

const readIdentityMarkerMock = jest.fn();
const updateIdentityMarkerMock = jest.fn();

// Control the identity marker (AsyncStorage-backed in production) surgically,
// while the SecureStore flag round-trips through the real expo-secure-store mock.
jest.mock('@oxy.so/core', () => {
  const actual = jest.requireActual('@oxy.so/core');
  return {
    ...actual,
    readIdentityMarker: () => readIdentityMarkerMock(),
    updateIdentityMarker: (partial: unknown) => updateIdentityMarkerMock(partial),
  };
});

// eslint-disable-next-line import/first
import {
  persistOnboardingComplete,
  getOnboardingCompleteFromStorage,
  persistOnboardingFlow,
  getOnboardingFlowFromStorage,
  ONBOARDING_COMPLETE_STORAGE_KEY,
  ONBOARDING_FLOW_STORAGE_KEY,
} from '@/hooks/identity/identityStore';
// eslint-disable-next-line import/first
import {
  __resetSecureStore,
  __seedSecureStore,
  getItemAsync,
  setItemAsync,
} from '@/__mocks__/expo-secure-store';

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('identityStore — onboarding milestone (marker mirror + self-heal)', () => {
  beforeEach(() => {
    __resetSecureStore();
    readIdentityMarkerMock.mockReset().mockResolvedValue(null);
    updateIdentityMarkerMock.mockReset().mockResolvedValue(true);
  });

  it('persistOnboardingComplete(true) writes the flag AND mirrors it into the marker', async () => {
    await persistOnboardingComplete(true);
    expect(await getItemAsync(ONBOARDING_COMPLETE_STORAGE_KEY)).toBe('true');
    expect(updateIdentityMarkerMock).toHaveBeenCalledWith({ onboardingComplete: true });
  });

  it('persistOnboardingComplete(false) mirrors false into the marker (create/import reset)', async () => {
    await persistOnboardingComplete(false);
    expect(await getItemAsync(ONBOARDING_COMPLETE_STORAGE_KEY)).toBe('false');
    expect(updateIdentityMarkerMock).toHaveBeenCalledWith({ onboardingComplete: false });
  });

  it('reads "true" directly from the flag without consulting the marker', async () => {
    __seedSecureStore(ONBOARDING_COMPLETE_STORAGE_KEY, 'true');
    expect(await getOnboardingCompleteFromStorage()).toBe(true);
    expect(readIdentityMarkerMock).not.toHaveBeenCalled();
  });

  it('self-heals from the marker when the flag is lost (marker.onboardingComplete === true)', async () => {
    // Flag absent (keystore reset) but the AsyncStorage marker still records
    // completion — the read must return true AND rewrite the flag.
    readIdentityMarkerMock.mockResolvedValue({
      v: 1,
      publicKey: 'pub',
      createdAt: 1,
      origin: 'create',
      onboardingComplete: true,
    });
    (setItemAsync as jest.Mock).mockClear();

    expect(await getOnboardingCompleteFromStorage()).toBe(true);

    // The self-heal write is fire-and-forget — let it flush, then assert.
    await flush();
    expect(setItemAsync).toHaveBeenCalledWith(ONBOARDING_COMPLETE_STORAGE_KEY, 'true');
  });

  it('returns false when the flag is absent and the marker does NOT record completion', async () => {
    readIdentityMarkerMock.mockResolvedValue({
      v: 1,
      publicKey: 'pub',
      createdAt: 1,
      origin: 'create',
    });
    expect(await getOnboardingCompleteFromStorage()).toBe(false);
  });

  it('returns false when the flag is absent and there is no marker (genuine fresh device)', async () => {
    readIdentityMarkerMock.mockResolvedValue(null);
    expect(await getOnboardingCompleteFromStorage()).toBe(false);
  });
});

describe('identityStore — onboarding flow persistence', () => {
  beforeEach(() => {
    __resetSecureStore();
  });

  it('round-trips the create/import flow choice', async () => {
    await persistOnboardingFlow('import');
    expect(await getOnboardingFlowFromStorage()).toBe('import');
    await persistOnboardingFlow('create');
    expect(await getOnboardingFlowFromStorage()).toBe('create');
    await persistOnboardingFlow(null);
    expect(await getOnboardingFlowFromStorage()).toBeNull();
    expect(await getItemAsync(ONBOARDING_FLOW_STORAGE_KEY)).toBe('');
  });
});
