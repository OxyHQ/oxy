import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { Icons } from '@/constants/icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Button } from '@oxy.so/bloom/button';
import { ImportantBanner } from '@/components/ui';
import { RecoveryPhraseGrid } from '@/components/identity/RecoveryPhraseGrid';
import { useTranslation } from '@/lib/i18n';

interface RecoveryPhraseStepProps {
  /**
   * The 12 (or 24) words of the user's recovery phrase. MUST come from
   * the in-memory `recoveryPhraseRef` — never read from storage.
   */
  words: string[] | null;
  /**
   * Whether the words should be rendered visible. False initially so the
   * user must explicitly tap "reveal" — this is a soft defense against
   * shoulder-surfing during onboarding.
   */
  revealed: boolean;
  onReveal: () => void;
  onHide: () => void;
  /**
   * The user must check this box before `onContinue` is enabled.
   * The parent screen is responsible for blocking back navigation while
   * this is false.
   */
  acknowledged: boolean;
  onAcknowledgeChange: (value: boolean) => void;
  onContinue: () => void;
  /**
   * Optional handler invoked when the words array is missing (e.g., a
   * screen refresh blew away the in-memory phrase). The parent should
   * show an error route — there's no UI for re-deriving the phrase here.
   */
  onMissingPhrase?: () => void;
  isContinuing?: boolean;
  backgroundColor: string;
  textColor: string;
  /** Bottom inset for scroll content; defaults to auth onboarding clearance. */
  contentBottomPad?: number;
}

/**
 * Recovery phrase reveal step.
 *
 * Forces the user to:
 *   1. Tap "Reveal" to see the words (one-time visibility, defense against
 *      shoulder-surfing during the flow).
 *   2. Check the acknowledgement box.
 *   3. Tap "Continue".
 *
 * There is no "copy to clipboard" or "screenshot" affordance by design —
 * any digital persistence of the recovery phrase outside the secure
 * enclave defeats its security model.
 */
export function RecoveryPhraseStep({
  words,
  revealed,
  onReveal,
  onHide,
  acknowledged,
  onAcknowledgeChange,
  onContinue,
  onMissingPhrase,
  isContinuing = false,
  backgroundColor,
  textColor,
  contentBottomPad = 60,
}: RecoveryPhraseStepProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [hasReportedMissing, setHasReportedMissing] = useState(false);

  // The phrase may be missing if the user reloaded the app between
  // generation and this screen. Without it we cannot continue safely —
  // bubble up so the parent can route to an error / re-create path.
  const hasPhrase = Array.isArray(words) && words.length > 0;

  // Use a ref-like guard so we only fire onMissingPhrase once per mount.
  if (!hasPhrase && !hasReportedMissing && onMissingPhrase) {
    setHasReportedMissing(true);
    // Schedule outside render — calling parent setState during render is
    // an anti-pattern and breaks concurrent React.
    Promise.resolve().then(onMissingPhrase);
  }

  if (!hasPhrase) {
    return (
      <View style={[styles.container, { backgroundColor, paddingTop: insets.top + 16 }]}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingBottom: contentBottomPad }]}
          showsVerticalScrollIndicator={false}
        >
          <View className="items-center mb-space-20 px-space-8">
            <Icons.key size="2xl" fill={colors.error} />
            <Text style={[styles.title, { color: textColor }]}>
              {t('auth.recoveryPhrase.missingTitle')}
            </Text>
            <Text style={[styles.subtitle, { color: textColor, opacity: 0.7 }]}>
              {t('auth.recoveryPhrase.missingMessage')}
            </Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor, paddingTop: insets.top + 16 }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: contentBottomPad }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center mb-space-20 px-space-8">
          <Icons.shield size="2xl" fill={colors.tint} />
          <Text style={[styles.title, { color: textColor }]}>{t('auth.recoveryPhrase.title')}</Text>
          <Text style={[styles.subtitle, { color: textColor, opacity: 0.7 }]}>
            {t('auth.recoveryPhrase.subtitle')}
          </Text>
        </View>

        <ImportantBanner title={t('auth.recoveryPhrase.warningTitle')}>
          {t('auth.recoveryPhrase.warning')}
        </ImportantBanner>

        <View
          style={[
            styles.phraseGrid,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
          accessibilityRole="text"
          accessibilityLabel={
            revealed ? t('auth.recoveryPhrase.title') : t('auth.recoveryPhrase.showButton')
          }
        >
          {!revealed ? (
            <TouchableOpacity
              style={styles.revealOverlay}
              onPress={onReveal}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('auth.recoveryPhrase.showButton')}
            >
              <Icons.hidden size="xl" fill={textColor} />
              <Text style={[styles.revealLabel, { color: textColor }]}>
                {t('auth.recoveryPhrase.showButton')}
              </Text>
            </TouchableOpacity>
          ) : (
            <RecoveryPhraseGrid words={words as string[]} textColor={textColor} />
          )}
        </View>

        {revealed && (
          <>
            <Button
              appearance="plain"
              tone="accent"
              leadingIcon={Icons.hidden}
              onPress={onHide}
              accessibilityLabel={t('auth.recoveryPhrase.hideButton')}
              style={styles.hideLink}
            >
              {t('auth.recoveryPhrase.hideButton')}
            </Button>

            <Text style={[styles.copyWarning, { color: colors.warning }]}>
              {t('auth.recoveryPhrase.copyWarning')}
            </Text>
          </>
        )}

        <Checkbox
          checked={acknowledged}
          onCheckedChange={onAcknowledgeChange}
          disabled={!revealed}
          label={t('auth.recoveryPhrase.confirmCheckbox')}
          accessibilityLabel={t('auth.recoveryPhrase.confirmCheckbox')}
          style={styles.acknowledge}
        />

        <Button
          appearance="solid"
          tone="accent"
          onPress={onContinue}
          disabled={!revealed || !acknowledged || isContinuing}
          loading={isContinuing}
          className="mt-space-4"
        >
          {t('auth.recoveryPhrase.continueButton')}
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 24,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  phraseGrid: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    minHeight: 240,
    marginTop: 20,
    marginBottom: 12,
    justifyContent: 'center',
  },
  revealOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
  },
  revealLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  hideLink: {
    alignSelf: 'center',
    marginBottom: 4,
  },
  copyWarning: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 16,
    fontStyle: 'italic',
  },
  acknowledge: {
    marginTop: 8,
    marginBottom: 24,
  },
});
