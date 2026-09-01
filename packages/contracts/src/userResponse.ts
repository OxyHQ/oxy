/**
 * Canonical API user-response contracts.
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of every user object the API emits
 * and every consumer (the auth app, services, accounts) parses. The API
 * validates its OUTPUT against these schemas; web/RN consumers validate their
 * INPUT against the same schemas. Because there is exactly one definition, the
 * producer and the consumers cannot drift — the class of bugs that motivated
 * this module (the auth app's local Zod schema requiring `name` to be a plain
 * string, dropping every account that had a structured name) is impossible.
 *
 * This package (`@oxyhq/contracts`) is the dedicated, zero-dependency home for
 * these contracts so the backend (`@oxyhq/api`) and the client SDKs
 * (`@oxyhq/core`, `@oxyhq/services`) can all depend on it without
 * the backend having to depend on a client SDK to obtain its schemas.
 *
 * Faithful to the producers:
 *  - `packages/api/src/utils/userTransform.ts` `formatUserResponse` — the
 *    canonical serialization used by login/signup, device sessions, etc.
 *    Emits `id` (NOT `_id`), forwards `username` verbatim (may be absent), and
 *    emits `name` as the structured `{ first, last, full, displayName }`
 *    subdocument.
 *  - `packages/api/src/models/User.ts` — `NameSchema` (`first`/`last` default
 *    `''`; `full` and `displayName` are Mongoose VIRTUALS. Formatted API
 *    responses compose both fields, while raw-document responses may omit the
 *    virtuals if the query did not materialise them.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';
import { verifiedDomainSchema } from './identity';
import { accountCategoriesSchema, accountKindSchema } from './accountGraph';

/**
 * Structured human name subdocument. Mirrors `User.name` (`NameSchema`).
 *
 * - `first` / `last` default to `''` in Mongo, so they are optional on the wire.
 * - `full` is a Mongoose virtual — absent unless the query materialised
 *   virtuals or the serializer composed it.
 * - `displayName` is the canonical app-facing display string when present.
 *   It is OPTIONAL on the wire: the API still synthesizes a default today, but
 *   the contract no longer guarantees it, so consumers fall back to a handle
 *   (e.g. `getNormalizedUserHandle`) when it is absent.
 *
 * This is declared as an explicit `interface` rather than being inferred from
 * the runtime schema via `z.infer<typeof userNameSchema>`. Inferring it produced
 * a `z.objectOutputType<…, "passthrough">` in the emitted `.d.ts`, whose
 * resolution to the named fields depends on zod's deep conditional-type
 * machinery (`objectUtil.addQuestionMarks` / `flatten` / `PassthroughType`).
 * Under a consumer's `moduleResolution: "node"` (node10), that chain does not
 * always resolve, so `name.displayName` silently widened to `{}` and broke the
 * "render `name.displayName` directly" contract at the type level. An explicit
 * interface emits `displayName?: string` literally and survives BOTH `node` and
 * `bundler` resolution. The index signature preserves the passthrough behaviour
 * (additive name fields are tolerated without a coordinated contract bump).
 */
export interface UserNameResponse {
    first?: string;
    last?: string;
    full?: string;
    /** Canonical display string when present — render this directly. */
    displayName?: string;
    [key: string]: unknown;
}

export const userNameSchema: z.ZodType<UserNameResponse> = z
    .object({
        first: z.string().optional(),
        last: z.string().optional(),
        full: z.string().optional(),
        displayName: z.string().optional(),
    })
    .passthrough();

/**
 * The authenticated viewer's relationship to a fetched profile.
 *
 * Rides the SINGLE-profile fetch (profile-by-username / profile-by-id) so
 * consumers get follow state without a second round-trip. Present ONLY when the
 * request is authenticated (the viewer id is known) — OMITTED entirely for
 * anonymous requests, so a consumer can distinguish "unknown" (field absent)
 * from "known, not following" (`isFollowing: false`).
 */
export interface UserRelationship {
    /** The viewer follows this profile (viewer → target). */
    isFollowing: boolean;
    /** This profile follows the viewer (target → viewer). */
    followsYou: boolean;
}

export const userRelationshipSchema: z.ZodType<UserRelationship> = z.object({
    isFollowing: z.boolean(),
    followsYou: z.boolean(),
});

