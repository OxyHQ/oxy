import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { useTranslation } from '@/lib/i18n';
import { Fonts } from '@/constants/theme';

// Platform-appropriate monospace stack for the dev-only stack-trace block.
// `Geist Mono` was referenced previously but is never bundled, so it silently
// fell back to the system face; `Fonts.mono` resolves to ui-monospace /
// monospace / a proper CSS stack per platform.
const MONO_FONT_FAMILY = Fonts?.mono;

interface ErrorFallbackProps {
  error: Error;
  retry: () => void;
}

interface MinimalErrorFallbackProps extends ErrorFallbackProps {
  /** Forced colour scheme when Bloom theme context is unavailable. */
  scheme?: 'light' | 'dark';
}

/**
 * Reusable error UI for expo-router `ErrorBoundary` exports and the root
 * boundary. Shows a friendly message with a retry action; the raw error
 * details are only revealed in development builds.
 */
export function ErrorFallback({ error, retry }: ErrorFallbackProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[
            styles.iconBubble,
            { backgroundColor: colors.error + '22', borderColor: colors.error + '55' },
          ]}
        >
          <MaterialCommunityIcons
            name="alert-circle-outline"
            size={48}
            color={colors.error}
          />
        </View>

        <ThemedText style={[styles.title, { color: colors.text }]}>
          {t('errors.boundary.title')}
        </ThemedText>
        <ThemedText style={[styles.subtitle, { color: colors.textSecondary }]}>
          {t('errors.boundary.subtitle')}
        </ThemedText>

        {isDev && (
          <View
            style={[
              styles.devDetails,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.devLabel, { color: colors.textSecondary }]}>
              {t('errors.boundary.details')}
            </Text>
            <Text style={[styles.devMessage, { color: colors.text }]} selectable>
              {error.message}
            </Text>
            {error.stack ? (
              <Text style={[styles.devStack, { color: colors.textSecondary }]} selectable>
                {error.stack}
              </Text>
            ) : null}
          </View>
        )}

        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: colors.tint }]}
          onPress={retry}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('errors.boundary.retry')}
        >
          <MaterialCommunityIcons name="refresh" size={20} color="#FFFFFF" />
          <Text style={styles.retryText}>{t('errors.boundary.retry')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

/**
 * Variant for the top-level boundary that must work without the Bloom theme
 * provider (e.g. if `OxyProvider`/`BloomThemeProvider` itself throws). Uses
 * raw colour values so it is safe to render at the absolute root of the app.
 */
export function MinimalErrorFallback({ error, retry, scheme = 'light' }: MinimalErrorFallbackProps) {
  const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
  const isDark = scheme === 'dark';

  const bg = isDark ? '#0B0B0F' : '#FFFFFF';
  const surface = isDark ? '#1B1B22' : '#F5F5F7';
  const border = isDark ? '#2A2A33' : '#E5E5EA';
  const text = isDark ? '#FFFFFF' : '#0B0B0F';
  const muted = isDark ? '#9A9AA8' : '#6B6B73';
  const tint = '#7C5CFA';
  const errorColor = '#FF3B30';

  return (
    <View style={[minimalStyles.container, { backgroundColor: bg }]}>
      <ScrollView contentContainerStyle={minimalStyles.content} showsVerticalScrollIndicator={false}>
        <View style={[minimalStyles.iconBubble, { backgroundColor: errorColor + '22', borderColor: errorColor + '55' }]}>
          <MaterialCommunityIcons name="alert-circle-outline" size={48} color={errorColor} />
        </View>

        <Text style={[minimalStyles.title, { color: text }]}>Something went wrong</Text>
        <Text style={[minimalStyles.subtitle, { color: muted }]}>
          An unexpected error occurred. Please try again.
        </Text>

        {isDev && (
          <View style={[minimalStyles.devDetails, { backgroundColor: surface, borderColor: border }]}>
            <Text style={[minimalStyles.devLabel, { color: muted }]}>Error details</Text>
            <Text style={[minimalStyles.devMessage, { color: text }]} selectable>
              {error.message}
            </Text>
            {error.stack ? (
              <Text style={[minimalStyles.devStack, { color: muted }]} selectable>
                {error.stack}
              </Text>
            ) : null}
          </View>
        )}

        <TouchableOpacity
          style={[minimalStyles.retryButton, { backgroundColor: tint }]}
          onPress={retry}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <MaterialCommunityIcons name="refresh" size={20} color="#FFFFFF" />
          <Text style={minimalStyles.retryText}>Try again</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const minimalStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
    gap: 16,
  },
  iconBubble: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: Platform.OS === 'web' ? '600' : undefined,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 360,
  },
  devDetails: {
    width: '100%',
    maxWidth: 480,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  devLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  devMessage: {
    fontSize: 14,
    fontWeight: '500',
  },
  devStack: {
    fontSize: 11,
    fontFamily: MONO_FONT_FAMILY,
    lineHeight: 14,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 24,
    gap: 8,
    marginTop: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  iconBubble: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: Platform.OS === 'web' ? '600' : undefined,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 360,
  },
  devDetails: {
    width: '100%',
    maxWidth: 480,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  devLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  devMessage: {
    fontSize: 14,
    fontWeight: '500',
  },
  devStack: {
    fontSize: 11,
    fontFamily: MONO_FONT_FAMILY,
    lineHeight: 14,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 24,
    gap: 8,
    marginTop: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
