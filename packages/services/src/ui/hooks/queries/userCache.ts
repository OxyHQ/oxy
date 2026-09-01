/**
 * Canonical user-cache UPSERT for the Oxy React Query cache.
 *
 * The problem this solves: many places across an app write a user object into
 * the React Query cache and REPLACE the existing entry — profile fetch, feed /
 * post hydration, search, notifications, lists. Each of those sources carries a
 * DIFFERENT (often sparse) slice of the user: a feed author has no viewer
 * `relationship`, a search hit has no `createdAt`, a notification actor has no
 * `_count`. A plain `setQueryData(key, sparseUser)` therefore STRIPS whatever
 * fields the authoritative single-profile fetch had already stored — the
 * "Follows you tag vanishes when the feed loads" / "counts flash to zero" class
 * of bug.
 *
 * The fix (owned here, in the SDK): ONE canonical upsert that MERGES. It writes
 * under BOTH keys the SDK's user hooks read from:
 *   - by-id:       `queryKeys.users.detail(id)`             (read by `useUserById`)
 *   - by-username: `queryKeys.users.byUsername(username, viewerId)` (viewer-scoped;
 *                  read by `useUserByUsername`, carries the viewer `relationship`)
 *
 * Merge semantics (per key):
 *   - No existing entry  -> seed the (normalized) incoming object and mark it
 *     STALE (`updatedAt: 0`) so react-query refetches the full authoritative
 *     profile (viewer-relative `relationship`, counts, `createdAt`, …). Instant
 *     first paint, then the real fetch.
 *   - Existing entry     -> `{ ...existing, ...pickMeaningful(incoming) }`: only
 *     the DEFINED, non-empty fields of `incoming` win; every other field is kept
 *     from `existing`. A sparse source can never NULL-out or STRIP a field the
 *     authoritative fetch set. The entry's freshness is left untouched (never
 *     marked stale — it is already managed).
 *   - Nested objects (`name`, `_count`, `relationship`) merge field-by-field, so
 *     a partial `name`/`_count`/`relationship` never replaces a fuller one.
 *   - `relationship` is written ONLY under the viewer-scoped by-username key —
 *     the viewer-independent by-id key never stores it (prevents one viewer's
 *     follow state from leaking into every other viewer's identity cache).
 *   - Anti-degradation: a good `username` / `name.displayName` / `avatar` is
 *     never overwritten by a degraded/empty one (empty username, the
 *     `'Unknown user'` ghost-author sentinel, `null` avatar).
 *
 * EXPRESSING A DELIBERATE CLEAR ("remove my picture")
 * ---------------------------------------------------
 * The anti-degradation rule above is right for a sparse source and wrong for a
 * user who just emptied the field — and the two are NOT distinguishable from the
 * payload. Measured against oxy-api's canonical serializer (`formatUserResponse`
 * in `packages/api/src/utils/userTransform.ts`, which passes every field through
 * `typeof value === 'string' ? value : undefined`): an account whose avatar,
 * bio and display name were all just CLEARED serializes to
 * `{"id":…,"publicKey":…,"username":…,"name":{},"languages":[]}` — byte-identical
 * to the same account read as a sparse projection. There is no `null` and no
 * `''` on the wire to key on. The information that a field was deliberately
 * emptied exists ONLY at the call site that performed the write.
 *
 * So the caller declares it: `upsertCachedUser(qc, user, viewerId, { cleared:
 * ['avatar'] })`. For a declared field an incoming EMPTY value means the field
 * IS empty and the stale value is dropped; a MEANINGFUL incoming value still
 * wins as usual (so `{ cleared: ['name.displayName'] }` on a personal account,
 * where clearing the explicit name makes the server return the COMPOSED one,
 * keeps the composed name rather than blanking it).
 *
 * A blanket "this source is authoritative, treat every absent field as cleared"
 * flag was considered and rejected: because the two payloads are byte-identical,
 * such a flag is an unverifiable promise about provenance, and the failure mode
 * of getting it wrong is blanking real identity data in every Oxy app. Naming
 * the fields states something the caller actually observed — which fields the
 * user emptied — and bounds the damage to exactly those.
 *
 * It is a cache write only — zero network, one `setQueryData` per key.
 */

