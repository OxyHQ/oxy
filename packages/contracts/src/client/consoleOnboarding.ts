/**
 * Oxy Console first-run onboarding constants, without Zod. Schemas:
 * `../consoleOnboarding.ts`.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

/**
 * The version of the Console terms a person accepts. A date string: bump it
 * when the terms change and every person is asked to accept again. The API
 * refuses any other version, and the Console shows the acceptance step while
 * the version a person accepted differs from this one.
 */
export const CONSOLE_TERMS_VERSION = '2026-10-22';

/** What a person says they came to Oxy Console to do. A closed set. */
export const CONSOLE_USE_CASES = [
  'build-with-api',
  'ai-models',
  'publish-apps',
  'billing-credits',
  'explore-platform',
] as const;

export type ConsoleUseCaseId = (typeof CONSOLE_USE_CASES)[number];
