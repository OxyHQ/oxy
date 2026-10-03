/** This restriction exists only in the reviewed old-derived fallback image. */
import { eq } from "drizzle-orm";
import { getDb } from "../config/postgres";
import { isRollbackAuthOnly } from "../config/runtimeMode";
import { users } from "../db/schema/users";

export async function rollbackAuthAccountAllowed(
	accountId: string,
): Promise<boolean> {
	if (!isRollbackAuthOnly) return true;
	const [account] = await getDb()
		.select({ kind: users.kind, status: users.accountStatus })
		.from(users)
		.where(eq(users.id, accountId))
		.limit(1);
	// Agent key/code provenance is unsupported by the old issuer; never re-mint it.
	return (
		account !== undefined &&
		account.kind !== "bot" &&
		account.status === "active"
	);
}

export async function rollbackAuthSessionAllowed(
	accountId: string,
	operatorId: string | null,
): Promise<boolean> {
	if (!isRollbackAuthOnly) return true;
	return (
		(await rollbackAuthAccountAllowed(accountId)) &&
		(operatorId === null || (await rollbackAuthAccountAllowed(operatorId)))
	);
}
