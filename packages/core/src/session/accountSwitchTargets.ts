/**
 * The two questions an account chooser asks of an account-graph node: is this
 * kind switchable at all, and may THIS caller become it.
 *
 * Pure and I/O-free. They live here rather than beside the surfaces that ask
 * them because there is more than one such surface — the Console's workspace
 * tree, the Accounts app's managed-account rows — and a second enumeration of
 * switch targets is a second place for the rule to go missing, which is
 * precisely how the Console went on offering `channel` rows after the rule
 * learned to drop them.
 *
 * The DEVICE switcher no longer asks anything here: it renders the server's
 * device directory (ADR 0002, `deviceDirectory.ts`), whose `available` field is
 * the server's own authorization verdict. These predicates answer a different
 * question — one about the caller's account GRAPH, which is a list of accounts
 * to manage, not a list of identities the device can become.
 */

import { isActAsEligibleKind } from '@oxyhq/contracts';
import type {
  AccountRelationship,
  AccountKind,
  AccountMember,
} from '../mixins/OxyServices.accounts';

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
 * holding an already-projected row can ask it too.
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
