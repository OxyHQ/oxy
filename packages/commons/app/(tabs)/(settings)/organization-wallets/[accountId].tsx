import { useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { Icons } from '@/constants/icons';
import {
  Screen,
  StackHeader,
  SettingsListItem,
  ImportantBanner,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { organizationKeyErrorKey } from '@/lib/organization-wallet';
import { shortenKey } from '@/utils/shorten-key';
import {
  useGovernedOrganizations,
  useOrganizationWallet,
} from '@/hooks/organization-wallet/useOrganizationWallets';

/**
 * One organization's Peable wallet (ADR 0061).
 *
 * - No key yet: "Set up the organization's Peable wallet" (D8) → create.
 * - This phone holds the current key: show its phrase, or replace it.
 * - Another phone holds it: add the phrase you were given (D5), or replace it.
 * - This phone holds a replaced key: add the current one; the old key's coins
 *   stay with the old phrase (Peable ADR 0002).
 */
export default function OrganizationWalletScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const wallet = useOrganizationWallet(accountId ?? null);
  const organizations = useGovernedOrganizations();
  const name =
    organizations.data?.find((organization) => organization.accountId === accountId)?.name ??
    t('organizationWallet.list.title');

  const go = useCallback(
    (screen: 'create' | 'add' | 'phrase', operation?: 'create' | 'replace') => {
      if (!accountId) return;
      router.push({
        pathname: `/(tabs)/(settings)/organization-wallets/${screen}`,
        params: operation ? { accountId, operation } : { accountId },
      });
    },
    [accountId, router],
  );

  const header = (
    <StackHeader
      title={name}
      onBack={() => router.back()}
      backAccessibilityLabel={t('common.back')}
    />
  );

  if (wallet.isPending) {
    return (
      <Screen>
        {header}
        <LoadingState title={t('organizationWallet.detail.loading')} />
      </Screen>
    );
  }
  if (wallet.isError) {
    return (
      <Screen>
        {header}
        <EmptyState
          illustration={<Icons.error size="3xl" fill={colors.error} />}
          title={t(organizationKeyErrorKey(wallet.error))}
          action={{
            label: t('organizationWallet.list.retry'),
            onPress: () => void wallet.refetch(),
          }}
          minHeight={STATE_MIN_HEIGHT}
        />
      </Screen>
    );
  }

  const { state, status } = wallet.data;
  const replace = (
    <SettingsListItem
      icon={<Icons.refresh size="md" fill={colors.text} />}
      title={t('organizationWallet.detail.replaceKey')}
      description={t('organizationWallet.detail.replaceHint')}
      onPress={() => go('create', 'replace')}
      testID="organization-wallet-replace"
    />
  );

  return (
    <Screen gap={16}>
      {header}

      {status === 'none' ? (
        <>
          <ImportantBanner type="info" title={t('organizationWallet.detail.setUpTitle')}>
            {t('organizationWallet.detail.setUpBody')}
          </ImportantBanner>
          <Button
            appearance="solid"
            tone="accent"
            onPress={() => go('create', 'create')}
            testID="organization-wallet-set-up"
          >
            {t('organizationWallet.detail.setUp')}
          </Button>
        </>
      ) : null}

      {status === 'held' ? (
        <>
          <ImportantBanner type="info" title={t('organizationWallet.detail.heldTitle')}>
            {t('organizationWallet.detail.heldBody')}
          </ImportantBanner>
          <SettingsListGroup>
            <SettingsListItem
              icon={<Icons.lock size="md" fill={colors.text} />}
              title={t('organizationWallet.detail.showPhrase')}
              onPress={() => go('phrase')}
            />
            {replace}
          </SettingsListGroup>
        </>
      ) : null}

      {status === 'elsewhere' || status === 'stale' ? (
        <>
          <ImportantBanner
            type={status === 'stale' ? 'warning' : 'info'}
            title={
              status === 'stale'
                ? t('organizationWallet.detail.staleTitle')
                : t('organizationWallet.detail.elsewhereTitle')
            }
          >
            {status === 'stale'
              ? t('organizationWallet.detail.staleBody')
              : t('organizationWallet.detail.elsewhereBody')}
          </ImportantBanner>
          <SettingsListGroup>
            <SettingsListItem
              icon={<Icons.key size="md" fill={colors.text} />}
              title={t('organizationWallet.detail.addKey')}
              onPress={() => go('add')}
              testID="organization-wallet-add"
            />
            {replace}
          </SettingsListGroup>
        </>
      ) : null}

      {state.publicKey ? (
        <SettingsListGroup title={t('organizationWallet.detail.publicKey')}>
          <SettingsListItem
            icon={<Icons.key size="md" fill={colors.text} />}
            title={shortenKey(state.publicKey)}
          />
        </SettingsListGroup>
      ) : null}
    </Screen>
  );
}
