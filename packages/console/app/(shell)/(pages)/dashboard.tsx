import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCheckboxBlankCircleLine } from '@oxy.so/bloom/icons/RiCheckboxBlankCircleLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { useApplications } from '@/hooks/use-applications';
import { useCredits } from '@/hooks/use-billing';
import config from '@/lib/config';
import { useTranslation } from '@/lib/i18n';

interface OnboardingStep {
  id: string;
  title: string;
  completed: boolean;
  href: Href;
  action?: string;
}

/** First-run checklist: credits, an application, a first request. */
export default function DashboardPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const { open: openSettings } = useConsoleSettings();
  const theme = useTheme();
  const { data: applications = [] } = useApplications();
  const { data: credits } = useCredits();

  const hasCredits = (credits?.credits ?? 0) > 0;
  const hasApplication = applications.length > 0;

  const steps: ReadonlyArray<OnboardingStep> = [
    {
      id: 'credits',
      title: t('dashboardPage.steps.credits'),
      completed: hasCredits,
      href: '/billing',
      action: t('dashboardPage.steps.creditsAction'),
    },
    {
      id: 'application',
      title: t('dashboardPage.steps.application'),
      completed: hasApplication,
      href: '/apps',
      action: hasApplication ? undefined : t('dashboardPage.steps.applicationAction'),
    },
    {
      id: 'request',
      title: t('dashboardPage.steps.request'),
      completed: false,
      href: config.docsUrl as Href,
      action: t('dashboardPage.steps.requestAction'),
    },
  ];

  const allCompleted = steps.every((step) => step.completed);

  return (
    <Screen
      header={
        <PageHeader
          title={t('dashboard.title')}
          subtitle={t('dashboard.subtitle')}
          leading={<AppShellMenuButton />}
          presentation="bar"
          titleAlign="start"
          safeArea={false}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="pb-12">
        <View className="flex-row flex-wrap items-center justify-center gap-x-24 gap-y-12 px-8 py-12">
          <View className="w-full max-w-md gap-4">
            <Text variant="display-4-semibold">{t('dashboardPage.headline')}</Text>
            <Muted className="text-lg">{t('dashboardPage.welcome')}</Muted>
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

          <View className="w-full max-w-md gap-6">
            <GroupedSection>
              {steps.map((step) => (
                <GroupedSectionItem
                  key={step.id}
                  title={step.title}
                  icon={
                    step.completed ? (
                      <RiCheckboxCircleFill size="lg" fill={theme.colors.success} />
                    ) : (
                      <RiCheckboxBlankCircleLine size="lg" fill={theme.colors.textSecondary} />
                    )
                  }
                  value={step.action && !step.completed ? step.action : undefined}
                  onPress={step.completed ? undefined : () => router.navigate(step.href)}
                />
              ))}
            </GroupedSection>

            {hasApplication ? (
              <GroupedSection>
                <GroupedSectionItem
                  title={t('dashboardPage.applications')}
                  value={String(applications.length)}
                />
              </GroupedSection>
            ) : null}
          </View>
        </View>

        {allCompleted ? (
          <View className="flex-row flex-wrap items-center justify-center gap-6 pb-8">
            <QuickLink label={t('nav.documentation')} href={config.docsUrl as Href} />
            <QuickLink label={t('nav.models')} href="/models" />
          </View>
        ) : null}
      </ScreenScrollView>
    </Screen>
  );
}

function QuickLink({ label, href }: { label: string; href: Href }) {
  const router = useRouter();
  return (
    <Button
      appearance="plain"
      size="sm"
      trailingIcon={RiArrowRightSLine}
      accessibilityRole="link"
      onPress={() => router.navigate(href)}
    >
      {label}
    </Button>
  );
}
