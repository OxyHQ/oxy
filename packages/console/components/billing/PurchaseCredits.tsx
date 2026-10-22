import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';

import { type CreditPackage, useCreateCheckout } from '@/hooks/use-billing';
import { getErrorMessage } from '@/lib/api-error';
import { useTranslation } from '@/lib/i18n';
import { formatCount } from '@/lib/money';

/** One-off credit packages, each with a button that opens the provider's checkout. */
export function PurchaseCredits({ packages }: { packages: ReadonlyArray<CreditPackage> }) {
  const { t } = useTranslation();
  const checkout = useCreateCheckout();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const purchase = async (packageId: string) => {
    setPendingId(packageId);
    try {
      const result = await checkout.mutateAsync({
        packageId,
        successUrl: `${window.location.origin}/billing/plans?success=true`,
        cancelUrl: `${window.location.origin}/billing/plans?canceled=true`,
      });
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('billingPage.plans.checkoutFailed')));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <GroupedSection title={t('billingPage.plans.purchaseTitle')}>
      {packages.map((pkg) => (
        <GroupedSectionItem
          key={pkg.id}
          title={t('billingPage.plans.creditsCount', { credits: formatCount(pkg.credits) })}
          description={`${(pkg.price / 100).toFixed(2)} ${pkg.currency.toUpperCase()}`}
          rightElement={
            <Button
              appearance="outline"
              size="sm"
              loading={pendingId === pkg.id}
              disabled={checkout.isPending}
              onPress={() => void purchase(pkg.id)}
            >
              {t('billingPage.plans.purchase')}
            </Button>
          }
        />
      ))}
    </GroupedSection>
  );
}
