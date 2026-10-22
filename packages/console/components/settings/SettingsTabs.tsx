import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n';

const SECTIONS = [
  { key: 'account', href: '/settings/account', icon: RiSettings3Line },
  { key: 'audit', href: '/settings/audit', icon: RiHistoryLine },
] as const;

/** Sub-navigation between the settings pages, rendered under each page header. */
export function SettingsTabs({ active }: { active: (typeof SECTIONS)[number]['key'] }) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <View className="border-b border-border px-6">
      <Tabs
        value={active}
        onValueChange={(next) => {
          const section = SECTIONS.find((candidate) => candidate.key === next);
          if (section) router.navigate(section.href as Href);
        }}
        variant="underline"
        label={t('settingsPage.tabs.label')}
      >
        {SECTIONS.map((section) => (
          <TabsTrigger
            key={section.key}
            value={section.key}
            label={t(`settingsPage.tabs.${section.key}`)}
            leadingIcon={section.icon}
          />
        ))}
      </Tabs>
    </View>
  );
}
