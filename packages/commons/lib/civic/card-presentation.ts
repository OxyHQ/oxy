/**
 * Pure presentation mappers for the civic Oxy ID card.
 *
 * These translate the wire-level enums (`CardTrustTier`, `PersonhoodStatus`)
 * and the client-side attestation verdict into a small, render-agnostic "tone"
 * plus the i18n key suffix a screen uses to look up the label. Keeping the
 * mapping pure (no React, no colours) lets the trust badge, the personhood row,
 * and the VERIFIED/UNVERIFIED indicator share one source of truth and be unit
 * tested without rendering — {@link bloomToneFor} maps a `CivicTone` onto
 * Bloom's own tone axis at the render site.
 */

import type { CardTrustTier, PersonhoodStatus } from '@oxy.so/contracts';

/**
 * Semantic tone a civic value renders with.
 *
 * It stays the CIVIC vocabulary rather than Bloom's: a reputation verdict is
 * `positive` or `caution` in the domain's terms, and the screens that read
 * these mappers should not have to know which of Bloom's eight tones that is.
 * {@link bloomToneFor} is the one place the translation happens.
 */
export type CivicTone = 'positive' | 'neutral' | 'caution' | 'danger';

/**
 * A civic tone as one of Bloom's.
 *
 * This is all that remained of `components/civic/CivicBadge.tsx`, a 91-line
 * bordered pill with its own `${accent}1A` fill, its own hairline, its own two
 * type sizes and its own icon slot — every one of which is what
 * `@oxy.so/bloom/badge` draws, from the same theme, in the same register as the
 * rest of the app. The component is gone; the mapping is data, so it lives with
 * the other pure mappers.
 */
export function bloomToneFor(tone: CivicTone): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (tone) {
    case 'positive':
      return 'success';
    case 'caution':
      return 'warning';
    case 'danger':
      return 'danger';
    case 'neutral':
      return 'neutral';
  }
}

/** Trust-tier presentation: tone + the `civic.trustTier.*` i18n key suffix. */
export interface TrustTierMeta {
  tone: CivicTone;
  /** i18n key suffix — `civic.trustTier.<labelKey>`. */
  labelKey: CardTrustTier;
}

/** Personhood presentation: tone + the `civic.personhood.*` i18n key suffix. */
export interface PersonhoodMeta {
  tone: CivicTone;
  /** i18n key suffix — `civic.personhood.<labelKey>`. */
  labelKey: PersonhoodStatus;
}

/** Attestation-verdict presentation: tone + the `civic.card.*` i18n key suffix. */
export interface VerificationMeta {
  verified: boolean;
  tone: 'positive' | 'danger';
  /** i18n key suffix — `civic.card.<labelKey>` / `<labelKey>Desc`. */
  labelKey: 'verified' | 'unverified';
}

/** Tone for each trust tier (lowest → highest, plus the punitive `restricted`). */
const TRUST_TIER_TONE: Record<CardTrustTier, CivicTone> = {
  restricted: 'danger',
  new: 'neutral',
  trusted: 'positive',
  high_trust: 'positive',
  verified: 'positive',
};

/** Tone for each personhood status. */
const PERSONHOOD_TONE: Record<PersonhoodStatus, CivicTone> = {
  unverified: 'neutral',
  pending: 'caution',
  verified: 'positive',
};

/** Map a trust tier to its render tone + i18n label key. */
export function getTrustTierMeta(tier: CardTrustTier): TrustTierMeta {
  return { tone: TRUST_TIER_TONE[tier] ?? 'neutral', labelKey: tier };
}

/** Map a personhood status to its render tone + i18n label key. */
export function getPersonhoodMeta(status: PersonhoodStatus): PersonhoodMeta {
  return { tone: PERSONHOOD_TONE[status] ?? 'neutral', labelKey: status };
}

/**
 * Map the client-side attestation verdict to the VERIFIED / UNVERIFIED
 * indicator. A `false` verdict (forged, unsigned, or tampered card) MUST render
 * as `danger` — the card is untrusted, not merely "not yet verified".
 */
export function getVerificationMeta(verified: boolean): VerificationMeta {
  return verified
    ? { verified: true, tone: 'positive', labelKey: 'verified' }
    : { verified: false, tone: 'danger', labelKey: 'unverified' };
}
