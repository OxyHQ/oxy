/** Network-only subscription evidence reconciliation. Never runs inside a DB lock. */
import type Stripe from 'stripe';
import { getStripe } from '../utils/stripeClient';
import type { PaidPeriodEvidence } from './subscriptionPeriodPolicy';
import { assignPaidPeriodCredits } from './subscriptionPeriodPolicy';

export type CreditPlan = { stripePriceId: string; creditsPerMonth: number; currency: string };
export function stripeReference(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

/** Server-held key and authenticated provider account establish the namespace. */
export async function subscriptionProcessorBinding(livemode: boolean, connectedAccount?: string): Promise<string> {
  const key = process.env.STRIPE_SECRET_KEY;
  const mode = key?.match(/^(?:sk|rk)_(live|test)_/u)?.[1];
  if (!mode || typeof livemode !== 'boolean' || (mode === 'live') !== livemode) throw new Error('Stripe credential and evidence mode differ');
  const account = await getStripe().accounts.retrieve();
  if (!/^acct_[a-zA-Z0-9_]+$/u.test(account.id) || (connectedAccount && account.id !== connectedAccount)) throw new Error('Stripe provider account binding differs');
  const environment = process.env.BILLING_PROCESSOR_ENVIRONMENT ?? (process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development');
  if (!['production', 'staging', 'test', 'development'].includes(environment)) throw new Error('Unknown billing processor environment');
  if (environment === 'production' && !livemode) throw new Error('Production credit evidence requires live Stripe mode');
  return JSON.stringify(['stripe', account.id, mode, environment]);
}

export async function allInvoiceLines(invoice: Stripe.Invoice): Promise<Stripe.InvoiceLineItem[]> {
  const lines = [...invoice.lines.data]; let page = invoice.lines;
  const seen = new Set<string>();
  while (page.has_more) {
    const cursor = page.data.at(-1)?.id;
    if (!cursor || seen.has(cursor) || seen.size >= 100) throw new Error('Invoice line pagination is incomplete');
    seen.add(cursor);
    page = await getStripe().invoices.listLineItems(invoice.id, { limit: 100, starting_after: cursor });
    lines.push(...page.data);
  }
  if (new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('Invoice line identity is repeated');
  return lines;
}
/** A paid upgrade's financial period comes from its historical paid base, not current lifecycle. */
export async function paidPeriodForUpgrade(invoice: Stripe.Invoice, subscriptionId: string, plans: readonly CreditPlan[]) {
  const delivered = (await allInvoiceLines(invoice)).filter(line => line.parent?.subscription_item_details?.subscription === subscriptionId);
  if (delivered.length !== 2 || delivered.some(line => line.parent?.subscription_item_details?.proration !== true)
    || delivered[0].period.start !== delivered[1].period.start || delivered[0].period.end !== delivered[1].period.end) throw new Error('Delivered upgrade period is ambiguous');
  const end = delivered[0].period.end; const changeStart = delivered[0].period.start;
  const bases: { start: number; end: number }[] = []; let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber <= 100; pageNumber += 1) {
    if (pageNumber === 100) throw new Error('Historical base invoice pagination exceeded its bound');
    const page = await getStripe().invoices.list({ subscription: subscriptionId, status: 'paid', limit: 100,
      ...(cursor ? { starting_after: cursor } : {}) });
    for (const base of page.data) {
      if (seen.has(base.id)) throw new Error('Historical paid invoice identity repeated');
      seen.add(base.id);
      if (base.livemode !== invoice.livemode || stripeReference(base.customer) !== stripeReference(invoice.customer)
        || stripeReference(base.parent?.subscription_details?.subscription) !== subscriptionId) throw new Error('Historical invoice binding differs');
      if (!['subscription_create','subscription_cycle'].includes(base.billing_reason ?? '') || base.amount_paid <= 0) continue;
      const lines = (await allInvoiceLines(base)).filter(line => line.parent?.subscription_item_details?.subscription === subscriptionId);
      if (!lines.some(line => line.period.end === end)) continue;
      if (lines.length !== 1 || lines[0].period.start > changeStart || lines[0].period.start <= 0
        || lines[0].parent?.subscription_item_details?.proration !== false || lines[0].quantity !== 1 || lines[0].amount <= 0
        || lines[0].currency !== base.currency || base.currency !== invoice.currency
        || !plans.some(plan => plan.stripePriceId && plan.stripePriceId === stripeReference(lines[0].pricing?.price_details?.price))) throw new Error('Historical paid base is ambiguous');
      bases.push(lines[0].period);
    }
    if (!page.has_more) break;
    const next = page.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error('Historical base pagination made no progress');
    cursor = next;
  }
  if (bases.length !== 1) throw new Error('Exactly one historical paid base invoice is required');
  return { periodStart: bases[0].start, periodEnd: bases[0].end };
}

export type ReconciledCreditInvoice = { invoice: Stripe.Invoice; credits: number; kind: 'base' | 'change'; capApplied: boolean };

/** Two equal complete paginated reads reduce churn; they do not prove an atomic remote snapshot. */
export async function reconcilePaidCreditPeriod(input: { subscriptionId: string; customerId: string; livemode: boolean;
  periodStart: number; periodEnd: number; plans: readonly CreditPlan[] }): Promise<ReconciledCreditInvoice[]> {
  const read = async () => {
    const invoices: Stripe.Invoice[] = []; let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber <= 100; pageNumber += 1) {
      if (pageNumber === 100) throw new Error('Paid subscription invoice pagination exceeded its bound');
      const page = await getStripe().invoices.list({ subscription: input.subscriptionId, status: 'paid', limit: 100,
        ...(cursor ? { starting_after: cursor } : {}) });
      for (const invoice of page.data) {
        if (seen.has(invoice.id)) throw new Error('Paid invoice identity is repeated');
        seen.add(invoice.id); invoices.push(invoice);
      }
      if (!page.has_more) break;
      const next = page.data.at(-1)?.id;
      if (!next || next === cursor) throw new Error('Paid invoice pagination made no progress');
      cursor = next;
    }
    const evidence: PaidPeriodEvidence['invoices'] = [];
    const selected: Stripe.Invoice[] = [];
    for (const invoice of invoices) {
      if (invoice.status !== 'paid' || invoice.livemode !== input.livemode
        || stripeReference(invoice.customer) !== input.customerId
        || stripeReference(invoice.parent?.subscription_details?.subscription) !== input.subscriptionId) throw new Error('Paid invoice attribution differs');
      const all = await allInvoiceLines(invoice);
      const recurring = all.filter(line => line.parent?.type === 'subscription_item_details'
        && line.parent.subscription_item_details?.subscription === input.subscriptionId);
      const inPeriod = recurring.filter(line => line.period.start >= input.periodStart && line.period.end === input.periodEnd);
      if (!inPeriod.length) continue;
      if (!Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < 0) throw new Error('Invoice paid amount is invalid');
      if (invoice.amount_paid === 0) continue; // Promotions are separately declared; no implicit credit grant.
      const paidAt = invoice.status_transitions.paid_at;
      if (!Number.isSafeInteger(paidAt) || !paidAt || paidAt <= 0) throw new Error('Paid invoice has no valid payment time');
      const planFor = (line: Stripe.InvoiceLineItem) => {
        const price = stripeReference(line.pricing?.price_details?.price);
        const plan = input.plans.find(candidate => candidate.stripePriceId && candidate.stripePriceId === price);
        if (!plan || line.quantity !== 1 || invoice.currency !== plan.currency || line.currency !== invoice.currency
          || !Number.isSafeInteger(line.amount) || !Number.isSafeInteger(line.period.start) || !Number.isSafeInteger(line.period.end)) throw new Error('Invoice plan, currency, quantity or period is ambiguous');
        return plan;
      };
      if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
        if (recurring.length !== 1 || inPeriod.length !== 1 || inPeriod[0].period.start !== input.periodStart
          || inPeriod[0].parent?.subscription_item_details?.proration !== false || inPeriod[0].amount <= 0) throw new Error('Base invoice is ambiguous');
        const plan = planFor(inPeriod[0]);
        evidence.push({ invoiceId: invoice.id, paidAt, kind: 'base', oldCredits: plan.creditsPerMonth, newCredits: plan.creditsPerMonth,
          remainingStart: input.periodStart, remainingEnd: input.periodEnd });
      } else if (invoice.billing_reason === 'subscription_update') {
        if (recurring.length !== 2 || inPeriod.length !== 2 || inPeriod.some(line => line.parent?.subscription_item_details?.proration !== true)) throw new Error('Proration invoice needs one old and one new line');
        const old = inPeriod.filter(line => line.amount < 0); const next = inPeriod.filter(line => line.amount > 0);
        if (old.length !== 1 || next.length !== 1 || old[0].period.start !== next[0].period.start
          || old[0].parent?.subscription_item_details?.subscription_item !== next[0].parent?.subscription_item_details?.subscription_item) throw new Error('Proration pair attribution differs');
        const oldPlan = planFor(old[0]); const newPlan = planFor(next[0]);
        evidence.push({ invoiceId: invoice.id, paidAt, kind: 'change', oldCredits: oldPlan.creditsPerMonth, newCredits: newPlan.creditsPerMonth,
          remainingStart: next[0].period.start, remainingEnd: next[0].period.end });
      } else throw new Error('Unknown paid invoice reason in the reconciled period');
      selected.push({ ...invoice, lines: { ...invoice.lines, data: all, has_more: false } });
    }
    const assignments = assignPaidPeriodCredits({ periodStart: input.periodStart, periodEnd: input.periodEnd, invoices: evidence });
    return assignments.map(assignment => {
      const invoice = selected.find(candidate => candidate.id === assignment.invoiceId);
      if (!invoice) throw new Error('Assigned invoice evidence is unavailable');
      return { invoice, ...assignment };
    });
  };
  const first = await read(); const second = await read();
  const project = (rows: typeof first) => rows.map(row => ({ id: row.invoice.id, paidAt: row.invoice.status_transitions.paid_at,
    amount: row.invoice.amount_paid, currency: row.invoice.currency, credits: row.credits, kind: row.kind,
    lines: row.invoice.lines.data.map(line => ({ id: line.id, amount: line.amount, period: line.period,
      quantity: line.quantity, parent: line.parent, pricing: line.pricing })) }));
  if (JSON.stringify(project(first)) !== JSON.stringify(project(second))) throw new Error('Paid invoice evidence changed during reconciliation');
  return second;
}
