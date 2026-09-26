import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import LottieView from 'lottie-react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Easing
} from 'react-native-reanimated';
import hedgehogAnimation from '@/assets/lottie/Hedgehog.json';
import { useTranslation } from '@/lib/i18n';

interface CreatingStepProps {
  progress: number;
  backgroundColor: string;
  textColor: string;
  isSyncing?: boolean;
  isSigningIn?: boolean;
  /**
   * When set, the step renders a recoverable error state (message + Retry)
   * instead of the loading animation. Without this, a failed `createIdentity()`
   * left the user stuck on an endless "Setting up your account…" screen with no
   * feedback and no way forward (see issue #605).
   */
  error?: string | null;
  onRetry?: () => void;
}

const TOTAL_PROGRESS_STEPS = 3; // 0, 1, 2
const PROGRESS_MESSAGE_KEYS = [
  'auth.creating.messages.0',
  'auth.creating.messages.1',
  'auth.creating.messages.2',
] as const;

/**
 * Creating step component showing progress during identity creation, sync, and sign-in
 */
export function CreatingStep({ progress, backgroundColor, textColor, isSyncing, isSigningIn, error, onRetry }: CreatingStepProps) {
  const { t } = useTranslation();
  // Determine message based on current state
  let currentMessage: string;
  let subtitle: string = t('auth.creating.subtitle');

  if (isSigningIn) {
    currentMessage = t('auth.creating.connecting');
    subtitle = t('auth.creating.connectingSubtitle');
  } else if (isSyncing) {
    currentMessage = t('auth.creating.syncing');
    subtitle = t('auth.creating.syncingSubtitle');
  } else {
    const key = PROGRESS_MESSAGE_KEYS[progress] ?? PROGRESS_MESSAGE_KEYS[0];
    currentMessage = t(key);
  }

  const progressValue = useSharedValue(0);

  useEffect(() => {
    // Animate progress from 0 to 1 based on current progress step
    // Progress can be 0, 1, or 2 (3 steps total)
    const targetProgress = Math.min(progress / (TOTAL_PROGRESS_STEPS - 1), 1);
    progressValue.value = withTiming(targetProgress, {
      duration: 500,
      easing: Easing.out(Easing.cubic),
    });
  }, [progress, progressValue]);

  const progressBarStyle = useAnimatedStyle(() => {
    const widthPercent = interpolate(
      progressValue.value,
      [0, 1],
      [0, 100],
      'clamp'
    );
    return {
      width: `${widthPercent}%`,
    };
  });

  const progressBarContainerStyle = useAnimatedStyle(() => {
    // Always visible, but slightly more opaque when there's progress
    return {
      opacity: progressValue.value > 0 ? 1 : 0.5,
    };
  });

  // Recoverable failure: show the reason + a Retry instead of an endless
  // "Setting up your account…" with no way forward (issue #605).
  if (error) {
    return (
      <View style={[styles.container, { backgroundColor }]}>
        <View className="flex-1 justify-center items-center p-space-20">
          <Text style={[styles.creatingTitle, { color: textColor }]}>
            {t('auth.creating.errorTitle')}
          </Text>
          <Text style={[styles.creatingSubtitle, { color: textColor, opacity: 0.7 }]}>
            {error}
          </Text>
          {onRetry ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              style={({ pressed }) => [styles.retryButton, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.retryButtonText}>{t('auth.creating.retry')}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <View className="flex-1 justify-center items-center p-space-20">
        <LottieView
          source={hedgehogAnimation}
          autoPlay
          loop
          style={styles.lottieAnimation}
        />
        <Animated.View
          key={progress}
          entering={FadeIn.duration(300)}
          exiting={FadeOut.duration(200)}
          style={styles.progressMessageContainer}
        >
          <Text style={[styles.creatingTitle, { color: textColor }]}>
            {currentMessage}
          </Text>
        </Animated.View>
        <Text style={[styles.creatingSubtitle, { color: textColor, opacity: 0.6 }]}>
          {subtitle}
        </Text>

        {/* Progress Bar */}
        <Animated.View
          style={[
            styles.progressBarContainer,
            progressBarContainerStyle,
            {
              backgroundColor: backgroundColor === '#000000' || backgroundColor === 'rgba(0, 0, 0, 1)'
                ? 'rgba(255, 255, 255, 0.1)'
                : 'rgba(0, 0, 0, 0.1)'
            }
          ]}
        >
          <Animated.View
            style={[
              styles.progressBar,
              progressBarStyle,
              { backgroundColor: textColor }
            ]}
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  lottieAnimation: {
    width: 120,
    height: 120,
  },
  progressMessageContainer: {
    marginTop: 20,
    minHeight: 30,
  },
  creatingTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 20,
    textAlign: 'center',
  },
  creatingSubtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  progressBarContainer: {
    width: '80%',
    maxWidth: 300,
    height: 4,
    borderRadius: 2,
    marginTop: 32,
    overflow: 'hidden',
    // Ensure container is always visible
    minHeight: 4,
  },
  progressBar: {
    height: '100%',
    borderRadius: 2,
    // Ensure minimum width for visibility even at 0%
    minWidth: 1,
  },
  retryButton: {
    marginTop: 28,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24,
    backgroundColor: '#8B5CF6',
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});

