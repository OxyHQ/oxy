/**
 * Authoritative server-side display-name composition.
 *
 * Single source of truth for the `User.name.displayName` virtual (see
 * `models/User.ts`).
 * Extracted as a pure function so the composition rules are unit-testable in
 * isolation — the API jest setup mocks Mongoose entirely, so the model's
 * virtual getter never actually runs under test; the rules are verified here
 * against this helper instead.
 *
 * This is the DERIVED default only. It does NOT replace any raw field — callers
 * that want the structured name keep reading `name.first` / `name.last` /
 * `name.full` / `username` directly.
 */

export interface NameParts {
  first?: string | null;
  last?: string | null;
  full?: string | null;
  displayName?: string | null;
}

export interface DisplayNameSource {
  name?: NameParts | null;
  username?: string | null;
  publicKey?: string | null;
}

export interface NameResponse extends Record<string, unknown> {
  first?: string;
  last?: string;
  full?: string;
  /**
   * The user's REAL display name (explicit `displayName`, or composed from
   * `first`/`last`). OMITTED when the user has no real name — the API no longer
   * synthesizes one from `username` / `publicKey` / `'Anonymous'`. Matches the
   * optional `@oxyhq/contracts` `UserNameResponse` contract; consumers fall back
   * to the handle when this field is absent.
   */
  displayName?: string;
}

/**
 * Compose the human full name from `first` / `last`.
 *
 * First-only is valid — there is NO requirement that both parts exist. Returns
 * an empty string when neither part is a non-empty string.
 */
export function composeFullName(name: NameParts | null | undefined): string {
  if (!name || typeof name !== 'object') {
    return '';
  }
  const first = typeof name.first === 'string' ? name.first : '';
  const last = typeof name.last === 'string' ? name.last : '';
  return [first, last].filter(Boolean).join(' ').trim();
}

/**
 * Truncate a public key into a short, human-readable handle.
 *
 * `0x`-prefixed keys keep the prefix; otherwise the bare hex is truncated.
 * Returns `undefined` when the input is not a usable string.
 */
export function truncatePublicKeyHandle(publicKey: string | null | undefined): string | undefined {
  if (!publicKey || typeof publicKey !== 'string') {
    return undefined;
  }
  if (publicKey.startsWith('0x')) {
    return `0x${publicKey.slice(2, 8)}...${publicKey.slice(-6)}`;
  }
  return `${publicKey.slice(0, 6)}...${publicKey.slice(-6)}`;
}

/**
 * Compose the user's REAL display name, or `undefined` when they have none.
 *
 *   1. explicit `name.displayName` (trimmed), else
 *   2. `name.full` (composed from `name.first` / `name.last`; first-only valid),
 *      else
 *   3. `undefined`.
 *
 * It deliberately does NOT fall back to `username`, a truncated `publicKey`
 * handle, or `'Anonymous'` — the API must not synthesize a display name. When
 * this returns `undefined` the serializer omits `name.displayName` entirely and
 * consumers fall back to the handle. Call sites that genuinely need a non-empty
 * string (e.g. an ActivityPub actor `name`, an email greeting) add their OWN
 * local fallback to the handle/username — never re-add it here.
 */
export function composeDisplayName(source: DisplayNameSource): string | undefined {
  const explicitDisplayName =
    typeof source.name?.displayName === 'string' ? source.name.displayName.trim() : '';
  if (explicitDisplayName) {
    return explicitDisplayName;
  }

  const explicitFull = typeof source.name?.full === 'string' ? source.name.full.trim() : '';
  const full = explicitFull || composeFullName(source.name);
  if (full) {
    return full;
  }

  return undefined;
}

/**
 * Build the canonical structured name emitted by user DTO serializers.
 *
 * `name.displayName` is the app-facing display string. It is present ONLY when
 * the user has a REAL name (explicit `displayName`, or composed from
 * `first`/`last`); it is OMITTED otherwise — the API never synthesizes a name
 * from `username` / `publicKey`, so consumers fall back to the handle. `first`,
 * `last`, and `full` preserve the raw structured human-name fields when they
 * exist.
 */
export function formatUserNameResponse(source: DisplayNameSource): NameResponse {
  const rawName = source.name;
  const first = typeof rawName?.first === 'string' ? rawName.first.trim() : '';
  const last = typeof rawName?.last === 'string' ? rawName.last.trim() : '';
  const explicitFull = typeof rawName?.full === 'string' ? rawName.full.trim() : '';
  const full = explicitFull || composeFullName({ first, last });

  const name: NameResponse = {};

  const displayName = composeDisplayName({
    name: {
      first,
      last,
      full,
      displayName: rawName?.displayName,
    },
  });
  if (displayName) {
    name.displayName = displayName;
  }
  if (first) {
    name.first = first;
  }
  if (last) {
    name.last = last;
  }
  if (full) {
    name.full = full;
  }

  return name;
}

/**
 * Resolve a non-empty outbound-email "From:" / greeting name.
 *
 * Uses {@link composeDisplayName} for the real name, then falls back to
 * `username` — the one place email call sites are allowed to synthesize a
 * label when the user has no composed real name.
 */
export function resolveEmailFromName(source: DisplayNameSource): string {
  const composed = composeDisplayName(source);
  if (composed) return composed;
  const username = typeof source.username === 'string' ? source.username.trim() : '';
  return username;
}
