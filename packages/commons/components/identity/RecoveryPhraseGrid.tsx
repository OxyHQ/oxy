import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { Fonts } from '@/constants/theme';
import { usePreventScreenCapture } from '@/hooks/usePreventScreenCapture';

interface RecoveryPhraseGridProps {
  /** The recovery words, in order. */
  words: string[];
  textColor: string;
}

/**
 * Numbered word grid for a recovery phrase.
 *
 * Purely presentational — the caller owns reveal gating and phrase provenance.
 * Shared by the onboarding acknowledgement step ({@link RecoveryPhraseStep}) and
 * the Settings re-reveal screen so the phrase renders identically in both.
 *
 * While it is mounted — which is exactly while the words are on screen — the
 * window refuses screenshots and screen recording. Each word stays readable by a
 * screen reader ("Word 3: apple"): the capture guard is the protection, and a
 * blind user needs to hear the words to write them down.
 */
export function RecoveryPhraseGrid({ words, textColor }: RecoveryPhraseGridProps) {
  const colors = useColors();
  const { t } = useTranslation();
  usePreventScreenCapture();

  const wordItems = useMemo(
    () => words.map((word, index) => ({ index: index + 1, word })),
    [words],
  );

  return (
    <View style={styles.wordList}>
      {wordItems.map(({ index, word }) => (
        <View
          key={index}
          style={[styles.wordRow, { borderColor: colors.border }]}
          accessible
          accessibilityRole="text"
          accessibilityLabel={t('auth.recoveryPhrase.wordLabel', { index, word })}
        >
          <Text style={[styles.wordNumber, { color: textColor, opacity: 0.5 }]}>{index}</Text>
          <Text style={[styles.word, { color: textColor }]}>{word}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wordList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  wordRow: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    marginBottom: 8,
  },
  wordNumber: {
    fontSize: 11,
    width: 22,
    fontWeight: '500',
  },
  word: {
    fontSize: 14,
    fontWeight: '500',
    // Monospace keeps recovery words evenly aligned; `Fonts.mono` resolves to
    // the platform monospace stack (`Geist Mono` was never bundled).
    fontFamily: Fonts?.mono,
  },
});
