/**
 * Lightweight stub for `react-native-reanimated` used by the services jest
 * environment. Animated components render as their plain children (the `react-
 * native` mock already renders `View` as a `div`), shared values are inert
 * boxes, and layout-animation builders (`FadeIn`) are chainable no-ops — enough
 * for component tests to render without the native reanimated runtime.
 */
import { createElement, type ReactNode } from 'react';

const passthrough = ({ children }: { children?: ReactNode; [key: string]: unknown }) =>
  createElement('div', null, children);

export const useSharedValue = <T>(initial: T): { value: T } => ({ value: initial });
export const useAnimatedStyle = (): Record<string, unknown> => ({});
export const withTiming = <T>(toValue: T): T => toValue;
export const withSpring = <T>(toValue: T): T => toValue;

const chainableEntering = {
  duration: () => chainableEntering,
  delay: () => chainableEntering,
  springify: () => chainableEntering,
};

export const FadeIn = chainableEntering;
export const FadeOut = chainableEntering;

const Animated = {
  View: passthrough,
  Text: passthrough,
  ScrollView: passthrough,
  createAnimatedComponent: <T>(component: T): T => component,
};

export default Animated;
