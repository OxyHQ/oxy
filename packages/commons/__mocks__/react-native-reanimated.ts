/**
 * Lightweight stub for `react-native-reanimated` in the commons Jest env.
 */
import { createElement, type ReactNode } from 'react';

const passthrough = ({ children }: { children?: ReactNode }) =>
  createElement('div', null, children);

export const useSharedValue = <T,>(initial: T): { value: T } => ({ value: initial });
export const useAnimatedStyle = (): Record<string, unknown> => ({});
export const withTiming = <T,>(toValue: T): T => toValue;
export const withSpring = <T,>(toValue: T): T => toValue;

const chainableEntering = {
  duration: () => chainableEntering,
  delay: () => chainableEntering,
  springify: () => chainableEntering,
};

export const FadeIn = chainableEntering;
export const FadeOut = chainableEntering;
export const FadeInDown = chainableEntering;

const Animated = {
  View: passthrough,
  Text: passthrough,
  ScrollView: passthrough,
  createAnimatedComponent: <T,>(component: T): T => component,
};

export default Animated;
