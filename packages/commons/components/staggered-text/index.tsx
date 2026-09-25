import {
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  StyleSheet,
  View,
} from 'react-native';

import { forwardRef, useImperativeHandle, useMemo } from 'react';

import {
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSpring,
} from 'react-native-reanimated';

import { StaggeredDigit } from './staggered-digit';

import type { ForwardedRef } from 'react';

/**
 * Props for the StaggeredText component
 */
type StaggeredTextProps = {
  /** The text to be animated */
  text: string;
  /** Delay in milliseconds before starting the animation */
  delay?: number;
  /** Font size of the text */
  fontSize?: number;
  /** Additional text styles to be applied */
  textStyle?: StyleProp<TextStyle>;
  /** Additional container styles to be applied */
  containerStyle?: StyleProp<ViewStyle>;
  /** Enable reverse animation support */
  enableReverse?: boolean;
};

/**
 * Ref methods exposed by the StaggeredText component
 */
export type StaggeredTextRef = {
  /** Starts the staggered animation */
  animate: () => void;
  /** Resets the animation to its initial state */
  reset: () => void;
  /** Toggles between forward and reverse animation (requires enableReverse prop) */
  toggleAnimate: () => void;
};

/**
 * A component that creates a staggered animation effect for text.
 * Each character of the text animates individually with a slight delay,
 * creating a wave-like animation effect.
 *
 * @example
 * ```tsx
 * const textRef = useRef<StaggeredTextRef>(null);
 *
 * <StaggeredText
 *   text="Hello World"
 *   ref={textRef}
 *   fontSize={50}
 *   delay={300}
 * />
 *
 * // Trigger animation
 * textRef.current?.animate();
 * ```
 */
type StaggeredCharProps = {
  char: string;
  index: number;
  progress: ReturnType<typeof useSharedValue<number>>;
  delay: number;
  fontSize: number;
  textStyle?: StyleProp<TextStyle>;
  enableReverse: boolean;
};

const StaggeredChar = ({
  char,
  index,
  progress,
  delay,
  fontSize,
  textStyle,
  enableReverse,
}: StaggeredCharProps) => {
  const delayedProgress = useDerivedValue(() => {
    'worklet';

    if (progress.value === 0 && !enableReverse) {
      return 0;
    }

    const delayMs = index * 40 + delay;
    return withDelay(
      delayMs,
      withSpring(progress.value, {
        duration: 350,
        dampingRatio: 2.8,
      }),
    );
  });

  return (
    <StaggeredDigit
      digit={char}
      progress={delayedProgress}
      fontSize={fontSize}
      textStyle={textStyle}
    />
  );
};

export const StaggeredText = forwardRef(
  (
    {
      text,
      delay = 0,
      fontSize = 50,
      textStyle,
      containerStyle,
      enableReverse = false,
    }: StaggeredTextProps,
    ref: ForwardedRef<StaggeredTextRef>,
  ) => {
    const progress = useSharedValue(0);

    useImperativeHandle(ref, () => ({
      animate: () => {
        setTimeout(() => {
          progress.value = 1;
        }, 0);
      },
      reset: () => {
        progress.value = 0;
      },
      toggleAnimate: () => {
        if (!enableReverse) {
          console.warn(
            'You must add the "enableReverse" prop to the StaggeredText to support the toggleAnimate method',
          );
          return;
        }
        progress.value = progress.value === 0 ? 1 : 0;
      },
    }));

    // Group characters by words to prevent word breaks
    const wordGroups = useMemo(() => {
      const words: string[] = [];
      const parts = text.split(/(\s+)/); // Split by spaces but keep the spaces
      
      parts.forEach(part => {
        if (part.trim() === '') {
          // This is a space - add it as a separate "word" group
          words.push(part);
        } else {
          // This is a word - add it as a group
          words.push(part);
        }
      });
      
      return words;
    }, [text]);

    // Calculate character index offset for each word group
    let charIndexOffset = 0;

    // ONE text node for assistive technology: each letter is its own animated
    // `Text`, so unhidden, TalkBack read "O", "x", "y", … one node per letter
    // (OxyHQ/oxy#1375 item 10). The container carries the whole string; the
    // letters are hidden beneath it.
    return (
      <View style={[styles.container, containerStyle]} accessible accessibilityLabel={text}>
        {wordGroups.map((word, wordIndex) => {
          const wordStartIndex = charIndexOffset;
          const wordChars = word.split('');
          charIndexOffset += wordChars.length;
          
          return (
            <View key={wordIndex} style={styles.wordGroup} aria-hidden>
              {wordChars.map((char, charIndex) => (
                <StaggeredChar
                  key={charIndex}
                  char={char}
                  index={wordStartIndex + charIndex}
                  progress={progress}
                  delay={delay}
                  fontSize={fontSize}
                  textStyle={textStyle}
                  enableReverse={enableReverse}
                />
              ))}
            </View>
          );
        })}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  wordGroup: {
    flexDirection: 'row',
    flexShrink: 0, // Prevent word groups from shrinking/breaking
  },
});

