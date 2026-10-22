import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useState } from 'react';
import { View } from 'react-native';

import { CatalogueTab } from '@/components/models/CatalogueTab';
import { RoutingProfilesTab } from '@/components/models/RoutingProfilesTab';
import { useTranslation } from '@/lib/i18n';

type ModelsTab = 'models' | 'profiles';

/**
 * The Models page, rendered from the real catalogue.
 *
 * Two tabs, because a routing profile is not a model and putting them in one list
 * is the conflation ADR 0008 exists to remove. A model is a named line from a
 * publisher, resolvable as `<publisher>/<model>`; a profile is a POLICY object
 * with its own identifier space that selects among deployments.
 */
export default function ModelsScreen() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ModelsTab>('models');

  return (
    <Screen
      className="flex-1 bg-background"
      header={
        <PageHeader
          title={t('modelsPage.title')}
          subtitle={t('modelsPage.subtitle')}
          leading={<AppShellMenuButton />}
          presentation="bar"
          sticky={false}
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-6">
        <View className="w-full max-w-6xl gap-6">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as ModelsTab)}
            label={t('modelsPage.title')}
          >
            <TabsTrigger value="models" label={t('modelsPage.tabs.models')} />
            <TabsTrigger value="profiles" label={t('modelsPage.tabs.profiles')} />
          </Tabs>
          {tab === 'models' ? <CatalogueTab /> : <RoutingProfilesTab />}
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
