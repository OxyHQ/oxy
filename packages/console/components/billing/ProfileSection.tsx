import type { AccountBillingState } from '@oxy.so/contracts';
import { Chip } from '@oxy.so/bloom/chip';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';

import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';

/** Who pays for the account and on what terms: the billing profile, read-only. */
export function ProfileSection({
  state,
  payerName,
  canManage,
}: {
  state: AccountBillingState;
  /** The account that pays, when this one inherits its profile. */
  payerName: string | undefined;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { profile } = state;

  return (
    <GroupedSection
      title={t('billingPage.overview.profile')}
      footer={canManage ? t('billingPage.overview.modeSetByOxy') : undefined}
    >
      <GroupedSectionItem
        title={t('billingPage.overview.paidBy')}
        value={payerName ?? t('billingPage.overview.thisAccount')}
      />
      <GroupedSectionItem
        title={t('billingPage.overview.mode')}
        value={t(`billingPage.mode.${profile.billingMode}`)}
      />
      <GroupedSectionItem title={t('billingPage.overview.currency')} value={profile.currency} />
      <GroupedSectionItem
        title={t('billingPage.overview.status')}
        rightElement={
          <Chip size="md" hue={profile.status === 'active' ? 'lime' : 'gray'}>
            {profile.status}
          </Chip>
        }
      />
      {profile.billingMode === 'invoiced' ? (
        <GroupedSectionItem
          title={t('billingPage.overview.creditLimit')}
          value={formatMoney(profile.creditLimit, profile.currency)}
        />
      ) : null}
    </GroupedSection>
  );
}
