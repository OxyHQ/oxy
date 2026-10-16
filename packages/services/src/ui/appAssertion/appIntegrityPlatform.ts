/**
 * Web: the app proves itself with the browser's `Origin`, which Oxy reads from
 * the request itself (ADR 0045). Nothing to load.
 *
 * Native builds resolve `appIntegrityPlatform.native.ts` instead.
 */
import type { AppIntegrityPlatform } from './appIntegrityTypes';

export const appIntegrityPlatform: AppIntegrityPlatform = {
  platform: 'web',
  loadIntegrity: async () => null,
};
