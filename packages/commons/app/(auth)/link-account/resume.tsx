import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, type Href } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { LoadingState } from '@/components/ui/loading-state';
import { useTranslation } from '@/lib/i18n';
import { readPendingLink } from '@/lib/link-account/pendingLink';

/**
 * Where an unfinished onboarding resumes when its key was made to link a web
 * account (`OnboardingFlow` `link`). The confirmation screen picks up from
 * where the request stands (waiting for the other screen, sign in, or a
 * request that can no longer finish, whose key it removes when leaving).
 *
 * Without this, resuming went to the create wizard, whose username step
 * registered the link's key as a NEW account.
 */
export default function LinkAccountResumeScreen() {
  const colors = useColors();
  const { t } = useTranslation();
  const [href, setHref] = useState<Href | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readPendingLink().then((pending) => {
      if (cancelled) return;
      setHref(
        pending
          ? {
              pathname: '/(auth)/link-account/confirm',
              params: { id: pending.linkId, c: pending.challenge },
            }
          : // No request to resume: start the link again rather than register.
            '/(auth)/link-account',
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (href) return <Redirect href={href} />;
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <LoadingState title={t('linkAccount.loading')} />
    </View>
  );
}

const styles = StyleSheet.create({ container: { flex: 1 } });
