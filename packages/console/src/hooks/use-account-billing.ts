import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type {
  AccountBillingState,
  AutoRechargeAttempt,
  BillingInvoice,
  ProductEntitlement,
} from '@oxyhq/contracts';

// ===========================================================================
// Account-scoped billing (`/billing/accounts`, issue #972 sections 7.1/7.4/7.5).
//
// The pre-existing `/billing` routes key every read on the signed-in USER, which
// makes the billable principal an implicit personal account. Everything here
// takes the account id in the path and is authorised against THAT account's
// membership, so an organization's billing profile belongs to the organization.
//
// Nothing in this file re-derives a permission from a role: the caller's own
// `billing:read` / `billing:manage` come off the account node the API serves
// (`callerMembership.permissions`), and the pages pass the answer in.
//
// The shapes are `@oxyhq/contracts`' own — this surface, unlike the reporting
// one, publishes its contract, so there is nothing to restate here.
//
// WHAT IS NOT HERE, and where it went. `GET /billing/accounts/:id` answers who
// PAYS and on what TERMS, and deliberately no longer restates the balance:
// `/inference/reporting/accounts/:id/balance` is the single reader, and two
// balance endpoints would eventually disagree. Budgets and their threshold
// alerts moved to `/inference/reporting` for the same reason — a budget read
// there comes from the query the reservation path enforces with. Both live in
// `use-inference-reporting.ts`.
// ===========================================================================

const queryKeys = {
  state: (accountId: string) => ['account-billing', accountId] as const,
  invoices: (accountId: string) => ['account-billing-invoices', accountId] as const,
  autoRecharge: (accountId: string) => ['account-billing-auto-recharge', accountId] as const,
  entitlements: (accountId: string) => ['account-billing-entitlements', accountId] as const,
};

/**
 * Who pays for this account, what they hold, and whether the money is their own.
 *
 * Resolves to `null` when the account has no billing profile and inherits none.
 * The API answers that with `200 { data: null }` rather than a 404 on purpose —
 * a 404 would be indistinguishable from an account the caller cannot see, and
 * this is the answer the provisioning prompt is rendered from.
 */
export function useAccountBillingState(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.state(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<AccountBillingState | null>(
        'GET',
        `/billing/accounts/${accountId ?? ''}`,
        undefined,
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 15,
    retry: 1,
  });
}

/** Give the account a billing profile and a zeroed balance of its own. */
export function useProvisionAccountBilling() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      accountId,
      currency,
    }: {
      accountId: string;
      currency?: string;
    }): Promise<AccountBillingState> =>
      oxyServices.makeRequest<AccountBillingState>(
        'POST',
        `/billing/accounts/${accountId}`,
        currency === undefined ? {} : { currency },
        { retry: false }
      ),
    onSuccess: (_state, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.state(accountId) });
    },
  });
}

/**
 * Change the account's own auto-recharge settings.
 *
 * `billingMode` and `creditLimit` are deliberately absent from the input: both
 * are staff-only server-side, because an account granting itself `invoiced` mode
 * with a credit limit is an account issuing itself credit. Offering the field
 * here would produce a guaranteed 403 after a form was filled in.
 *
 * `null` clears a configured amount; omitting it leaves it alone. They are
 * different requests, and collapsing them would make turning auto-recharge off
 * impossible without re-sending the amounts it should have had.
 */
export interface AutoRechargePatch {
  readonly enabled?: boolean;
  readonly threshold?: string | null;
  readonly amount?: string | null;
}

export function useUpdateAutoRecharge() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      accountId,
      autoRecharge,
    }: {
      accountId: string;
      autoRecharge: AutoRechargePatch;
    }): Promise<unknown> =>
      oxyServices.makeRequest(
        'PATCH',
        `/billing/accounts/${accountId}`,
        { autoRecharge },
        { retry: false }
      ),
    onSuccess: (_profile, { accountId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.state(accountId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.autoRecharge(accountId) });
    },
  });
}

/** The account's own invoices — the payer's whole period of spend. */
export function useAccountInvoices(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.invoices(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<Array<BillingInvoice>>(
        'GET',
        `/billing/accounts/${accountId ?? ''}/invoices`,
        undefined,
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

/** Recent automatic top-ups, and what the sweep did with them. */
export function useAutoRechargeAttempts(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.autoRecharge(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<Array<AutoRechargeAttempt>>(
        'GET',
        `/billing/accounts/${accountId ?? ''}/auto-recharge`,
        undefined,
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

/**
 * What this account's product plan entitles it to.
 *
 * Plan allowances are integer counts and pay-as-you-go money is an exact
 * decimal, and the contract keeps them in separate sections that share no unit —
 * #972 is explicit that confusing a product subscription with pay-as-you-go
 * inference spend is the failure mode.
 */
export function useAccountEntitlements(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.entitlements(accountId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<ProductEntitlement>(
        'GET',
        `/billing/accounts/${accountId ?? ''}/entitlements`,
        undefined,
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

/**
 * Start a hosted checkout that funds the payer's prepaid balance.
 *
 * The balance is NOT credited here: it moves when the processor's webhook
 * confirms the charge, so a balance is only ever credited by the processor's own
 * confirmation. The currency is read from the profile server-side, and a body
 * naming a different one is refused rather than quietly ignored.
 */
export function useAccountTopUpCheckout() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: ({
      accountId,
      amount,
      successUrl,
      cancelUrl,
    }: {
      accountId: string;
      amount: string;
      successUrl: string;
      cancelUrl: string;
    }): Promise<{ sessionId: string; url: string }> =>
      oxyServices.makeRequest<{ sessionId: string; url: string }>(
        'POST',
        `/billing/accounts/${accountId}/checkout`,
        { amount, successUrl, cancelUrl },
        { retry: false }
      ),
  });
}

/** Payment methods, receipts and past invoices, in the processor's own portal. */
export function useAccountBillingPortal() {
  const { oxyServices } = useAuth();

  return useMutation({
    mutationFn: async ({
      accountId,
      returnUrl,
    }: {
      accountId: string;
      returnUrl: string;
    }): Promise<string> => {
      const result = await oxyServices.makeRequest<{ url: string }>(
        'POST',
        `/billing/accounts/${accountId}/portal`,
        { returnUrl },
        { retry: false }
      );
      return result.url;
    },
  });
}
