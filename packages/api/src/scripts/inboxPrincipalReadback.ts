import { INBOX_APPLICATION_ID } from "../config/inboxInference";
import { intersectScopes } from "../utils/applicationScopes";
import { isCredentialUsable } from "../utils/credentialUsability";

/**
 * Pure validation for the read-only Inbox principal and financial ledger proof
 * (`packages/api/scripts/readback-inbox-principal.ts`).
 *
 * The command reads exact rows inside one PostgreSQL `READ ONLY` transaction and
 * hands them here. This module decides, and returns a deliberately small
 * allowlisted projection: opaque row IDs, USD amounts, the billing mode and
 * booleans. The credential public key, any secret or hash, scopes, names and
 * labels never reach the result.
 */

export const INBOX_PRINCIPAL_READBACK_RESULT_PREFIX =
  "INBOX_PRINCIPAL_READBACK_RESULT=";

/** The one currency this proof accepts; a non-USD profile is a blocked reason. */
export const INBOX_PRINCIPAL_READBACK_CURRENCY = "USD";

/** The promotional funds that must remain after every reserve, in USD. */
export const INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD = "0.01";

const MONEY_SCALE = 12;
// No bigint literals or `**`: this package compiles below ES2020.
const MONEY_UNIT = BigInt("1000000000000");
const ZERO = BigInt(0);

export interface InboxPrincipalCredentialRow {
  readonly id: string;
  readonly applicationId: string;
  readonly type: string;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
}

export interface InboxPrincipalApplicationRow {
  readonly id: string;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly ownerAccountId: string;
}

export interface InboxPrincipalOwnerRow {
  readonly id: string;
  readonly accountStatus: string;
}

export interface InboxPrincipalBillingProfileRow {
  readonly accountId: string;
  readonly currency: string;
  readonly billingMode: string;
  readonly status: string;
}

/** `account_balances`, amounts as PostgreSQL `numeric::text`. */
export interface InboxPrincipalBalanceRow {
  readonly accountId: string;
  readonly currency: string;
  readonly purchasedBalance: string;
  readonly promotionalBalance: string;
  readonly reservedBalance: string;
}

/**
 * The owner's USD journal, recomputed from `billing_ledger_postings` with the
 * ledger's one rule `balance = Σ(destination) − Σ(source)`.
 */
export interface InboxPrincipalJournalRow {
  readonly accountId: string;
  readonly currency: string;
  readonly purchasedFunds: string;
  readonly promotionalFunds: string;
  readonly reservedFunds: string;
  readonly promotionalGrantEntries: number;
}

export interface InboxPrincipalReadbackInput {
  /** The exact `INBOX_APPLICATION_KEY` selector. Checked, never returned. */
  readonly requestedApplicationKey: string;
  readonly transactionReadOnly: boolean;
  /** PostgreSQL `now()` of the read-only transaction. */
  readonly observedAt: Date;
  readonly credentials: readonly InboxPrincipalCredentialRow[];
  readonly applications: readonly InboxPrincipalApplicationRow[];
  readonly owners: readonly InboxPrincipalOwnerRow[];
  readonly billingProfiles: readonly InboxPrincipalBillingProfileRow[];
  readonly balances: readonly InboxPrincipalBalanceRow[];
  readonly journals: readonly InboxPrincipalJournalRow[];
}

export const INBOX_PRINCIPAL_BLOCKED_REASONS = [
  "credential_missing",
  "credential_ambiguous",
  "credential_wrong_application",
  "credential_not_service",
  "credential_inactive",
  "credential_expired",
  "application_missing",
  "application_inactive",
  "effective_invoke_missing",
  "owner_missing",
  "owner_inactive",
  "billing_profile_missing",
  "billing_profile_inactive",
  "billing_currency_not_usd",
  "balance_missing",
  "ledger_projection_mismatch",
  "promotional_grant_missing",
  "missing_funds",
] as const;

export type InboxPrincipalBlockedReason =
  (typeof INBOX_PRINCIPAL_BLOCKED_REASONS)[number];

