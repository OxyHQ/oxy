/**
 * Canonical contract for `GET /auth/session/status/:sessionToken`.
 *
 * SINGLE SOURCE OF TRUTH for the wire shape of the cross-app device-flow
 * session-status payload and the sanitized public application identity it
 * embeds. The API validates its OUTPUT against these schemas; the auth app
 * (consent UI) validates its INPUT against the same schemas. Because there is
 * exactly one definition, the producer and the consumer cannot drift.
 *
 * The class of bug that motivated moving this into `@oxyhq/contracts`: the auth
 * app's LOCAL `sessionStatusSchema` typed `sessionId` as a non-nullable
 * `z.string().optional()`. The producer emits `sessionId: authorizedSessionId ||
 * null`, so a PENDING session (not yet authorized) carries `sessionId: null` —
 * `.optional()` permits `undefined`/missing but REJECTS `null`, so `safeParse`
 * failed, the whole response collapsed to `null`, and the consent screen showed
 * "Unable to identify the requesting application". Pinning the nullability in one
 * shared place makes that drift impossible.
 *
 * Faithful to the producers:
 *  - `packages/api/src/utils/serializeApplication.ts` `serializePublicApplication`
 *    — the ONLY shape returned to an unauthenticated consent UI. Optional fields
 *    (`description`, `icon`, `websiteUrl`, `privacyPolicyUrl`, `termsUrl`,
 *    `developerName`) are OMITTED when absent (never serialized as `null`), so
 *    they are `.optional()` — NOT `.nullable()`. `type` is the `Application.type`
 *    enum.
 *  - `packages/api/src/routes/auth.ts` `GET /session/status/:sessionToken` — the
 *    inner object of the API's `{ data: ... }` success envelope. The handler
 *    ALWAYS emits `status`, `authorized` (`status === 'authorized'`),
 *    `sessionToken`, `expiresAt` (ISO string), and `application` (resolved object
 *    OR `null`). It ALWAYS emits `sessionId` / `publicKey` / `userId`, each as a
 *    string value OR `null` (`authorizedSessionId || null`, `authorizedBy ||
 *    null`, `authorizedUserId?.toString() || null`).
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';

/**
 * Application `type` enum. Mirrors `APPLICATION_TYPES` in
 * `packages/api/src/models/Application.ts` (`first_party` | `third_party` |
 * `internal` | `system`).
 */
export const applicationTypeSchema = z.enum([
    'first_party',
    'third_party',
    'internal',
    'system',
]);

export type ApplicationTypeContract = z.infer<typeof applicationTypeSchema>;

/**
 * The display-safe public identity of a requesting application, exactly as
 * `serializePublicApplication` emits it. Returned by the API inside
 * `GET /auth/session/status/:sessionToken` (device flow) and
 * `GET /auth/oauth/client/:clientId` (OAuth code flow).
 *
 * Optional fields are `.optional()` (NOT `.nullable()`): the serializer OMITS
 * `description` / `icon` / `websiteUrl` / `privacyPolicyUrl` / `termsUrl` /
 * `developerName` when the underlying value is absent — it never writes `null`
 * for them. `developerName` is only attached for non-official apps when a name
 * could be resolved.
 */
export const publicApplicationSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    websiteUrl: z.string().optional(),
    privacyPolicyUrl: z.string().optional(),
    termsUrl: z.string().optional(),
    type: applicationTypeSchema,
    isOfficial: z.boolean(),
    isInternal: z.boolean(),
    scopes: z.array(z.string()),
    developerName: z.string().optional(),
});

export type PublicApplicationResponse = z.infer<typeof publicApplicationSchema>;

/**
 * The inner object of `GET /auth/session/status/:sessionToken` (inside the API's
 * `{ data: ... }` envelope).
 *
 * `application` is the resolved {@link publicApplicationSchema} identity of the
 * requesting application, or `null` when the bound app was hard-deleted / is no
 * longer `active` (defensive — normally always present).
 *
 * `sessionId` / `publicKey` / `userId` are `.nullable().optional()`: the producer
 * ALWAYS emits the key, with a string for an AUTHORIZED session or `null` for a
 * PENDING one. `.nullable()` accepts the PENDING `null`; `.optional()` is belt-
 * and-braces so a consumer is never broken by a future projection that drops the
 * key. (`.optional()` alone would REJECT the PENDING `null` — that was the bug.)
 *
 * `authorized` / `sessionToken` / `expiresAt` are emitted unconditionally by the
 * current producer and are never `null`, but stay `.optional()` so the contract
 * tolerates leaner shapes from other producers of this same payload without a
 * coordinated bump.
 *
 * `pushSentAt` / `openedAt` are DELIVERY PROGRESS, not authorization state: they
 * let a waiting surface render "Check Commons on your phone" → "Opened in
 * Commons" without inventing competing statuses. `status` remains the only
 * authority on whether the request is pending, authorized, cancelled or expired.
 * Both are `.nullable().optional()` for the same reason as `sessionId` — the
 * producer always emits the key with `null` until that step happens, and an
 * older API that omits them entirely must degrade, not fail the parse.
 */
export const sessionStatusSchema = z.object({
    status: z.string(),
    authorized: z.boolean().optional(),
    sessionToken: z.string().optional(),
    application: publicApplicationSchema.nullable().optional(),
    expiresAt: z.string().optional(),
    sessionId: z.string().nullable().optional(),
    publicKey: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    /**
     * What approving this request does. Legacy rows read as `device_sign_in`.
     * OAuth-bound sessions finalize into an authorization code (no `sessionId`).
     */
    purpose: z.enum(['device_sign_in', 'oauth_authorization']).optional(),
    pushSentAt: z.string().nullable().optional(),
    openedAt: z.string().nullable().optional(),
});

export type SessionStatusResponse = z.infer<typeof sessionStatusSchema>;
