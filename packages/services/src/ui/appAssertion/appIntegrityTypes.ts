import type { AppAssertionPlatform } from '@oxy.so/contracts';

/**
 * The part of `@expo/app-integrity` the SDK uses: App Attest on iOS, the Play
 * Integrity standard request on Android. Declared here rather than imported so
 * the web build never names the native package.
 */
export interface AppIntegrityModule {
  /** Whether this iOS device offers App Attest. `true` on Android. */
  readonly isSupported: boolean;
  generateKeyAsync(): Promise<string>;
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
  generateAssertionAsync(keyId: string, challenge: string): Promise<string>;
  prepareIntegrityTokenProviderAsync(cloudProjectNumber: string): Promise<void>;
  requestIntegrityCheckAsync(requestHash: string): Promise<string>;
}

/** How this build proves which app it is. */
export interface AppIntegrityPlatform {
  readonly platform: AppAssertionPlatform;
  /** The native integrity module, or `null` where there is none (web, or a binary without it). */
  loadIntegrity(): Promise<AppIntegrityModule | null>;
}
