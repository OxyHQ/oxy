import type { ConsoleOnboardingState } from '@oxy.so/contracts';
import { CONSOLE_USE_CASES, type ConsoleUseCaseId } from '@oxy.so/contracts/client';

/** Mirrors `CONSOLE_USE_CASE_DESCRIPTION_MAX_LENGTH` (a server-schema value, not in `/client`). */
export const USE_CASE_DESCRIPTION_MAX_LENGTH = 2000;

export type OnboardingStep = 'terms' | 'use-cases' | 'done';

/** Which screen the person is on: terms until the current version is accepted, then the question. */
export function deriveOnboardingStep(
  state: Pick<ConsoleOnboardingState, 'termsCurrent' | 'useCasesAnswered'>,
): OnboardingStep {
  if (!state.termsCurrent) return 'terms';
  if (!state.useCasesAnswered) return 'use-cases';
  return 'done';
}

/** Continue on the terms step needs both required acknowledgements. */
export function canAcceptTerms(acks: { adult: boolean; aup: boolean }): boolean {
  return acks.adult && acks.aup;
}

/** Trimmed, capped at the limit; blank is absent so the API stores no description. */
export function normalizeDescription(raw: string): string | undefined {
  const text = raw.trim().slice(0, USE_CASE_DESCRIPTION_MAX_LENGTH).trim();
  return text === '' ? undefined : text;
}

/** Adds or removes one use case, keeping the catalogue's order. */
export function toggleUseCase(
  selected: ReadonlyArray<ConsoleUseCaseId>,
  id: ConsoleUseCaseId,
): ConsoleUseCaseId[] {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return CONSOLE_USE_CASES.filter((useCase) => next.has(useCase));
}
