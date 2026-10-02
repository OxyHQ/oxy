import { resolveEconomicTreatment } from '../config/inferenceEconomicPolicy';
import { canonicalWorkloadSubject } from "../services/workloadIdentityBinding.service";
import { workloadAttestationHandle } from "../services/workloadAttestation.service";
import { intersectScopes, workloadBindingScopes } from "../utils/applicationScopes";
import { isCredentialUsable } from "../utils/credentialUsability";
import { isTrustedApplication } from "../utils/trustedApplication";
import {
  INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD,
  INBOX_PRINCIPAL_READBACK_CURRENCY,
  INBOX_PRINCIPAL_READBACK_ISOLATION,
  formatExactUsd,
  parseExactUsd,
} from "./inboxPrincipalReadback";

/**
 * Pure validation for the metadata-only Jev principals readback
 * (`packages/api/scripts/readback-jev-principals.ts`).
 *
 * Two fixed principals, read in ONE `REPEATABLE READ, READ ONLY` snapshot:
 *
 *  - Mention, attested by its exact ECS task role. The binding, its
 *    materialised `workload` credential and the application are judged with
 *    the same rules `resolveLiveAgencyWorkloadByHandle` applies, and its
 *    funds with the account `resolveBillingAccount` actually charges.
 *  - Kaana, whose existing credentials are inspected as metadata only.
 *
 * A `ready` result is evidence for review. It grants nothing and approves no
 * dispatch, canary or provider activation.
 */

export const JEV_PRINCIPALS_READBACK_RESULT_PREFIX = "JEV_PRINCIPALS_READBACK_RESULT=";

export const JEV_MENTION_APPLICATION_ID = "6a2f851751b784a86fd0e916";
export const JEV_MENTION_WORKLOAD_PROVIDER = "aws-iam";
export const JEV_MENTION_WORKLOAD_ROLE_ARN =
  "arn:aws:iam::237343248947:role/oxy-mention-task";
/**
 * The handle the role derives to. Pinned so a reviewer can compare it with a
 * token's `credentialId`; the validator re-derives it through the canonical
 * service utilities and refuses to run if the two ever disagree.
 */
export const JEV_MENTION_WORKLOAD_CREDENTIAL_ID = "wl_d61be5cd068abb658ed4d193";

export const JEV_KAANA_APPLICATION_ID = "68b7c4e19f2a6d0e3c8b5174";

export const JEV_ALIA_APPLICATION_ID = "6a2f851751b784a86fd0e934";
export const JEV_ALIA_WORKLOAD_ROLE_ARN = "arn:aws:iam::237343248947:role/oxy-alia-task";
export function deriveJevAliaWorkloadCredentialId(): string {
  return workloadAttestationHandle(canonicalWorkloadSubject("aws-iam", JEV_ALIA_WORKLOAD_ROLE_ARN));
}

const INVOKE_SCOPE = "inference:invoke";

export interface JevApplicationRow {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly isOfficial: boolean;
  readonly isInternal: boolean;
  readonly scopes: readonly string[];
  readonly ownerAccountId: string;
}

export interface JevOwnerRow {
  readonly id: string;
  readonly accountStatus: string;
  readonly closureFenced: boolean;
}

/** `application_workload_identities`, selected by exact provider + subject. */
export interface JevWorkloadBindingRow {
  readonly id: string;
  readonly applicationId: string;
  readonly provider: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
}

/** `application_credentials` metadata only: never a key, secret, hash or name. */
export interface JevCredentialRow {
  readonly id: string;
  readonly applicationId: string;
  readonly type: string;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly workloadIdentityId: string | null;
}

/** `resolveBillingAccount(tx, owner)`, verbatim. */
export type JevBillingResolution =
  | {
      readonly status: "resolved";
      readonly billingAccount: {
        readonly accountId: string;
        readonly currency: string;
        readonly billingMode: string;
      };
    }
  | { readonly status: "not-provisioned"; readonly accountId: string };

