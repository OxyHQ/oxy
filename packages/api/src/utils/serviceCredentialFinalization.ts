interface FinalizedPredecessorIdentity {
  applicationId: string;
  name: string;
  type: string;
  environment: string;
  status: string;
  expiresAt: Date | null;
}

/**
 * An idempotent finalize verifies the committed transition, not whether the
 * predecessor can still authenticate today. Expiry of its bounded grace is an
 * expected later state and must not make exact recovery fail.
 */
export function isValidFinalizedPredecessor(
  predecessor: FinalizedPredecessorIdentity | undefined,
  expected: {
    applicationId: string;
    name: string;
    type: string;
    environment: string;
  },
): boolean {
  return (
    predecessor?.applicationId === expected.applicationId &&
    predecessor.name === expected.name &&
    predecessor.type === expected.type &&
    predecessor.environment === expected.environment &&
    predecessor.status === "deprecated"
  );
}
