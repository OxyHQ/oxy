import { Card } from '@oxy.so/bloom/card';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCodeSLine } from '@oxy.so/bloom/icons/RiCodeSLine';
import { RiCpuLine } from '@oxy.so/bloom/icons/RiCpuLine';
import { RiKey2Line } from '@oxy.so/bloom/icons/RiKey2Line';
import { RiMessage2Line } from '@oxy.so/bloom/icons/RiMessage2Line';
import { RiPlayLine } from '@oxy.so/bloom/icons/RiPlayLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { type Href, Link } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { ContentScreen } from '@/components/content/ContentScreen';
import { Section } from '@/components/content/Section';
import { TextLink } from '@/components/content/TextLink';
import { useTranslation } from '@/lib/i18n';

const SECTIONS = [
  { key: 'quickstart', href: '/documentation/quickstart', icon: RiPlayLine },
  { key: 'authentication', href: '/documentation/authentication', icon: RiKey2Line },
  { key: 'chatCompletions', href: '/documentation/chat-completions', icon: RiMessage2Line },
  { key: 'models', href: '/documentation/models', icon: RiCpuLine },
  { key: 'sdks', href: '/documentation/sdks', icon: RiCodeSLine },
] as const satisfies ReadonlyArray<{ key: string; href: Href; icon: typeof RiPlayLine }>;

export default function DocumentationIndexScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <ContentScreen title={t('docs.index.title')} subtitle={t('docs.index.subtitle')} maxWidth="xl">
      <View className="flex-row flex-wrap gap-4">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Link key={section.key} href={section.href} asChild>
              <Pressable accessibilityRole="link" className="min-w-72 flex-1 basis-72">
                <Card className="h-full gap-2 p-5">
                  <View className="flex-row items-start justify-between">
                    <Icon width={28} height={28} fill={colors.primary} />
                    <RiArrowRightSLine width={16} height={16} fill={colors.textSecondary} />
                  </View>
                  <Text className="text-base font-semibold text-foreground">
                    {t(`docs.index.sections.${section.key}.title`)}
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    {t(`docs.index.sections.${section.key}.description`)}
                  </Text>
                </Card>
              </Pressable>
            </Link>
          );
        })}
      </View>

      <Section title={t('docs.index.quickLinks')}>
        <View className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
          <TextLink href="/apps">{t('docs.index.createApplication')}</TextLink>
          <TextLink href="/examples">{t('docs.index.viewExamples')}</TextLink>
          <TextLink href="/models">{t('docs.index.browseModels')}</TextLink>
        </View>
      </Section>
    </ContentScreen>
  );
}
