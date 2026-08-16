/**
 * The account-scoped billing surface: who pays, what they hold, what bounds
 * them, and how it reconciles against the payment processor.
 *
 * Every shape here is denominated in {@link exactDecimalSchema} — an exact
 * decimal string — for the reason `money.ts` gives at length: a JS `number`
 * cannot represent `0.1 + 0.2`, and a balance is the last place a rounding error
 * should be allowed to accumulate silently.
 *
 * ## What is NOT here, and where it is instead
 *
 * The BALANCE and the BUDGETS both live at `/inference/reporting` (#972
 * workstream 8), which owns the customer's view of what they hold and what
 * bounds them, stamped `{source, consistency}` so a reader can always tell which
 * kind of number they are looking at. This file declares who PAYS and on what
 * TERMS, plus the records that sit behind those numbers — invoices, processor
 * payments, auto-recharge attempts and reconciliation.
 *
 * The split is not cosmetic. A second balance shape here would be a second
 * answer to one question, and the pair would disagree the day one of them stops
 * accounting for an invoiced account's unused credit line — which is exactly the
 * kind of drift a customer discovers before we do.
 *
 * ## Product entitlements are NOT here
 *
 * Alia plans, their monthly allowances and the API-credit product live in
 * `entitlement.ts`, in a shape that cannot be added to a balance. #972 is
 * explicit that confusing a product subscription with pay-as-you-go inference
 * spend is the failure mode, so the two are separate types that share no field
 * and no unit.
 *
 * ## Stripe appears only as a REFERENCE
 *
 * `externalRef` names a record in the processor's database; nothing in this file
 * is derived from Stripe, and no shape here can carry a processor-computed
 * balance. The epic's invariant is that Stripe is a payment and invoicing
 * processor and not the authoritative usage ledger, so the reconciliation shapes
 * below describe a COMPARISON between two independent records rather than an
 * import of one into the other.
 *
 * Decided in: docs/adr/0014-account-billing-and-entitlements.md,
 * docs/adr/0009-usage-reservation-and-settlement.md.
 */

import { z } from 'zod';
import { oxyAccountIdSchema } from './identifiers';
import { currencyCodeSchema, exactDecimalSchema } from './money';

/* -------------------------------------------------------------------------- */
/*  Billing profile                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How an account pays.
 *
 * `prepaid` spends money it topped up in advance. `invoiced` draws against a
 * credit limit and is billed in arrears — the enterprise shape. Both settle
 * through the same ledger; the difference is only which bucket a reservation
 * draws from once the prepaid and granted balances are exhausted.
 */
export const BILLING_MODES = ['prepaid', 'invoiced'] as const;

export const billingModeSchema = z.enum(BILLING_MODES);

/** Whether the profile may currently spend at all. */
export const BILLING_PROFILE_STATUSES = ['active', 'suspended', 'closed'] as const;

export const billingProfileStatusSchema = z.enum(BILLING_PROFILE_STATUSES);

/**
 * Automatic top-up settings.
 *
 * An IMPLICATION rather than a biconditional, matching the column CHECK: the
 * two amounts may be configured before the feature is switched on, but an
 * `enabled` recharge with either missing is a setting that reads as "on" and can
 * never fire — the shape a customer discovers only when their traffic stops.
 */
export const autoRechargeSchema = z
  .object({
    enabled: z.boolean(),
    /** Recharge when the spendable balance falls below this. */
    threshold: exactDecimalSchema.optional(),
    /** How much to add. */
    amount: exactDecimalSchema.optional(),
  })
  .strict()
  .refine(
    (value) => !value.enabled || (value.threshold !== undefined && value.amount !== undefined),
    { message: 'an enabled auto-recharge must carry both a threshold and an amount' },
  );

/**
 * Which account pays for a workload, and on what terms.
 *
 * `accountId` is an Oxy account of ANY kind — personal, organization, project,
 * bot or channel — because `Application.ownerAccountId` may be any of them. It
 * is branded (`oxyAccountIdSchema`), so a delegated end-user id cannot be
 * substituted for it anywhere in this contract.
 */
export const billingProfileSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    accountId: oxyAccountIdSchema,
    currency: currencyCodeSchema,
    billingMode: billingModeSchema,
    status: billingProfileStatusSchema,
    /**
     * How far an `invoiced` account may draw before a reservation is refused.
     * Always `'0'` for a `prepaid` account, where it is not consulted at all.
     */
    creditLimit: exactDecimalSchema,
    autoRecharge: autoRechargeSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Billing state                                                             */
/* -------------------------------------------------------------------------- */

