import { Animated } from 'react-native';

// Simple hex color manipulation without color package
const hexToRgb = (hex: string): [number, number, number] => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
};

const rgbToHex = (r: number, g: number, b: number): string => {
  return `#${[r, g, b]
    .map((x) => {
      const hex = Math.round(x).toString(16);
      return hex.length === 1 ? `0${hex}` : hex;
    })
    .join('')}`;
};

const mixColors = (color1: string, color2: string, ratio: number): string => {
  const [r1, g1, b1] = hexToRgb(color1);
  const [r2, g2, b2] = hexToRgb(color2);
  const r = r1 + (r2 - r1) * ratio;
  const g = g1 + (g2 - g1) * ratio;
  const b = b1 + (b2 - b1) * ratio;
  return rgbToHex(r, g, b);
};

export const isAnimatedValue = (
  it: number | string | Animated.AnimatedInterpolation<number | string>,
): it is Animated.Value => it instanceof Animated.Value;

// Overloaded signatures so each call site gets the right return type
// without the conditional-type narrowing that TS cannot infer inside the
// implementation body.
function overlay(elevation: number, surfaceColor?: string): string;
function overlay(
  elevation: Animated.Value,
  surfaceColor?: string,
): Animated.AnimatedInterpolation<number | string>;
function overlay(
  elevation: Animated.Value | number,
  surfaceColor = '#121212',
): string | Animated.AnimatedInterpolation<number | string> {
  if (isAnimatedValue(elevation)) {
    const inputRange = [0, 1, 2, 3, 8, 24];

    return elevation.interpolate({
      inputRange,
      outputRange: inputRange.map((e) => calculateColor(surfaceColor, e)),
    });
  }

  return calculateColor(surfaceColor, elevation);
}

export default overlay;

function calculateColor(surfaceColor: string, elevation = 1) {
  let overlayTransparency: number;
  if (elevation >= 1 && elevation <= 24) {
    overlayTransparency = elevationOverlayTransparency[elevation];
  } else if (elevation > 24) {
    overlayTransparency = elevationOverlayTransparency[24];
  } else {
    overlayTransparency = elevationOverlayTransparency[1];
  }
  return mixColors(surfaceColor, '#FFFFFF', overlayTransparency * 0.01);
}

const elevationOverlayTransparency: Record<string, number> = {
  1: 5,
  2: 7,
  3: 8,
  4: 9,
  5: 10,
  6: 11,
  7: 11.5,
  8: 12,
  9: 12.5,
  10: 13,
  11: 13.5,
  12: 14,
  13: 14.25,
  14: 14.5,
  15: 14.75,
  16: 15,
  17: 15.12,
  18: 15.24,
  19: 15.36,
  20: 15.48,
  21: 15.6,
  22: 15.72,
  23: 15.84,
  24: 16,
};