export interface JevBalanceRow {
  readonly accountId: string;
  readonly currency: string;
  readonly purchasedBalance: string;
  readonly promotionalBalance: string;
  readonly reservedBalance: string;
}

export interface JevJournalRow {
  readonly accountId: string;
  readonly currency: string;
  readonly purchasedFunds: string;
  readonly promotionalFunds: string;
  readonly reservedFunds: string;
  readonly promotionalGrantEntries: number;
}

export interface JevPrincipalsReadbackInput {
  readonly transactionReadOnly: boolean;
  readonly transactionIsolation: string;
  readonly observedAt: Date;
  readonly alia?: JevPrincipalsReadbackInput["mention"] & {
    readonly technicalMetering?: { readonly schemaAvailable: boolean; readonly activeAdmissions: number; readonly dailyAdmissions: number };
  };
  readonly mention: {
    readonly applications: readonly JevApplicationRow[];
    readonly owners: readonly JevOwnerRow[];
    readonly bindings: readonly JevWorkloadBindingRow[];
    readonly credentials: readonly JevCredentialRow[];
    readonly billing: JevBillingResolution | null;
    readonly balances: readonly JevBalanceRow[];
    readonly journals: readonly JevJournalRow[];
  };
  readonly kaana: {
    readonly applications: readonly JevApplicationRow[];
    readonly owners: readonly JevOwnerRow[];
    readonly credentials: readonly JevCredentialRow[];
  };
}

export const JEV_PRINCIPALS_BLOCKED_REASONS = [
  "mention_application_missing",
  "mention_application_inactive",
  "mention_application_untrusted",
  "mention_owner_missing",
  "mention_owner_inactive",
  "mention_binding_missing",
  "mention_binding_wrong_application",
  "mention_binding_expired",
  "mention_credential_missing",
  "mention_credential_not_workload",
  "mention_credential_wrong_application",
  "mention_credential_unbound",
  "mention_credential_inactive",
  "mention_credential_expired",
  "mention_effective_invoke_missing",
  "mention_billing_not_provisioned",
  "mention_billing_currency_not_usd",
  "mention_balance_missing",
  "mention_ledger_projection_mismatch",
  "mention_promotional_grant_missing",
  "mention_missing_funds",
  "kaana_application_missing",
  "kaana_application_inactive",
  "kaana_owner_missing",
  "kaana_owner_inactive",
  "kaana_invoke_credential_missing",
] as const;

export type JevPrincipalsBlockedReason = (typeof JEV_PRINCIPALS_BLOCKED_REASONS)[number];

export interface JevCredentialSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly usable: boolean;
  readonly effectiveInferenceInvoke: boolean;
}

export interface JevPrincipalsReadbackResult {
  readonly schemaVersion: 1 | 2;
  readonly status: "ready" | "blocked";
  readonly blockedReasons: readonly JevPrincipalsBlockedReason[];
  readonly database: {
    readonly engine: "postgresql";
    readonly transactionReadOnly: true;
    readonly transactionIsolation: typeof INBOX_PRINCIPAL_READBACK_ISOLATION;
    readonly writes: 0;
  };
  readonly alia?: JevPrincipalsReadbackResult["mention"] & { readonly status: "ready" | "blocked"; readonly blockedReasons: readonly string[];
    readonly economicTreatment: "commercial" | "internal_metered";
    readonly economicPolicyVersion: string;
    readonly commercialFundingRequired: boolean;
    readonly technicalMetering: { readonly schemaAvailable: boolean; readonly activeAdmissions: number | null;
      readonly dailyAdmissions: number | null; readonly maxInFlight: number | null; readonly maxRequestsPerDay: number | null };
    readonly providerActivationAuthorized: false;
  };
  readonly mention: {
    readonly applicationId: string;
    readonly ownerAccountId: string | null;
    readonly workloadCredentialId: string;
    readonly bindingId: string | null;
    readonly effectiveInferenceInvoke: boolean;
    readonly billing: {
      readonly provisioned: boolean;
      readonly billingAccountId: string | null;
      readonly inheritedFromAncestor: boolean | null;
      readonly accountMode: "prepaid" | "invoiced" | null;
      readonly currency: "USD";
      readonly purchasedUsd: string | null;
      readonly promotionalUsd: string | null;
      readonly reservedUsd: string | null;
      readonly promotionalAfterReservesUsd: string | null;
      readonly minimumPromotionalUsd: typeof INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD;
      readonly ledgerReconciled: boolean;
    };
  };
  readonly kaana: {
    readonly applicationId: string;
    readonly ownerAccountId: string | null;
    readonly usableInvokeCredentialCount: number;
    readonly credentials: readonly JevCredentialSummary[];
  };
}