/**
 * Portable per-account theme preference, applied across every Oxy app.
 *
 * Persisted on the Oxy user document and projected onto the self/session
 * payload the SDK already loads during cold boot, so Bloom can theme on first
 * paint with ZERO extra network call. `colorPreset` is a Bloom preset KEY
 * (e.g. `"blue"`) — never raw colors.
 */
export interface ThemePreference {
    mode: 'light' | 'dark' | 'system';
    colorPreset: string;
}

export const themePreferenceSchema: z.ZodType<ThemePreference> = z.object({
    mode: z.enum(['light', 'dark', 'system']),
    colorPreset: z.string(),
});

/**
 * The canonical user object emitted by `formatUserResponse`.
 *
 * `id` is present on formatted user DTOs. `name.displayName` is OPTIONAL on the
 * contract — the API still synthesizes a default today, but consumers must not
 * assume it is present and should fall back to a handle when it is absent. The
 * rest is forwarded from the user document and may be absent depending on the query's
 * `.select(...)`/`.lean()` projection. Both `id` and `_id` are accepted because
 * some raw-document responses carry `_id` instead of `id`; resolve the
 * identifier with {@link resolveUserId}.
 *
 * `.passthrough()` keeps the large tail of profile fields
 * (`privacySettings`, `locations`, `links`, `linksMetadata`, `bio`,
 * `description`, `languages`, `verified`, timestamps, …) available to callers
 * that need them without enumerating every nested shape here — the load-bearing
 * identity/display fields are the ones we pin precisely.
 */
export const userResponseSchema = z
    .object({
        /** MongoDB ObjectId as a string. Present on `formatUserResponse` output. */
        id: z.string().optional(),
        /** Raw-document id (e.g. `GET /users/me`). Present when `id` is not. */
        _id: z.string().optional(),
        publicKey: z.string().optional(),
        username: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        birthday: z.string().optional(),
        /** Avatar file id (string) or null. */
        avatar: z.string().nullable().optional(),
        /** Named Bloom color preset (e.g. `"blue"`) or null. */
        color: z.string().nullable().optional(),
        name: userNameSchema,
        verified: z.boolean().optional(),
        /**
         * The account's languages as full BCP-47 locales (`language-REGION`,
         * e.g. `es-ES`, `en-US`, `pt-BR`), ordered with the PRIMARY (UI) locale
         * first. `languages[0]` is the primary locale — there is no singular
         * `language` field.
         */
        languages: z.array(z.string()).optional(),
        /**
         * The account's self-sovereign identifier
         * (`did:web:<FEDERATION_DOMAIN>:u:<userId>`). Surfaced as a `User`
         * virtual; present on formatted DTOs once the identity layer is live.
         */
        did: z.string().optional(),
        /**
         * Proven domain-ownership badges. Each is a {@link verifiedDomainSchema}
         * entry; present only when the account has verified at least one domain.
         */
        verifiedDomains: z.array(verifiedDomainSchema).optional(),
        /**
         * Account-graph classification — what KIND of account this is.
         *
         * ORTHOGONAL to `type` (`local` / `federated` / `agent` / `automated`),
         * which says where the account lives and how it is driven; the two
         * coexist and neither substitutes for the other. A `channel` is a
         * publishing identity nobody can act as, so a consumer that renders
         * authored content reads THIS to tell a channel's post from a person's.
         *
         * Optional because a DTO produced from a source that never carried the
         * column omits it; absent should be read as `personal`, the column's
         * default, not as unknown.
         */
        kind: accountKindSchema.optional(),
        /**
         * What this account is about — the field a profile screen RENDERS.
         *
         * **Ordered, primary first.** `accountCategories[0]` is the primary
         * category; there is deliberately no sibling `primaryCategory` field,
         * because two representations of one fact can disagree (see rule 2 in
         * `accountGraph.ts`). Nothing downstream may sort, de-duplicate or
         * otherwise reorder this array.
         *
         * **Ids, never labels.** Each element is a stable slug; the visible text
         * comes from the reader's own translation catalogue, keyed
         * `accounts.accountCategory.<id>`. A label on the wire would paint every
         * profile in the language of whoever picked it.
         *
         * Absent when the account has none — which is every `personal` account,
         * and any non-personal one that has not chosen. A renderer reads
         * `user.accountCategories ?? []`.
         */
        accountCategories: accountCategoriesSchema.optional(),
        /**
         * The authenticated viewer's relationship to this profile. Present ONLY
         * on single-profile fetches (`GET /profiles/username/:username`,
         * `GET /users/:userId`) when the request is authenticated; OMITTED for
         * anonymous requests and for the bulk `POST /users/by-ids` fan-out.
         */
        relationship: userRelationshipSchema.optional(),
        /**
         * Portable theme preference. Rides the self/session payload (cold boot),
         * so it is present on the current-user DTO (`GET /users/me`,
         * `GET /session/user/:sessionId`) and absent until the user sets it.
         */
        themePreference: themePreferenceSchema.optional(),
    })
    .passthrough();

