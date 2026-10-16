/**
 * Fakes for the app-assertion tests: an `oxy.apps` that records what the SDK
 * asks Oxy for, and an `@expo/app-integrity` that records what it asks the
 * device for.
 */
import type {
  AppIntegrityModule,
  AppIntegrityPlatform,
} from '../../src/ui/appAssertion/appIntegrityTypes';
import { createMemoryStorage } from '../../src/ui/utils/storageHelpers';

export const CHALLENGE = 'C'.repeat(43);
export const REQUEST_HASH = 'H'.repeat(43);
export const KEY_ID = `${'K'.repeat(43)}=`;

export function fakeOxy(options: { now?: () => number; applicationId?: string } = {}) {
  const now = options.now ?? Date.now;
  let issued = 0;
  const assertions = {
    challenge: jest.fn(async (input: { platform: string; purpose?: string }) => ({
      challenge: CHALLENGE,
      requestHash: `${REQUEST_HASH.slice(0, 42)}${input.purpose === 'attest_key' ? 'A' : 'H'}`,
      expiresAt: new Date(now() + 120_000).toISOString(),
      ...(input.platform === 'android' ? { cloudProjectNumber: '424242424242' } : {}),
    })),
    registerAttestKey: jest.fn(async (input: { keyId: string }) => ({ keyId: input.keyId })),
    create: jest.fn(async (input: { applicationId: string; platform: string }) => {
      issued += 1;
      return {
        assertion: `head.assertion-${issued}.sig`,
        applicationId: input.applicationId,
        platform: input.platform as 'web' | 'android' | 'ios',
        expiresAt: new Date(Math.floor(now() / 1000) * 1000 + 300_000).toISOString(),
      };
    }),
  };
  const getPublic = jest.fn(async () => ({ id: options.applicationId ?? 'mention-app' }));
  return { apps: { assertions, getPublic }, assertions, getPublic };
}

export function fakeIntegrity(overrides: Partial<AppIntegrityModule> = {}) {
  const module: AppIntegrityModule = {
    isSupported: true,
    generateKeyAsync: jest.fn(async () => KEY_ID),
    attestKeyAsync: jest.fn(async () => 'YXR0ZXN0YXRpb24='),
    generateAssertionAsync: jest.fn(async () => 'YXNzZXJ0aW9u'),
    prepareIntegrityTokenProviderAsync: jest.fn(async () => undefined),
    requestIntegrityCheckAsync: jest.fn(async () => 'play-integrity-token'),
    ...overrides,
  };
  return module;
}

export function platform(
  name: 'web' | 'android' | 'ios',
  module: AppIntegrityModule | null = null,
): AppIntegrityPlatform {
  return { platform: name, loadIntegrity: async () => module };
}

export function refusal(code: string, status = 403) {
  return Object.assign(new Error(code), { code, status });
}

export { createMemoryStorage };
