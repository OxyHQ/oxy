/**
 * Simple utility to format user objects for API responses.
 * Returns clean, explicit user object with id (MongoDB ObjectId) and publicKey as separate fields.
 */

import { getUserLanguages } from '@oxyhq/core';
import {
  ACCOUNT_CATEGORY_IDS,
  isAccountKind,
  type AccountCategoryId,
  type ThemePreference,
} from '@oxyhq/contracts';
import { formatUserNameResponse, type NameParts, type NameResponse } from './displayName';

type StringableId = string | { toString(): string };

export type UserLike = {
  _id?: StringableId | null;
  publicKey?: string;
  username?: string;
  email?: string;
  avatar?: string | null;
  color?: string | null;
  name?: NameParts;
  accountCategories?: unknown;
  privacySettings?: unknown;
  verified?: boolean;
  languages?: string[];
  bio?: string;
  description?: string;
  locations?: unknown;
  links?: unknown;
  linksMetadata?: unknown;
  verifiedDomains?: unknown;
  themePreference?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
} | null | undefined;

/** A proven-domain badge as emitted on the user DTO (secret-free, no subdoc _id). */
interface VerifiedDomainDto {
  domain: string;
  verifiedAt: Date | string;
  method: 'dns-txt' | 'well-known';
}

function toVerifiedDomains(value: unknown): VerifiedDomainDto[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains: VerifiedDomainDto[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const domain = stringValue(entry.domain);
    const method = stringValue(entry.method);
    const verifiedAt = entry.verifiedAt;
    if (!domain || (method !== 'dns-txt' && method !== 'well-known')) continue;
    if (!(verifiedAt instanceof Date) && typeof verifiedAt !== 'string') continue;
    domains.push({ domain, verifiedAt, method });
  }
  return domains;
}

/**
 * Ordered account categories, filtered to ids the vocabulary still defines.
 *
 * ORDER IS PRESERVED — `filter` keeps it, and nothing here sorts or
 * de-duplicates, because index 0 is the primary category and any rewrite would
 * change which one that is. An unknown id is dropped rather than emitted: the
 * DTO is parsed against `accountCategoriesSchema` by consumers, so passing one
 * through would fail the whole payload over a value no client could render
 * anyway (its label key would not exist).
 */
function toAccountCategories(value: unknown): AccountCategoryId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = new Set<string>(ACCOUNT_CATEGORY_IDS);
  const ids = value.filter((entry): entry is AccountCategoryId =>
    typeof entry === 'string' && known.has(entry)
  );
  return ids.length > 0 ? ids : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Coerce a stored `themePreference` subdoc into the wire {@link ThemePreference}.
 *
 * Returns `undefined` unless BOTH a valid `mode` and a string `colorPreset` are
 * present — an empty/partial Mongoose nested path (`{}`) serializes as absent
 * rather than an invalid `{}`, so consumers keep their own default theme until
 * the user actually chooses one. Shared by both the canonical
 * `formatUserResponse` here and `UserService.formatUserResponse` so the two
 * serializers cannot drift on the shape.
 */
