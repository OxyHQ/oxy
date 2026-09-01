import { ACCOUNT_KINDS } from "@oxyhq/contracts";
import type { AccountMember } from "../../mixins/OxyServices.accounts";
import { canSwitchIntoAccount } from "../accountSwitchTargets";
import { resolveAccountDelegationAccess } from "../accountDelegationAccess";

function membership(
	permissions: string[],
	status: AccountMember["status"] = "active",
): AccountMember {
	return {
		_id: "membership-1",
		accountId: "account-1",
		memberUserId: "user-1",
		role: "viewer",
		permissions,
		inherit: true,
		status,
		source: "direct",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

describe("resolveAccountDelegationAccess", () => {
	it("admits exactly the delegated account kinds for an implicit owner baseline", () => {
		expect(
			Object.fromEntries(
				ACCOUNT_KINDS.map((kind) => [
					kind,
					resolveAccountDelegationAccess({ kind, relationship: "owner" }),
				]),
			),
		).toEqual({
			personal: { hasStanding: true, canActAs: false },
			organization: { hasStanding: true, canActAs: true },
			project: { hasStanding: true, canActAs: true },
			bot: { hasStanding: true, canActAs: true },
			channel: { hasStanding: true, canActAs: false },
		});
	});

	it("keeps bot delegation separate from human account switching", () => {
		const bot = { kind: "bot" as const, relationship: "owner" as const };

		expect(resolveAccountDelegationAccess(bot)).toEqual({
			hasStanding: true,
			canActAs: true,
		});
		expect(canSwitchIntoAccount(bot)).toBe(false);
	});

	it("treats active membership as standing without promoting it to act-as", () => {
		expect(
			resolveAccountDelegationAccess({
				kind: "bot",
				relationship: "member",
				callerMembership: membership(["account:read"]),
			}),
		).toEqual({ hasStanding: true, canActAs: false });
	});

	it("uses the effective account:act_as permission for a live member", () => {
		expect(
			resolveAccountDelegationAccess({
				kind: "bot",
				relationship: "member",
				callerMembership: membership(["account:read", "account:act_as"]),
			}),
		).toEqual({ hasStanding: true, canActAs: true });
	});

	it("refuses a removed membership even if a stale projection still carries act_as", () => {
		expect(
			resolveAccountDelegationAccess({
				kind: "bot",
				relationship: "member",
				callerMembership: membership(["account:act_as"], "removed"),
			}),
		).toEqual({ hasStanding: false, canActAs: false });
	});

	it("honours an explicit permission revoke on an owner membership projection", () => {
		expect(
			resolveAccountDelegationAccess({
				kind: "bot",
				relationship: "owner",
				callerMembership: membership(["account:read"]),
			}),
		).toEqual({ hasStanding: true, canActAs: false });
	});

	it("fails closed when the node carries no relationship or kind", () => {
		expect(resolveAccountDelegationAccess({})).toEqual({
			hasStanding: false,
			canActAs: false,
		});
		expect(
			resolveAccountDelegationAccess({ relationship: "member", kind: null }),
		).toEqual({
			hasStanding: false,
			canActAs: false,
		});
	});
});
