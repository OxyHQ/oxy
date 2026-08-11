import { canSwitchIntoAccount } from '@oxyhq/core';
import type { AccountNode } from '@/hooks/use-account';

/** The workspace switcher's rendered shape — see {@link buildWorkspaceTree}. */
export interface WorkspaceTree {
  /** `self` / owned roots, in graph order. */
  yourAccounts: AccountNode[];
  /** Roots shared with the caller via membership. */
  sharedAccounts: AccountNode[];
  /**
   * Direct children of a root, one level deep. DISJOINT from the two root
   * lists: an account promoted to a root because its own parent was dropped is
   * not also returned here, so nothing renders twice.
   */
  childrenOf: (accountId: string) => AccountNode[];
}

/**
 * Build the relationship-grouped, two-level tree the workspace switcher renders:
 * a node is a root when its parent is not in the switchable set, and its direct
 * children nest one level beneath it.
 *
 * Every row it produces SWITCHES the session, so the tree is built from the
 * SWITCH TARGETS, not from the whole accessible forest. `useAccount().accounts`
 * is deliberately unfiltered — the Console manages accounts it can never become
 * (a channel's members, its profile, its applications) — so the narrowing
 * belongs here, at the one place that asks "which identity can I become?".
 *
 * It asks {@link canSwitchIntoAccount} — the SAME predicate the Accounts app's
 * managed-account rows ask — rather than testing a kind literal. A second
 * enumeration of switch targets is a second place for the rule to go missing,
 * which is precisely how the Console went on offering channel rows after the
 * rule learned to drop them.
 *
 * This is the account GRAPH, not the device switcher. The switcher renders the
 * server's device directory (ADR 0002) and asks it nothing: what the Console
 * lists here is the forest of accounts a caller can MANAGE, which is a longer
 * list than the identities this device can become.
 *
 * Filtering BEFORE the top-level pass is what keeps a descendant reachable — an
 * account parented to a channel finds its parent absent and promotes to a root,
 * rather than nesting under a row that no longer renders.
 *
 * Lives apart from `sidebar-header.tsx` because the component drags in the whole
 * UI tree, which no unit test can transform; an untested exclusion here is one
 * refactor away from being dropped again.
 */
export function buildWorkspaceTree(accounts: AccountNode[]): WorkspaceTree {
  const switchable = accounts.filter(canSwitchIntoAccount);
  const present = new Set(switchable.map((a) => a.accountId));
  const isTopLevel = (a: AccountNode) => !a.parentAccountId || !present.has(a.parentAccountId);
  // A strict partition of `switchable`. `nested` excludes promoted roots on
  // purpose: without that, an account whose parent was dropped would be listed
  // BOTH as a root and as a child of the dropped parent — harmless only for as
  // long as nobody calls `childrenOf` with a non-root id, which is not an
  // invariant worth resting on.
  const topLevel = switchable.filter(isTopLevel);
  const nested = switchable.filter((a) => !isTopLevel(a));
  return {
    yourAccounts: topLevel.filter(
      (a) => a.relationship === 'self' || a.relationship === 'owner'
    ),
    sharedAccounts: topLevel.filter((a) => a.relationship === 'member'),
    childrenOf: (accountId: string) =>
      nested.filter((a) => a.parentAccountId === accountId),
  };
}