export class JevPrincipalsReadbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevPrincipalsReadbackError";
  }
}

function fail(message: string): never {
  throw new JevPrincipalsReadbackError(message);
}

function onlyRow<T>(rows: readonly T[], description: string): T | undefined {
  if (rows.length > 1) fail(`Expected at most one ${description} row`);
  return rows[0];
}

function isLiveAt(expiresAt: Date | null, observedAt: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > observedAt.getTime();
}

/**
 * Re-derive the Mention handle through the canonical service utilities: the
 * binding writer's `canonicalWorkloadSubject` and the mint's
 * `workloadAttestationHandle`. A mismatch is a source defect, not a state.
 */
export function deriveJevMentionWorkloadCredentialId(): string {
  const subject = canonicalWorkloadSubject(
    JEV_MENTION_WORKLOAD_PROVIDER,
    JEV_MENTION_WORKLOAD_ROLE_ARN,
  );
  if (subject !== JEV_MENTION_WORKLOAD_ROLE_ARN) {
    fail("The pinned Mention role ARN is not canonical");
  }
  const handle = workloadAttestationHandle(subject);
  if (handle !== JEV_MENTION_WORKLOAD_CREDENTIAL_ID) {
    fail("The pinned Mention workload credential does not derive from its role");
  }
  return handle;
}

function checkApplication(
  application: JevApplicationRow | undefined,
  expectedId: string,
): void {
  if (application !== undefined && application.id !== expectedId) {
    fail("An application row is not its fixed primary key");
  }
}

function checkOwner(
  owner: JevOwnerRow | undefined,
  application: JevApplicationRow | undefined,
): void {
  if (owner !== undefined && owner.id !== application?.ownerAccountId) {
    fail("An owner row does not match its application's owner account");
  }
}

