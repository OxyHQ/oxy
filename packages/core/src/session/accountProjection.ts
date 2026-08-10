/**
 * Unified account-list projection — THE single source of truth.
 *
 * Produces the flat `SwitchableAccount[]` every account chooser renders, by
 * merging the device's server-authoritative session set (`DeviceSessionState`
 * from {@link SessionClient}) with the caller's account graph (`AccountNode[]`
 * from `oxyServices.listAccounts()`), deduped by `accountId`. This lives in
 * `@oxyhq/core` so every `@oxyhq/services` platform variant — and
 * `auth.oxy.so` — all render the SAME list from the SAME logic and cannot
 * diverge.
 *
 * Pure and I/O-free: the caller resolves per-account profiles via
 * `oxyServices.getUsersByIds(...)` and passes them in as `profilesById`, and
 * binds `resolveAvatarUrl` to `oxyServices.getFileDownloadUrl`. This is the same
 * split the former `@oxyhq/services` `buildSwitchableAccounts` used — hoisted
 * into core, keyed directly on `DeviceSessionState` (whose `activeAccountId` is
 * atomic, so no cross-call current-row reconciliation is needed).
 */

import type { DeviceSessionState } from '@oxyhq/contracts';
import { isActAsEligibleKind } from '@oxyhq/contracts';
import type { User } from '../models/interfaces';
import type {
  AccountNode,
  AccountRelationship,
  AccountKind,
  AccountMember,
} from '../mixins/OxyServices.accounts';
import { getAccountDisplayName, getAccountFallbackHandle } from '../utils/accountUtils';
import { getNormalizedUserHandle } from '../utils/userHandle';
import { boundAccountIdOf } from './projectSessionState';

/**
 * The per-account user shape carried by a {@link SwitchableAccount}. The SDK's
 * canonical {@link User} document — either a profile resolved via
 * `oxyServices.getUsersByIds()` (device rows), the caller-supplied
 * `activeUser` override (the freshest copy of the active row), or the `account`
 * document embedded in an account-graph node (graph-only rows).
 */
export type SwitchableAccountUser = User;

/**
 * One account the signed-in user can switch INTO, in the uniform switch model.
 *
 * A switchable account is either a device sign-in, an account-graph node (owned
 * org / shared-with-you), or BOTH (an account that has been switched into
 * becomes a device session while still being a graph node — the two are deduped
 * into a single row). Every row carries a canonical `accountId` (the uniform
 * switch key); `sessionId` is present IFF the account is currently signed in on
 * THIS device.
 */
export interface SwitchableAccount {
  /**
   * Canonical account id (the underlying `User._id`). The single key EVERY
   * switch uses — `controller.switchTo(accountId)`. Always present.
   */
  accountId: string;
  /**
   * Device session id, present IFF this account is signed in on THIS device.
   * Absent for a graph account not yet switched into. Used only for
   * device-scoped actions (per-account sign-out); switching ALWAYS goes through
   * `switchTo(accountId)`.
   */
  sessionId?: string;
  /**
   * Device-local account slot index (0..N-1) carried on the underlying
   * `SessionAccount`. Absent for graph-only rows.
   */
  authuser?: number;
  /**
   * The HUMAN this account is being operated by, for a delegated device session.
   * Absent for a row the account itself signed into, and for every graph-only
   * row (nobody operates an account that has no session here yet).
   *
   * Lets a switcher say "The Oxy Collective — operated by Nate" instead of
   * rendering a delegated session identically to a direct one. On a device
   * holding two people the flat lane still cannot show BOTH routes to one
   * account — the unique key is the account id — which is exactly the limit
   * `SessionClient.getDirectory()` exists to lift.
   */
  operatedByUserId?: string;
  /**
   * Whether this account is the currently-active one — `accountId` equals the
   * BOUND account, i.e. the pin when {@link ProjectSwitchableAccountsInput.pinnedAccountId}
   * is supplied and the device's `activeAccountId` otherwise.
   */
  isCurrent: boolean;
  /** Whether this account is signed in on THIS device (has a `sessionId`). */
  onDevice: boolean;
  /**
   * The caller's relationship to this account when it appears in the account
   * graph: `self` (the caller's own personal account), `owner` (an org/project/
   * bot the caller owns), or `member` (shared with the caller). Absent for an
   * independent device sign-in that is NOT in the active account's graph.
   */
  relationship?: AccountRelationship;
  /** Account classification (personal/organization/…). Cosmetic badge only. */
  kind?: AccountKind;
  /** Parent account id for 2-level tree grouping, or `null` for a root. */
  parentAccountId?: string | null;
  /**
   * The caller's effective membership (role + permissions) in this account when
   * it appears in the graph, or `null`/absent otherwise. Use `permissions` to
   * gate per-account settings UI.
   */
  callerMembership?: AccountMember | null;
  /** Friendly display name (never blank — falls back to a handle/sentinel). */
  displayName: string;
  /**
   * Real account email, or `null` when the account genuinely has none. NEVER a
   * synthesized `username@oxy.so` — a missing email falls back to the `@handle`
   * secondary line.
   */
  email: string | null;
  /** Resolved avatar thumbnail URL, or `undefined` when the account has no avatar. */
  avatarUrl?: string;
  /** Account's preferred Bloom color preset, or `null` when unset. */
  color: string | null;
  /** The underlying per-account user payload. */
  user: SwitchableAccountUser;
}

