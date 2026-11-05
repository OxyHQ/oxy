import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { Icons } from '@/constants/icons';
import {
  Screen,
  StackHeader,
  SettingsListItem,
  LoadingState,
  STATE_MIN_HEIGHT,
} from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import {
  useGovernedOrganizations,
  useOrganizationWallet,
  type GovernedOrganization,
} from '@/hooks/organization-wallet/useOrganizationWallets';

const STATUS_KEYS = {
  none: 'organizationWallet.list.statusNone',
  held: 'organizationWallet.list.statusHeld',
  stale: 'organizationWallet.list.statusStale',
  elsewhere: 'organizationWallet.list.statusElsewhere',
} as const;

/** One organization and where its wallet stands. */
function OrganizationRow({
  organization,
  onPress,
}: {
  organization: GovernedOrganization;
  onPress: (accountId: string) => void;
}) {
  const colors = useColors();
  const { t } = useTranslation();
  const wallet = useOrganizationWallet(organization.accountId);
  const description = wallet.data
    ? t(STATUS_KEYS[wallet.data.status])
    : t('organizationWallet.list.statusUnknown');
  return (
    <SettingsListItem
      icon={<Icons.people size="md" fill={colors.text} />}
      title={organization.name}
      description={description}
      onPress={() => onPress(organization.accountId)}
      testID={`organization-wallet-${organization.accountId}`}
    />
  );
}

/**
 * Settings → Organization wallets (ADR 0061): every organization the person
 * owns or administers, each with its own Peable wallet key. The key is created
 * and kept here, in Commons; Oxy and Peable only ever see its public half.
 */
export default function OrganizationWalletsScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const organizations = useGovernedOrganizations();

  const open = useCallback(
    (accountId: string) => {
      router.push({
        pathname: '/(tabs)/(settings)/organization-wallets/[accountId]',
        params: { accountId },
      });
    },
    [router],
  );

  return (
    <Screen gap={16}>
      <StackHeader
        title={t('organizationWallet.list.title')}
        subtitle={t('organizationWallet.list.subtitle')}
        onBack={() => router.back()}
        backAccessibilityLabel={t('common.back')}
      />
      {organizations.isPending ? (
        <LoadingState />
      ) : organizations.isError ? (
        <EmptyState
          illustration={<Icons.error size="3xl" fill={colors.error} />}
          title={t('organizationWallet.list.loadError')}
          action={{
            label: t('organizationWallet.list.retry'),
            onPress: () => void organizations.refetch(),
          }}
          minHeight={STATE_MIN_HEIGHT}
        />
      ) : organizations.data.length === 0 ? (
        <EmptyState
          illustration={<Icons.people size="3xl" fill={colors.text} />}
          title={t('organizationWallet.list.empty')}
          minHeight={STATE_MIN_HEIGHT}
        />
      ) : (
        <SettingsListGroup>
          {organizations.data.map((organization) => (
            <OrganizationRow
              key={organization.accountId}
              organization={organization}
              onPress={open}
            />
          ))}
        </SettingsListGroup>
      )}
    </Screen>
  );
}
