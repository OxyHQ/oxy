import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import type { ReactNode } from 'react';
import { View } from 'react-native';

interface PageScreenProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Rendered under the header (a tab bar, for example). */
  headerExtra?: ReactNode;
  children: ReactNode;
}

/**
 * A Bloom screen with the console's page header. The header sits in the shell
 * panel, so it never reserves the device safe area (the shell does).
 */
export function PageScreen({ title, subtitle, actions, headerExtra, children }: PageScreenProps) {
  return (
    <Screen
      header={
        <View className="bg-background">
          <PageHeader
            title={title}
            subtitle={subtitle}
            actions={actions}
            leading={<AppShellMenuButton />}
            presentation="bar"
            titleAlign="start"
            border={headerExtra ? 'none' : 'always'}
            sticky={false}
            safeArea={false}
          />
          {headerExtra}
        </View>
      }
    >
      {children}
    </Screen>
  );
}

/** The scrolling body of a page: sections stacked with a hairline between them. */
export function PageBody({ children }: { children: ReactNode }) {
  return <ScreenScrollView contentContainerClassName="pb-12">{children}</ScreenScrollView>;
}

/** Header plus body, for pages that own both. */
export function PageFrame(props: PageScreenProps) {
  const { children, ...header } = props;
  return (
    <PageScreen {...header}>
      <PageBody>{children}</PageBody>
    </PageScreen>
  );
}