/**
 * Whether the caller can BECOME this account — the one question every account
 * switcher asks, answered here so no surface has to re-derive it.
 *
 * Two independent grounds, either of which suffices:
 *
 *  - **It is already the caller's own identity** (`relationship: 'self'`).
 *    `GET /accounts` resolves its caller through `resolveOperatorId`, so `self`
 *    is the HUMAN operator's personal account even while they are operating an
 *    org — never the operated account. Kind is irrelevant on this ground: the
 *    caller IS that account, so returning to it asks the server for nothing.
 *  - **The server will mint a session for it** — `isActAsEligibleKind(kind)` is
 *    the exact predicate `POST /accounts/:id/switch` enforces, so a row offered
 *    on this ground is never a dead button.
 *
 * `isActAsEligibleKind` ALONE is not this question, and reaching for it
 * directly is the mistake this function exists to prevent: it is false for
 * `personal` as well as `channel`, so a switcher gated on it alone renders an
 * empty list rather than a filtered one. Equally, `kind !== 'channel'` is not
 * this question either — it silently admits every kind invented after it was
 * written, which is the same trap `isActAsEligibleKind` was introduced to close
 * on the server.
 *
 * Takes a structural subset rather than a whole {@link AccountNode} so a caller
 * holding a projected {@link SwitchableAccount} can ask it too.
 */
export function isSwitchTargetAccount(
  node: { kind?: AccountKind | null; relationship?: AccountRelationship },
): boolean {
  return node.relationship === 'self' || isActAsEligibleKind(node.kind);
}

/**
 * Whether the caller may switch INTO this account — the server-side
 * `account:act_as` gate plus the structural {@link isSwitchTargetAccount} rule.
 *
 * `relationship: 'self'` always passes (returning to the caller's own personal
 * account). Every other ground requires a switch-eligible kind AND
 * `account:act_as` in the resolved membership permissions. When permissions are
 * absent but the relationship is `owner`, the owner baseline is assumed — the
 * API always resolves effective permissions for owned accounts, but test
 * fixtures and stale rows may omit the membership blob.
 */
export function canSwitchIntoAccount(
  node: {
    kind?: AccountKind | null;
    relationship?: AccountRelationship;
    callerMembership?: AccountMember | null;
  },
): boolean {
  if (node.relationship === 'self') {
    return true;
  }
  if (!isSwitchTargetAccount(node)) {
    return false;
  }
  const permissions = node.callerMembership?.permissions;
  if (permissions) {
    return permissions.includes('account:act_as');
  }
  return node.relationship === 'owner';
}

