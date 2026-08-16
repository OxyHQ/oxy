/**
 * How privileged an Application is, as ONE predicate (issue #972).
 *
 * Two places decide "is this an internal application": the catalogue's audience
 * (`services/inferenceCatalogue.service.ts`, which internal-only routes are
 * withheld from) and the inference edge's rollout audience
 * (`config/rolloutFlags.ts`, which canary stage a caller is admitted under).
 * They must give the same answer about the same row, and the way to guarantee
 * that is one function rather than two lists that agree today.
 *
 * The tiers are derived from the STAFF-CONTROLLED columns and nothing else.
 * `routes/applications.ts` silently drops `type` and `isInternal` from a
 * non-staff PATCH, so no self-service application can promote its own tier —
 * which is what makes a tier safe to gate a rollout on.
 */

/**
 * Least to most privileged.
 *
 * `first_party` sits BELOW `internal` deliberately: Console and Accounts are
 * first-party and customer-facing, and the separation between "Alia may use it
 * internally" and "an Oxy customer may be sold it" is exactly what workstream 11
 * exists to draw.
 */
export const APPLICATION_TIERS = ['third_party', 'first_party', 'internal'] as const;

export type ApplicationTier = (typeof APPLICATION_TIERS)[number];

/** The two Application columns a tier is read from. */
export interface ApplicationClassification {
  readonly type: string | null;
  readonly isInternal: boolean | null;
}

/**
 * The `Application.type` values that carry the internal tier.
 *
 * `isInternal` is the flag the rest of the platform gates service-token issuance
 * on; these two types carry it structurally. Either one is enough — an internal
 * application whose boolean was never set is still internal.
 */
const INTERNAL_APPLICATION_TYPES = ['internal', 'system'] as const;

/**
 * Which tier an application principal belongs to.
 *
 * `undefined` — no application principal at all, i.e. an anonymous caller or a
 * plain user bearer — is `third_party`, the LEAST privileged tier. That is the
 * default-deny direction: the way to be treated as more is to present an
 * internal application's credential, never to present nothing.
 */
export function classifyApplicationTier(
  application: ApplicationClassification | undefined
): ApplicationTier {
  if (application === undefined) return 'third_party';

  if (
    application.isInternal === true ||
    (application.type !== null &&
      (INTERNAL_APPLICATION_TYPES as readonly string[]).includes(application.type))
  ) {
    return 'internal';
  }

  return application.type === 'first_party' ? 'first_party' : 'third_party';
}
