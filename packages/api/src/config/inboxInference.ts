import {
  KAANA_INITIAL_MODEL_REFERENCE,
  KAANA_INITIAL_ROUTING_PROFILE_IDS,
  KAANA_INITIAL_ROUTING_PROFILES,
} from "./kaanaInitialCatalogue";

/** Exact Oxy application identity assigned to Inbox in production. */
export const INBOX_APPLICATION_ID = "6a37b3e61ddfd195b656819b";

const reviewedRoutingProfile = KAANA_INITIAL_ROUTING_PROFILES.find(
  (profile) => profile.id === KAANA_INITIAL_ROUTING_PROFILE_IDS.default,
);
if (reviewedRoutingProfile === undefined) {
  throw new Error(
    "The reviewed Inbox routing profile is absent from the Kaana catalogue",
  );
}

/**
 * Exact, source-reviewed row Inbox is allowed to point at.
 *
 * This is not evidence that the row exists in production. The readback script
 * proves that separately by this primary key, inside a PostgreSQL read-only
 * transaction. Keeping the spec derived from the reviewed bootstrap prevents a
 * second slug/name/order-based source of truth from emerging here.
 */
export const INBOX_REVIEWED_ROUTING_PROFILE = {
  ...reviewedRoutingProfile,
  description: `Oxy-owned ${reviewedRoutingProfile.displayName} routing policy over exact Kaana deployments.`,
  isProductPreset: true,
  candidate: {
    modelReference: KAANA_INITIAL_MODEL_REFERENCE,
    priority: 100,
  },
} as const;