export interface InboxPrincipalReadbackResult {
  readonly schemaVersion: 1;
  readonly status: "ready" | "blocked";
  readonly blockedReasons: readonly InboxPrincipalBlockedReason[];
  readonly database: {
    readonly engine: "postgresql";
    readonly transactionReadOnly: true;
    readonly writes: 0;
  };
  readonly credentialId: string | null;
  readonly applicationId: string;
  readonly ownerAccountId: string | null;
  readonly effectiveInferenceInvoke: boolean;
  readonly billing: {
    readonly provisioned: boolean;
    readonly accountMode: "prepaid" | "invoiced" | null;
    readonly currency: "USD";
    readonly purchasedUsd: string | null;
    readonly promotionalUsd: string | null;
    readonly reservedUsd: string | null;
    readonly promotionalAfterReservesUsd: string | null;
    readonly minimumPromotionalUsd: typeof INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD;
    readonly ledgerReconciled: boolean;
  };
}

export class InboxPrincipalReadbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxPrincipalReadbackError";
  }
}

function fail(message: string): never {
  throw new InboxPrincipalReadbackError(message);
}

/** Exact PostgreSQL `numeric::text` → integer units of 10⁻¹². Never rounds. */
export function parseExactUsd(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null || (match[3] ?? "").length > MONEY_SCALE) {
    fail("A ledger amount is not an exact decimal");
  }
  const fraction = (match[3] ?? "").padEnd(MONEY_SCALE, "0");
  const units = BigInt(match[2] ?? "0") * MONEY_UNIT + BigInt(fraction);
  return match[1] === "-" ? -units : units;
}

