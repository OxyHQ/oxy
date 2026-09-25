/**
 * The onboarding titles animate letter by letter, so each letter is its own
 * `Text`. Exposed, TalkBack read the welcome title as "O", "x", "y", … one node
 * per letter (OxyHQ/oxy#1375 item 10). The animation is hidden; the string is
 * exposed once.
 */

import React from 'react';
import { render } from '@testing-library/react';

// The shared stubs drop every prop but a few queryable ones; this subject IS
// the accessibility props, so these stubs forward them as the DOM spells them.
jest.mock('react-native', () => {
  const { createElement } = jest.requireActual('react');
  const a11y = (props: Record<string, unknown>) => ({
    'aria-label': props.accessibilityLabel,
    'aria-hidden': props['aria-hidden'] ? 'true' : undefined,
    role: props.accessibilityRole,
  });
  const Box = ({ children, ...props }: Record<string, unknown>) =>
    createElement('div', a11y(props), children);
  const Text = ({ children, ...props }: Record<string, unknown>) =>
    createElement('span', a11y(props), children);
  return {
    View: Box,
    Text,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  };
});
jest.mock('react-native-reanimated', () => {
  const { createElement } = jest.requireActual('react');
  const Box = ({ children, ...props }: Record<string, unknown>) =>
    createElement('div', { 'aria-hidden': props['aria-hidden'] ? 'true' : undefined }, children);
  const Text = ({ children }: Record<string, unknown>) => createElement('span', null, children);
  return {
    __esModule: true,
    default: { View: Box, Text, createAnimatedComponent: (c: unknown) => c },
    useSharedValue: (v: unknown) => ({ value: v }),
    useDerivedValue: (f: () => unknown) => ({ value: f() }),
    useAnimatedStyle: () => ({}),
    useAnimatedReaction: () => undefined,
    withDelay: (_d: number, v: unknown) => v,
    withSpring: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...v: unknown[]) => v[v.length - 1],
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' },
    Easing: { bezier: () => () => 0, out: () => () => 0, inOut: () => () => 0, ease: () => 0, cubic: () => 0 },
    runOnJS: (f: unknown) => f,
    cancelAnimation: () => undefined,
  };
});
import { StaggeredText } from '@/components/staggered-text';
import { RotatingTextAnimation } from '@/components/staggered-text/rotating-text';

describe('animated onboarding text reaches assistive technology once', () => {
  it('StaggeredText is ONE labelled node over hidden letters', () => {
    const { container } = render(<StaggeredText text="Oxy is your" fontSize={38} />);

    const labelled = container.querySelectorAll('[aria-label]');
    expect(labelled).toHaveLength(1);
    expect(labelled[0]?.getAttribute('aria-label')).toBe('Oxy is your');
    const words = labelled[0]?.children ?? [];
    expect(words.length).toBeGreaterThan(0);
    for (const word of Array.from(words)) {
      expect(word.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('RotatingTextAnimation is hidden — the screen names the sentence it completes', () => {
    const { container } = render(
      <RotatingTextAnimation texts={['human ID', 'digital identity']} fontSize={38} />,
    );

    expect((container.firstElementChild as HTMLElement | null)?.getAttribute('aria-hidden')).toBe('true');
  });
});
