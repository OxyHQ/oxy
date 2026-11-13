/**
 * This package's version, as part of every declared-version buster (`persistedBuster`).
 *
 * The SDK owns the shape of the shared roots (`accounts`, `users`, ...) and of the blob itself, so
 * an app that declares its own data version still starts from the network after an SDK upgrade.
 * `__tests__/hooks/persistedDataVersion.test.ts` keeps it equal to `package.json`'s `version`, so a
 * release cannot forget it.
 */
export const SERVICES_PERSISTED_DATA_VERSION = '14.21.0';
