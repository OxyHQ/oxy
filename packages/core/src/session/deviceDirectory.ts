import type {
  AccountKind,
  DeviceAccountContext,
  DeviceContextRelationship,
  DeviceDirectory,
  DeviceDirectoryProfile,
  DevicePrincipal,
} from '@oxyhq/contracts';
import { getAccountDisplayName } from '../utils/accountUtils';
import { getNormalizedUserHandle } from '../utils/userHandle';

/**
 * Pure projections over the device directory (`GET /session/device/directory`,
 * ADR 0002). No I/O — the caller holds the directory `SessionClient` fetched.
 *
 * These exist to say the one thing the flat `DeviceSessionState` projection
 * structurally cannot: WHO an account is being reached through.
 * `DeviceSessionState.accounts[]` has carried `operatedByUserId` on the wire all
 * along and nothing in this SDK ever read it, so "signed in as The Oxy
 * Collective" and "Nate operating The Oxy Collective" render identically today —
 * two different audit actors, two different revocation paths, one row. The
 * directory keeps the two facts apart, and so does everything below.
 */

/**
 * The human whose authentication backs a context — the audit actor.
 *
 * Always a person (ADR 0001: a principal is never an organization, project,
 * channel or bot) and the owner of the `authuser` slot. An organization in the
 * switcher consumes no slot of its own; it is a SUBJECT under some principal.
 */
export interface DeviceContextActor {
  /** Identifies the principal row — the id `POST /session/device/signout { principalId }` takes. */
  principalId: string;
  /** The person's own account id. */
  userId: string;
  /** Google-style signed-in-human slot, allocated per person. */
  authuser: number;
  profile: DeviceDirectoryProfile;
}

/** The account a context acts AS — what a profile header renders. */
export interface DeviceContextSubject {
  accountId: string;
  kind: AccountKind;
  relationship: DeviceContextRelationship;
  profile: DeviceDirectoryProfile;
  /**
   * `false` for a context the principal may act as but has never activated here.
   *
   * NOT a synonym for activatable, in either direction — see
   * {@link canActivateContext}.
   */
  onDevice: boolean;
  /**
   * Whether this context can be activated right now — the server's whole verdict,
   * returned as a row rather than omitted so the UI can explain a row going away.
   *
   * It is STRICTER than the old `/switch` gate, and stricter than the name
   * suggests: it is the live `account:act_as` check AND the PRINCIPAL's own
   * personal session being live. Activation has no proof of who is acting once
   * the human's own session is gone, so a dead principal makes every one of
   * their contexts unavailable — the delegated ones whose own sessions are
   * perfectly alive included.
   */
  available: boolean;
  lastUsedAt: number | null;
}

/**
 * One resolved `principal acting as account` pair — the globally switchable
 * unit, with its two halves named.
 */
export interface DeviceContext {
  /**
   * The identifier `POST /session/device/activate` takes. Names the PAIR, never
   * the account.
   *
   * NOT STABLE ACROSS A REMOVAL, and therefore never something to persist or to
   * hold across a read. Removing a delegated context is not permanent while the
   * membership lives: the server rematerializes the pair on the next directory
   * read, as `onDevice: false` under a NEW id — and it does so WITHOUT bumping
   * `revision`, so "the device has not changed" is not evidence the id has not.
   * Re-resolve from the directory in hand every time, and read an id that no
   * longer resolves as gone rather than as an error.
   */
  contextId: string;
  actor: DeviceContextActor;
  subject: DeviceContextSubject;
  /**
   * Whether the actor and the subject are different accounts — "Nate operating
   * The Oxy Collective" rather than "Nate". Compared by id rather than read off
   * `relationship`, so it stays true if the vocabulary ever grows a fourth term.
   */
  isDelegated: boolean;
}

/** Resolve one wire context under the principal it hangs off. */
function toDeviceContext(principal: DevicePrincipal, context: DeviceAccountContext): DeviceContext {
  return {
    contextId: context.id,
    actor: {
      principalId: principal.id,
      userId: principal.userId,
      authuser: principal.authuser,
      profile: principal.user,
    },
    subject: {
      accountId: context.accountId,
      kind: context.kind,
      relationship: context.relationship,
      profile: context.account,
      onDevice: context.onDevice,
      available: context.available,
      lastUsedAt: context.lastUsedAt,
    },
    isDelegated: context.accountId !== principal.userId,
  };
}

/**
 * Resolve one context by its id.
 *
 * The search is over `(principal, context)` PAIRS, not over accounts: the same
 * `accountId` legitimately appears under two principals on a shared device, and
 * matching on the account would hand back whichever person happened to be
 * enumerated first.
 */
