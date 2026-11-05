import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IdentityLinkState } from '@oxy.so/contracts';
import {
  abandonPendingLink,
  clearPendingLink,
  pendingLinkVerdict,
  persistPendingLink,
  readPendingLink,
  type PendingLink,
} from '@/lib/link-account/pendingLink';
import { getOnboardingResumeHref } from '@/hooks/useOnboardingStatus';

const KEY = `04${'ab'.repeat(64)}`;
const OTHER = `04${'cd'.repeat(64)}`;
const link: PendingLink = { linkId: 'lnk_1', challenge: 'c1', publicKey: KEY };
const NOW = 1_800_000_000_000;

function state(overrides: Partial<IdentityLinkState>): IdentityLinkState {
  return {
    status: 'pending',
    userId: 'u1',
    username: 'nate',
    publicKey: null,
    audience: 'oxy',
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

/**
 * Leaving a link half-way used to leave its key behind as an identity with no
 * account, which onboarding then registered as a NEW account. The decisions
 * below are what keep that key from being either registered or lost.
 */
describe('pendingLinkVerdict', () => {
  it('a request still waiting for a key: confirm again (the key is reused)', () => {
    expect(pendingLinkVerdict(link, state({}), NOW)).toBe('confirm');
  });

  it('signed with THIS key and open: wait, never remove the key', () => {
    expect(pendingLinkVerdict(link, state({ status: 'signed', publicKey: KEY }), NOW)).toBe('wait');
  });

  it('completed with this key: it is the account key, sign in', () => {
    expect(pendingLinkVerdict(link, state({ status: 'completed', publicKey: KEY }), NOW)).toBe(
      'signIn',
    );
  });

  it('expired, cancelled, gone, or another key: abandon', () => {
    expect(pendingLinkVerdict(link, state({ expiresAt: NOW - 1 }), NOW)).toBe('abandon');
    expect(pendingLinkVerdict(link, state({ status: 'cancelled' }), NOW)).toBe('abandon');
    expect(pendingLinkVerdict(link, null, NOW)).toBe('abandon');
    expect(pendingLinkVerdict(link, state({ status: 'signed', publicKey: OTHER }), NOW)).toBe(
      'abandon',
    );
    expect(pendingLinkVerdict(link, state({ status: 'completed', publicKey: OTHER }), NOW)).toBe(
      'abandon',
    );
  });
});

describe('abandonPendingLink', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await persistPendingLink(link);
  });

  const deps = (overrides: Partial<Parameters<typeof abandonPendingLink>[0]> = {}) => ({
    link,
    getState: jest.fn(async () => state({ expiresAt: Date.now() - 1 })),
    currentPublicKey: jest.fn(async () => KEY),
    isKeyRegistered: jest.fn(async () => false),
    deleteKey: jest.fn(async () => undefined),
    ...overrides,
  });

  it('removes a key nothing can sign in with, and the marker', async () => {
    const d = deps();
    await expect(abandonPendingLink(d)).resolves.toBe('removed');
    expect(d.deleteKey).toHaveBeenCalledTimes(1);
    await expect(readPendingLink()).resolves.toBeNull();
  });

  it('removes it when the request never got this key (still pending)', async () => {
    const d = deps({ getState: jest.fn(async () => state({ expiresAt: Date.now() + 60_000 })) });
    await expect(abandonPendingLink(d)).resolves.toBe('removed');
  });

  it('keeps a key the other screen can still confirm', async () => {
    const d = deps({
      getState: jest.fn(async () =>
        state({ status: 'signed', publicKey: KEY, expiresAt: Date.now() + 60_000 }),
      ),
    });
    await expect(abandonPendingLink(d)).resolves.toBe('kept');
    expect(d.deleteKey).not.toHaveBeenCalled();
    await expect(readPendingLink()).resolves.toEqual(link);
  });

  it('keeps a key the server knows (a completed link), whatever the request says', async () => {
    const d = deps({ isKeyRegistered: jest.fn(async () => true) });
    await expect(abandonPendingLink(d)).resolves.toBe('kept');
    expect(d.deleteKey).not.toHaveBeenCalled();
  });

  it('keeps everything when the server cannot be reached', async () => {
    const d = deps({
      getState: jest.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(abandonPendingLink(d)).resolves.toBe('kept');
    expect(d.deleteKey).not.toHaveBeenCalled();
  });

  it('never touches a different key: only the stale marker goes', async () => {
    const d = deps({ currentPublicKey: jest.fn(async () => OTHER) });
    await expect(abandonPendingLink(d)).resolves.toBe('notOurs');
    expect(d.deleteKey).not.toHaveBeenCalled();
    await expect(readPendingLink()).resolves.toBeNull();
  });
});

describe('persistence and resume', () => {
  it('round-trips the marker, lowercasing the key', async () => {
    await persistPendingLink({ ...link, publicKey: KEY.toUpperCase() });
    await expect(readPendingLink()).resolves.toEqual(link);
    await clearPendingLink();
    await expect(readPendingLink()).resolves.toBeNull();
  });

  it('an onboarding interrupted mid-link resumes at the link, never at a username step', () => {
    expect(getOnboardingResumeHref('link')).toBe('/(auth)/link-account/resume');
  });
});
