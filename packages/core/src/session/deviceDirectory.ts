import type {
  AccountKind,
  DeviceContextRelationship,
  DeviceDirectory,
  DeviceDirectoryProfile,
} from '@oxyhq/contracts';

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
      if (context.id !== contextId) {
        continue;
      }
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
  }
  return null;
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
