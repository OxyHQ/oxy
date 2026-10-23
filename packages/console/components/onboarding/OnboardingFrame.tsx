import { AppShell } from '@oxy.so/bloom/app-shell';
import { useTheme } from '@oxy.so/bloom/theme';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

/**
 * Full-screen welcome frame: `AppShell` without a sidebar, the form in the content column and
 * the preview in the `aside`, which Bloom puts beside it from `md` and drops below it (the form
 * alone on a phone). The glow is two theme-token gradients at low opacity.
 */
export function OnboardingFrame({ form, preview }: { form: ReactNode; preview: ReactNode }) {
  const { height } = useWindowDimensions();
  return (
    <AppShell
      variant="dashboard"
      header={null}
      contentMaxWidth={560}
      aside={<PreviewPanel minHeight={height - 24}>{preview}</PreviewPanel>}
      asideWidth={560}
      asideFrom="md"
      asideCollapse="hidden"
    >
      <View className="justify-center gap-6 p-6 md:p-10" style={{ minHeight: height }}>
        {form}
      </View>
    </AppShell>
  );
}

function PreviewPanel({ children, minHeight }: { children: ReactNode; minHeight: number }) {
  const { colors } = useTheme();
  return (
    <View
      className="flex-1 items-center justify-center overflow-hidden rounded-3xl bg-background-secondary p-8"
      style={{ minHeight }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className="absolute inset-0 opacity-30" pointerEvents="none">
        <LinearGradient
          colors={[colors.primary, 'transparent']}
          start={{ x: 1, y: 0 }}
          end={{ x: 0.3, y: 0.7 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View className="absolute inset-0 opacity-20" pointerEvents="none">
        <LinearGradient
          colors={[colors.secondary, 'transparent']}
          start={{ x: 0, y: 1 }}
          end={{ x: 0.7, y: 0.3 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View className="w-full max-w-[440px]">{children}</View>
    </View>
  );
}
