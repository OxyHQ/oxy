/**
 * The two authorization facts a service needs before it acts as a managed
 * account: whether the caller has standing in the account, and whether that
 * standing includes `account:act_as` for a delegation-eligible subject.
 *
 * This is deliberately separate from `accountSwitchTargets.ts`. A human account
 * switcher and a backend delegation ask different questions: `bot` is a valid
 * delegation subject, but it is never a seat a person may switch into. Sharing
 * one predicate between those paths is what previously put bot sessions on
 * human devices.
 *
 * Pure and I/O-free. Consumers pass the `AccountNode` returned by `getAccount`
 * (or the structural subset below), so the SDK and every agent runtime read the
 * API's already-resolved relationship and effective permissions identically.
 */

import { isDelegatedActAsEligibleKind } from "@oxyhq/contracts";
import type {
	AccountKind,
	AccountMember,
	AccountRelationship,
} from "../mixins/OxyServices.accounts";

export interface AccountDelegationAccess {
	/** The caller owns the account or has a live membership in it. */
	readonly hasStanding: boolean;
	/** The account may be delegated and the caller holds effective `account:act_as`. */
	readonly canActAs: boolean;
}

export type AccountDelegationNode = {
	kind?: AccountKind | null;
	relationship?: AccountRelationship;
	callerMembership?: AccountMember | null;
};

/**
 * Resolve standing and delegated act-as authority from one account-graph node.
 *
 * `hasStanding` is intentionally weaker than `canActAs`: an active viewer may
 * use a private agent shared through its bot account without gaining permission
 * to edit the agent or mint a session as it. A non-active membership grants
 * neither fact even if a stale projection still carries permissions.
 *
 * Owners normally have no membership blob because ownership is implicit. When
 * the API does return effective permissions for an owner, those permissions are
 * authoritative: an explicit `account:act_as` revoke must remain a revoke.
 */
export function resolveAccountDelegationAccess(
	node: AccountDelegationNode,
): AccountDelegationAccess {
	const membership = node.callerMembership;
	const activeMembership = membership?.status === "active";
	const hasStanding =
		node.relationship === "self" ||
		node.relationship === "owner" ||
		activeMembership;

	if (!hasStanding || !isDelegatedActAsEligibleKind(node.kind)) {
		return { hasStanding, canActAs: false };
	}

	if (membership !== null && membership !== undefined) {
		return {
			hasStanding,
			canActAs:
				activeMembership && membership.permissions.includes("account:act_as"),
		};
	}

	return { hasStanding, canActAs: node.relationship === "owner" };
}
