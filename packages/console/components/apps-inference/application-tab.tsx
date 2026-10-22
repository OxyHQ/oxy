import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useAppDetail } from '@/components/apps/app-context';
import type { Application, CallerAccess } from '@/hooks/use-applications';

/**
 * The scrolling, width-limited body shared by the Inference, Store and Updates tabs.
 * The `[appId]` layout owns loading the application and the header; a tab only
 * receives the loaded application and the caller's access.
 */
export function ApplicationTab({
  maxWidthClassName = 'max-w-3xl',
  children,
}: {
  maxWidthClassName?: string;
  children: (application: Application, access: CallerAccess) => ReactNode;
}) {
  const { application, access } = useAppDetail();
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
      <View className={`w-full ${maxWidthClassName}`}>{children(application, access)}</View>
    </ScrollView>
  );
}
