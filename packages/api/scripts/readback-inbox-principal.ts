import { and, eq, sql } from "drizzle-orm";
import { INBOX_APPLICATION_ID } from "../src/config/inboxInference";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import {
  accountBalances,
  applicationCredentials,
  applications,
  billingProfiles,
  users,
} from "../src/db/schema";
import {
  INBOX_PRINCIPAL_READBACK_CURRENCY,
  INBOX_PRINCIPAL_READBACK_RESULT_PREFIX,
  InboxPrincipalReadbackError,
  type InboxPrincipalJournalRow,
  validateInboxPrincipalReadback,
} from "../src/scripts/inboxPrincipalReadback";

/**
 * Read-only proof that the exact Inbox principal selected by
 * `INBOX_APPLICATION_KEY` can pay for `inference:invoke` from granted credit.
 *
 * Reads ONLY `DATABASE_URL` (through `connectPostgres`) and
 * `INBOX_APPLICATION_KEY`. No HTTP, no token mint, no inference, no write: the
 * first statement makes PostgreSQL itself refuse every write. Prints one
 * allowlisted result line; a failure prints a fixed message and never the
 * underlying error, which could carry connection details.
 */
async function readback(): Promise<boolean> {
  const requestedApplicationKey = process.env.INBOX_APPLICATION_KEY ?? "";
  if (requestedApplicationKey.length === 0) {
    throw new InboxPrincipalReadbackError("INBOX_APPLICATION_KEY is not set");
  }

  await connectPostgres();
  try {
    const result = await getDb().transaction(async (tx) => {
      // This must be the first transaction statement.
      await tx.execute(sql`set transaction read only`);
      const readOnlyRows = await tx.execute<{ transaction_read_only: string }>(
        sql`show transaction_read_only`,
      );
      const transactionReadOnly =
        readOnlyRows.length === 1 &&
        readOnlyRows[0]?.transaction_read_only === "on";
      if (!transactionReadOnly) {
        throw new InboxPrincipalReadbackError(
          "PostgreSQL did not confirm a read-only transaction",
        );
      }

      const [clock] = await tx.execute<{ observed_at: string }>(
        sql`select now()::text as observed_at`,
      );
      const observedAt = new Date(clock?.observed_at ?? "");

      // Exact public key; `limit 2` so ambiguity is visible. No secret or
      // hash column is selected.
      const credentials = await tx
        .select({
          id: applicationCredentials.id,
          applicationId: applicationCredentials.applicationId,
          type: applicationCredentials.type,
          status: applicationCredentials.status,
          scopes: applicationCredentials.scopes,
          expiresAt: applicationCredentials.expiresAt,
        })
        .from(applicationCredentials)
        .where(eq(applicationCredentials.publicKey, requestedApplicationKey))
        .limit(2);

      const applicationRows = await tx
        .select({
          id: applications.id,
          status: applications.status,
          scopes: applications.scopes,
          ownerAccountId: applications.ownerAccountId,
        })
        .from(applications)
        .where(eq(applications.id, INBOX_APPLICATION_ID))
        .limit(2);

      const ownerAccountId =
        applicationRows.length === 1 ? applicationRows[0]?.ownerAccountId : undefined;
      if (ownerAccountId === undefined) {
        return validateInboxPrincipalReadback({
          requestedApplicationKey,
          transactionReadOnly,
          observedAt,
          credentials,
          applications: applicationRows,
          owners: [],
          billingProfiles: [],
          balances: [],
          journals: [],
        });
      }

      const owners = await tx
        .select({ id: users.id, accountStatus: users.accountStatus })
        .from(users)
        .where(eq(users.id, ownerAccountId))
        .limit(2);

      const profiles = await tx
        .select({
          accountId: billingProfiles.accountId,
          currency: billingProfiles.currency,
          billingMode: billingProfiles.billingMode,
          status: billingProfiles.status,
        })
        .from(billingProfiles)
        .where(eq(billingProfiles.accountId, ownerAccountId))
        .limit(2);

      const balances = await tx
        .select({
          accountId: accountBalances.accountId,
          currency: accountBalances.currency,
          purchasedBalance: sql<string>`${accountBalances.purchasedBalance}::text`,
          promotionalBalance: sql<string>`${accountBalances.promotionalBalance}::text`,
          reservedBalance: sql<string>`${accountBalances.reservedBalance}::text`,
        })
        .from(accountBalances)
        .where(
          and(
            eq(accountBalances.accountId, ownerAccountId),
            eq(accountBalances.currency, INBOX_PRINCIPAL_READBACK_CURRENCY),
          ),
        )
        .limit(2);

      // The journal is the authority; recompute each customer bucket with
      // `balance = Σ(destination) − Σ(source)` over this owner's USD entries.
      const journalRows = await tx.execute<{
        purchased_funds: string;
        promotional_funds: string;
        reserved_funds: string;
        promotional_grant_entries: number;
      }>(sql`
        select
          (coalesce(sum(p.amount) filter (where p.destination_account = 'purchased_funds'), 0)
            - coalesce(sum(p.amount) filter (where p.source_account = 'purchased_funds'), 0))::text
            as purchased_funds,
          (coalesce(sum(p.amount) filter (where p.destination_account = 'promotional_funds'), 0)
            - coalesce(sum(p.amount) filter (where p.source_account = 'promotional_funds'), 0))::text
            as promotional_funds,
          (coalesce(sum(p.amount) filter (where p.destination_account = 'reserved_funds'), 0)
            - coalesce(sum(p.amount) filter (where p.source_account = 'reserved_funds'), 0))::text
            as reserved_funds,
          (select count(*)::int from billing_ledger_entries g
            where g.account_id = ${ownerAccountId}
              and g.currency = ${INBOX_PRINCIPAL_READBACK_CURRENCY}
              and g.kind = 'promotional_grant') as promotional_grant_entries
        from billing_ledger_entries e
        join billing_ledger_postings p on p.entry_id = e.id
        where e.account_id = ${ownerAccountId}
          and e.currency = ${INBOX_PRINCIPAL_READBACK_CURRENCY}
      `);
      const journals: InboxPrincipalJournalRow[] = journalRows.map((row) => ({
        accountId: ownerAccountId,
        currency: INBOX_PRINCIPAL_READBACK_CURRENCY,
        purchasedFunds: row.purchased_funds,
        promotionalFunds: row.promotional_funds,
        reservedFunds: row.reserved_funds,
        promotionalGrantEntries: Number(row.promotional_grant_entries),
      }));

      return validateInboxPrincipalReadback({
        requestedApplicationKey,
        transactionReadOnly,
        observedAt,
        credentials,
        applications: applicationRows,
        owners,
        billingProfiles: profiles,
        balances,
        journals,
      });
    });

    process.stdout.write(
      `${INBOX_PRINCIPAL_READBACK_RESULT_PREFIX}${JSON.stringify(result)}\n`,
    );
    return result.status === "ready";
  } finally {
    await closePostgres();
  }
}

void readback()
  .then((ready) => {
    if (!ready) process.exitCode = 2;
  })
  .catch((error: unknown) => {
    const message =
      error instanceof InboxPrincipalReadbackError
        ? error.message
        : "Unexpected PostgreSQL readback failure";
    process.stderr.write(`Inbox principal readback failed: ${message}\n`);
    process.exitCode = 1;
  });
