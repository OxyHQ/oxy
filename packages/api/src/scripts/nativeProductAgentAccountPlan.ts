import { composeDisplayName } from '../utils/displayName';

export type NativeProductAgentDisplayNameDisposition =
  | 'exact'
  | 'normalize_legacy'
  | 'drift';

/**
 * Classify an account title without broadening the bootstrap's authority.
 *
 * The existing Homiio project predates the explicit `nameDisplay` column. Its
 * public title is therefore composed from the legacy name fields. We may copy
 * that already-visible title into the explicit column, but only for the one
 * account deliberately adopted by the manifest and only when the composed
 * value is byte-for-byte equal to the desired title.
 */
export function classifyNativeProductAgentDisplayName(input: {
  adoptedLegacyAccount: boolean;
  expectedDisplayName: string;
  storedDisplayName: string | null;
  storedFirstName: string | null;
  storedLastName: string | null;
}): NativeProductAgentDisplayNameDisposition {
  if (input.storedDisplayName === input.expectedDisplayName) return 'exact';
  if (!input.adoptedLegacyAccount || input.storedDisplayName !== null) {
    return 'drift';
  }

  const effectiveDisplayName = composeDisplayName({
    name: {
      first: input.storedFirstName,
      last: input.storedLastName,
    },
  });
  return effectiveDisplayName === input.expectedDisplayName
    ? 'normalize_legacy'
    : 'drift';
}
