import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity } from 'react-native';
import LottieView from 'lottie-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Button, KeyboardAwareScrollViewWrapper } from '@/components/ui';
import { useUsernameValidation } from '@/hooks/auth/useUsernameValidation';
import { sanitizeUsernameInput } from '@/utils/auth/usernameUtils';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import type { OxyServices } from '@oxyhq/core';
import { useTranslation } from '@/lib/i18n';
import telescopeAnimation from '@/assets/lottie/telescope.json';

/**
 * Sections of the "Learn more about usernames" explainer, in presentation
 * order. The copy itself lives in the shared dictionary under
 * `learnMoreUsernames.sections.<id>.{title,content}` (resolved by `t()` through
 * the accounts dictionary and then `@oxyhq/core`), so it stays the SAME copy
 * the surface showed before, in every locale.
 */
const LEARN_MORE_SECTION_IDS = ['what', 'rules', 'unique', 'change', 'tips'] as const;

interface UsernameStepProps {
  username: string;
  onUsernameChange: (username: string) => void;
  onContinue: () => void | Promise<void>;
  onSkip?: () => void;
  isOffline: boolean;
  oxyServices: OxyServices | null;
  backgroundColor: string;
  textColor: string;
  isUpdating?: boolean;
  updateError?: string | null;
}

/**
 * Username step component for choosing a username
 */
