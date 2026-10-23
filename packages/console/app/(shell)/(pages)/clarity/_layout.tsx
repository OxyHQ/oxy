import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Badge } from '@oxy.so/bloom/badge';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { Slot, usePathname, useRouter } from 'expo-router';

import { CLARITY_SECTIONS } from '@/components/clarity/sections';
import { useTranslation } from '@/lib/i18n';

/**
 * Clarity is a routed tab cluster, like Mention's Explore: each tool is its own URL under
 * `/clarity`, the active tab is derived from the pathname, and this layout owns the
 * header, the tab bar and the scroll.
 */
export default function ClarityLayout() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const active =
    [...CLARITY_SECTIONS]
      .reverse()
      .find((section) =>
        section.href === '/clarity' ? pathname === '/clarity' : pathname.startsWith(section.href),
      )?.id ?? 'overview';

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={t('clarityPage.title')}
          subtitle={t('clarityPage.subtitle')}
          leading={<AppShellMenuButton />}
          actions={<Badge size="label-medium" variant="subtle" content={t('clarityPage.beta')} />}
          safeArea={false}
          accessory={
            <Tabs
              variant="underline"
              value={active}
              label={t('clarityPage.sectionsLabel')}
              onValueChange={(id) =>
                router.navigate(
                  CLARITY_SECTIONS.find((section) => section.id === id)?.href ?? '/clarity',
                )
              }
            >
              {CLARITY_SECTIONS.map((section) => (
                <TabsTrigger
                  key={section.id}
                  value={section.id}
                  label={t(`clarityPage.sections.${section.id}`)}
                />
              ))}
            </Tabs>
          }
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-4 md:p-6">
        <Slot />
      </ScreenScrollView>
    </Screen>
  );
}
