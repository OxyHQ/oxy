import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { type Href, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { PageFrame } from '@/components/account-pages/PageFrame';
import { useApplications } from '@/hooks/use-applications';
import { useCredits } from '@/hooks/use-billing';
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
      href: '/documentation',
      action: t('dashboardPage.steps.requestAction'),
    },
  ];

  const allCompleted = steps.every((step) => step.completed);

  return (
    <PageFrame title={t('dashboard.title')} subtitle={t('dashboard.subtitle')}>
      <View className="flex-row flex-wrap items-center justify-center gap-x-24 gap-y-12 px-8 py-12">
        <View className="max-w-md gap-4">
          <Text className="text-3xl font-semibold text-foreground">
            {t('dashboardPage.headline')}
          </Text>
          <Text className="text-lg text-muted-foreground">{t('dashboardPage.welcome')}</Text>
          <View className="mt-8 items-start">
            <Button
              appearance="outline"
              leadingIcon={RiGroupLine}
              onPress={() => router.navigate('/settings/account' as Href)}
            >
              {t('dashboardPage.inviteTeam')}
            </Button>
          </View>
        </View>

        <View className="w-full max-w-md gap-6">
          <Card border="hairline" clipContent>
            {steps.map((step, index) => (
              <View
                key={step.id}
                className={`flex-row items-center justify-between gap-4 px-6 py-5 ${
                  index < steps.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <View className="min-w-0 flex-1 flex-row items-center gap-4">
                  {step.completed ? (
                    <RiCheckboxCircleFill size="lg" fill={theme.colors.success} />
                  ) : (
                    <View className="size-6 rounded-full border-2 border-border" />
                  )}
                  <Text
                    className={`shrink text-sm ${
                      step.completed ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                  >
                    {step.title}
                  </Text>
                </View>
                {step.action && !step.completed ? (
                  <Pressable accessibilityRole="link" onPress={() => router.navigate(step.href)}>
                    <Text className="text-sm text-muted-foreground">{step.action}</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </Card>

          {hasApplication ? (
            <View className="items-center gap-0.5">
              <Text className="text-2xl font-semibold text-foreground">{applications.length}</Text>
              <Text className="text-xs text-muted-foreground">
                {t('dashboardPage.applications')}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {allCompleted ? (
        <View className="flex-row flex-wrap items-center justify-center gap-6 pb-8">
          <QuickLink label={t('nav.documentation')} href="/documentation" />
          <QuickLink label={t('nav.examples')} href="/examples" />
          <QuickLink label={t('nav.models')} href="/models" />
        </View>
      ) : null}
    </PageFrame>
  );
}

function QuickLink({ label, href }: { label: string; href: Href }) {
  const router = useRouter();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.navigate(href)}
      className="flex-row items-center gap-1"
    >
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <RiArrowRightSLine size="xs" fill={theme.colors.textSecondary} />
    </Pressable>
  );
}
