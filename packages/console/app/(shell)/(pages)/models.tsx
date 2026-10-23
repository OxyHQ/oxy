import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useState } from 'react';
import { View } from 'react-native';

import { ModelCatalogue } from '@/components/models/ModelCatalogue';
import { RoutingProfiles } from '@/components/models/RoutingProfiles';
import { useTranslation } from '@/lib/i18n';

type ModelsTab = 'models' | 'profiles';

/**
 * The models Oxy can serve, and the routing profiles that choose between them.
 *
 * Two tabs, because a profile is a policy with its own identifier space, not a model;
 * one list for both is the conflation ADR 0008 removes.
 */
export default function ModelsScreen() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ModelsTab>('models');

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={t('modelsPage.title')}
          subtitle={t('modelsPage.subtitle')}
          leading={<AppShellMenuButton />}
          safeArea={false}
          accessory={
            <Tabs
              variant="underline"
              value={tab}
              onValueChange={(value) => setTab(value as ModelsTab)}
              label={t('modelsPage.title')}
            >
              <TabsTrigger value="models" label={t('modelsPage.tabs.models')} />
              <TabsTrigger value="profiles" label={t('modelsPage.tabs.profiles')} />
            </Tabs>
          }
        />
      }
    >
      <ScreenScrollView contentContainerClassName="gap-6 p-4 md:p-6">
        <View className="w-full">
          {tab === 'models' ? <ModelCatalogue /> : <RoutingProfiles />}
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
