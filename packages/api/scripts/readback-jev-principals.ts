import { JEV_ALIA_APPLICATION_ID, JEV_ALIA_WORKLOAD_ROLE_ARN, deriveJevAliaWorkloadCredentialId } from "../src/scripts/jevPrincipalsReadback";
import { and, eq, sql } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import {
  accountBalances,
  accountClosureFences,
  applicationCredentials,
  applicationWorkloadIdentities,
  applications,
  users,
} from "../src/db/schema";
import { INBOX_PRINCIPAL_READBACK_ISOLATION } from "../src/scripts/inboxPrincipalReadback";
import {
  JEV_KAANA_APPLICATION_ID,
  JEV_MENTION_APPLICATION_ID,
  JEV_MENTION_WORKLOAD_PROVIDER,
  JEV_MENTION_WORKLOAD_ROLE_ARN,
  JEV_PRINCIPALS_READBACK_RESULT_PREFIX,
  JevPrincipalsReadbackError,
  type JevJournalRow,
  deriveJevMentionWorkloadCredentialId,
  validateJevPrincipalsReadback,
} from "../src/scripts/jevPrincipalsReadback";
import { resolveBillingAccount } from "../src/services/inferenceLedger.service";

/**
 * Metadata-only readback of the Mention workload principal and the Kaana
 * application's credentials, for review before any Jev canary is considered.
 *
 * Reads ONLY `DATABASE_URL` (through `connectPostgres`). No Inbox key, no
 * public key, secret, hash or token column, no HTTP, no attestation or token
 * mint, no inference, and no row is constructed or materialised: the first
 * statement makes PostgreSQL refuse every write and pins one REPEATABLE READ
 * snapshot for every read, billing resolution included. Prints one
 * allowlisted result line; a failure prints a fixed message only.
 */

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const credentialMetadata = {
  id: applicationCredentials.id,
  applicationId: applicationCredentials.applicationId,
  type: applicationCredentials.type,
  status: applicationCredentials.status,
  scopes: applicationCredentials.scopes,
  expiresAt: applicationCredentials.expiresAt,
  workloadIdentityId: applicationCredentials.workloadIdentityId,
};