function validateWorkloadReadback(
  input: JevPrincipalsReadbackInput,
  target: { app: string; role: string; handle: () => string; requireCommercialFunding?: boolean } = { app: JEV_MENTION_APPLICATION_ID, role: JEV_MENTION_WORKLOAD_ROLE_ARN, handle: deriveJevMentionWorkloadCredentialId },
): JevPrincipalsReadbackResult {
  if (input.transactionReadOnly !== true) {
    fail("PostgreSQL did not confirm a read-only transaction");
  }
  if (input.transactionIsolation !== INBOX_PRINCIPAL_READBACK_ISOLATION) {
    fail("PostgreSQL did not confirm a repeatable-read transaction");
  }
  if (Number.isNaN(input.observedAt.getTime())) {
    fail("The PostgreSQL observation time is invalid");
  }
  const handle = target.handle();
  const reasons = new Set<JevPrincipalsBlockedReason>();
  const now = input.observedAt;

  // ---- Mention: application, owner -----------------------------------------
  const mention = input.mention;
  const mentionApp = onlyRow(mention.applications, "Mention application");
  checkApplication(mentionApp, target.app);
  const mentionOwner = onlyRow(mention.owners, "Mention owner");
  checkOwner(mentionOwner, mentionApp);
  if (mentionApp === undefined) {
    reasons.add("mention_application_missing");
  } else {
    if (mentionApp.status !== "active") reasons.add("mention_application_inactive");
    if (!isTrustedApplication(mentionApp as Parameters<typeof isTrustedApplication>[0])) {
      reasons.add("mention_application_untrusted");
    }
    if (mentionOwner === undefined) {
      reasons.add("mention_owner_missing");
    } else if (mentionOwner.accountStatus !== "active" || mentionOwner.closureFenced) {
      reasons.add("mention_owner_inactive");
    }
  }

  // ---- Mention: binding (exact provider + subject; unique) ------------------
  const binding = onlyRow(mention.bindings, "Mention workload binding");
  if (
    binding !== undefined &&
    (binding.provider !== JEV_MENTION_WORKLOAD_PROVIDER ||
      binding.subject !== target.role)
  ) {
    fail("The binding row is not the exact Mention provider and subject");
  }
  if (binding === undefined) {
    reasons.add("mention_binding_missing");
  } else {
    if (binding.applicationId !== target.app) {
      reasons.add("mention_binding_wrong_application");
    }
    if (!isLiveAt(binding.expiresAt, now)) reasons.add("mention_binding_expired");
  }

  // ---- Mention: the materialised workload credential ------------------------
  const credential = onlyRow(mention.credentials, "Mention workload credential");
  if (credential !== undefined && credential.id !== handle) {
    fail("The credential row is not the derived Mention workload credential");
  }
  if (credential === undefined) {
    reasons.add("mention_credential_missing");
  } else {
    if (credential.type !== "workload") reasons.add("mention_credential_not_workload");
    if (credential.applicationId !== target.app) {
      reasons.add("mention_credential_wrong_application");
    }
    if (binding === undefined || credential.workloadIdentityId !== binding.id) {
      reasons.add("mention_credential_unbound");
    }
    // The service reads neither for a workload row; a revoked or expired one
    // is still refused here rather than trusted.
    if (credential.status !== "active") {
      reasons.add("mention_credential_inactive");
    } else if (!isLiveAt(credential.expiresAt, now)) {
      reasons.add("mention_credential_expired");
    }
  }

  // Authority: the binding's scopes against the application's, through the
  // one definition the mint and the live ceiling share. A workload row holds
  // no scopes of its own (its CHECK keeps them empty), so it narrows nothing;
  // it must exist, be bound and be live, which is checked above.
  const mentionInvoke =
    mentionApp !== undefined &&
    binding !== undefined &&
    binding.applicationId === mentionApp.id &&
    workloadBindingScopes(binding.scopes, mentionApp.scopes).includes(INVOKE_SCOPE);
  if (!mentionInvoke) reasons.add("mention_effective_invoke_missing");

  // ---- Mention: the account resolveBillingAccount charges -------------------
  const billing = mention.billing;
  if (billing !== null && billing.status === "not-provisioned" && billing.accountId !== mentionApp?.ownerAccountId) {
    fail("The billing resolution was not asked for the Mention owner");
  }
  const billingAccount = billing?.status === "resolved" ? billing.billingAccount : undefined;
  const balance = onlyRow(mention.balances, "Mention billing balance");
  const journal = onlyRow(mention.journals, "Mention billing journal");
  for (const row of [balance, journal]) {
    if (row !== undefined && (billingAccount === undefined || row.accountId !== billingAccount.accountId)) {
      fail("A balance or journal row is not the resolved billing account's");
    }
    if (row !== undefined && row.currency !== INBOX_PRINCIPAL_READBACK_CURRENCY) {
      fail("A balance or journal row is not the USD row that was asked for");
    }
  }

  let accountMode: "prepaid" | "invoiced" | null = null;
  let purchased: bigint | null = null;
  let promotional: bigint | null = null;
  let reserved: bigint | null = null;
  let promotionalAfterReserves: bigint | null = null;
  let ledgerReconciled = false;
  if (target.requireCommercialFunding !== false && mentionApp !== undefined && billingAccount === undefined) {
    reasons.add("mention_billing_not_provisioned");
  }
  if (target.requireCommercialFunding !== false && billingAccount !== undefined) {
    if (billingAccount.billingMode === "prepaid" || billingAccount.billingMode === "invoiced") {
      accountMode = billingAccount.billingMode;
    } else {
      fail("The billing account carries an unknown billing mode");
    }
    if (billingAccount.currency !== INBOX_PRINCIPAL_READBACK_CURRENCY) {
      reasons.add("mention_billing_currency_not_usd");
    }
    if (balance === undefined) {
      reasons.add("mention_balance_missing");
    } else {
      purchased = parseExactUsd(balance.purchasedBalance);
      promotional = parseExactUsd(balance.promotionalBalance);
      reserved = parseExactUsd(balance.reservedBalance);
      const zero = parseExactUsd("0");
      if (purchased < zero || promotional < zero || reserved < zero) {
        fail("A projected balance bucket is negative");
      }
      // Grant only: the whole reserve is charged against it, and purchased
      // money and an invoiced credit line never fund this proof.
      promotionalAfterReserves = promotional - reserved;
      ledgerReconciled =
        journal !== undefined &&
        parseExactUsd(journal.purchasedFunds) === purchased &&
        parseExactUsd(journal.promotionalFunds) === promotional &&
        parseExactUsd(journal.reservedFunds) === reserved;
      if (!ledgerReconciled) reasons.add("mention_ledger_projection_mismatch");
      if (journal === undefined || journal.promotionalGrantEntries < 1) {
        reasons.add("mention_promotional_grant_missing");
      }
      if (promotionalAfterReserves < parseExactUsd(INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD)) {
        reasons.add("mention_missing_funds");
      }
    }
  }

  // ---- Kaana: metadata of every existing credential -------------------------
  const kaana = input.kaana;
  const kaanaApp = onlyRow(kaana.applications, "Kaana application");
  checkApplication(kaanaApp, JEV_KAANA_APPLICATION_ID);
  const kaanaOwner = onlyRow(kaana.owners, "Kaana owner");
  checkOwner(kaanaOwner, kaanaApp);
  if (kaanaApp === undefined) {
    reasons.add("kaana_application_missing");
  } else {
    if (kaanaApp.status !== "active") reasons.add("kaana_application_inactive");
    if (kaanaOwner === undefined) {
      reasons.add("kaana_owner_missing");
    } else if (kaanaOwner.accountStatus !== "active" || kaanaOwner.closureFenced) {
      reasons.add("kaana_owner_inactive");
    }
  }
  const kaanaCredentials = kaana.credentials.map((row): JevCredentialSummary => {
    if (row.applicationId !== JEV_KAANA_APPLICATION_ID) {
      fail("A Kaana credential row belongs to another application");
    }
    const usable =
      row.status === "active" &&
      isLiveAt(row.expiresAt, now) &&
      isCredentialUsable({
        status: row.status as Parameters<typeof isCredentialUsable>[0]["status"],
        expiresAt: row.expiresAt,
      });
    const effectiveInferenceInvoke =
      usable &&
      kaanaApp !== undefined &&
      kaanaApp.status === "active" &&
      intersectScopes(row.scopes, kaanaApp.scopes).includes(INVOKE_SCOPE);
    return { id: row.id, type: row.type, status: row.status, usable, effectiveInferenceInvoke };
  });
  const usableInvokeCredentialCount = kaanaCredentials.filter(
    (row) => row.effectiveInferenceInvoke,
  ).length;
  if (usableInvokeCredentialCount === 0) reasons.add("kaana_invoke_credential_missing");

  const blockedReasons = JEV_PRINCIPALS_BLOCKED_REASONS.filter((reason) => reasons.has(reason));
  const usd = (units: bigint | null) => (units === null ? null : formatExactUsd(units));

  return {
    schemaVersion: 1,
    status: blockedReasons.length === 0 ? "ready" : "blocked",
    blockedReasons,
    database: {
      engine: "postgresql",
      transactionReadOnly: true,
      transactionIsolation: INBOX_PRINCIPAL_READBACK_ISOLATION,
      writes: 0,
    },
    mention: {
      applicationId: target.app,
      ownerAccountId: mentionOwner?.id ?? null,
      workloadCredentialId: handle,
      bindingId: binding?.id ?? null,
      effectiveInferenceInvoke: mentionInvoke,
      billing: {
        provisioned: billingAccount !== undefined && balance !== undefined,
        billingAccountId: billingAccount?.accountId ?? null,
        inheritedFromAncestor:
          billingAccount === undefined || mentionApp === undefined
            ? null
            : billingAccount.accountId !== mentionApp.ownerAccountId,
        accountMode,
        currency: INBOX_PRINCIPAL_READBACK_CURRENCY,
        purchasedUsd: usd(purchased),
        promotionalUsd: usd(promotional),
        reservedUsd: usd(reserved),
        promotionalAfterReservesUsd: usd(promotionalAfterReserves),
        minimumPromotionalUsd: INBOX_PRINCIPAL_MINIMUM_PROMOTIONAL_USD,
        ledgerReconciled,
      },
    },
    kaana: {
      applicationId: JEV_KAANA_APPLICATION_ID,
      ownerAccountId: kaanaOwner?.id ?? null,
      usableInvokeCredentialCount,
      credentials: kaanaCredentials,
    },
  };
}