export type UserResponse = z.infer<typeof userResponseSchema>;

export const userProfileUpdateSchema = z
    .object({
        name: z
            .object({
                first: z.string().optional(),
                last: z.string().optional(),
                /**
                 * Explicit display name, stored rather than composed. Wins over
                 * `first`/`last` when set; send `''` to clear it and fall back
                 * to the composed pair.
                 */
                displayName: z.string().optional(),
            })
            .optional(),
        username: z.string().optional(),
        email: z.string().optional(),
        avatar: z.string().optional(),
        color: z.string().nullable().optional(),
        bio: z.string().optional(),
        description: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        birthday: z.string().optional(),
        locations: z.array(z.unknown()).optional(),
        links: z.array(z.string()).optional(),
        linksMetadata: z
            .array(
                z.object({
                    url: z.string(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                    image: z.string().optional(),
                    id: z.string().optional(),
                }),
            )
            .optional(),
        /**
         * Ordered account locales (`language-REGION`), primary first. Replaces
         * the eliminated singular `language`; `languages[0]` is the primary UI
         * locale.
         */
        languages: z.array(z.string()).optional(),
        accountExpiresAfterInactivityDays: z.number().nullable().optional(),
        notificationPreferences: z.record(z.unknown()).optional(),
        userPreferences: z.record(z.unknown()).optional(),
        privacySettings: z.record(z.unknown()).optional(),
        /**
         * Portable theme preference. Written through the same `PUT /users/me`
         * settings-update path as `languages`/`userPreferences`.
         */
        themePreference: themePreferenceSchema.optional(),
    })
    .passthrough();

export type UserProfileUpdate = z.infer<typeof userProfileUpdateSchema>;

/**
 * Resolve the canonical user id from a {@link UserResponse}, accepting either
 * the `formatUserResponse` `id` field or the raw-document `_id` field.
 */
export function resolveUserId(user: UserResponse): string | undefined {
    return user.id ?? user._id;
}

/**
 * Wire shape of `GET /users/me` — the API success envelope (`{ data: <user> }`)
 * wrapping the current-user DTO. Some older producers use `_id` instead of
 * `id`; resolve via {@link resolveUserId}. The display name still lives under
 * `name.displayName`.
 */
export const currentUserResponseSchema = z.object({
    data: userResponseSchema,
});

export type CurrentUserResponseContract = z.infer<typeof currentUserResponseSchema>;

/**
 * One entry of `GET /session/device/sessions/:sessionId` — the deduplicated
 * accounts signed in on this physical device (one per user, most recent
 * session). Backs the multi-account chooser. The embedded user mirrors
 * `formatUserResponse`; it is nullable on slots that lost their user document.
 */
export const deviceLinkedSessionSchema = z.object({
    sessionId: z.string(),
    isCurrent: z.boolean().optional(),
    user: userResponseSchema.nullable().optional(),
});

export type DeviceLinkedSessionResponse = z.infer<typeof deviceLinkedSessionSchema>;

/** Wire shape of `GET /session/device/sessions/:sessionId` (an array). */
export const deviceLinkedSessionsResponseSchema = z.array(deviceLinkedSessionSchema);

export type DeviceLinkedSessionsResponseContract = z.infer<typeof deviceLinkedSessionsResponseSchema>;

/**
 * Safely parse a value against a contract schema. Returns the parsed (typed)
 * value, or `null` when validation fails — the same ergonomics the auth app's
 * local `safeParse` provided, now sourced from the contracts package so the
 * parse helper and the schemas live together.
 */
export function safeParseContract<T>(schema: z.ZodType<T>, data: unknown): T | null {
    const result = schema.safeParse(data);
    return result.success ? result.data : null;
}