import type { UserNameResponse, UserProfileUpdate } from "@oxyhq/contracts";
import type { UpdateAccountInput } from "@oxyhq/core";
import type { QueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../../stores/authStore";
import { queryKeys } from "./queryKeys";

/**
 * A user-shaped object that can be upserted into the cache. Intentionally
 * permissive: it covers the SDK `User` PLUS the looser actor objects embedded on
 * posts / notifications / lists, where `name` may be a plain string and the id
 * may arrive as Mongo `_id`. Every field is optional — a sparse feed author is a
 * valid `CacheableUser`. The index signature lets any additional `User` field
 * pass through untouched (so the upsert never has to know the full DTO shape).
 */
export interface CacheableUser {
	id?: string;
	/** Some sources (post/notification actors) carry the id as Mongo `_id`. */
	_id?: string;
	username?: string;
	/**
	 * Canonical structured name (`UserNameResponse`) OR a plain display string on
	 * the looser actor objects. Normalized to the object shape on write.
	 */
	name?: string | UserNameResponse;
	/** Avatar file id. `null`/`''` are treated as "no avatar" (never degrade). */
	avatar?: string | null;
	/** Social counts. A partial `_count` never replaces a fuller one. */
	_count?: { followers?: number; following?: number } | null;
	/**
	 * Viewer-relative follow relationship. Present ONLY on an authenticated
	 * single-profile fetch; `null`/absent for anon/self/bulk/feed. Never stripped
	 * from an existing entry by a source that lacks it.
	 */
	relationship?: { isFollowing?: boolean; followsYou?: boolean } | null;
	[key: string]: unknown;
}

/** The degraded display-name sentinel (ghost-author rule). */
const DEGRADED_DISPLAY_NAME = "Unknown user";

/**
 * The profile fields a user can genuinely EMPTY through a real Oxy write, and
 * for which "empty" is a state every renderer already handles.
 *
 * Deliberately a closed list rather than "any field": a clear DELETES data from
 * the cache, so the blast radius of a mistaken declaration is bounded here
 * instead of resting on each call site. `username` is absent because an account
 * always has one; `_count` and `relationship` are absent because they are
 * server-derived, never user-emptied — and dropping a viewer `relationship` is
 * the exact "Follows you vanishes" bug this module exists to prevent.
 *
 * Each entry is clearable through a shipped write path: `avatar`, `bio`,
 * `description` and `name.displayName` via `UserProfileUpdate` (`''` clears) and
 * `UpdateAccountInput` (`null` clears avatar/bio; `accountCategories: []`
 * clears the ordered category list), and `color` via its nullable field.
 */
export const CLEARABLE_USER_FIELDS = [
	"avatar",
	"bio",
	"description",
	"color",
	"accountCategories",
	"name.displayName",
] as const;

/** A field nameable in {@link UpsertCachedUserOptions.cleared}. */
export type ClearableUserField = (typeof CLEARABLE_USER_FIELDS)[number];

/**
 * Fields the caller deliberately emptied in a `PUT /users/me` patch. The wire
 * response omits cleared scalars, so the cache needs this list to drop stale
 * values immediately instead of waiting for a refetch that merges the same
 * sparse payload.
 */
export function clearedFieldsFromProfileUpdate(
	updates: UserProfileUpdate,
): ClearableUserField[] {
	const cleared: ClearableUserField[] = [];
	if ("avatar" in updates && !isMeaningful(updates.avatar)) {
		cleared.push("avatar");
	}
	if ("bio" in updates && !isMeaningful(updates.bio)) {
		cleared.push("bio");
	}
	if ("description" in updates && !isMeaningful(updates.description)) {
		cleared.push("description");
	}
	if ("color" in updates && updates.color === null) {
		cleared.push("color");
	}
	if (
		updates.name !== undefined &&
		"displayName" in updates.name &&
		!isMeaningful(updates.name.displayName)
	) {
		cleared.push("name.displayName");
	}
	return cleared;
}

/**
 * Same contract as {@link clearedFieldsFromProfileUpdate} for managed-account
 * `PATCH /accounts/:id` writes (`null` clears avatar/bio/category).
 */
export function clearedFieldsFromAccountUpdate(
	input: UpdateAccountInput,
): ClearableUserField[] {
	const cleared: ClearableUserField[] = [];
	if ("avatar" in input && !isMeaningful(input.avatar)) {
		cleared.push("avatar");
	}
	if ("bio" in input && !isMeaningful(input.bio)) {
		cleared.push("bio");
	}
	if (
		"accountCategories" in input &&
		Array.isArray(input.accountCategories) &&
		input.accountCategories.length === 0
	) {
		cleared.push("accountCategories");
	}
	if (
		input.name !== undefined &&
		"displayName" in input.name &&
		!isMeaningful(input.name.displayName)
	) {
		cleared.push("name.displayName");
	}
	return cleared;
}

/** Options for {@link upsertCachedUser}. */
export interface UpsertCachedUserOptions {
	/**
	 * Fields the write that produced this user DELIBERATELY emptied. For each,
	 * an incoming empty value stops meaning "this source does not carry it" and
	 * starts meaning "it is empty" — so the stale value is dropped rather than
	 * preserved. Everything not named here keeps the anti-degradation guard.
	 */
	cleared?: readonly ClearableUserField[];
}

/** A cache entry always carries a resolved string `id`. */
type CachedUser = CacheableUser & { id: string; name?: UserNameResponse };

/**
 * Whether a value is "meaningful" — i.e. it should override an existing field.
 * Drops `undefined` / `null` / empty-or-whitespace strings so a sparse source
 * can never strip a field. `false`, `0` and other falsy-but-defined values ARE
 * meaningful (a real `verified: false` or `_count.followers: 0`).
 */
function isMeaningful(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return value.trim() !== "";
	return true;
}

/** A display name is meaningful only when non-empty AND not the degraded sentinel. */
function isMeaningfulDisplayName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim() !== "" &&
		value !== DEGRADED_DISPLAY_NAME
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize the polymorphic `name` (string | object | nullish) to the canonical object shape. */
function normalizeName(
	name: CacheableUser["name"],
): UserNameResponse | undefined {
	if (name === undefined || name === null) return undefined;
	if (typeof name === "string") {
		const trimmed = name.trim();
		return trimmed ? { displayName: trimmed } : undefined;
	}
	return name;
}

/**
 * Coerce a user-shaped object to a cache entry: resolve the id from
 * `id ?? _id ?? fallbackId` and normalize `name` to the canonical object shape
 * (the polymorphic `string` name is dropped from the spread and re-set as an
 * object so the cache never holds a bare-string name).
 */
function toCachedUser(user: CacheableUser, fallbackId: string): CachedUser {
	const { name: rawName, ...rest } = user;
	const id = String(user.id ?? user._id ?? fallbackId);
	const name = normalizeName(rawName);
	const normalized: CachedUser = { ...rest, id };
	if (name !== undefined) normalized.name = name;
	return normalized;
}

/**
 * Normalize an incoming (possibly partial) user to a cache entry. Returns `null`
 * when no id can be resolved (nothing to key on).
 */
function normalizeIncoming(user: CacheableUser): CachedUser | null {
	const cached = toCachedUser(user, "");
	return cached.id ? cached : null;
}

/**
 * Copy a name WITHOUT its `displayName`. The key must end up ABSENT rather than
 * present-and-`undefined`: consumers render `name.displayName` directly and fall
 * back to the handle when it is missing, and a present-but-undefined key also
 * changes what a later merge sees.
 */
function omitDisplayName(name: UserNameResponse): UserNameResponse {
	const result: UserNameResponse = {};
	for (const [key, value] of Object.entries(name)) {
		if (key !== "displayName") result[key] = value;
	}
	return result;
}

/**
 * Merge two `name` objects field-by-field, with anti-degradation on
 * `displayName`.
 *
 * `clearDisplayName` is the declared-clear escape hatch: the incoming value
 * still wins whenever it is meaningful (an account that clears its explicit
 * display name gets the server-COMPOSED one back, which must not be discarded),
 * and only a genuinely empty incoming value drops the stored one.
 *
 * Both incoming shapes reach the clear, and they are separate branches: the
 * measured oxy-api response carries `name` as a PRESENT-but-empty object, while
 * a caller passing a bare user object may carry no `name` key at all.
 */
function mergeName(
	existing: UserNameResponse | undefined,
	incoming: UserNameResponse | undefined,
	clearDisplayName: boolean,
): UserNameResponse | undefined {
	if (incoming === undefined) {
		if (!clearDisplayName || existing === undefined) return existing;
		return omitDisplayName(existing);
	}
	if (existing === undefined) return incoming;
	const merged: UserNameResponse = { ...existing };
	for (const [key, value] of Object.entries(incoming)) {
		if (key === "displayName") continue;
		if (isMeaningful(value)) merged[key] = value;
	}
	// Never let an empty / `'Unknown user'` displayName overwrite a real one —
	// unless the caller declared that the user cleared it.
	if (isMeaningfulDisplayName(incoming.displayName)) {
		merged.displayName = incoming.displayName;
		return merged;
	}
	return clearDisplayName ? omitDisplayName(merged) : merged;
}

/** Merge `_count` field-by-field so a partial count never replaces a fuller one. */
function mergeCount(
	existing: CacheableUser["_count"],
	incoming: CacheableUser["_count"],
): CacheableUser["_count"] {
	if (!isPlainObject(incoming)) return existing;
	const merged: { followers?: number; following?: number } = {
		...(isPlainObject(existing) ? existing : {}),
	};
	if (typeof incoming.followers === "number")
		merged.followers = incoming.followers;
	if (typeof incoming.following === "number")
		merged.following = incoming.following;
	return merged;
}

/**
 * Merge `relationship`. A source without a relationship (feed/list/notification,
 * or an anon/self/bulk `null`) must NEVER strip an existing viewer relationship.
 */
function mergeRelationship(
	existing: CacheableUser["relationship"],
	incoming: CacheableUser["relationship"],
): CacheableUser["relationship"] {
	if (!isPlainObject(incoming)) return existing;
	const merged: { isFollowing?: boolean; followsYou?: boolean } = {
		...(isPlainObject(existing) ? existing : {}),
	};
	if (typeof incoming.isFollowing === "boolean")
		merged.isFollowing = incoming.isFollowing;
	if (typeof incoming.followsYou === "boolean")
		merged.followsYou = incoming.followsYou;
	return merged;
}

/**
 * Merge a (normalized) incoming user over an existing cache entry: keep every
 * existing field, override only with the meaningful fields of `incoming`.
 *
 * When `includeRelationship` is false (the viewer-independent by-id key), the
 * viewer-relative `relationship` field is never read, written, or preserved —
 * only the by-username key carries it (`useUserByUsername`).
 *
 * `cleared` names the fields the write deliberately emptied. It is applied
 * AFTER the merge, because the merge loop can only ever COPY a meaningful value
 * — an emptied field is absent from `incoming` (see the module docs: oxy-api
 * omits it entirely) and would otherwise survive from `existing` untouched.
 */
function mergeUsers(
	existing: CachedUser,
	incoming: CachedUser,
	options?: {
		includeRelationship?: boolean;
		cleared?: readonly ClearableUserField[];
	},
): CachedUser {
	const includeRelationship = options?.includeRelationship ?? true;
	const cleared = options?.cleared;
	const merged: CachedUser = { ...existing };
	for (const [key, value] of Object.entries(incoming)) {
		if (key === "name" || key === "_count" || key === "relationship") continue;
		if (key === "id") {
			merged.id = incoming.id;
			continue;
		}
		if (isMeaningful(value)) merged[key] = value;
	}
	const name = mergeName(
		existing.name,
		incoming.name,
		cleared?.includes("name.displayName") ?? false,
	);
	if (name !== undefined) merged.name = name;
	const count = mergeCount(existing._count, incoming._count);
	if (count !== undefined) merged._count = count;
	if (includeRelationship) {
		const relationship = mergeRelationship(
			existing.relationship,
			incoming.relationship,
		);
		if (relationship !== undefined) merged.relationship = relationship;
	} else {
		merged.relationship = undefined;
	}
	if (cleared) {
		for (const field of cleared) {
			if (field === "name.displayName") continue; // handled by `mergeName`.
			if (!isMeaningful(incoming[field])) delete merged[field];
		}
	}
	return merged;
}

/** Merge-upsert a normalized user into one cache key (see module docs for semantics). */
function upsertOneKey(
	queryClient: QueryClient,
	key: readonly unknown[],
	incoming: CachedUser,
	options: {
		includeRelationship: boolean;
		cleared?: readonly ClearableUserField[];
	},
): void {
	const mergeOpts = {
		includeRelationship: options.includeRelationship,
		cleared: options.cleared,
	};
	const existing = queryClient.getQueryData<CacheableUser>(key);
	if (existing === undefined) {
		// Cold slot: seed the full incoming object, STALE, so react-query refetches
		// the full authoritative profile (relationship, counts, createdAt, …).
		const seeded = mergeUsers({ id: incoming.id }, incoming, mergeOpts);
		queryClient.setQueryData<CachedUser>(key, seeded, { updatedAt: 0 });
		return;
	}
	// Existing entry: merge and leave its freshness lifecycle untouched. The
	// existing entry is keyed by `incoming.id`, so use it as the fallback id.
	const merged = mergeUsers(
		toCachedUser(existing, incoming.id),
		incoming,
		mergeOpts,
	);
	const dataUpdatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
	queryClient.setQueryData<CachedUser>(key, merged, {
		updatedAt: dataUpdatedAt,
	});
}

/**
 * Resolve the active viewer id. The by-username cache key is viewer-scoped; the
 * seed must land on the exact key `useUserByUsername` reads. When a caller does
 * not pass `viewerId`, read it from the auth store — the same store behind the
 * hook's `useOxy().user?.id`, so seed and read stay in lockstep. An explicit
 * empty string is honoured (anonymous scope).
 */
function resolveViewerId(viewerId?: string): string {
	return viewerId ?? useAuthStore.getState().user?.id ?? "";
}

/**
 * Merge-upsert a (possibly partial) user into the SDK's user query cache under
 * both the by-id key and, when a username is present, the viewer-scoped
 * by-username key.
 *
 * @param queryClient The app's React Query client.
 * @param user        A `User`-shaped object (may be sparse).
 * @param viewerId    The active viewer id for the by-username key. Defaults to
 *                    the current auth-store user id.
 * @param options     `cleared` names the fields the write deliberately emptied
 *                    — the ONLY way "remove my picture" can propagate, since a
 *                    cleared field and an uncarried one are byte-identical on
 *                    the wire (see the module docs).
 */
export function upsertCachedUser(
	queryClient: QueryClient,
	user: CacheableUser,
	viewerId?: string,
	options?: UpsertCachedUserOptions,
): void {
	const incoming = normalizeIncoming(user);
	if (!incoming) return;
	const cleared = options?.cleared;

	// By-id identity entry (read by `useUserById`). Not viewer-scoped — never store
	// the viewer-relative `relationship` here or one viewer's follow state leaks
	// into every other viewer's by-id cache entry.
	upsertOneKey(queryClient, queryKeys.users.detail(incoming.id), incoming, {
		includeRelationship: false,
		cleared,
	});

	const username = incoming.username;
	if (typeof username === "string" && username.trim() !== "") {
		// By-username entry (read by `useUserByUsername`). Viewer-scoped because the
		// authenticated single-profile fetch embeds the viewer `relationship`. Build
		// the key through the SAME helper the hook uses so username normalization
		// (`trim().toLowerCase()`) matches byte-for-byte.
		const key = queryKeys.users.byUsername(username, resolveViewerId(viewerId));
		upsertOneKey(queryClient, key, incoming, {
			includeRelationship: true,
			cleared,
		});
	}
}

/**
 * Batch merge-upsert many users at once (for a feed / list / search response).
 * Resolves the viewer id once and upserts each user cumulatively — a user that
 * appears twice merges both slices into the single cache entry.
 *
 * Takes NO `cleared`, deliberately: a batch is a multi-user projection, so it is
 * exactly the sparse source the anti-degradation guard exists for, and one
 * declaration could not be true of every user in the array anyway.
 */
export function upsertCachedUsers(
	queryClient: QueryClient,
	users: readonly CacheableUser[] | null | undefined,
	viewerId?: string,
): void {
	if (!Array.isArray(users) || users.length === 0) return;
	const resolvedViewerId = resolveViewerId(viewerId);
	for (const user of users) {
		if (user) upsertCachedUser(queryClient, user, resolvedViewerId);
	}
}