/**
 * WHO pays for an account and on what TERMS. Deliberately not how much they
 * have.
 *
 * The balance lives at `GET /inference/reporting/accounts/:accountId/balance`
 * (#972 workstream 8), which reads `account_balances` and stamps every response
 * with `{source: 'financial_ledger', consistency: 'authoritative'}`. Restating
 * those amounts here would be a second answer to one question, and the failure
 * mode of two balance endpoints is the pair disagreeing on the day one of them
 * stops accounting for the credit line.
 *
 * What this shape adds, and what nothing else carries: `billingAccountId` and
 * `inherited`. A project draws on the nearest ancestor that has a profile
 * (ADR 0014), so a Console page has to be able to say "this project spends the
 * organization's balance" — showing somebody else's money under a project's name
 * with no indication whose it is would be worse than showing nothing.
 */
export const accountBillingStateSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    accountId: oxyAccountIdSchema,
    billingAccountId: oxyAccountIdSchema,
    inherited: z.boolean(),
    profile: billingProfileSchema,
  })
  .strict();

/*
 * SPENDING LIMITS AND THEIR ALERTS ARE NOT DECLARED HERE.
 *
 * `/inference/reporting` owns the budget surface (#972 workstream 8) and
 * declares its own shapes beside the router that serves them, stamped
 * `{source, consistency}` so a reader can always tell which kind of number they
 * are looking at. A second set here would be a second answer to what a budget
 * is, on a table both would write — and the closed alert-threshold set already
 * lives once more where it is ENFORCED, as a CHECK on
 * `spending_limits.alert_threshold_bps`.
 */

/* -------------------------------------------------------------------------- */
/*  Invoices                                                                  */
/* -------------------------------------------------------------------------- */

export const BILLING_INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;

export const billingInvoiceStatusSchema = z.enum(BILLING_INVOICE_STATUSES);

/**
 * A period's charges, aggregated — the invoiced-enterprise settlement document.
 *
 * `subtotalAmount` is the EXACT sum of the receipts on the invoice, at full
 * scale; `totalAmount` is the rounded figure actually charged. The difference is
 * booked as an `invoice_rounding` ledger entry rather than discarded, because a
 * discarded remainder is money that exists in one system and not the other.
 *
 * `minorUnitExponent` is carried rather than derived from the currency code:
 * USD is 2, JPY is 0, BHD is 3, and that is not a property this platform's
 * database knows. Storing what was used keeps the invoice reproducible.
 */
