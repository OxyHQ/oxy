import { z } from 'zod';
import { accountKindSchema } from './accountGraph';
import { userNameSchema } from './userResponse';

/**
 * The canonical device directory — the ONE server-authoritative read model an
 * account switcher renders (issue #937, ADR 0002).
 *
 * It replaces the client-side union of `DeviceSessionState.accounts[]` with a
 * separately fetched `AccountNode[]` graph. That union cannot be correct on a
 * device holding more than one person: the client only ever holds ONE caller's
 * account graph, so it cannot enumerate what the OTHER principals may act as.
 * Switchability is an authorization question, so the server answers it.
 *
 * The directory is deterministic and revision-bound: two reads at the same
 * `revision` describe the same device state, and `revision` only advances on a
 * real mutation (an idempotent activation advances nothing — ADR 0002).
 */

/**
 * How a principal reaches an account.
 *
 * Mirrors `AccountRelationship` in `@oxyhq/core`'s account graph rather than
 * inventing a second vocabulary for the same fact:
 *  - `self`   — the principal's own personal account (`principal.userId === accountId`)
 *  - `owner`  — the principal owns this account
 *  - `member` — the principal holds a membership granting `account:act_as`
 */
export const deviceContextRelationshipSchema = z.enum(['self', 'owner', 'member']);

/**
 * Sanitized display metadata for a principal or an account context.
 *
 * Deliberately NOT `userResponseSchema`: a switcher needs a handle, a name and
 * an avatar, and the directory is read by every app on the device — so it
 * carries the minimum that renders a row and nothing that would make it a
 * general profile feed. `name.displayName` stays OPTIONAL; consumers fall back
 * to the handle (`getNormalizedUserHandle`), never to a synthesized name.
 */
export const deviceDirectoryProfileSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
  name: userNameSchema.optional(),
  avatar: z.string().nullable().optional(),
});

/**
 * One `principal acting as account` pair — the globally switchable unit.
 *
 * `id` is the identifier `POST /session/device/activate` takes. It names the
 * PAIR, not the account: the same `accountId` legitimately appears under two
 * principals on a shared device, and those are different sessions, permissions,
 * audit actors and revocation paths.
 *
 * `onDevice` is `false` for a context the principal may act as but has never
 * activated here — it exists as a row so it has a stable id to activate, and
 * its delegated session is minted on first activation rather than eagerly for
 * every organization the principal belongs to.
 *
 * `available` is `principalLive && (personal || live account:act_as)`, and the
 * principal clause is not decoration: a principal whose own personal session
 * has died makes EVERY context of theirs unavailable, including delegated ones
 * whose sessions are perfectly alive. Activation verifies the principal's
 * personal session (ADR 0002 step 3), so a client that models availability as
 * "delegated context has a live session ⇒ activatable" will be refused by the
 * server and the context healed away.
 *
 * A managed account whose membership was revoked is returned with
 * `available: false` rather than silently omitted, so the UI can explain a row
 * disappearing instead of just dropping it.
 *
 * (An earlier version of this comment described `available` as the
 * `account:act_as` verdict alone. It was written before the server existed and
 * was weaker than the code that shipped — the kind of wrong statement nothing
 * recomputes, so it is spelled out here in full.)
 */
export const deviceAccountContextSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  kind: accountKindSchema,
  relationship: deviceContextRelationshipSchema,
  account: deviceDirectoryProfileSchema,
  onDevice: z.boolean(),
  available: z.boolean(),
  active: z.boolean(),
  lastUsedAt: z.number().nullable(),
});

/**
 * A human who authenticated onto this device.
 *
 * Never an organization, project, channel or bot — those are subjects a
 * principal acts as, and they appear only in `contexts`. `authuser` is the
 * Google-style signed-in-human slot and belongs HERE, not to an account: adding
 * an organization must never consume one.
 */
export const devicePrincipalSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  authuser: z.number().int().nonnegative(),
  user: deviceDirectoryProfileSchema,
  contexts: z.array(deviceAccountContextSchema),
});

/**
 * Response of `GET /session/device/directory`.
 *
 * `activeContextId` is the authority for what every official app in
 * `sessionMode: 'account'` renders. It is null when the device has no active
 * context — a real state (every context removed, or an active context healed
 * away), not an error.
 */
export const deviceDirectorySchema = z.object({
  deviceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  activeContextId: z.string().nullable(),
  principals: z.array(devicePrincipalSchema),
  updatedAt: z.number(),
});

/**
 * Request body of `POST /session/device/activate`.
 *
 * `contextId`, never `accountId`: an account id cannot name a context on a
 * device where two people can both reach the same organization, and resolving
 * that ambiguity server-side would mean guessing inside an authorization path.
 */
export const deviceActivateRequestSchema = z.object({
  contextId: z.string().min(1),
});

/**
 * Response of `POST /session/device/activate`.
 *
 * Carries the post-transition directory AND the bearer for the newly active
 * context, because the client's ordering invariant is
 * `commit token → reset caches → publish snapshot → notify` (ADR 0002). Handing
 * the directory back without the token would force a second round trip in the
 * middle of that sequence, which is exactly where a component would render the
 * new subject while still holding the previous subject's bearer.
 *
 * `activeToken` is null when the activation legitimately produced no bearer for
 * THIS caller — an identity-pinned client, or a caller whose application is not
 * entitled to a token for the new context. It is never an error signal.
 */
export const deviceActivateResponseSchema = z.object({
  directory: deviceDirectorySchema,
  activeToken: z
    .object({
      accessToken: z.string(),
      expiresAt: z.string(),
    })
    .nullable(),
});

export type DeviceContextRelationship = z.infer<typeof deviceContextRelationshipSchema>;
export type DeviceDirectoryProfile = z.infer<typeof deviceDirectoryProfileSchema>;
export type DeviceAccountContext = z.infer<typeof deviceAccountContextSchema>;
export type DevicePrincipal = z.infer<typeof devicePrincipalSchema>;
export type DeviceDirectory = z.infer<typeof deviceDirectorySchema>;
export type DeviceActivateRequest = z.infer<typeof deviceActivateRequestSchema>;
export type DeviceActivateResponse = z.infer<typeof deviceActivateResponseSchema>;
