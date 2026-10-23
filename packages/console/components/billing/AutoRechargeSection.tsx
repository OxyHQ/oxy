import type { BillingProfile } from '@oxy.so/contracts';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { useState } from 'react';

import { useTranslation } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { AutoRechargeDialog } from './AutoRechargeDialog';

/** The automatic top-up rule, and the dialog that changes it. */
export function AutoRechargeSection({
  accountId,
  profile,
  canManage,
}: {
  accountId: string;
  profile: BillingProfile;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const rule = profile.autoRecharge;

  return (
    <>
      <GroupedSection
        title={t('billingPage.overview.autoRecharge')}
        footer={t('billingPage.autoRecharge.footer')}
      >
        <GroupedSectionItem
          title={t('billingPage.autoRecharge.rule')}
          titleNumberOfLines={0}
          value={
            rule.enabled && rule.threshold !== undefined && rule.amount !== undefined
              ? t('billingPage.overview.autoRechargeRule', {
                  amount: formatMoney(rule.amount, profile.currency),
                  threshold: formatMoney(rule.threshold, profile.currency),
                })
              : t('billingPage.overview.off')
          }
          rightElement={
            canManage ? (
              <Button appearance="outline" size="sm" onPress={() => setEditing(true)}>
                {t('billingPage.autoRecharge.edit')}
              </Button>
            ) : undefined
          }
        />
      </GroupedSection>
      <AutoRechargeDialog
        open={editing}
        onClose={() => setEditing(false)}
        accountId={accountId}
        profile={profile}
      />
    </>
  );
}
