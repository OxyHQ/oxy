import {
  KAANA_INITIAL_MODEL_REFERENCE,
  KAANA_INITIAL_ROUTING_PROFILE_IDS,
  KAANA_INITIAL_ROUTING_PROFILES,
} from "./kaanaInitialCatalogue";

/** Exact Oxy application identity assigned to Inbox in production. */
export const INBOX_APPLICATION_ID = "6a37b3e61ddfd195b656819b";

/**
 * The routing profile every Inbox point-inference feature targets: the
 * `instant` power level, the cheapest one (owner decision, 2026-10).
 *
 * `power-instant` is the fixed primary key migration
 * `0129_power_routing_profiles` seeds identically in every environment, so it
 * is source, not deploy configuration: the edge resolves it by primary key,
 * picks the cheapest servable model of the reviewed `instant` class, may fail
 * over to another `instant` model, and names the concrete model that ran in
 * the completion. It must also be on Inbox's application routing policy's
 * `allowedRoutingProfileIds` when that list is non-empty
 * (docs/inference/inbox-point-inference.md).
 */
export const INBOX_ROUTING_PROFILE_ID = "power-instant";

const reviewedRoutingProfile = KAANA_INITIAL_ROUTING_PROFILES.find(
  (profile) => profile.id === KAANA_INITIAL_ROUTING_PROFILE_IDS.default,
);
if (reviewedRoutingProfile === undefined) {
  throw new Error(
    "The reviewed Inbox routing profile is absent from the Kaana catalogue",
  );
}

/**
 * Exact, source-reviewed `kaana-v1` row Inbox pointed at before it moved to
 * the `instant` power level ({@link INBOX_ROUTING_PROFILE_ID}). Runtime no
 * longer routes through it; the catalogue bootstrap and its SELECT-only
 * readback still own it.
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