/** Input to {@link projectSwitchableAccounts}. */
export interface ProjectSwitchableAccountsInput {
  /**
   * The device-scoped session state from `SessionClient.getState()`. `null`
   * (or an empty account set) contributes no device rows.
   */
  state: DeviceSessionState | null;
  /** The caller's account graph (`oxyServices.listAccounts()`). `[]` when none. */
  graph: AccountNode[];
  /**
   * Per-account profiles resolved via `oxyServices.getUsersByIds()`, keyed by
   * account id (`User.id`). Device accounts whose profile is absent here are
   * omitted until a subsequent fetch resolves them (unless they are the active
   * account and `activeUser` is supplied).
   */
  profilesById: Map<string, User>;
  /**
   * The freshest copy of the ACTIVE account's user (e.g. `useOxy().user`),
   * preferred over `profilesById` for the active row so a just-committed profile
   * edit is reflected immediately. Optional — the controller relies on
   * `profilesById` alone when omitted.
   */
  activeUser?: User | null;
  /**
   * The PINNED account id for an identity-bound client, or `null`/omitted for
   * every ordinary one — the same parameter every projection in
   * `projectSessionState.ts` takes, resolved through the same
   * `boundAccountIdOf`.
   *
   * It exists here because the alternative was a structural coupling, not a
   * guarantee: reading `state.activeAccountId` directly is correct only while
   * identity mode never builds a switcher, and "this projection happens not to
   * be reachable from that mode today" is not a property anything checks. With
   * the pin threaded, a pinned client that DID render a switcher marks its own
   * identity current instead of whichever account another app on the device
   * last activated.
   */
  pinnedAccountId?: string | null;
  /** Locale for display-name resolution (passed to `getAccountDisplayName`). */
  locale?: string;
  /**
   * Resolves an avatar file id to a thumbnail URL — bind to
   * `(id) => id ? oxyServices.getFileDownloadUrl(id, 'thumb') : undefined`.
   */
  resolveAvatarUrl: (avatar: string | null | undefined) => string | undefined;
}

/**
 * Pure union of device sign-ins and account-graph nodes into the flat
 * {@link SwitchableAccount}[] every switcher renders.
 *
 * Order: device rows first (in `state.accounts` order, active flagged), then
 * graph-only rows (in graph order). An account present as BOTH a device session
 * and a graph node is deduped into ONE device row enriched with the graph
 * metadata (relationship / kind / parent / membership).
 *
 * Graph nodes the caller cannot switch into — a `channel`, or a managed account
 * whose membership lacks `account:act_as` — are omitted.
 * {@link canSwitchIntoAccount} is the rule; see the filter below.
 *
 * `isCurrent` marks the BOUND account — the pin when
 * {@link ProjectSwitchableAccountsInput.pinnedAccountId} is supplied, the
 * device's `activeAccountId` otherwise — through the same `boundAccountIdOf`
 * every projection in `projectSessionState.ts` uses, so the two can never
 * disagree about which row is current for one pin.
 */
