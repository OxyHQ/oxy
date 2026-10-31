import type { ReactNode } from 'react';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Badge } from '@oxy.so/bloom/badge';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useIsFocused, usePathname, useRouter } from 'expo-router';

import { CLARITY_SECTIONS } from '@/components/clarity/sections';
import { useTranslation } from '@/lib/i18n';

/** Shared route chrome; each leaf owns its viewport and restoration identity. */
export function ClarityScreen({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
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
      active={focused}
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
      <ScreenScrollView contentContainerClassName="p-4 md:p-6">{children}</ScreenScrollView>
    </Screen>
  );
}
