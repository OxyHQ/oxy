import { utf16MaxLength, utf16MinLength } from './stringChecks';
/**
 * Oxy Console first-run onboarding — the wire contract.
 *
 * Acceptance belongs to the PERSON, not to a workspace: one record per user,
 * whichever account they are acting as. Two steps, in order: accept the
 * current terms (with the adult acknowledgement), then say what the Console is
 * for, or skip. A skip stores an empty list and still counts as answered.
 *
 * Platform-agnostic — zod only. ESM-safe (no `require()`).
 */

import { z } from 'zod';
import { CONSOLE_TERMS_VERSION, CONSOLE_USE_CASES } from './client/consoleOnboarding';

export {
  CONSOLE_TERMS_VERSION,
  CONSOLE_USE_CASES,
  type ConsoleUseCaseId,
} from './client/consoleOnboarding';

export const consoleUseCaseIdSchema = z.enum(CONSOLE_USE_CASES);

/** `GET /console/onboarding`. A person with no record gets the empty state. */
export const consoleOnboardingStateSchema = z.object({
  /** The terms version the person accepted, or null when none. */
  termsVersion: z.string().nullable(),
  termsAcceptedAt: z.string().nullable(),
  /** True when `termsVersion` is the current {@link CONSOLE_TERMS_VERSION}. */
  termsCurrent: z.boolean(),
  marketingOptIn: z.boolean(),
  useCases: z.array(consoleUseCaseIdSchema),
  /** The person's own words about their use cases, or null. */
  useCaseDescription: z.string().nullable(),
  /** True once the person picked options or skipped. */
  useCasesAnswered: z.boolean(),
});
export type ConsoleOnboardingState = z.infer<typeof consoleOnboardingStateSchema>;

/** `POST /console/onboarding/terms`. */
export const acceptConsoleTermsInputSchema = z.object({
  version: z.string().check(utf16MinLength(1)).check(utf16MaxLength(64)),
  adultAcknowledged: z.literal(true),
  /** Understands the account may be suspended or terminated for violating the AUP/Terms. */
  aupAcknowledged: z.literal(true),
  marketingOptIn: z.boolean(),
});
export type AcceptConsoleTermsInput = z.infer<typeof acceptConsoleTermsInputSchema>;

/** `POST /console/onboarding/use-cases`. Empty means the person skipped. */
export const CONSOLE_USE_CASE_DESCRIPTION_MAX_LENGTH = 2000;

export const saveConsoleUseCasesInputSchema = z.object({
  /** Optional free text; trimmed, and blank counts as absent. */
  description: z
    .string()
    .trim()
    .check(utf16MaxLength(CONSOLE_USE_CASE_DESCRIPTION_MAX_LENGTH))
    .optional(),
  useCases: z
    .array(consoleUseCaseIdSchema)
    .max(CONSOLE_USE_CASES.length)
    .transform((ids) => [...new Set(ids)]),
});
export type SaveConsoleUseCasesInput = z.input<typeof saveConsoleUseCasesInputSchema>;
