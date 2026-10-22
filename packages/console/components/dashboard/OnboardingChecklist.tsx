import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiCheckboxBlankCircleLine } from '@oxy.so/bloom/icons/RiCheckboxBlankCircleLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { type Href, useRouter } from 'expo-router';
import { Linking, View } from 'react-native';

import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';

interface Step {
  id: string;
  completed: boolean;
  onPress: () => void;
  action: string;
}

/**
 * The first-run checklist: credits, an application, a first request.
 *
 * Before any traffic it is the whole page (a welcome beside the steps); once the
 * account has data the same steps shrink to one section above the overview.
 */
export function OnboardingChecklist({
  hasCredits,
  hasApplication,
  hasRequest,
  compact,
  workspaceName,
}: {
  hasCredits: boolean;
  hasApplication: boolean;
  hasRequest: boolean;
  compact: boolean;
  /** The active workspace: the application step is about ITS applications. */
  workspaceName: string | undefined;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();
  const { open: openSettings } = useConsoleSettings();

  const steps: ReadonlyArray<Step> = [
    {
      id: 'credits',
      completed: hasCredits,
      onPress: () => router.navigate('/billing' as Href),
      action: t('dashboardPage.steps.creditsAction'),
    },
    {
      id: 'application',
      completed: hasApplication,
      onPress: () => router.navigate('/apps' as Href),
      action: t('dashboardPage.steps.applicationAction'),
    },
    {
      id: 'request',
      completed: hasRequest,
      onPress: () => void Linking.openURL(config.docsUrl),
      action: t('dashboardPage.steps.requestAction'),
    },
  ];

  const checklist = (
    <GroupedSection title={compact ? t('dashboardPage.checklistTitle') : undefined}>
      {steps.map((step) => (
        <GroupedSectionItem
          key={step.id}
          title={
            step.id === 'application' && workspaceName !== undefined
              ? t('dashboardPage.steps.applicationIn', { workspace: workspaceName })
              : t(`dashboardPage.steps.${step.id}`)
          }
          icon={
            step.completed ? (
              <RiCheckboxCircleFill size="lg" fill={theme.colors.success} />
            ) : (
              <RiCheckboxBlankCircleLine size="lg" fill={theme.colors.textSecondary} />
            )
          }
          value={step.completed ? undefined : step.action}
          onPress={step.completed ? undefined : step.onPress}
        />
      ))}
    </GroupedSection>
  );

  if (compact) {
    return checklist;
  }

  return (
    <View className="flex-row flex-wrap items-center justify-center gap-x-24 gap-y-12 px-4 py-12">
      <View className="w-full max-w-md gap-4">
        <Text variant="display-4-semibold">{t('dashboardPage.headline')}</Text>
        <Muted className="text-lg text-muted-foreground">{t('dashboardPage.welcome')}</Muted>
        <View className="mt-8 items-start">
          <Button
            appearance="outline"
            leadingIcon={RiGroupLine}
            onPress={() => openSettings('account')}
          >
            {t('dashboardPage.inviteTeam')}
          </Button>
        </View>
      </View>
      <View className="w-full max-w-md">{checklist}</View>
    </View>
  );
}
