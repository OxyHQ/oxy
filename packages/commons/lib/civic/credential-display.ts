/**
 * Pure presentation helpers for verifiable credentials (Fase 4).
 *
 * A verifiable credential carries a `types` array (the W3C base
 * `'VerifiableCredential'` plus at least one specific type) and an arbitrary
 * issuer-asserted `claims` record. These helpers translate that wire shape into
 * the small, render-agnostic pieces the credential list / detail / issue screens
 * need — the specific type label (with the generic base dropped), a humanized
 * rendering of the claim set, the status tone + i18n key, and the preset → type
 * tag derivation for the issue form.
 *
 * Everything here is pure (no React, no colours, no i18n lookups) so it can be
 * unit-tested without rendering; the component layer maps a `CivicTone` to a
 * Bloom colour and a `*.labelKey` to a localized string at the call site.
 */

import type { CredentialStatus, VerifiableCredentialResponse } from '@oxy.so/contracts';
import type { CivicTone } from './card-presentation';

/** The W3C base type every credential carries; dropped from user-facing display. */
export const CREDENTIAL_BASE_TYPE = 'VerifiableCredential';

/** The preset credential kinds offered by the issue form (plus free-form custom). */
export type CredentialPresetId = 'employment' | 'course' | 'membership' | 'custom';

export interface CredentialPreset {
  id: CredentialPresetId;
  /**
   * The fixed VC type tag for a preset. `undefined` for `'custom'`, whose tag is
   * derived from the user-entered label via {@link deriveCustomTypeTag}.
   */
  typeTag?: string;
}

/** The preset list rendered as a chooser in the issue form (order preserved). */
export const CREDENTIAL_PRESETS: readonly CredentialPreset[] = [
  { id: 'employment', typeTag: 'EmploymentCredential' },
  { id: 'course', typeTag: 'CourseCredential' },
  { id: 'membership', typeTag: 'MembershipCredential' },
  { id: 'custom' },
];

/** The specific (non-base) type tags of a credential, in declaration order. */
export function specificCredentialTypes(types: readonly string[]): string[] {
  return types.filter((type) => type !== CREDENTIAL_BASE_TYPE);
}

/**
 * The primary specific type tag to lead the display with, or `null` when a
 * credential carries only the base type (malformed — should not happen given the
 * server requires a specific type, but rendered defensively).
 */
export function primaryCredentialType(types: readonly string[]): string | null {
  return specificCredentialTypes(types)[0] ?? null;
}

/**
 * Humanize a PascalCase / camelCase / separator-delimited type tag into a
 * spaced, title-cased label, dropping a trailing `Credential` suffix:
 *   `EmploymentCredential`        → `Employment`
 *   `CourseCompletionCredential`  → `Course Completion`
 *   `membership_card`             → `Membership Card`
 * A tag that is exactly `Credential` (or empty) falls back to `Credential`.
 */
export function humanizeTypeTag(tag: string): string {
  const stripped = tag.replace(/Credential$/u, '');
  const spaced = splitWords(stripped);
  return spaced.length > 0 ? spaced : 'Credential';
}

/** Derive a VC type tag from a free-form custom label (PascalCase + `Credential`). */
export function deriveCustomTypeTag(label: string): string {
  const pascal = label
    .trim()
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  if (pascal.length === 0) return '';
  return /Credential$/u.test(pascal) ? pascal : `${pascal}Credential`;
}

/**
 * Resolve the final VC type tag a preset selection produces:
 * - a fixed preset returns its `typeTag`;
 * - `custom` derives the tag from `customLabel` (or `null` when the label is empty).
 */
export function resolveCredentialTypeTag(
  presetId: CredentialPresetId,
  customLabel: string,
): string | null {
  const preset = CREDENTIAL_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return null;
  if (preset.typeTag) return preset.typeTag;
  const derived = deriveCustomTypeTag(customLabel);
  return derived.length > 0 ? derived : null;
}

/** A single humanized claim row for display. */
export interface CredentialClaimEntry {
  /** The raw claim key (stable React key). */
  key: string;
  /** The humanized claim label (`employer_name` → `Employer Name`). */
  label: string;
  /** The stringified claim value. */
  value: string;
}

/**
 * Flatten an issuer-asserted claim set into humanized `{ label, value }` rows for
 * display. Empty / nullish values are dropped; non-primitive values are JSON
 * stringified so the detail view always renders a string.
 */
export function claimEntries(claims: Record<string, unknown>): CredentialClaimEntry[] {
  return Object.entries(claims)
    .map(([key, raw]) => ({ key, label: humanizeKey(key), value: stringifyClaimValue(raw) }))
    .filter((entry) => entry.value.length > 0);
}

/** Status presentation: tone + the `civic.credentials.status.*` i18n key suffix. */
export interface CredentialStatusMeta {
  tone: CivicTone;
  /** i18n key suffix — `civic.credentials.status.<labelKey>`. */
  labelKey: CredentialStatus;
}

/** Tone for each credential status (active is good, revoked is punitive). */
const CREDENTIAL_STATUS_TONE: Record<CredentialStatus, CivicTone> = {
  active: 'positive',
  revoked: 'danger',
  expired: 'caution',
};

/** Map a credential status to its render tone + i18n label key. */
export function getCredentialStatusMeta(status: CredentialStatus): CredentialStatusMeta {
  return { tone: CREDENTIAL_STATUS_TONE[status] ?? 'neutral', labelKey: status };
}

/**
 * Whether the viewer may revoke a credential — mirrors the server rule: only the
 * ORIGINAL USER issuer may revoke, and only while the credential is still active
 * (a revoked / expired credential is terminal). The detail screen uses this to
 * gate whether the revoke action is even offered; the server remains
 * authoritative on the write.
 *
 * @param credential - The credential under inspection.
 * @param viewerUserId - The current user's id, or `null` when unknown.
 */
export function canRevokeCredential(
  credential: VerifiableCredentialResponse,
  viewerUserId: string | null,
): boolean {
  if (!viewerUserId) return false;
  if (credential.status !== 'active') return false;
  return credential.issuerUserId === viewerUserId;
}

/* -------------------------------------------------------------------------- */
/*  Internal                                                                  */
/* -------------------------------------------------------------------------- */

/** Split a PascalCase / camelCase / separator-delimited string into title-cased words. */
function splitWords(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Humanize a claim key (`employerName` / `employer_name` → `Employer Name`). */
function humanizeKey(key: string): string {
  const spaced = splitWords(key);
  return spaced.length > 0 ? spaced : key;
}

/** Stringify a claim value for display; non-primitives are JSON encoded. */
function stringifyClaimValue(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}