/** Units of 10⁻¹² → a decimal string with at least two fraction digits. */
export function formatExactUsd(units: bigint): string {
  const negative = units < ZERO;
  const magnitude = negative ? -units : units;
  const whole = magnitude / MONEY_UNIT;
  const fraction = (magnitude % MONEY_UNIT)
    .toString()
    .padStart(MONEY_SCALE, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function onlyRow<T>(rows: readonly T[], description: string): T | undefined {
  if (rows.length > 1) fail(`Expected at most one ${description} row`);
  return rows[0];
}

/**
 * Decide whether the exact Inbox principal can pay for `inference:invoke` from
 * granted credit alone.
 *
 * Funds are judged conservatively: only `promotional_balance` counts, the
 * WHOLE `reserved_balance` is charged against it (even though a hold already
 * drew from it), and purchased money is reported separately and never counted.
 */
export function validateInboxPrincipalReadback(
  input: InboxPrincipalReadbackInput,
): InboxPrincipalReadbackResult {
  const key = input.requestedApplicationKey;
  if (key.length === 0 || key.trim() !== key) {
    fail("INBOX_APPLICATION_KEY must be exact and contain no edge whitespace");
  }
  if (input.transactionReadOnly !== true) {
    fail("PostgreSQL did not confirm a read-only transaction");
  }
  if (Number.isNaN(input.observedAt.getTime())) {
    fail("The PostgreSQL observation time is invalid");
  }

  const reasons = new Set<InboxPrincipalBlockedReason>();

  // Credential: exactly one row for the exact public key, and only that row.
  let credential: InboxPrincipalCredentialRow | undefined;
  if (input.credentials.length === 0) {
    reasons.add("credential_missing");
  } else if (input.credentials.length > 1) {
    reasons.add("credential_ambiguous");
  } else {
    credential = input.credentials[0];
  }
  if (credential !== undefined) {
    if (credential.applicationId !== INBOX_APPLICATION_ID) {
      reasons.add("credential_wrong_application");
    }
    if (credential.type !== "service") reasons.add("credential_not_service");
    if (credential.status !== "active") {
      reasons.add("credential_inactive");
    } else if (
      (credential.expiresAt !== null &&
        credential.expiresAt.getTime() <= input.observedAt.getTime()) ||
      !isCredentialUsable({
        status: credential.status,
        expiresAt: credential.expiresAt,
      })
    ) {
      reasons.add("credential_expired");
    }
  }

  // Application: the fixed Inbox primary key, never the credential's own.
  const application = onlyRow(input.applications, "Inbox application");
  if (application !== undefined && application.id !== INBOX_APPLICATION_ID) {
    fail("The application row is not the fixed Inbox primary key");
  }
  if (application === undefined) {
    reasons.add("application_missing");
  } else if (application.status !== "active") {
    reasons.add("application_inactive");
  }

  const effectiveInferenceInvoke =
    credential !== undefined &&
    application !== undefined &&
    credential.applicationId === application.id &&
    intersectScopes(credential.scopes, application.scopes).includes(
      "inference:invoke",
    );
  if (!effectiveInferenceInvoke) reasons.add("effective_invoke_missing");

  // Owner: the exact `applications.owner_account_id`, and only that account.
  const ownerAccountId = application?.ownerAccountId ?? null;
  const owner = onlyRow(input.owners, "owner account");
  if (owner !== undefined && owner.id !== ownerAccountId) {
    fail("The owner row does not match the application's owner account");
  }
  if (application !== undefined && owner === undefined) {
    reasons.add("owner_missing");
  } else if (owner !== undefined && owner.accountStatus !== "active") {
    reasons.add("owner_inactive");
  }

  // Billing: the owner's OWN profile, directly. Runtime spending may walk to an
  // ancestor's profile (`resolveBillingAccount`); that inherited relation is
  // not proof here. `billing_profile_missing` therefore means "no OWN profile"
  // and does NOT prove the owner has no inherited funds.
  const profile = onlyRow(input.billingProfiles, "billing profile");
  const balance = onlyRow(input.balances, "USD balance");
  const journal = onlyRow(input.journals, "USD journal");
  for (const row of [profile, balance, journal]) {
    if (row !== undefined && row.accountId !== ownerAccountId) {
      fail("A billing row does not belong to the application's owner account");
    }
  }
  for (const row of [balance, journal]) {
    if (row !== undefined && row.currency !== INBOX_PRINCIPAL_READBACK_CURRENCY) {
      fail("A balance or journal row is not the USD row that was asked for");
    }
  }

  let accountMode: "prepaid" | "invoiced" | null = null;
  if (profile === undefined) {
    reasons.add("billing_profile_missing");
  } else {
    if (profile.billingMode === "prepaid" || profile.billingMode === "invoiced") {
      accountMode = profile.billingMode;
    } else {
      fail("The billing profile carries an unknown billing mode");
    }
    if (profile.status !== "active") reasons.add("billing_profile_inactive");
    if (profile.currency !== INBOX_PRINCIPAL_READBACK_CURRENCY) {
      reasons.add("billing_currency_not_usd");
    }
  }

  let purchased: bigint | null = null;
  let promotional: bigint | null = null;
  let reserved: bigint | null = null;
  let promotionalAfterReserves: bigint | null = null;
  let ledgerReconciled = false;
  if (balance === undefined) {
    reasons.add("balance_missing");
  } else {
    purchased = parseExactUsd(balance.purchasedBalance);
    promotional = parseExactUsd(balance.promotionalBalance);
    reserved = parseExactUsd(balance.reservedBalance);
    // The table CHECKs every bucket >= 0; a negative one is a corrupt read,
    // never a balance to reason about.
    if (purchased < ZERO || promotional < ZERO || reserved < ZERO) {
      fail("A projected balance bucket is negative");
    }
    promotionalAfterReserves = promotional - reserved;

    if (journal === undefined) {
      reasons.add("ledger_projection_mismatch");
    } else {
      ledgerReconciled =
        parseExactUsd(journal.purchasedFunds) === purchased &&
        parseExactUsd(journal.promotionalFunds) === promotional &&
        parseExactUsd(journal.reservedFunds) === reserved;
      if (!ledgerReconciled) reasons.add("ledger_projection_mismatch");
    }
    if (journal === undefined || journal.promotionalGrantEntries < 1) {
      reasons.add("promotional_grant_missing");
    }
    if (
      promotionalAfterReserves <
      parseExactUsd(INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD)
    ) {
      reasons.add("missing_funds");
    }
  }

  const blockedReasons = INBOX_PRINCIPAL_BLOCKED_REASONS.filter((reason) =>
    reasons.has(reason),
  );
  const usd = (units: bigint | null) =>
    units === null ? null : formatExactUsd(units);

  return {
    schemaVersion: 1,
    status: blockedReasons.length === 0 ? "ready" : "blocked",
    blockedReasons,
    database: { engine: "postgresql", transactionReadOnly: true, writes: 0 },
    credentialId: credential?.id ?? null,
    applicationId: INBOX_APPLICATION_ID,
    ownerAccountId: owner === undefined ? null : owner.id,
    effectiveInferenceInvoke,
    billing: {
      provisioned: profile !== undefined && balance !== undefined,
      accountMode,
      currency: INBOX_PRINCIPAL_READBACK_CURRENCY,
      purchasedUsd: usd(purchased),
      promotionalUsd: usd(promotional),
      reservedUsd: usd(reserved),
      promotionalAfterReservesUsd: usd(promotionalAfterReserves),
      minimumPromotionalUsd: INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD,
      ledgerReconciled,
    },
  };
}