export const billingInvoiceSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(64),
    accountId: oxyAccountIdSchema,
    currency: currencyCodeSchema,
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    status: billingInvoiceStatusSchema,
    subtotalAmount: exactDecimalSchema,
    totalAmount: exactDecimalSchema,
    minorUnitExponent: z.number().int().min(0).max(4),
    /** The processor's own invoice id, for reconciliation. Never an authority. */
    externalInvoiceRef: z.string().min(1).max(255).optional(),
    issuedAt: z.string().datetime().optional(),
    paidAt: z.string().datetime().optional(),
    receiptCount: z.number().int().nonnegative().safe(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Payment processor boundary                                                */
/* -------------------------------------------------------------------------- */

/** The processors this platform records payments from. */
export const EXTERNAL_PAYMENT_PROVIDERS = ['stripe'] as const;

export const externalPaymentProviderSchema = z.enum(EXTERNAL_PAYMENT_PROVIDERS);

/**
 * What kind of processor record `externalRef` names.
 *
 * Kept explicit because reconciliation compares like with like: a payment intent
 * and the invoice it paid are two records of one movement of money, and counting
 * both would double the external total.
 */
export const EXTERNAL_PAYMENT_KINDS = ['payment_intent', 'invoice'] as const;

export const externalPaymentKindSchema = z.enum(EXTERNAL_PAYMENT_KINDS);

/**
 * A processor payment that funded an Oxy balance.
 *
 * This is the reconciliation ANCHOR: one row per charge that landed in the
 * ledger, carrying both the processor's reference and the ledger entry it
 * produced. Without it, matching a Stripe charge back to a ledger entry means
 * parsing an idempotency key, and a parser is not a foreign key.
 */
export const externalPaymentSchema = z
  .object({
    id: z.string().min(1).max(64),
    accountId: oxyAccountIdSchema,
    provider: externalPaymentProviderSchema,
    externalKind: externalPaymentKindSchema,
    externalRef: z.string().min(1).max(255),
    amount: exactDecimalSchema,
    currency: currencyCodeSchema,
    ledgerEntryId: z.string().min(1).max(64),
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Lifecycle of one automatic top-up. */
export const AUTO_RECHARGE_STATUSES = ['pending', 'succeeded', 'failed'] as const;

export const autoRechargeStatusSchema = z.enum(AUTO_RECHARGE_STATUSES);

/**
 * One attempt to top an account up automatically.
 *
 * Recorded BEFORE the processor is called and keyed on the account, currency and
 * the window it fired in, so a sweep that runs twice — or two instances of it —
 * charges a customer's card once. An off-session charge is the one operation on
 * this surface where a duplicate is not merely a wrong number in a report.
 */
export const autoRechargeAttemptSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(64),
    accountId: oxyAccountIdSchema,
    currency: currencyCodeSchema,
    requestedAmount: exactDecimalSchema,
    /** The spendable balance that triggered it — why this attempt exists. */
    balanceAtTrigger: exactDecimalSchema,
    status: autoRechargeStatusSchema,
    externalRef: z.string().min(1).max(255).optional(),
    /** The processor's own decline code. Never a free-form message. */
    failureCode: z.string().min(1).max(64).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How an Oxy record and a processor record fail to agree.
 *
 * A closed set, and every member is a DIFFERENT operational problem:
 *
 *  - `missing_in_ledger` — the processor took money Oxy never credited. The
 *    customer paid and has no balance. This is the one that costs a customer.
 *  - `missing_in_external` — Oxy credited a balance with no processor charge
 *    behind it. This is the one that costs Oxy.
 *  - `amount_mismatch` — both exist and disagree.
 *  - `account_unresolved` — a processor charge whose customer maps to no Oxy
 *    account. Money arrived and nobody owns it.
 *
 * Collapsing them into a single "discrepancy" count is what makes a
 * reconciliation report a number nobody acts on.
 */
export const RECONCILIATION_DISCREPANCY_KINDS = [
  'missing_in_ledger',
  'missing_in_external',
  'amount_mismatch',
  'account_unresolved',
] as const;

export const reconciliationDiscrepancyKindSchema = z.enum(RECONCILIATION_DISCREPANCY_KINDS);

export const RECONCILIATION_RUN_STATUSES = ['running', 'completed', 'failed'] as const;

export const reconciliationRunStatusSchema = z.enum(RECONCILIATION_RUN_STATUSES);

export const reconciliationDiscrepancySchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(64),
    runId: z.string().min(1).max(64),
    kind: reconciliationDiscrepancyKindSchema,
    accountId: oxyAccountIdSchema.optional(),
    externalRef: z.string().min(1).max(255).optional(),
    ledgerEntryId: z.string().min(1).max(64).optional(),
    /** What Oxy recorded. Absent for `missing_in_ledger`. */
    ledgerAmount: exactDecimalSchema.optional(),
    /** What the processor recorded. Absent for `missing_in_external`. */
    externalAmount: exactDecimalSchema.optional(),
    currency: currencyCodeSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

/**
 * One reconciliation pass over a window.
 *
 * The totals are carried beside the discrepancy list on purpose: two totals that
 * agree while the lists differ is a real and common state (a charge recorded
 * against the wrong account), and a report that only published a difference
 * would call it clean.
 */
export const reconciliationRunSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(64),
    provider: externalPaymentProviderSchema,
    /** Absent for a platform-wide pass. */
    accountId: oxyAccountIdSchema.optional(),
    currency: currencyCodeSchema,
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    status: reconciliationRunStatusSchema,
    ledgerTotal: exactDecimalSchema,
    externalTotal: exactDecimalSchema,
    discrepancyCount: z.number().int().nonnegative().safe(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export const reconciliationReportSchema = z
  .object({
    /** See `version.ts`: this shape is served to Console and to Alia. */
    schemaVersion: z.literal(1),
    run: reconciliationRunSchema,
    discrepancies: z.array(reconciliationDiscrepancySchema),
  })
  .strict();

export type BillingMode = z.infer<typeof billingModeSchema>;
export type BillingProfileStatus = z.infer<typeof billingProfileStatusSchema>;
export type AutoRecharge = z.infer<typeof autoRechargeSchema>;
export type BillingProfile = z.infer<typeof billingProfileSchema>;
export type AccountBillingState = z.infer<typeof accountBillingStateSchema>;
export type BillingInvoiceStatus = z.infer<typeof billingInvoiceStatusSchema>;
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;
export type ExternalPaymentProvider = z.infer<typeof externalPaymentProviderSchema>;
export type ExternalPaymentKind = z.infer<typeof externalPaymentKindSchema>;
export type ExternalPayment = z.infer<typeof externalPaymentSchema>;
export type AutoRechargeStatus = z.infer<typeof autoRechargeStatusSchema>;
export type AutoRechargeAttempt = z.infer<typeof autoRechargeAttemptSchema>;
export type ReconciliationDiscrepancyKind = z.infer<typeof reconciliationDiscrepancyKindSchema>;
export type ReconciliationRunStatus = z.infer<typeof reconciliationRunStatusSchema>;
export type ReconciliationDiscrepancy = z.infer<typeof reconciliationDiscrepancySchema>;
export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