export function projectSwitchableAccounts(input: ProjectSwitchableAccountsInput): SwitchableAccount[] {
  const { state, graph, profilesById, activeUser, pinnedAccountId, locale, resolveAvatarUrl } = input;
  const boundAccountId = boundAccountIdOf(state, pinnedAccountId);

  const toRow = (
    accountUser: User,
    opts: {
      sessionId?: string;
      authuser?: number;
      operatedByUserId?: string;
      relationship?: AccountRelationship;
      kind?: AccountKind;
      parentAccountId?: string | null;
      callerMembership?: AccountMember | null;
    },
  ): SwitchableAccount => {
    const accountId = accountUser.id?.toString() ?? '';
    const handle = getAccountFallbackHandle(accountUser);
    const secondaryHandle = handle ? `@${handle}` : null;
    return {
      accountId,
      sessionId: opts.sessionId,
      authuser: opts.authuser,
      operatedByUserId: opts.operatedByUserId,
      isCurrent: Boolean(accountId) && accountId === boundAccountId,
      onDevice: Boolean(opts.sessionId),
      relationship: opts.relationship,
      kind: opts.kind,
      parentAccountId: opts.parentAccountId,
      callerMembership: opts.callerMembership,
      displayName:
        accountUser.name?.displayName ??
        getNormalizedUserHandle(accountUser) ??
        getAccountDisplayName(null, locale),
      // Real email, or the `@handle` fallback (NEVER synthesized).
      email: accountUser.email ?? secondaryHandle,
      avatarUrl: resolveAvatarUrl(accountUser.avatar),
      color: accountUser.color ?? null,
      user: accountUser,
    };
  };

  // --- Device rows (from the server-authoritative session set) ---
  const deviceRows = (state?.accounts ?? []).flatMap((account): SwitchableAccount[] => {
    const isActive = account.accountId === boundAccountId;
    // The active row prefers the freshest `activeUser` (when supplied), then the
    // batch-resolved profile; every other row uses the batch-resolved profile.
    const accountUser: User | undefined = isActive && activeUser
      ? activeUser
      : profilesById.get(account.accountId);
    if (!accountUser) {
      return [];
    }
    return [toRow(accountUser, {
      sessionId: account.sessionId,
      authuser: account.authuser,
      operatedByUserId: account.operatedByUserId,
    })];
  });

  // --- Merge graph nodes, deduping by account id ---
  const byAccountId = new Map<string, SwitchableAccount>();
  const order: string[] = [];
  const remember = (row: SwitchableAccount): void => {
    if (!row.accountId || byAccountId.has(row.accountId)) {
      return;
    }
    byAccountId.set(row.accountId, row);
    order.push(row.accountId);
  };

  for (const row of deviceRows) {
    remember(row);
  }

  for (const node of graph) {
    const existing = byAccountId.get(node.accountId);
    if (existing) {
      // On-device account that is ALSO in the graph: enrich the device row with
      // graph metadata; keep its (freshest) profile + sessionId + active flag.
      byAccountId.set(node.accountId, {
        ...existing,
        relationship: node.relationship,
        kind: node.kind,
        parentAccountId: node.parentAccountId,
        callerMembership: node.callerMembership,
      });
      continue;
    }
    // Graph-only account (owned org / shared, not yet a device session).
    //
    // This lane is why a no-login account is NOT kept out of the switcher "by
    // construction": the graph contributes accounts that have no device session
    // and no credentials at all, which is exactly how an org first becomes
    // switchable. So a kind that must never be switched into has to be filtered
    // HERE — offering a row the server would 403 is a dead button.
    //
    // An account already on the device skipped this check via the branch above,
    // and correctly: whatever its kind, the caller is signed into it, so
    // switching is a local activation that asks the server for nothing.
    if (!canSwitchIntoAccount(node)) {
      continue;
    }
    remember(toRow(node.account, {
      relationship: node.relationship,
      kind: node.kind,
      parentAccountId: node.parentAccountId,
      callerMembership: node.callerMembership,
    }));
  }

  return order.flatMap((id) => {
    const row = byAccountId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Every distinct account id referenced by a device session set AND an account
 * graph, sorted for a stable profile-fetch key. Feed to
 * `oxyServices.getUsersByIds(...)`; graph nodes already embed their `account`
 * document, but including their ids lets the caller pass one id set and lets the
 * projection prefer freshly-fetched profiles uniformly.
 *
 * Applies the SAME {@link canSwitchIntoAccount} filter as
 * {@link projectSwitchableAccounts} to graph nodes, so this never fetches a
 * profile for a row the projection will drop — and, just as importantly, never
 * SKIPS one the projection will keep, which would leave that row unrendered
 * until some later fetch happened to resolve it.
 */
export function switchableAccountIds(
  state: DeviceSessionState | null,
  graph: AccountNode[],
): string[] {
  const ids = new Set<string>();
  for (const account of state?.accounts ?? []) {
    if (account.accountId) {
      ids.add(account.accountId);
    }
  }
  for (const node of graph) {
    if (node.accountId && canSwitchIntoAccount(node)) {
      ids.add(node.accountId);
    }
  }
  return Array.from(ids).sort();
}
