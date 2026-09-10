import { INBOX_REVIEWED_ROUTING_PROFILE } from "../config/inboxInference";

export interface InboxRoutingProfileReadbackRow {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly optimiseFor: string;
  readonly isProductPreset: boolean;
}

export interface InboxRoutingProfileCandidateReadbackRow {
  readonly routingProfileId: string;
  readonly modelReference: string | null;
  readonly priority: number;
}

export interface InboxRoutingProfileReadbackInput {
  readonly requestedRoutingProfileId: string;
  readonly transactionReadOnly: boolean;
  readonly profiles: readonly InboxRoutingProfileReadbackRow[];
  readonly candidates: readonly InboxRoutingProfileCandidateReadbackRow[];
}

export interface InboxRoutingProfileReadbackResult {
  readonly schemaVersion: 1;
  readonly status: "passed";
  readonly database: {
    readonly engine: "postgresql";
    readonly transactionReadOnly: true;
    readonly writes: 0;
  };
  readonly routingProfile: {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly description: string;
    readonly optimiseFor: string;
    readonly isProductPreset: true;
  };
  readonly candidate: {
    readonly modelReference: string;
    readonly priority: number;
  };
}

export class InboxRoutingProfileReadbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxRoutingProfileReadbackError";
  }
}

function fail(message: string): never {
  throw new InboxRoutingProfileReadbackError(message);
}

/**
 * Validate the exact rows selected by primary key and return a deliberately
 * small operator-safe projection. This never normalizes or rediscovers an ID.
 */
export function validateInboxRoutingProfileReadback(
  input: InboxRoutingProfileReadbackInput,
): InboxRoutingProfileReadbackResult {
  const expected = INBOX_REVIEWED_ROUTING_PROFILE;
  if (
    input.requestedRoutingProfileId.length === 0 ||
    input.requestedRoutingProfileId.trim() !== input.requestedRoutingProfileId
  ) {
    fail(
      "The requested routing-profile ID must be exact and contain no edge whitespace",
    );
  }
  if (input.requestedRoutingProfileId !== expected.id) {
    fail(
      "The requested routing-profile ID is not the reviewed Inbox primary key",
    );
  }
  if (input.transactionReadOnly !== true) {
    fail("PostgreSQL did not confirm a read-only transaction");
  }
  if (input.profiles.length !== 1) {
    fail(
      "Expected exactly one Inbox routing-profile row for the reviewed primary key",
    );
  }
  if (input.candidates.length !== 1) {
    fail(
      "Expected exactly one candidate row for the reviewed Inbox primary key",
    );
  }

  const profile = input.profiles[0];
  const candidate = input.candidates[0];
  if (profile === undefined || candidate === undefined) {
    fail("The exact Inbox routing-profile readback is incomplete");
  }
  if (
    profile.id !== expected.id ||
    profile.slug !== expected.slug ||
    profile.displayName !== expected.displayName ||
    profile.description !== expected.description ||
    profile.optimiseFor !== expected.optimiseFor ||
    profile.isProductPreset !== expected.isProductPreset
  ) {
    fail(
      "The Inbox routing-profile row does not match its reviewed source metadata",
    );
  }
  if (
    candidate.routingProfileId !== expected.id ||
    candidate.modelReference !== expected.candidate.modelReference ||
    candidate.priority !== expected.candidate.priority
  ) {
    fail(
      "The Inbox routing-profile candidate does not match its reviewed model and priority",
    );
  }

  return {
    schemaVersion: 1,
    status: "passed",
    database: {
      engine: "postgresql",
      transactionReadOnly: true,
      writes: 0,
    },
    routingProfile: {
      id: profile.id,
      slug: profile.slug,
      displayName: profile.displayName,
      description: profile.description,
      optimiseFor: profile.optimiseFor,
      isProductPreset: true,
    },
    candidate: {
      modelReference: candidate.modelReference,
      priority: candidate.priority,
    },
  };
}
