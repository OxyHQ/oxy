import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import { usePreventScreenCapture } from '@/hooks/usePreventScreenCapture';

interface PhraseInputGridProps {
  /** The current words. Length drives how many inputs are rendered (12 or 24). */
  words: string[];
  /** Called when a single word input changes. */
  onWordChange: (index: number, word: string) => void;
  /**
   * Called when the user pastes a full space-separated phrase into the first
   * field. The parent decides how to split/assign it.
   */
  onPaste: (text: string) => void;
  /** Disable editing (e.g. while a restore/backup request is in flight). */
  editable?: boolean;
}

/**
 * The numbered recovery-phrase word-entry grid.
 *
 * Extracted so the three phrase-entry surfaces — import identity, create an
 * encrypted backup, and restore from backup — share ONE implementation of the
 * paste-into-first-field detection and the numbered layout, instead of each
 * re-deriving it. Purely presentational: it owns no phrase state.
 *
 * The words typed here are the recovery phrase, so the window refuses
 * screenshots and screen recording while the grid is mounted.
 */
export function PhraseInputGrid({
  words,
  onWordChange,
  onPaste,
  editable = true,
}: PhraseInputGridProps) {
  const colors = useColors();
  const { t } = useTranslation();
  usePreventScreenCapture();

  return (
    <View style={[styles.phraseGrid, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {words.map((word, index) => (
        <View key={index} style={styles.wordInputContainer}>
          <Text style={[styles.wordNumber, { color: colors.text, opacity: 0.6 }]}>{index + 1}</Text>
          <TextInput
            style={[styles.wordInput, { color: colors.text, borderColor: colors.border }]}
            value={word}
            editable={editable}
            onChangeText={(text) => {
              // Detect paste: multiple space-separated words dropped into the
              // first field are treated as the whole phrase.
              if (index === 0 && text.includes(' ') && text.split(/\s+/).length > 1) {
                onPaste(text);
              } else {
                onWordChange(index, text);
              }
            }}
            placeholder={t('auth.importStep.wordPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  phraseGrid: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  wordInputContainer: {
    width: '30%',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  wordNumber: {
    fontSize: 12,
    width: 20,
  },
  wordInput: {
    flex: 1,
    borderBottomWidth: 1,
    paddingVertical: 4,
    fontSize: 14,
  },
});
