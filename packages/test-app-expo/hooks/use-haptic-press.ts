import { useCallback } from 'react';
import * as Haptics from 'expo-haptics';

/**
 * Hook that returns a memoized callback for haptic feedback on press.
 * Provides consistent light haptic feedback across the app.
 *
 * @returns A stable callback function that triggers haptic feedback
 */
export function useHapticPress() {
  return useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);
}
