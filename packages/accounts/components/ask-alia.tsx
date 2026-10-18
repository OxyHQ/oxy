import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { AliaAskProvider, useAskAgent } from '@alia.onl/sdk/ask';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { useColors } from '@/hooks/useColors';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';

/**
 * Alia's one sheet for the whole app (`@alia.onl/sdk/ask`), mounted once at the root beside the
 * inert boundary. The sheet loads with the first "Ask Alia"; signed out, asking opens the in-app
 * Oxy sign-in instead. Conversations it starts are labelled Accounts' (`app`), so its recents are
 * the ones started here. `clientContext` describes the app only: never pass tokens, codes or other
 * account secrets through it.
 */
export function AccountsAskProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const welcomeSuggestions = useMemo(
    () => [
      { id: 'security', text: t('alia.suggestion.security') },
      { id: 'devices', text: t('alia.suggestion.devices') },
      { id: 'data', text: t('alia.suggestion.data') },
    ],
    [t],
  );

  return (
    <AliaAskProvider
      app="accounts"
      clientContext={t('alia.clientContext')}
      welcomeSuggestions={welcomeSuggestions}
    >
      {children}
    </AliaAskProvider>
  );
}

interface AskAliaProps {
  /** Show the "Ask Alia" word beside the icon (desktop); mobile is icon-only. */
  showLabel?: boolean;
}

/** The "Ask Alia" header button: opens the app's one sheet on Alia. */
export function AskAlia({ showLabel = false }: AskAliaProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const { ask } = useAskAgent();
  const handlePressIn = useHapticPress();

  return (
    <TouchableOpacity
      onPressIn={handlePressIn}
      onPress={() => ask()}
      activeOpacity={0.7}
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={t('alia.ask')}
      accessibilityHint={t('alia.askHint')}
    >
      <RiSparklingLine width={22} height={22} fill={colors.text} />
      {showLabel ? (
        <Text style={[styles.label, { color: colors.text }]}>{t('alia.ask')}</Text>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
});