export function resolveDeviceContext(
  directory: DeviceDirectory | null,
  contextId: string,
): DeviceContext | null {
  if (directory === null) {
    return null;
  }
  for (const principal of directory.principals) {
    for (const context of principal.contexts) {
      if (context.id === contextId) {
        return toDeviceContext(principal, context);
      }
    }
  }
  return null;
}

/**
 * One person on the device, with every account they can act as beneath them.
 *
 * This is the switcher's shape, and it is grouped rather than flat because the
 * flat one cannot state the fact the whole model exists for: the same
 * organization reachable through two people is TWO rows, under two different
 * humans, and a list keyed by account can only ever show one of them.
 */
export interface DevicePrincipalGroup {
  /** The id `POST /session/device/signout { principalId }` takes. */
  principalId: string;
  /** The person's own account id. */
  userId: string;
  /** Google-style signed-in-human slot. An organization consumes none. */
  authuser: number;
  profile: DeviceDirectoryProfile;
  /**
   * Every context this person can reach, in the server's order (their personal
   * account first, then the accounts they act as, by account id). Not re-sorted
   * here: the server's order is already total and revision-stable, and a second
   * ordering rule on the client would be a second thing to keep in agreement.
   */
  contexts: DeviceContext[];
  /** Whether the device's ACTIVE context belongs to this person. */
  isActive: boolean;
}

/**
 * The directory as the switcher renders it: people, each with what they may
 * become.
 *
 * A principal with no contexts is kept rather than dropped. It is a real state
 * — a person whose every context was removed while they remain on the device —
 * and rendering them with nothing under them is how "sign out of this person"
 * stays reachable. Silently omitting them would strand the row.
 */
export function projectDevicePrincipals(
  directory: DeviceDirectory | null,
): DevicePrincipalGroup[] {
  if (directory === null) {
    return [];
  }
  return directory.principals.map((principal) => ({
    principalId: principal.id,
    userId: principal.userId,
    authuser: principal.authuser,
    profile: principal.user,
    contexts: principal.contexts.map((context) => toDeviceContext(principal, context)),
    isActive:
      directory.activeContextId !== null &&
      principal.contexts.some((context) => context.id === directory.activeContextId),
  }));
}

/**
 * The device's active context, or `null`.
 *
 * `null` is a real state, not an error: a device with every context removed, or
 * one whose active context was healed away, has none. It is also the answer when
 * `activeContextId` names a row no principal holds — a directory that
 * disagreed with itself, which resolves to "nothing is active" rather than to a
 * guess.
 */
export function resolveActiveContext(directory: DeviceDirectory | null): DeviceContext | null {
  if (directory === null || directory.activeContextId === null) {
    return null;
  }
  return resolveDeviceContext(directory, directory.activeContextId);
}

/**
 * The name a directory row renders: the API's `displayName` when it has one,
 * otherwise the normalized handle, otherwise the localized unnamed sentinel.
 *
 * The identity contract's `displayName ?? handle`, and deliberately not
 * `getAccountDisplayName`'s multi-field chain — that one is for LOCAL account
 * surfaces, and the directory profile is an API DTO whose `name.displayName`
 * the server already composed or deliberately omitted. `getAccountDisplayName`
 * appears here only for its `null` case, which is the sentinel.
 */
export function directoryDisplayName(profile: DeviceDirectoryProfile, locale?: string): string {
  const displayName = profile.name?.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return getNormalizedUserHandle(profile) ?? getAccountDisplayName(null, locale);
}

/**
 * A directory row's `@handle`, or `null` when the profile carries no usable
 * username.
 *
 * The directory profile has no email — by design, it is the minimum that
 * renders a row — so the handle is the secondary line, never a synthesized
 * `username@oxy.so` address.
 */
export function directoryHandle(profile: DeviceDirectoryProfile): string | null {
  return getNormalizedUserHandle(profile);
}

/**
 * Whether a switcher may offer this row — the one question it asks, answered
 * here so no surface has to re-derive it.
 *
 * It is deliberately a single field. `available` is the server's complete
 * verdict (see {@link DeviceContextSubject.available}), and switchability is an
 * authorization question the client must READ, never recompute; this exists to
 * name the field that answers it, not to combine several.
 *
 * `onDevice` is NOT part of the question and composing the two is the mistake
 * this function exists to prevent, in both directions. `onDevice: false` is an
 * ordinary reachable context whose session is minted on first activation, so
 * requiring it hides every organization the person has not used here yet.
 * `onDevice: true` does not imply activatable either: when a principal's own
 * personal session dies, their delegated contexts keep live sessions of their
 * own and still cannot be activated, so `available || onDevice` would render a
 * row the server answers with 403 and then heals away.
 *
 * Takes a structural subset so a caller holding a raw `DeviceAccountContext`
 * from the wire can ask it without resolving the pair first.
 */
export function canActivateContext(context: { available: boolean }): boolean {
  return context.available;
}
