import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { ScreenScrollView } from '@oxy.so/bloom/screen';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { exactDecimalSchema } from '@oxy.so/contracts';
import { useState } from 'react';
import { View } from 'react-native';
import { AccountBalanceCard } from '@/components/billing/account-balance-card';
import { statusBadge } from '@/components/billing/labels';
import { ProvenanceBanner } from '@/components/billing/provenance-banner';
import { accountLabel, useAccount } from '@/hooks/use-account';
import {
  useAccountBillingPortal,
  useAccountBillingState,
  useAccountInvoices,
  useAccountTopUpCheckout,
  useAutoRechargeAttempts,
  useProvisionAccountBilling,
  useUpdateAutoRecharge,
} from '@/hooks/use-account-billing';
import { useLedgerBalance } from '@/hooks/use-inference-reporting';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';

/**
 * The account's balance and billing profile.
 *
 * Everything here is ACCOUNT-scoped: the balance belongs to the account being
 * worked in, not to the signed-in user, and when that account merely inherits a
 * profile the header says whose money it is spending. Product plans and their
 * credits are a different unit and live on their own page.
 *
 * Both reads that produce money (the ledger balance and the billing profile) are
 * stamped `financial_ledger` / `authoritative` by the API.
 */
export default function BillingOverviewPage() {
  const { t } = useTranslation();
  const { accounts, currentAccount, canReadBilling, canManageBilling } = useAccount();
  const accountId = currentAccount?.accountId;
  const canRead = currentAccount !== null && canReadBilling(currentAccount);
  const canManage = currentAccount !== null && canManageBilling(currentAccount);

  const balanceQuery = useLedgerBalance(accountId, canRead);
  const stateQuery = useAccountBillingState(accountId, canRead);
  const invoicesQuery = useAccountInvoices(accountId, canRead);
  const attemptsQuery = useAutoRechargeAttempts(accountId, canRead);

  const provision = useProvisionAccountBilling();
  const checkout = useAccountTopUpCheckout();
  const portal = useAccountBillingPortal();
  const updateAutoRecharge = useUpdateAutoRecharge();

  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpError, setTopUpError] = useState<string | null>(null);

  const state = stateQuery.data ?? null;
  const payer = state?.inherited
    ? accounts.find((node) => node.accountId === state.billingAccountId)
    : undefined;
  const invoices = invoicesQuery.data ?? [];
  const attempts = attemptsQuery.data ?? [];

  const handleProvision = async () => {
    if (accountId === undefined) {
      return;
    }
    try {
      await provision.mutateAsync({ accountId });
      toast.success(t('billingPage.overview.provisioned'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.overview.provisionFailed')));
    }
  };

  const handleTopUp = async () => {
    if (accountId === undefined) {
      return;
    }
    // Parsed with the contract's own schema — the same one the ledger's NUMERIC
    // columns are declared against — so an amount that would become a float is
    // refused here rather than after the card is charged.
    const amount = exactDecimalSchema.safeParse(topUpAmount.trim());
    if (!amount.success) {
      setTopUpError(t('billingPage.overview.topUpExact'));
      return;
    }
    if (/^0+(\.0*)?$/.test(topUpAmount.trim())) {
      setTopUpError(t('billingPage.overview.topUpZero'));
      return;
    }
    setTopUpError(null);
    try {
      const result = await checkout.mutateAsync({
        accountId,
        amount: amount.data,
        successUrl: `${window.location.origin}/billing?topup=success`,
        cancelUrl: `${window.location.origin}/billing?topup=canceled`,
      });
      window.location.href = result.url;
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.overview.topUpFailed')));
    }
  };

  const handlePortal = async () => {
    if (accountId === undefined) {
      return;
    }
    try {
      const url = await portal.mutateAsync({
        accountId,
        returnUrl: `${window.location.origin}/billing`,
      });
      window.location.href = url;
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.overview.portalFailed')));
    }
  };

  const handleDisableAutoRecharge = async () => {
    if (accountId === undefined) {
      return;
    }
    try {
      await updateAutoRecharge.mutateAsync({ accountId, autoRecharge: { enabled: false } });
      toast.success(t('billingPage.overview.autoRechargeOff'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.overview.autoRechargeFailed')));
    }
  };

  const autoRecharge = state?.profile.autoRecharge;

  const profile = state?.profile;
  const autoRechargeRule =
    profile !== undefined &&
    autoRecharge?.enabled &&
    autoRecharge.threshold !== undefined &&
    autoRecharge.amount !== undefined
      ? t('billingPage.overview.autoRechargeRule', {
          amount: formatMoney(autoRecharge.amount, profile.currency),
          threshold: formatMoney(autoRecharge.threshold, profile.currency),
        })
      : t('billingPage.overview.off');

  return (
    <ScreenScrollView contentContainerClassName="gap-6 px-4 py-6 pb-12">
      {!canRead ? (
        <EmptyState icon={RiLockLine} title={t('billingPage.overview.denied')} />
      ) : (
        <>
          <ProvenanceBanner
            provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
          />

          <View className="gap-3">
            <Text variant="headline-semibold">{t('billingPage.overview.balance')}</Text>
            <AccountBalanceCard balance={balanceQuery.data} isLoading={balanceQuery.isLoading} />
            {balanceQuery.data?.provisioned === false && canManage && (
              <View className="items-start">
                <Button
                  appearance="outline"
                  size="sm"
                  onPress={handleProvision}
                  disabled={provision.isPending}
                >
                  {provision.isPending
                    ? t('billingPage.overview.creating')
                    : t('billingPage.overview.createProfile')}
                </Button>
              </View>
            )}
          </View>

          {stateQuery.isLoading ? (
            <Skeleton.Box width="100%" height={176} />
          ) : state === null || profile === undefined ? (
            <GroupedSection title={t('billingPage.overview.profile')}>
              <GroupedSectionItem title={t('billingPage.overview.noProfile')} />
            </GroupedSection>
          ) : (
            <GroupedSection
              title={t('billingPage.overview.profile')}
              footer={canManage ? t('billingPage.overview.modeSetByOxy') : undefined}
            >
              <GroupedSectionItem
                title={t('billingPage.overview.paidBy')}
                value={
                  payer === undefined ? t('billingPage.overview.thisAccount') : accountLabel(payer)
                }
              />
              <GroupedSectionItem
                title={t('billingPage.overview.mode')}
                value={t(
                  profile.billingMode === 'prepaid'
                    ? 'billingPage.mode.prepaid'
                    : 'billingPage.mode.invoiced',
                )}
              />
              <GroupedSectionItem
                title={t('billingPage.overview.currency')}
                value={profile.currency}
              />
              <GroupedSectionItem
                title={t('billingPage.overview.status')}
                rightElement={
                  <Badge
                    content={profile.status}
                    {...statusBadge(profile.status === 'active' ? 'default' : 'secondary')}
                  />
                }
              />
              <GroupedSectionItem
                title={t('billingPage.overview.autoRecharge')}
                value={autoRechargeRule}
                rightElement={
                  canManage && profile.autoRecharge.enabled ? (
                    <Button
                      appearance="outline"
                      size="sm"
                      onPress={handleDisableAutoRecharge}
                      disabled={updateAutoRecharge.isPending}
                    >
                      {t('billingPage.overview.turnOffAutoRecharge')}
                    </Button>
                  ) : undefined
                }
              />
              {profile.billingMode === 'invoiced' && (
                <GroupedSectionItem
                  title={t('billingPage.overview.creditLimit')}
                  value={formatMoney(profile.creditLimit, profile.currency)}
                />
              )}
            </GroupedSection>
          )}

          <GroupedSection
            title={t('billingPage.overview.paymentTitle')}
            footer={t('billingPage.overview.paymentBody')}
          >
            {canManage && (
              <GroupedSectionItem
                title={t('billingPage.overview.addFunds')}
                onPress={() => setShowTopUp(true)}
              />
            )}
            {canManage && (
              <GroupedSectionItem
                title={
                  portal.isPending
                    ? t('billingPage.overview.opening')
                    : t('billingPage.overview.openPortal')
                }
                disabled={portal.isPending}
                onPress={handlePortal}
              />
            )}
          </GroupedSection>

          {invoicesQuery.isLoading ? (
            <Skeleton.Box width="100%" height={96} />
          ) : invoices.length === 0 ? (
            <Muted>{t('billingPage.overview.noInvoices')}</Muted>
          ) : (
            <GroupedSection title={t('billingPage.overview.invoices')}>
              {invoices.map((invoice) => (
                <GroupedSectionItem
                  key={invoice.id}
                  title={`${new Date(invoice.periodStart).toLocaleDateString()} – ${new Date(invoice.periodEnd).toLocaleDateString()}`}
                  description={t('billingPage.overview.charges', { count: invoice.receiptCount })}
                  value={formatMoney(invoice.totalAmount, invoice.currency)}
                  rightElement={
                    <Badge
                      content={invoice.status}
                      {...statusBadge(invoice.status === 'paid' ? 'default' : 'secondary')}
                    />
                  }
                />
              ))}
            </GroupedSection>
          )}

          {attemptsQuery.isLoading ? (
            <Skeleton.Box width="100%" height={96} />
          ) : attempts.length === 0 ? (
            <Muted>{t('billingPage.overview.noAuto')}</Muted>
          ) : (
            <GroupedSection title={t('billingPage.overview.recentAuto')}>
              {attempts.map((attempt) => (
                <GroupedSectionItem
                  key={attempt.id}
                  title={formatMoney(attempt.requestedAmount, attempt.currency)}
                  description={t('billingPage.overview.triggeredAt', {
                    balance: formatMoney(attempt.balanceAtTrigger, attempt.currency),
                    when: new Date(attempt.createdAt).toLocaleString(),
                  })}
                  value={attempt.failureCode}
                  rightElement={
                    <Badge
                      content={attempt.status}
                      {...statusBadge(
                        attempt.status === 'succeeded'
                          ? 'default'
                          : attempt.status === 'failed'
                            ? 'destructive'
                            : 'secondary',
                      )}
                    />
                  }
                />
              ))}
            </GroupedSection>
          )}
        </>
      )}

      <Dialog
        open={showTopUp}
        onClose={() => setShowTopUp(false)}
        title={t('billingPage.overview.addFunds')}
        description={t('billingPage.overview.topUpDescription', {
          currency: state === null ? '' : ` (${state.profile.currency})`,
        })}
        actions={[
          { label: t('common.cancel'), color: 'cancel' },
          {
            label: checkout.isPending
              ? t('billingPage.overview.opening')
              : t('billingPage.overview.continueToPayment'),
            onPress: handleTopUp,
            disabled: checkout.isPending,
            shouldCloseOnPress: false,
          },
        ]}
      >
        <Field label={t('billingPage.overview.amount')} error={topUpError}>
          <TextFieldInput
            label={t('billingPage.overview.amount')}
            value={topUpAmount}
            inputMode="decimal"
            placeholder="50.00"
            onChangeText={setTopUpAmount}
          />
        </Field>
      </Dialog>
    </ScreenScrollView>
  );
}
