import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiMoneyDollarCircleLine } from '@oxy.so/bloom/icons/RiMoneyDollarCircleLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useAuth } from '@oxy.so/services/ui/client';
import { Slot, usePathname, useRouter } from 'expo-router';
import { View } from 'react-native';
import { accountLabel, useAccount } from '@/hooks/use-account';
import { useAccountBillingState } from '@/hooks/use-account-billing';
import { useTranslation } from '@/lib/i18n';

/**
 * The billing sections are separate PAGES rather than tabs on one page, and
 * money and units never share one: Spend and Charges read the financial ledger;
 * Usage (outside this header, in the sidebar) reads telemetry. Different screens
 * are the strongest form of "do not let a usage number appear under a heading
 * that implies it is what they were charged".
 */
const SECTIONS = [
  {
    key: 'overview',
    href: '/billing',
    icon: RiBankCardLine,
    labelKey: 'billingPage.tabs.overview',
  },
  {
    key: 'spend',
    href: '/billing/spend',
    icon: RiMoneyDollarCircleLine,
    labelKey: 'billingPage.tabs.spend',
  },
  {
    key: 'charges',
    href: '/billing/charges',
    icon: RiTimeLine,
    labelKey: 'billingPage.tabs.charges',
  },
  {
    key: 'budgets',
    href: '/billing/budgets',
    icon: RiFocus3Line,
    labelKey: 'billingPage.tabs.budgets',
  },
  { key: 'plans', href: '/billing/plans', icon: RiCoinsLine, labelKey: 'billingPage.tabs.plans' },
  // Changes to the balance, as opposed to movements within one; last because it
  // is the section a customer reaches for after reading the others.
  { key: 'audit', href: '/billing/audit', icon: RiHistoryLine, labelKey: 'billingPage.tabs.audit' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

function sectionFromPath(pathname: string): SectionKey {
  const segment = pathname.split('/').filter(Boolean)[1];
  return SECTIONS.find((section) => section.key === segment)?.key ?? 'overview';
}

export default function BillingLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const { accounts, currentAccount, canReadBilling } = useAccount();
  const active = sectionFromPath(pathname);

  const canRead = currentAccount !== null && canReadBilling(currentAccount);
  // Only the overview names the payer, and only when the profile is inherited.
  const stateQuery = useAccountBillingState(
    currentAccount?.accountId,
    canRead && active === 'overview',
  );
  const state = stateQuery.data ?? null;
  const payer = state?.inherited
    ? accounts.find((node) => node.accountId === state.billingAccountId)
    : undefined;

  // Plans and credits belong to the signed-in USER, every other section to the account.
  const subjectName =
    active === 'plans'
      ? user
        ? typeof user.displayName === 'string' && user.displayName
          ? user.displayName
          : (getNormalizedUserHandle(user) ?? undefined)
        : undefined
      : currentAccount === null
        ? undefined
        : accountLabel(currentAccount);

  const subtitle =
    subjectName === undefined
      ? t('billingPage.subtitle.none')
      : payer !== undefined
        ? t('billingPage.subtitle.payer', { name: subjectName, payer: accountLabel(payer) })
        : t('billingPage.subtitle.account', { name: subjectName });

  return (
    <Screen
      header={
        <View className="bg-background">
          <PageHeader
            title={t('billingPage.title')}
            subtitle={subtitle}
            leading={<AppShellMenuButton />}
            presentation="bar"
            titleAlign="start"
            border="none"
            sticky={false}
            safeArea={false}
          />
          <View className="border-b border-border px-6">
            <Tabs
              value={active}
              onValueChange={(next) => {
                const section = SECTIONS.find((candidate) => candidate.key === next);
                if (section) router.navigate(section.href);
              }}
              variant="underline"
              label={t('billingPage.tabs.label')}
            >
              {SECTIONS.map((section) => (
                <TabsTrigger
                  key={section.key}
                  value={section.key}
                  label={t(section.labelKey)}
                  leadingIcon={section.icon}
                />
              ))}
            </Tabs>
          </View>
        </View>
      }
    >
      <Slot />
    </Screen>
  );
}
