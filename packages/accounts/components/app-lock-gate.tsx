/**
 * The app lock: when "Face ID / Touch ID" (or fingerprint) is turned on in
 * Security → On this device, the app asks for it when it opens and every time
 * it comes back from the background, and covers everything until it passes.
 *
 * Whether it applies is `isAppLockEnabled` (`lib/appLock.ts`): the preference
 * `useBiometricSettings` keeps on this device, on a device that can still use
 * biometrics. Web has no lock.
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { LogoIcon } from '@oxy.so/services';
import { ThemedText } from '@/components/themed-text';
import { useColors } from '@/hooks/useColors';
import { isAppLockEnabled } from '@/lib/appLock';
import { authenticate } from '@/lib/biometricAuth';
import { useTranslation } from '@/lib/i18n';

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const { t } = useTranslation();
  // `unknown` until the preference is read: the content stays covered (a plain
  // background, no lock screen) so a locked device paints nothing first and an
  // unlocked one does not flash the lock. The web never locks.
  const [state, setState] = useState<'unknown' | 'locked' | 'open'>(
    Platform.OS === 'web' ? 'open' : 'unknown',
  );
  const [prompting, setPrompting] = useState(false);
  const promptingRef = useRef(false);

  const unlock = useCallback(async () => {
    if (promptingRef.current) return;
    if (!(await isAppLockEnabled())) {
      setState('open');
      return;
    }
    setState('locked');
    promptingRef.current = true;
    setPrompting(true);
    try {
      const result = await authenticate(t('appLock.reason'));
      if (result.success) setState('open');
    } finally {
      promptingRef.current = false;
      setPrompting(false);
    }
  }, [t]);

  // On open: ask right away.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void unlock();
  }, [unlock]);

  // Back from the background: lock again and ask. `background` only — the
  // system prompt itself makes iOS `inactive`, which must not re-lock.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let wasBackground = false;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        wasBackground = true;
        void isAppLockEnabled().then((enabled) => {
          if (enabled) setState('locked');
        });
      } else if (state === 'active' && wasBackground) {
        wasBackground = false;
        void unlock();
      }
    });
    return () => subscription.remove();
  }, [unlock]);

  return (
    <View style={styles.root}>
      {children}
      {state === 'unknown' ? (
        <View
          style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: colors.background }]}
        />
      ) : null}
      {state === 'locked' ? (
        <View
          style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: colors.background }]}
          accessibilityViewIsModal
          testID="app-lock"
        >
          <LogoIcon height={56} />
          <ThemedText style={styles.title}>{t('appLock.title')}</ThemedText>
          <ThemedText style={styles.subtitle}>{t('appLock.subtitle')}</ThemedText>
          <Button
            appearance="solid"
            size="lg"
            onPress={() => void unlock()}
            disabled={prompting}
            testID="app-lock-unlock"
          >
            {t('appLock.unlock')}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  cover: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 32,
    zIndex: 1000,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    opacity: 0.7,
    textAlign: 'center',
  },
});
