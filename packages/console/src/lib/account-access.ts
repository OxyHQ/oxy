import type { AccountRelationship } from '@oxyhq/core';

/**
 * The one account whose permissions do not come from a membership row.
 *
 * `accountService.effectiveAccessForAccount` short-circuits before it looks for
 * one: a user is the implicit owner of their OWN personal account, so the server
 * answers `{ role: 'owner', permissions: <every owner permission>, source:
 * 'self', membership: null }`. `serializeAccountNode` then sends
 * `callerMembership: null` for that node, because there is genuinely no row to
 * send.
 *
 * A client gate reading `callerMembership?.permissions` therefore sees an empty
 * list for the account the caller owns outright, and refuses them everything the
 * server would grant. That is not a theoretical inversion — it is the state of
 * every personal account, which is the account the Console defaults to.
 *
 * So this predicate is the client's half of the same short-circuit, defined once
 * and consumed by every gate rather than repeated at each call site. It is a
 * check on the RELATIONSHIP, not a re-derivation of a role's permission set: the
 * Console never enumerates what an owner may do — that map is single-sourced in
 * the API — it only knows that this particular caller may do all of it.
 */
export function hasImplicitOwnership(node: {
  readonly relationship: AccountRelationship;
}): boolean {
  return node.relationship === 'self';
}
