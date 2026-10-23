import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { View } from 'react-native';

import { AutoRechargeAttempts } from '@/components/billing/AutoRechargeAttempts';
import { AutoRechargeSection } from '@/components/billing/AutoRechargeSection';
import { BalanceStats } from '@/components/billing/BalanceStats';
import { OverviewSkeleton } from '@/components/billing/BillingSkeleton';
import { InvoicesTable } from '@/components/billing/InvoicesTable';
import { ProfileSection } from '@/components/billing/ProfileSection';
import { TopUpDialog } from '@/components/billing/TopUpDialog';
import { ApiState } from '@/components/loading/ApiState';
import { NoBillingAccess } from '@/components/reporting/NoBillingAccess';
import { ProvenanceBanner } from '@/components/reporting/ProvenanceBanner';
import { accountLabel, useAccount } from '@/hooks/use-account';
import {
  useAccountBillingPortal,
  useAccountBillingState,
  useAccountInvoices,
  useAutoRechargeAttempts,
  useProvisionAccountBilling,
} from '@/hooks/use-account-billing';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { useLedgerBalance } from '@/hooks/use-inference-reporting';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';

const LEDGER = { source: 'financial_ledger', consistency: 'authoritative' } as const;

/**
 * The account's balance, billing profile, automatic top-ups and invoices.
 *
 * Everything here is ACCOUNT-scoped: the balance belongs to the account being
 * worked in, and when that account inherits a profile the profile section names
 * whose money it spends. Product plans and credits are a different unit and live
 * on their own tab. An account nobody has decided who pays for is not a balance
 * of zero, so it gets a provisioning prompt instead of four empty tiles.
 */
export default function BillingOverviewPage() {
  const { t } = useTranslation();
  const { accounts } = useAccount();
  const { accountId, canRead, canManage } = useBillingAccess();

  const balance = useLedgerBalance(accountId, canRead);
  const state = useAccountBillingState(accountId, canRead);
  const invoices = useAccountInvoices(accountId, canRead);
  const attempts = useAutoRechargeAttempts(accountId, canRead);

  const provision = useProvisionAccountBilling();
  const portal = useAccountBillingPortal();
  const [topUp, setTopUp] = useState(false);

  const profile = state.data?.profile;
  const payer = state.data?.inherited
    ? accounts.find((node) => node.accountId === state.data?.billingAccountId)
    : undefined;

  const handleProvision = async () => {
    if (accountId === undefined) return;
    try {
      await provision.mutateAsync({ accountId });
      toast.success(t('billingPage.overview.provisioned'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.overview.provisionFailed')));
    }
  };

  const handlePortal = async () => {
    if (accountId === undefined) return;
    try {
      window.location.href = await portal.mutateAsync({
        accountId,
        returnUrl: `${window.location.origin}/billing`,
      });
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.overview.portalFailed')));
    }
  };

  return (
    <ScreenScrollView contentContainerClassName="gap-4 p-4 pb-12">
      {!canRead ? (
        <NoBillingAccess />
      ) : balance.isLoading ? (
        <OverviewSkeleton />
      ) : balance.isError ? (
        <ApiState error={balance.error} onRetry={() => void balance.refetch()} />
      ) : balance.data === undefined ? null : !balance.data.provisioned ? (
        <EmptyState
          icon={RiBankCardLine}
          title={t('billingPage.balance.noProfileTitle')}
          description={t('billingPage.balance.noProfileBody')}
          action={
            canManage
              ? {
                  label: t('billingPage.overview.createProfile'),
                  onPress: () => void handleProvision(),
                  loading: provision.isPending,
                }
              : undefined
          }
        />
      ) : (
        <>
          <ProvenanceBanner provenance={LEDGER} />

          {canManage ? (
            <View className="flex-row flex-wrap gap-2">
              <Button leadingIcon={RiAddLine} onPress={() => setTopUp(true)}>
                {t('billingPage.overview.addFunds')}
              </Button>
              <Button
                appearance="outline"
                leadingIcon={RiExternalLinkLine}
                loading={portal.isPending}
                onPress={() => void handlePortal()}
              >
                {t('billingPage.overview.openPortal')}
              </Button>
            </View>
          ) : null}

          <BalanceStats balance={balance.data} />

          {state.isLoading ? null : state.isError ? (
            <ApiState error={state.error} onRetry={() => void state.refetch()} />
          ) : state.data === null || state.data === undefined || profile === undefined ? (
            <EmptyState
              variant="compact"
              icon={RiBankCardLine}
              title={t('billingPage.overview.noProfile')}
            />
          ) : (
            <View className="gap-4 xl:flex-row xl:items-start">
              <View className="min-w-0 xl:flex-1">
                <ProfileSection
                  state={state.data}
                  payerName={payer === undefined ? undefined : accountLabel(payer)}
                  canManage={canManage}
                />
              </View>
              <View className="min-w-0 xl:flex-1">
                <AutoRechargeSection
                  accountId={state.data.accountId}
                  profile={profile}
                  canManage={canManage}
                />
              </View>
            </View>
          )}

          {invoices.isError ? (
            <ApiState error={invoices.error} onRetry={() => void invoices.refetch()} />
          ) : (
            <InvoicesTable invoices={invoices.data ?? []} />
          )}
          {attempts.isError ? (
            <ApiState error={attempts.error} onRetry={() => void attempts.refetch()} />
          ) : (
            <AutoRechargeAttempts attempts={attempts.data ?? []} />
          )}

          <TopUpDialog
            open={topUp}
            onClose={() => setTopUp(false)}
            accountId={balance.data.accountId}
            currency={profile?.currency}
          />
        </>
      )}
    </ScreenScrollView>
  );
}