export function UsernameStep({
  username,
  onUsernameChange,
  onContinue,
  onSkip,
  isOffline,
  oxyServices,
  backgroundColor,
  textColor,
  isUpdating = false,
  updateError = null,
}: UsernameStepProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const validation = useUsernameValidation(username, oxyServices);
  const lottieRef = useRef<LottieView>(null);
  const isMountedRef = useRef(true);
  const isConfirmingRef = useRef(false);
  const confirmationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const learnMoreDialog = useDialogControl();
  const [shouldLoop, setShouldLoop] = useState(false);
  const [isAnimationPlaying, setIsAnimationPlaying] = useState(true); // Start as true since autoPlay will start it

  const isUsernameValid = validation.isValid;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (confirmationTimeoutRef.current) {
        clearTimeout(confirmationTimeoutRef.current);
        confirmationTimeoutRef.current = null;
      }
    };
  }, []);

  // Play animation when checking username availability
  useEffect(() => {
    if (validation.isChecking && lottieRef.current) {
      setShouldLoop(true);
      setIsAnimationPlaying(true);
      lottieRef.current.reset();
      lottieRef.current.play();
    } else if (!validation.isChecking && !isConfirming) {
      setShouldLoop(false);
    }
  }, [validation.isChecking, isConfirming]);

  // Handle animation finish
  const handleAnimationFinish = () => {
    // Only mark as finished if not looping
    if (!shouldLoop && !validation.isChecking && !isConfirming) {
      setIsAnimationPlaying(false);
    }
  };

  // Handle tap on animation - only allow when animation has ended
  const handleAnimationPress = () => {
    // Only allow tap when animation is not playing and not looping
    if (!isAnimationPlaying && !shouldLoop && !validation.isChecking && !isConfirming) {
      if (lottieRef.current) {
        setIsAnimationPlaying(true);
        lottieRef.current.reset();
        lottieRef.current.play();
      }
    }
  };

  // Can continue if:
  // 1. Username is valid AND
  // 2. Either: available === true, available === null (not checked yet), or offline AND
  // 3. Not currently checking availability
  const canContinue = isUsernameValid && (
    validation.isAvailable === true ||
    validation.isAvailable === null ||
    isOffline
  ) && !validation.isChecking && !isConfirming;

  const handleTextChange = (text: string) => {
    const sanitized = sanitizeUsernameInput(text);
    onUsernameChange(sanitized);
  };

  const handleContinue = () => {
    // Validate username format
    if (!isUsernameValid) {
      return;
    }

    // Don't proceed if username is explicitly unavailable or currently being checked
    if (validation.isAvailable === false || validation.isChecking) {
      return;
    }
    if (isConfirmingRef.current) return;

    // Start confirmation animation
    isConfirmingRef.current = true;
    setIsConfirming(true);
    setShouldLoop(true);
    setIsAnimationPlaying(true);

    // Reset and play animation from start
    if (lottieRef.current) {
      lottieRef.current.reset();
      lottieRef.current.play();
    }

    // Wait 4 seconds before proceeding to next step
    confirmationTimeoutRef.current = setTimeout(() => {
      confirmationTimeoutRef.current = null;
      setShouldLoop(false);
      void (async () => {
        try {
          await onContinue();
        } finally {
          // A successful save navigates away and unmounts this screen. If the
          // parent stays here (session still starting, offline, API error),
          // release the confirmation state so Continue and the rest of the UI
          // remain usable and the user can retry.
          isConfirmingRef.current = false;
          if (isMountedRef.current) {
            setIsConfirming(false);
            setShouldLoop(false);
            setIsAnimationPlaying(false);
          }
        }
      })();
    }, 4000);
  };

  return (
    <View style={[styles.container, { backgroundColor, paddingTop: insets.top }]}>
      <KeyboardAwareScrollViewWrapper contentContainerStyle={styles.stepContainer}>
        <View style={styles.animationContainer}>
          <TouchableOpacity
            onPress={handleAnimationPress}
            activeOpacity={0.8}
            disabled={isAnimationPlaying || shouldLoop || validation.isChecking || isConfirming}
            accessibilityRole="button"
            accessibilityLabel={t('auth.usernameStep.a11y.playAnimation')}
            accessibilityState={{ disabled: isAnimationPlaying || shouldLoop || validation.isChecking || isConfirming }}
          >
            <LottieView
              ref={lottieRef}
              source={telescopeAnimation}
              autoPlay
              loop={shouldLoop || validation.isChecking}
              style={styles.lottieAnimation}
              onAnimationFinish={handleAnimationFinish}
            />
          </TouchableOpacity>
        </View>
        <Text style={[styles.title, { color: textColor }]}>{t('auth.usernameStep.title')}</Text>
        <Text style={[styles.subtitle, { color: textColor, opacity: 0.6 }]}>
          {isOffline
            ? t('auth.usernameStep.subtitleOffline')
            : t('auth.usernameStep.subtitle')}
        </Text>

        <View style={styles.inputWrapper}>
          <TextInput
            style={[styles.usernameInput, {
              color: textColor,
              backgroundColor: colors.card,
              borderColor: validation.error ? colors.error : colors.border,
            }]}
            placeholder={t('auth.usernameStep.placeholder')}
            placeholderTextColor={colors.textSecondary}
            value={username}
            onChangeText={handleTextChange}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
        </View>

        <Text style={[styles.inputHint, { color: textColor, opacity: 0.6 }]}>
          {t('auth.usernameStep.hint')}
        </Text>

        {validation.isChecking && (
          <Text style={[styles.checkingText, { color: textColor, opacity: 0.6 }]}>
            {t('auth.usernameStep.checking')}
          </Text>
        )}

        {validation.isAvailable === true && !validation.isChecking && (
          <Text style={[styles.availableText, { color: colors.success }]}>
            {t('auth.usernameStep.available')}
          </Text>
        )}

        {(validation.error || updateError) && (
          <Text style={[styles.errorText, { color: colors.error }]}>{validation.error || updateError}</Text>
        )}

        <Button
          variant="primary"
          onPress={handleContinue}
          disabled={(!canContinue && !isOffline) || isUpdating || isConfirming}
          loading={isUpdating || isConfirming}
          style={styles.primaryButton}
        >
          {isUpdating ? t('auth.usernameStep.saving') : isConfirming ? t('auth.usernameStep.confirming') : t('auth.usernameStep.confirm')}
        </Button>

        {/* Only show skip button if offline and onSkip is provided (for offline fallback) */}
        {isOffline && onSkip && (
          <Button
            variant="ghost"
            onPress={onSkip}
            style={styles.skipButton}
            disabled={isUpdating}
          >
            {t('auth.usernameStep.skip')}
          </Button>
        )}

        {!isOffline && (
          <Button
            variant="ghost"
            onPress={learnMoreDialog.open}
            disabled={isUpdating}
          >
            {t('auth.usernameStep.learnMore')}
          </Button>
        )}
      </KeyboardAwareScrollViewWrapper>

      <Dialog
        control={learnMoreDialog}
        title={t('learnMoreUsernames.introTitle')}
        description={t('learnMoreUsernames.introText')}
        label={t('learnMoreUsernames.introTitle')}
        actions={[{ label: t('common.close'), color: 'cancel' }]}
      >
        <View style={styles.learnMoreSections}>
          {LEARN_MORE_SECTION_IDS.map((id) => (
            <View key={id} style={styles.learnMoreSection}>
              <Text style={[styles.learnMoreSectionTitle, { color: colors.text }]}>
                {t(`learnMoreUsernames.sections.${id}.title`)}
              </Text>
              <Text style={[styles.learnMoreSectionBody, { color: colors.textSecondary }]}>
                {t(`learnMoreUsernames.sections.${id}.content`)}
              </Text>
            </View>
          ))}
          <Text style={[styles.learnMoreFooter, { color: colors.textSecondary }]}>
            {t('learnMoreUsernames.footer')}
          </Text>
        </View>
      </Dialog>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  stepContainer: {
    flex: 1,
    padding: 24,
    paddingTop: 60,
    justifyContent: 'center',
  },
  animationContainer: {
    alignItems: 'center',
    marginBottom: 24,
  },
  lottieAnimation: {
    width: 150,
    height: 150,
  },
  title: {
    fontSize: 38,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 32,
    lineHeight: 22,
    textAlign: 'center',
  },
  inputWrapper: {
    marginTop: 24,
    marginBottom: 8,
  },
  usernameInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
  },
  inputHint: {
    fontSize: 12,
    marginBottom: 8,
  },
  checkingText: {
    fontSize: 12,
    marginTop: 4,
  },
  availableText: {
    fontSize: 12,
    marginTop: 4,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 32,
  },
  skipButton: {
    marginTop: 12,
  },
  learnMoreSections: {
    gap: 20,
    paddingBottom: 20,
  },
  learnMoreSection: {
    gap: 4,
  },
  learnMoreSectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 22,
  },
  learnMoreSectionBody: {
    fontSize: 15,
    lineHeight: 21,
  },
  learnMoreFooter: {
    fontSize: 13,
    lineHeight: 18,
  },
});
