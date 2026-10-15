import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { VoiceSession } from '@alia.onl/sdk/voice';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { useAuth } from '@oxy.so/services';
import { useColors } from '@/hooks/useColors';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { useTranslation } from '@/lib/i18n';

interface AskAliaProps {
  /** Show the "Ask Alia" word beside the icon (desktop); mobile is icon-only. */
  showLabel?: boolean;
}

/**
 * The "Ask Alia" header button and the chat sheet it opens.
 *
 * Pressing it signed out opens the in-app Oxy sign-in dialog rather than a sheet
 * that could not call Alia. The sheet itself is mounted only once the session can
 * use the private API. `clientContext` describes the app only: never pass tokens,
 * codes or other account secrets through it.
 */
export function AskAlia({ showLabel = false }: AskAliaProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const { canUsePrivateApi, signIn } = useAuth();
  const chatRef = useRef<AliaChatSheetRef>(null);
  const handlePressIn = useHapticPress();

  const welcomeSuggestions = useMemo(
    () => [
      { id: 'security', text: t('alia.suggestion.security') },
      { id: 'devices', text: t('alia.suggestion.devices') },
      { id: 'data', text: t('alia.suggestion.data') },
    ],
    [t],
  );

  const handleAskAlia = useCallback(() => {
    if (canUsePrivateApi) chatRef.current?.present();
    else void signIn();
  }, [canUsePrivateApi, signIn]);

  return (
    <>
      <TouchableOpacity
        onPressIn={handlePressIn}
        onPress={handleAskAlia}
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
      {canUsePrivateApi && (
        <AliaChatSheet
          ref={chatRef}
          voiceSession={VoiceSession}
          clientContext={t('alia.clientContext')}
          welcomeSuggestions={welcomeSuggestions}
        />
      )}
    </>
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