export function toThemePreference(value: unknown): ThemePreference | undefined {
  if (!isRecord(value)) return undefined;
  const { mode, colorPreset } = value;
  if (
    (mode === 'light' || mode === 'dark' || mode === 'system') &&
    typeof colorPreset === 'string' &&
    colorPreset.length > 0
  ) {
    return { mode, colorPreset };
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The minimal surface the shared identity base reads off a user document. Every
 * field is `unknown` so ANY caller shape — a `Record<string, unknown>`, an
 * `IUser` / `PublicUserDocument`, or a recommendation projection row — is
 * structurally assignable with no cast.
 */
export interface UserIdentitySource {
  _id?: unknown;
  /**
   * Drizzle returns the users row FLAT — `name_first` / `name_last` columns, not
   * the nested `name` object Mongoose's schema produced. Both shapes reach this
   * one serializer during the Postgres port, and `name.displayName` is the
   * canonical API contract every ecosystem app reads, so the flat form is
   * accepted here rather than reassembled by each caller. `formatUserResponse`
   * takes `unknown`, so a caller that got this wrong would not fail tsc — it
   * would silently emit `name: {}` and surface as a zod error inside the SDK.
   */
  nameFirst?: unknown;
  nameLast?: unknown;
  /** Flat `name_display` column — the explicit, stored display name. */
  nameDisplay?: unknown;
  /**
   * Present only on objects that already went through the User schema's
   * toObject/toJSON transform, which deletes `_id` and folds the identifier into
   * `id` (e.g. a keyless managed/org account).
   */
  id?: unknown;
  name?: unknown;
  username?: unknown;
  avatar?: unknown;
  publicKey?: unknown;
}

/**
 * The load-bearing identity fields every user-DTO serializer MUST agree on. `id`
 * is `undefined` only when the source has no resolvable identifier — each caller
 * decides whether that is a `null` return or a thrown error.
 */
export interface UserIdentityFields {
  id: string | undefined;
  name: NameResponse;
  username: string | undefined;
  avatar: string | undefined;
}

/**
 * The SOLE definition of the DTO `id`: the stable Mongo ObjectId string, NEVER
 * the `publicKey`. The whole social graph (`Post.oxyUserId`, follow edges,
 * client follow-state maps) is keyed on `_id`, so flipping `id` to the publicKey
 * once a user links a Commons identity makes author-feed/follow lookups miss —
 * the bug this centralization prevents. Reads `_id` first, falling back to `id`
 * for already-transformed (keyless) objects; returns `undefined` when neither
 * yields a non-empty string.
 */
function resolveIdentityId(source: UserIdentitySource): string | undefined {
  const rawId = source._id;
  const fromObjectId = rawId == null ? '' : (rawId as { toString(): string }).toString();
  const fallback = typeof source.id === 'string' ? source.id : '';
  const publicKey = typeof source.publicKey === 'string' ? source.publicKey : '';
  // Reject legacy schema transforms that folded publicKey into `id` once `_id`
  // was stripped — the social graph keys on ObjectId, never the key material.
  const safeFallback = fallback && fallback === publicKey ? '' : fallback;
  return fromObjectId || safeFallback || undefined;
}

/**
 * Narrow a source's name to the structured `NameParts` the composer reads,
 * accepting either the nested Mongoose shape or the flat Drizzle columns.
 * Returns `undefined` when neither yields anything, so a nameless account still
 * omits `displayName` and consumers fall back to the handle.
 */
function identityNameSource(source: UserIdentitySource): NameParts | undefined {
  if (typeof source.name === 'object' && source.name !== null) {
    return source.name as NameParts;
  }
  const first = typeof source.nameFirst === 'string' ? source.nameFirst : '';
  const last = typeof source.nameLast === 'string' ? source.nameLast : '';
  const displayName = typeof source.nameDisplay === 'string' ? source.nameDisplay : '';
  return first || last || displayName ? { first, last, displayName } : undefined;
}

/**
 * The SOLE definition of the derived public `isFederated` flag — an account is
 * federated iff its `type` is `'federated'`. Shared by the public and
 * recommendation serializers so the derivation cannot drift between them.
 */
export function deriveIsFederated(type: unknown): boolean {
  return type === 'federated';
}

/**
 * The single definer of the load-bearing identity fields (`id`, `name`,
 * `username`, `avatar`) shared by every user-DTO serializer. Extracting this
 * makes it structurally impossible for the three serializers
 * (`formatUserResponse` here, `UserService.formatUserResponse`, and the
 * recommendation `formatProfileResult`) to diverge on these fields again — the
 * `id = publicKey || _id` class of bug. Each serializer keeps its own
 * resource-specific tail; only these four fields come from here.
 */
export function userIdentityFields(source: UserIdentitySource): UserIdentityFields {
  return {
    id: resolveIdentityId(source),
    name: formatUserNameResponse({
      name: identityNameSource(source),
      username: stringValue(source.username),
      publicKey: stringValue(source.publicKey),
    }),
    username: stringValue(source.username),
    avatar: stringValue(source.avatar),
  };
}

/**
 * Format user object for API response.
 * id = MongoDB ObjectId (_id.toString())
 * publicKey = separate field for authentication
 *
 * Self-sufficient name composition: the returned `name.full` is composed
 * whether or not the source document was loaded with Mongoose virtuals, and
 * `name.displayName` is present ONLY when the user has a real name (omitted for
 * username-only / publicKey-only accounts — consumers fall back to the handle).
 * This is the canonical producer of the `@oxyhq/core` `userResponseSchema`
 * contract — the api `userTransform.contract.test.ts` locks the output to that
 * schema so the producer cannot silently drift from it again.
 */
export function formatUserResponse(user: unknown) {
  if (!isRecord(user)) {
    return null;
  }

  const identity = userIdentityFields(user);
  if (!identity.id) {
    return null;
  }

  return {
    id: identity.id,
    publicKey: stringValue(user.publicKey),
    username: identity.username,
    email: stringValue(user.email),
    avatar: identity.avatar,
    color: stringValue(user.color),
    name: identity.name,
    privacySettings: user.privacySettings,
    verified: booleanValue(user.verified),
    // Ordered account locales, PRIMARY first. `languages` is the ONLY language
    // field; `getUserLanguages` normalizes and drops unsupported entries.
    languages: getUserLanguages({
      languages: Array.isArray(user.languages)
        ? user.languages.filter((code): code is string => typeof code === 'string')
        : undefined,
    }),
    bio: stringValue(user.bio),
    description: stringValue(user.description),
    locations: Array.isArray(user.locations) ? user.locations : undefined,
    links: Array.isArray(user.links) ? user.links.filter((link): link is string => typeof link === 'string') : undefined,
    linksMetadata: Array.isArray(user.linksMetadata) ? user.linksMetadata : undefined,
    verifiedDomains: toVerifiedDomains(user.verifiedDomains),
    // Account-graph classification. Orthogonal to `type` below — `kind` says
    // WHAT the account is (person / organization / channel …), `type` says where
    // it lives and how it is driven. Both ride every user DTO.
    kind: isAccountKind(user.kind) ? user.kind : undefined,
    // What the account is about, ORDERED — index 0 is the primary category.
    // Ids only; the label is the reader's to render. `undefined` rather than
    // `[]` when there are none, matching every other optional field here, so a
    // personal account's DTO does not grow an empty array on every bulk fetch.
    accountCategories: toAccountCategories(user.accountCategories),
    // Portable theme preference — rides this self/session payload (login, device
    // sessions, getUserBySession) so account switches carry the theme too.
    themePreference: toThemePreference(user.themePreference),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
