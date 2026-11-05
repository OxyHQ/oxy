import type { ReactNode } from 'react';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { type Href, useIsFocused, usePathname, useRouter } from 'expo-router';

import { accountLabel } from '@/hooks/use-account';
import { useBillingAccess } from '@/hooks/use-billing-access';
import { useTranslation } from '@/lib/i18n';

/**
 * Shared route chrome rendered inside each leaf, keeping its own scroll identity.
 * One tab per page, each its own URL under `/billing` (deep-linkable, reload-safe),
 * the way Mention's explore header does it. The active tab is derived from the
 * pathname. Money and units never share a page: Spend and Holds and charges read
 * the financial ledger, Usage (in the sidebar) reads telemetry.
 */
const TABS = [
  { id: 'overview', href: '/billing' },
  { id: 'spend', href: '/billing/spend' },
  { id: 'charges', href: '/billing/charges' },
  { id: 'budgets', href: '/billing/budgets' },
  { id: 'plans', href: '/billing/plans' },
  { id: 'audit', href: '/billing/audit' },
] as const satisfies ReadonlyArray<{ id: string; href: Href }>;

type TabId = (typeof TABS)[number]['id'];

function tabFromPath(pathname: string): TabId {
  const segment = pathname.split('/').filter(Boolean)[1];
  return TABS.find((tab) => tab.id === segment)?.id ?? 'overview';
}

export function BillingScreen({
  children,
  contentContainerClassName,
}: {
  children: ReactNode;
  contentContainerClassName?: string;
}) {
  const focused = useIsFocused();
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const { account } = useBillingAccess();
  const active = tabFromPath(pathname);

  // Plans and credits belong to the signed-in USER; every other tab to the account.
  const subject =
    active === 'plans'
      ? user
        ? typeof user.displayName === 'string' && user.displayName
          ? user.displayName
          : getNormalizedUserHandle(user)
        : undefined
      : account === null
        ? undefined
        : accountLabel(account);

  return (
    <Screen
      scroll="auto"
      active={focused}
      header={
        <PageHeader
          title={t('billingPage.title')}
          subtitle={
            subject
              ? t(
                  active === 'plans' ? 'billingPage.subtitle.user' : 'billingPage.subtitle.account',
                  {
                    name: subject,
                  },
                )
              : t('billingPage.subtitle.none')
          }
          leading={<AppShellMenuButton />}
          safeArea={false}
          accessory={
            <Tabs
              value={active}
              onValueChange={(next) => {
                const tab = TABS.find((candidate) => candidate.id === next);
                if (tab) router.push(tab.href);
              }}
              variant="underline"
              label={t('billingPage.tabs.label')}
            >
              {TABS.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id} label={t(`billingPage.tabs.${tab.id}`)} />
              ))}
            </Tabs>
          }
        />
      }
    >
      <ScreenScrollView contentContainerClassName={contentContainerClassName}>
        {children}
      </ScreenScrollView>
    </Screen>
  );
}
