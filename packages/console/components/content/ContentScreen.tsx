import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { type Href, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/lib/i18n';

const MAX_WIDTH = {
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
  full: 'max-w-full',
} as const;

interface ContentScreenProps {
  title: string;
  subtitle?: string;
  /** Shows a back button that navigates here (e.g. the docs index). */
  backHref?: Href;
  /** Trailing header content (buttons, a badge). */
  actions?: ReactNode;
  maxWidth?: keyof typeof MAX_WIDTH;
  children: ReactNode;
}

/**
 * The frame every content screen shares: a Bloom `PageHeader` over a scrolling,
 * width-bounded column. The shell already owns the status-bar inset, so the
 * header takes no safe area of its own.
 */
export function ContentScreen({
  title,
  subtitle,
  backHref,
  actions,
  maxWidth = 'lg',
  children,
}: ContentScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <Screen
      className="flex-1 bg-background"
      header={
        <PageHeader
          title={title}
          subtitle={subtitle}
          leading={<AppShellMenuButton />}
          presentation="bar"
          sticky={false}
          safeArea={false}
          onBack={backHref === undefined ? undefined : () => router.navigate(backHref)}
          backLabel={t('common.back')}
          actions={actions}
        />
      }
    >
      <ScreenScrollView contentContainerClassName="p-6">
        <View className={`w-full gap-6 ${MAX_WIDTH[maxWidth]}`}>{children}</View>
      </ScreenScrollView>
    </Screen>
  );
}
