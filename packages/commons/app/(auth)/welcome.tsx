import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Animated, {
  useSharedValue,
  withTiming,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { Checkbox } from 'expo-checkbox';
import { useColors } from '@/hooks/useColors';
import { StaggeredText, type StaggeredTextRef } from '@/components/staggered-text';
import { RotatingTextAnimation } from '@/components/staggered-text/rotating-text';
import { Button } from '@oxy.so/bloom/button';
import { useTranslation } from '@/lib/i18n';
import { persistOnboardingFlow } from '@/hooks/identity/identityStore';

const ROTATING_TEXT_KEYS = [
  'auth.welcome.rotating.humanId',
  'auth.welcome.rotating.digitalIdentity',
  'auth.welcome.rotating.privacyAccount',
  'auth.welcome.rotating.secureIdentity',
  'auth.welcome.rotating.ethicalAppsGateway',
  'auth.welcome.rotating.digitalTrustFoundation',
  'auth.welcome.rotating.ecosystemAccount',
  'auth.welcome.rotating.humanTechKey',
  'auth.welcome.rotating.fairDigitalPassport',
  'auth.welcome.rotating.noPasswordsIdentity',
  'auth.welcome.rotating.trustLayer',
  'auth.welcome.rotating.humanNetworkConnection',
  'auth.welcome.rotating.ethicalTechAccess',
  'auth.welcome.rotating.dataOwnership',
  'auth.welcome.rotating.uniqueAppsIdentity',
] as const;

export default function WelcomeScreen() {
  const router = useRouter();
  const colors = useColors();
  const { t } = useTranslation();
  const rotatingTexts = useMemo(
    () => ROTATING_TEXT_KEYS.map((key) => t(key)),
    [t],
  );

  const backgroundColor = colors.background;
  const textColor = colors.text;

  const [termsAccepted, setTermsAccepted] = useState(false);

  // Entrance animation values
  const oxyOpacity = useSharedValue(0);
  const oxyTranslateY = useSharedValue(20);
  const rotatingOpacity = useSharedValue(0);
  const footerOpacity = useSharedValue(0);

  // Refs for staggered text
  const oxyRef = useRef<StaggeredTextRef>(null);

  // Animated styles
  const entranceOxyStyle = useAnimatedStyle(() => ({
    opacity: oxyOpacity.value,
    transform: [{ translateY: oxyTranslateY.value }],
  }));

  const entranceRotatingStyle = useAnimatedStyle(() => ({
    opacity: rotatingOpacity.value,
  }));

  const footerStyle = useAnimatedStyle(() => ({
    opacity: footerOpacity.value,
  }));

  // Memoize style objects to prevent recreation on every render
  const containerStyle = useMemo(() => ({ backgroundColor }), [backgroundColor]);
  const textStyleMemo = useMemo(() => [styles.text, { color: textColor }], [textColor]);
  const rotatingTextStyleMemo = useMemo(() => ({ ...styles.text, color: textColor }), [textColor]);
  const checkboxTextStyleMemo = useMemo(() => [styles.checkboxText, { color: textColor }], [textColor]);

  // Consolidated entrance animation
  useEffect(() => {
    // Start Oxy animation after 200ms
    const t1 = setTimeout(() => {
      oxyOpacity.value = withTiming(1, { duration: 600 });
      oxyTranslateY.value = withTiming(0, { duration: 600 });
      oxyRef.current?.reset();
      // Start staggered text animation after reset
      setTimeout(() => {
        oxyRef.current?.animate();
      }, 200);
    }, 200);

    // Start rotating animation after 800ms
    const t2 = setTimeout(() => {
      rotatingOpacity.value = withTiming(1, { duration: 600 });
    }, 800);

    // Start footer animation after 1500ms
    const t3 = setTimeout(() => {
      footerOpacity.value = withTiming(1, { duration: 600 });
    }, 1500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleContinue = useCallback(() => {
    if (termsAccepted) {
      void persistOnboardingFlow('create');
      router.replace('/(auth)/create-identity');
    }
  }, [termsAccepted, router]);

  const handleRestore = useCallback(() => {
    void persistOnboardingFlow('import');
    router.replace('/(auth)/import-identity');
  }, [router]);

  const handleDecline = useCallback(() => {
    router.back();
  }, [router]);

  const toggleTermsAccepted = useCallback(() => {
    setTermsAccepted(prev => !prev);
  }, []);

  return (
    <View style={[styles.container, containerStyle]}>
      <View className="flex-1 justify-center items-center px-space-24">
        {/* ONE heading for assistive technology: the lead and the rotating
            phrase are per-letter / multi-copy animations, so the sentence they
            form is named here once and the animation itself is hidden. */}
        <View
          style={styles.textContainer}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${t('auth.welcome.lead')} ${rotatingTexts[0]}`}
        >
          {/* "Oxy is your" text */}
          <Animated.View style={entranceOxyStyle} aria-hidden>
            <StaggeredText
              text={t('auth.welcome.lead')}
              ref={oxyRef}
              fontSize={38}
              textStyle={textStyleMemo}
            />
          </Animated.View>

          {/* Rotating text with drum effect */}
          <Animated.View style={entranceRotatingStyle}>
            <RotatingTextAnimation
              texts={rotatingTexts}
              fontSize={38}
              interval={3000}
              duration={600}
              textStyle={rotatingTextStyleMemo}
              containerStyle={styles.rotatingContainer}
            />
          </Animated.View>
        </View>
      </View>

      {/* Footer */}
      <Animated.View style={[styles.footer, footerStyle]}>
        <View className="flex-row items-start mb-space-32">
          <Checkbox
            value={termsAccepted}
            onValueChange={setTermsAccepted}
            style={styles.checkbox}
            color={textColor}
          />
          <TouchableOpacity
            className="flex-1"
            onPress={toggleTermsAccepted}
            activeOpacity={0.7}
            accessibilityRole="checkbox"
            accessibilityLabel={t('auth.welcome.termsAgree')}
            accessibilityState={{ checked: termsAccepted }}
          >
            <Text style={checkboxTextStyleMemo}>
              {t('auth.welcome.termsAgree')}
            </Text>
          </TouchableOpacity>
        </View>

        <View className="flex-row gap-space-12">
          <Button appearance="outline" tone="neutral" onPress={handleDecline} className="flex-1">{t('auth.welcome.decline')}</Button>

          <Button appearance="solid" tone="accent" onPress={handleContinue} disabled={!termsAccepted} className="flex-1">{t('auth.welcome.accept')}</Button>
        </View>

        <TouchableOpacity
          className="mt-space-20 items-center"
          onPress={handleRestore}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('auth.welcome.restore')}
        >
          <Text style={[styles.restoreText, { color: textColor }]}>
            {t('auth.welcome.restore')}
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  textContainer: {
    alignItems: 'flex-start',
    gap: -16,
    width: '100%',
  },
  rotatingContainer: {
    width: '100%',
  },
  text: {
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  footer: {
    padding: 42,
    paddingBottom: 60,
  },
  checkbox: {
    width: 24,
    height: 24,
    marginRight: 12,
    marginTop: 2,
  },
  checkboxText: {
    fontSize: 14,
    lineHeight: 20,
  },
  restoreText: {
    fontSize: 14,
    fontWeight: '500',
    opacity: 0.7,
    textDecorationLine: 'underline',
  },
});