/** Each candidate remains a distinct existing application's proof, never a transferable grant. */
export function validateJevPrincipalsReadback(input: JevPrincipalsReadbackInput): JevPrincipalsReadbackResult {
  const result = validateWorkloadReadback(input);
  if (input.alia === undefined) return result;
  const app = onlyRow(input.alia.applications, "Alia application");
  const economics = resolveEconomicTreatment({ lane: 'service_token', applicationId: JEV_ALIA_APPLICATION_ID,
    environment: 'production', applicationIsInternal: app?.isInternal ?? false });
  const internal = economics.treatment === 'internal_metered';
  const candidate = validateWorkloadReadback({ ...input, mention: input.alia }, {
    app: JEV_ALIA_APPLICATION_ID, role: JEV_ALIA_WORKLOAD_ROLE_ARN, handle: deriveJevAliaWorkloadCredentialId,
    requireCommercialFunding: !internal,
  });
  const blockedReasons = candidate.blockedReasons.filter(reason => reason.startsWith("mention_"))
    .map(reason => reason.replace(/^mention_/, "alia_"));
  const evidence = input.alia.technicalMetering;
  const limits = economics.treatment === 'internal_metered' ? economics.relationship.capacity : undefined;
  if (internal) {
    if (evidence?.schemaAvailable !== true) blockedReasons.push('alia_technical_metering_unavailable');
    else {
      if (!Number.isSafeInteger(evidence.activeAdmissions) || evidence.activeAdmissions < 0
        || !Number.isSafeInteger(evidence.dailyAdmissions) || evidence.dailyAdmissions < 0) fail('Invalid technical capacity measurement');
      if (limits !== undefined && evidence.activeAdmissions >= limits.maxConcurrentRequests) blockedReasons.push('alia_technical_concurrency_exhausted');
      if (limits !== undefined && evidence.dailyAdmissions >= limits.maxRequestsPerUtcDay) blockedReasons.push('alia_technical_daily_exhausted');
    }
  }
  return { ...result, schemaVersion: 2, alia: { ...candidate.mention,
    status: blockedReasons.length === 0 ? "ready" : "blocked", blockedReasons,
    economicTreatment: economics.treatment, economicPolicyVersion: economics.policyVersion,
    commercialFundingRequired: !internal, providerActivationAuthorized: false,
    technicalMetering: { schemaAvailable: evidence?.schemaAvailable ?? false,
      activeAdmissions: evidence?.activeAdmissions ?? null, dailyAdmissions: evidence?.dailyAdmissions ?? null,
      maxInFlight: limits?.maxConcurrentRequests ?? null, maxRequestsPerDay: limits?.maxRequestsPerUtcDay ?? null },
  } };
}
