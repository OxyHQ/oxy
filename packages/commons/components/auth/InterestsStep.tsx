import React, { useCallback, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { InterestTagsCanvas } from '@/components/auth/InterestTagsCanvas';

interface InterestsStepProps {
  onContinue: (selectedIds: string[]) => void;
  isSubmitting?: boolean;
}

/**
 * Interests step: the user taps the falling tags that describe them.
 *
 * It runs AFTER the account exists, so the selection has somewhere to live.
 *
 * The canvas fills the WHOLE screen — it sits under the status bar and the
 * notch, so the tags drop in from behind the notch rather than appearing below
 * a header. The header and the footer are drawn over it, and the footer's
 * measured height becomes the canvas floor so the pile never ends up behind
 * the button.
 */
export function InterestsStep({ onContinue, isSubmitting = false }: InterestsStepProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [footerHeight, setFooterHeight] = useState(0);

  const handleToggle = useCallback((tagId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  }, []);

  const handleContinue = useCallback(() => {
    onContinue([...selectedIds]);
  }, [onContinue, selectedIds]);

  const handleFooterLayout = useCallback((event: LayoutChangeEvent) => {
    setFooterHeight(event.nativeEvent.layout.height);
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={StyleSheet.absoluteFill}>
        {footerHeight > 0 && (
          <InterestTagsCanvas
            selectedIds={selectedIds}
            onToggle={handleToggle}
            labelColor={colors.text}
            outlineColor={colors.text}
            floorInset={footerHeight}
          />
        )}
      </View>

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.header, { paddingTop: insets.top + 26 }]} pointerEvents="none">
          <Animated.View entering={FadeInDown.delay(300).duration(800).springify()}>
            <Text style={[styles.title, { color: colors.text }]}>
              Build around{'\n'}what you love
            </Text>
          </Animated.View>
          <Animated.View entering={FadeInDown.delay(400).duration(800).springify()}>
            <Text style={[styles.subtitle, { color: colors.text }]}>
              Tap what feels like you. Drag and toss the rest.
            </Text>
          </Animated.View>
        </View>

        <Animated.View
          style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}
          entering={FadeInDown.delay(600).duration(800).springify()}
          onLayout={handleFooterLayout}
        >
          <Text style={[styles.count, { color: colors.text }]}>
            {selectedIds.size === 0 ? 'Pick as many as you like' : `${selectedIds.size} selected`}
          </Text>
          <Button onPress={handleContinue} loading={isSubmitting} disabled={isSubmitting}>
            {selectedIds.size === 0 ? 'Skip for now' : 'Continue'}
          </Button>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  overlay: { flex: 1, justifyContent: 'space-between' },
  header: { paddingHorizontal: 24, gap: 12 },
  title: { fontSize: 32, fontWeight: '800', lineHeight: 38, letterSpacing: -0.7 },
  subtitle: { fontSize: 15, lineHeight: 22, opacity: 0.6 },
  footer: { paddingHorizontal: 24, paddingTop: 16, gap: 12 },
  count: { fontSize: 13, textAlign: 'center', opacity: 0.6 },
});
