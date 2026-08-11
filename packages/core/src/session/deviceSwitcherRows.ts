/**
 * The device switcher's RENDER model: the directory's people and contexts with
 * their names, handles and avatar URLs already resolved.
 *
 * Pure. It takes the projection {@link projectDevicePrincipals} produces from
 * the directory and answers the four questions a row asks —
 * what is it called, what is its handle, where is its avatar, may it be
 * activated — so the views stay presentational and neither of them re-derives
 * a display rule.
 *
 * Two things the flat account rows this replaced carried are deliberately absent,
 * because the directory does not carry them and inventing them would mean going
 * back to fetching another person's profiles:
 *
 *  - **email** — the directory profile is the minimum that renders a row, so the
 *    secondary line is the `@handle`. Never a synthesized `username@oxy.so`.
 *  - **per-account accent colour** — every row uses the ambient theme accent.
 *    The ACTIVE account's own colour is still available to the surfaces that
 *    want it, from the signed-in user, because that is the one account this
 *    client legitimately holds a full profile for.
 *
 * It lives here rather than in a UI package because there is more than one
 * switcher — the SDK's account dialog and the `auth.oxy.so` chooser — and the
 * whole point of ADR 0002 is that they render ONE list, built once.
 */

import {
  canActivateContext,
  directoryDisplayName,
  directoryHandle,
  type DeviceContext,
  type DevicePrincipalGroup,
} from './deviceDirectory';

/** One `principal acting as account` row. */
export interface SwitcherContextRow {
  /**
   * The id `activateContext` / `signOutContext` take. Names the PAIR.
   *
   * Not stable across a removal, so it is read out of the directory in hand on
   * every render and never held across one.
   */
  contextId: string;
  accountId: string;
  displayName: string;
  /** The `@handle` secondary line, or `null` when the profile has no username. */
  handle: string | null;
  avatarUrl: string | undefined;
  /** Whether this pair is the device's active context. */
  isActive: boolean;
  /** Whether the actor and the subject are different accounts. */
  isDelegated: boolean;
  /**
   * Whether the row may be pressed — the server's `available`, read and never
   * recomputed. Composing it with `onDevice` is wrong in both directions (see
   * `canActivateContext`), so this is one field forwarded, not a derivation.
   */
  canActivate: boolean;
}

/** One person on this device, with the accounts they can act as beneath them. */
export interface SwitcherPrincipalRow {
  /** The id `signOutPrincipal` takes. */
  principalId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | undefined;
  /** Whether the device's ACTIVE context belongs to this person. */
  isActive: boolean;
  contexts: SwitcherContextRow[];
}

/** Resolves an avatar file id to a thumbnail URL. Bind to `getFileDownloadUrl`. */
export type ResolveAvatarUrl = (avatar: string | null | undefined) => string | undefined;

function toContextRow(
  context: DeviceContext,
  activeContextId: string | null,
  resolveAvatarUrl: ResolveAvatarUrl,
  locale: string | undefined,
): SwitcherContextRow {
  return {
    contextId: context.contextId,
    accountId: context.subject.accountId,
    displayName: directoryDisplayName(context.subject.profile, locale),
    handle: directoryHandle(context.subject.profile),
    avatarUrl: resolveAvatarUrl(context.subject.profile.avatar),
    // Compared on the CONTEXT id, never the account id: on a device holding two
    // people the same account is active through exactly one of them, and an
    // account comparison would light up both rows.
    isActive: context.contextId === activeContextId,
    isDelegated: context.isDelegated,
    canActivate: canActivateContext(context.subject),
  };
}

/** The directory's people and their contexts, ready to render. */
export function buildSwitcherRows(
  groups: DevicePrincipalGroup[],
  activeContextId: string | null,
  resolveAvatarUrl: ResolveAvatarUrl,
  locale?: string,
): SwitcherPrincipalRow[] {
  return groups.map((group) => ({
    principalId: group.principalId,
    displayName: directoryDisplayName(group.profile, locale),
    handle: directoryHandle(group.profile),
    avatarUrl: resolveAvatarUrl(group.profile.avatar),
    isActive: group.isActive,
    contexts: group.contexts.map((context) =>
      toContextRow(context, activeContextId, resolveAvatarUrl, locale),
    ),
  }));
}

/**
 * Whether the switcher should name the person above each block.
 *
 * The question a header answers is "who is operating this account", and that is
 * only a question worth printing once somebody holds MORE THAN ONE account
 * here. Two people with one personal account each is the flat list again — every
 * row already IS a person, and a header would just print each name twice.
 *
 * The moment any one of them can act as a second account, every group gets a
 * header, including the single-context ones: an inconsistent list is harder to
 * read than a slightly redundant one, and it is exactly then that "The Oxy
 * Collective, under Nate" and "The Oxy Collective, under Alice" become two
 * different rows that must be told apart.
 */
export function showsPrincipalHeaders(rows: SwitcherPrincipalRow[]): boolean {
  return rows.some((row) => row.contexts.length > 1);
}
