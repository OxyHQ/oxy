/** All reviews must cover the exact child deployment; internal use is not exempt. */
export interface AutoClassifierReview {
  readonly commercial: boolean;
  readonly internalEligibility: boolean;
  readonly privacy: boolean;
  readonly zdr: boolean;
}

/** No credential or environment flag can activate Jev while review is unresolved. */
export function autoClassifierReview(): AutoClassifierReview {
  return { commercial: false, internalEligibility: false, privacy: false, zdr: false };
}

/** An immutable Jev revision can be pinned only after the exact deployment is reviewed. */
export function autoClassifierModelReference(): string | undefined {
  return undefined;
}
