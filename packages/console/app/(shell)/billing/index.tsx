import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { exactDecimalSchema } from '@oxy.so/contracts';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { PageBody } from '@/components/account-pages/PageFrame';
import {
  DefinitionRow,
  Denied,
  Muted,
  Row,
  RowList,
  Section,
} from '@/components/account-pages/Section';
import { SkeletonRows } from '@/components/account-pages/Skeletons';
import { StatusBadge } from '@/components/account-pages/StatusBadge';
import { AccountBalanceCard } from '@/components/billing/account-balance-card';
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

  return (
    <PageBody>
      {!canRead ? (
        <Denied>{t('billingPage.overview.denied')}</Denied>
      ) : (
        <>
          <Section>
            <ProvenanceBanner
              provenance={{ source: 'financial_ledger', consistency: 'authoritative' }}
            />
          </Section>

          <Section title={t('billingPage.overview.balance')}>
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
          </Section>

          <Section title={t('billingPage.overview.profile')}>
            {stateQuery.isLoading ? (
              <SkeletonRows count={1} height={72} />
            ) : state === null ? (
              <Muted>{t('billingPage.overview.noProfile')}</Muted>
            ) : (
              <View className="max-w-2xl gap-3">
                <DefinitionRow label={t('billingPage.overview.paidBy')}>
                  {payer === undefined
                    ? t('billingPage.overview.thisAccount')
                    : accountLabel(payer)}
                </DefinitionRow>
                <DefinitionRow label={t('billingPage.overview.mode')}>
                  {t(
                    state.profile.billingMode === 'prepaid'
                      ? 'billingPage.mode.prepaid'
                      : 'billingPage.mode.invoiced',
                  )}
                </DefinitionRow>
                <DefinitionRow label={t('billingPage.overview.currency')}>
                  {state.profile.currency}
                </DefinitionRow>
                <DefinitionRow label={t('billingPage.overview.status')}>
                  <StatusBadge
                    label={state.profile.status}
                    variant={state.profile.status === 'active' ? 'default' : 'secondary'}
                  />
                </DefinitionRow>
                <DefinitionRow label={t('billingPage.overview.autoRecharge')}>
                  {autoRecharge?.enabled &&
                  autoRecharge.threshold !== undefined &&
                  autoRecharge.amount !== undefined
                    ? t('billingPage.overview.autoRechargeRule', {
                        amount: formatMoney(autoRecharge.amount, state.profile.currency),
                        threshold: formatMoney(autoRecharge.threshold, state.profile.currency),
                      })
                    : t('billingPage.overview.off')}
                </DefinitionRow>
                {state.profile.billingMode === 'invoiced' && (
                  <DefinitionRow label={t('billingPage.overview.creditLimit')}>
                    {formatMoney(state.profile.creditLimit, state.profile.currency)}
                  </DefinitionRow>
                )}
              </View>
            )}

            {canManage && state?.profile.autoRecharge.enabled && (
              <View className="items-start">
                <Button
                  appearance="outline"
                  size="sm"
                  onPress={handleDisableAutoRecharge}
                  disabled={updateAutoRecharge.isPending}
                >
                  {t('billingPage.overview.turnOffAutoRecharge')}
                </Button>
              </View>
            )}
            {canManage && (
              <Text className="max-w-2xl text-xs text-muted-foreground">
                {t('billingPage.overview.modeSetByOxy')}
              </Text>
            )}
          </Section>

          <Section
            title={t('billingPage.overview.paymentTitle')}
            description={t('billingPage.overview.paymentBody')}
            action={
              canManage ? (
                <View className="flex-row gap-2">
                  <Button appearance="outline" size="sm" onPress={() => setShowTopUp(true)}>
                    {t('billingPage.overview.addFunds')}
                  </Button>
                  <Button
                    appearance="outline"
                    size="sm"
                    onPress={handlePortal}
                    disabled={portal.isPending}
                  >
                    {portal.isPending
                      ? t('billingPage.overview.opening')
                      : t('billingPage.overview.openPortal')}
                  </Button>
                </View>
              ) : undefined
            }
          >
            <Text className="text-sm font-medium text-foreground">
              {t('billingPage.overview.invoices')}
            </Text>
            {invoicesQuery.isLoading ? (
              <SkeletonRows count={1} height={48} />
            ) : invoices.length === 0 ? (
              <Muted>{t('billingPage.overview.noInvoices')}</Muted>
            ) : (
              <RowList>
                {invoices.map((invoice, index) => (
                  <Row key={invoice.id} first={index === 0}>
                    <View className="min-w-0 gap-0.5">
                      <Text className="text-sm font-medium text-foreground">
                        {new Date(invoice.periodStart).toLocaleDateString()} –{' '}
                        {new Date(invoice.periodEnd).toLocaleDateString()}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {t('billingPage.overview.charges', { count: invoice.receiptCount })}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-3">
                      <Text
                        className="text-sm text-foreground"
                        style={{ fontVariant: ['tabular-nums'] }}
                      >
                        {formatMoney(invoice.totalAmount, invoice.currency)}
                      </Text>
                      <StatusBadge
                        label={invoice.status}
                        variant={invoice.status === 'paid' ? 'default' : 'secondary'}
                      />
                    </View>
                  </Row>
                ))}
              </RowList>
            )}
          </Section>

          <Section title={t('billingPage.overview.recentAuto')} last>
            {attemptsQuery.isLoading ? (
              <SkeletonRows count={1} height={48} />
            ) : attempts.length === 0 ? (
              <Muted>{t('billingPage.overview.noAuto')}</Muted>
            ) : (
              <RowList>
                {attempts.map((attempt, index) => (
                  <Row key={attempt.id} first={index === 0}>
                    <View className="min-w-0 gap-0.5">
                      <Text
                        className="text-sm font-medium text-foreground"
                        style={{ fontVariant: ['tabular-nums'] }}
                      >
                        {formatMoney(attempt.requestedAmount, attempt.currency)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {t('billingPage.overview.triggeredAt', {
                          balance: formatMoney(attempt.balanceAtTrigger, attempt.currency),
                          when: new Date(attempt.createdAt).toLocaleString(),
                        })}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-3">
                      {attempt.failureCode !== undefined && (
                        <Text className="font-mono text-xs text-muted-foreground">
                          {attempt.failureCode}
                        </Text>
                      )}
                      <StatusBadge
                        label={attempt.status}
                        variant={
                          attempt.status === 'succeeded'
                            ? 'default'
                            : attempt.status === 'failed'
                              ? 'destructive'
                              : 'secondary'
                        }
                      />
                    </View>
                  </Row>
                ))}
              </RowList>
            )}
          </Section>
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
        <View className="gap-2 py-2">
          <TextFieldInput
            label={t('billingPage.overview.amount')}
            value={topUpAmount}
            inputMode="decimal"
            placeholder="50.00"
            onChangeText={setTopUpAmount}
          />
          {topUpError !== null && <Text className="text-sm text-destructive">{topUpError}</Text>}
        </View>
      </Dialog>
    </PageBody>
  );
}