async function readApplication(tx: Tx, applicationId: string) {
  const applicationRows = await tx
    .select({
      id: applications.id,
      status: applications.status,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      scopes: applications.scopes,
      ownerAccountId: applications.ownerAccountId,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(2);
  const ownerAccountId =
    applicationRows.length === 1 ? applicationRows[0]?.ownerAccountId : undefined;
  const owners =
    ownerAccountId === undefined
      ? []
      : (
          await tx
            .select({
              id: users.id,
              accountStatus: users.accountStatus,
              fence: accountClosureFences.accountId,
            })
            .from(users)
            .leftJoin(accountClosureFences, eq(accountClosureFences.accountId, users.id))
            .where(eq(users.id, ownerAccountId))
            .limit(2)
        ).map((row) => ({
          id: row.id,
          accountStatus: row.accountStatus,
          closureFenced: row.fence !== null,
        }));
  return { applicationRows, ownerAccountId, owners };
}

async function readUsdLedger(tx: Tx, accountId: string) {
  const balances = await tx
    .select({
      accountId: accountBalances.accountId,
      currency: accountBalances.currency,
      purchasedBalance: sql<string>`${accountBalances.purchasedBalance}::text`,
      promotionalBalance: sql<string>`${accountBalances.promotionalBalance}::text`,
      reservedBalance: sql<string>`${accountBalances.reservedBalance}::text`,
    })
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, "USD")))
    .limit(2);

  // `balance = Σ(destination) − Σ(source)` over the account's USD journal.
  const rows = await tx.execute<{
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
        where g.account_id = ${accountId} and g.currency = 'USD'
          and g.kind = 'promotional_grant') as promotional_grant_entries
    from billing_ledger_entries e
    join billing_ledger_postings p on p.entry_id = e.id
    where e.account_id = ${accountId} and e.currency = 'USD'
  `);
  const journals: JevJournalRow[] = rows.map((row) => ({
    accountId,
    currency: "USD",
    purchasedFunds: row.purchased_funds,
    promotionalFunds: row.promotional_funds,
    reservedFunds: row.reserved_funds,
    promotionalGrantEntries: Number(row.promotional_grant_entries),
  }));
  return { balances, journals };
}

async function readback(): Promise<boolean> {
  // Refuse before connecting if the pinned handle does not derive from the role.
  const mentionCredentialId = deriveJevMentionWorkloadCredentialId();

  await connectPostgres();
  try {
    const result = await getDb().transaction(async (tx) => {
      // This must be the first transaction statement, before ANY read.
      await tx.execute(
        sql`set transaction isolation level repeatable read, read only`,
      );
      const readOnlyRows = await tx.execute<{ transaction_read_only: string }>(
        sql`show transaction_read_only`,
      );
      const isolationRows = await tx.execute<{ transaction_isolation: string }>(
        sql`show transaction_isolation`,
      );
      const transactionReadOnly =
        readOnlyRows.length === 1 &&
        readOnlyRows[0]?.transaction_read_only === "on";
      const transactionIsolation =
        isolationRows.length === 1
          ? (isolationRows[0]?.transaction_isolation ?? "")
          : "";
      if (!transactionReadOnly) {
        throw new JevPrincipalsReadbackError(
          "PostgreSQL did not confirm a read-only transaction",
        );
      }
      if (transactionIsolation !== INBOX_PRINCIPAL_READBACK_ISOLATION) {
        throw new JevPrincipalsReadbackError(
          "PostgreSQL did not confirm a repeatable-read transaction",
        );
      }

      const [clock] = await tx.execute<{ observed_at: string }>(
        sql`select now()::text as observed_at`,
      );
      const observedAt = new Date(clock?.observed_at ?? "");

      // ---- Mention -----------------------------------------------------------
      const mentionApp = await readApplication(tx, JEV_MENTION_APPLICATION_ID);
      const bindings = await tx
        .select({
          id: applicationWorkloadIdentities.id,
          applicationId: applicationWorkloadIdentities.applicationId,
          provider: applicationWorkloadIdentities.provider,
          subject: applicationWorkloadIdentities.subject,
          scopes: applicationWorkloadIdentities.scopes,
          expiresAt: applicationWorkloadIdentities.expiresAt,
        })
        .from(applicationWorkloadIdentities)
        .where(
          and(
            eq(applicationWorkloadIdentities.provider, JEV_MENTION_WORKLOAD_PROVIDER),
            eq(applicationWorkloadIdentities.subject, JEV_MENTION_WORKLOAD_ROLE_ARN),
          ),
        )
        .limit(2);
      const mentionCredentials = await tx
        .select(credentialMetadata)
        .from(applicationCredentials)
        .where(eq(applicationCredentials.id, mentionCredentialId))
        .limit(2);

      // The canonical resolver, on THIS transaction, so it reads the same
      // snapshot and follows ancestors exactly as spending does.
      const billing =
        mentionApp.ownerAccountId === undefined
          ? null
          : await resolveBillingAccount(tx, mentionApp.ownerAccountId);
      const ledger =
        billing?.status === "resolved"
          ? await readUsdLedger(tx, billing.billingAccount.accountId)
          : { balances: [], journals: [] };

      // ---- Alia -----------------------------------------------------------
      const aliaApp = await readApplication(tx, JEV_ALIA_APPLICATION_ID);
      const aliaBindings = await tx
        .select({
          id: applicationWorkloadIdentities.id,
          applicationId: applicationWorkloadIdentities.applicationId,
          provider: applicationWorkloadIdentities.provider,
          subject: applicationWorkloadIdentities.subject,
          scopes: applicationWorkloadIdentities.scopes,
          expiresAt: applicationWorkloadIdentities.expiresAt,
        })
        .from(applicationWorkloadIdentities)
        .where(
          and(
            eq(applicationWorkloadIdentities.provider, JEV_MENTION_WORKLOAD_PROVIDER),
            eq(applicationWorkloadIdentities.subject, JEV_ALIA_WORKLOAD_ROLE_ARN),
          ),
        )
        .limit(2);
      const aliaCredentials = await tx
        .select(credentialMetadata)
        .from(applicationCredentials)
        .where(eq(applicationCredentials.id, deriveJevAliaWorkloadCredentialId()))
        .limit(2);

      // The canonical resolver, on THIS transaction, so it reads the same
      // snapshot and follows ancestors exactly as spending does.
      const aliaBilling =
        aliaApp.ownerAccountId === undefined
          ? null
          : await resolveBillingAccount(tx, aliaApp.ownerAccountId);
      const aliaLedger =
        aliaBilling?.status === "resolved"
          ? await readUsdLedger(tx, aliaBilling.billingAccount.accountId)
          : { balances: [], journals: [] };

      // The same read-only snapshot as identity. Availability is evidence only,
      // never a reservation and never authority to activate a provider.
      const [meteringSchema] = await tx.execute<{ available: boolean }>(sql`
        select to_regclass('public.inference_metered_usage') is not null as available`);
      const [capacity] = meteringSchema?.available === true
        ? await tx.execute<{ active: number; daily: number }>(sql`
            select count(*) filter (where status = 'admitted' and expires_at > now())::int as active,
              count(*) filter (where status <> 'refused' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')::int as daily
            from inference_metered_usage where application_id = ${JEV_ALIA_APPLICATION_ID}
              and environment = 'production' and economic_treatment = 'internal_metered'`)
        : [];
      const technicalMetering = { schemaAvailable: meteringSchema?.available ?? false,
        activeAdmissions: capacity?.active ?? 0, dailyAdmissions: capacity?.daily ?? 0 };

      // ---- Kaana -------------------------------------------------------------
      const kaanaApp = await readApplication(tx, JEV_KAANA_APPLICATION_ID);
      const kaanaCredentials = await tx
        .select(credentialMetadata)
        .from(applicationCredentials)
        .where(eq(applicationCredentials.applicationId, JEV_KAANA_APPLICATION_ID));

      return validateJevPrincipalsReadback({
        transactionReadOnly,
        transactionIsolation,
        observedAt,
        alia: { technicalMetering, applications: aliaApp.applicationRows, owners: aliaApp.owners, bindings: aliaBindings, credentials: aliaCredentials, billing: aliaBilling, balances: aliaLedger.balances, journals: aliaLedger.journals },
        mention: {
          applications: mentionApp.applicationRows,
          owners: mentionApp.owners,
          bindings,
          credentials: mentionCredentials,
          billing,
          balances: ledger.balances,
          journals: ledger.journals,
        },
        kaana: {
          applications: kaanaApp.applicationRows,
          owners: kaanaApp.owners,
          credentials: kaanaCredentials,
        },
      });
    });

    process.stdout.write(
      `${JEV_PRINCIPALS_READBACK_RESULT_PREFIX}${JSON.stringify(result)}\n`,
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
      error instanceof JevPrincipalsReadbackError
        ? error.message
        : "Unexpected PostgreSQL readback failure";
    process.stderr.write(`Jev principals readback failed: ${message}\n`);
    process.exitCode = 1;
  });
