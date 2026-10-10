/**
 * Shared tilt state for the Oxy ID card, plus the `ParallaxLayer` primitive.
 *
 * Depth on the card is faked with manual parallax: RN 0.86's transform whitelist
 * has no reliable per-layer `translateZ`, so instead each layer translates in the
 * plane proportional to the current tilt angle and its assigned "elevation". A
 * higher elevation leads the motion (floats above the face); a negative elevation
 * trails (recedes below it). All layers share one container `perspective +
 * rotateX/rotateY`, so together they read as genuine 3D.
 */

import { type ReactNode } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import { createContext, useContext } from 'react';
import Animated, {
  useAnimatedStyle,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';

// Per-layer depths (screen-space parallax lead/trail). Kept at 0 so the printed
// content stays FLAT on the card surface (like a real ID/passport) instead of
// floating above the hologram. The card still tilts as a whole in 3D.
export const HOLOGRAM_ELEVATION = 0;
export const AVATAR_ELEVATION = 0;
export const TEXT_ELEVATION = 0;
export const BADGE_ELEVATION = 0;
export const GLOSS_ELEVATION = 0;

// Global parallax intensity knob.
const PARALLAX_SCALE = 0;
const DEG_TO_RAD = Math.PI / 180;

export interface TiltContextValue {
  pitchDeg: SharedValue<number>;
  yawDeg: SharedValue<number>;
  nx: SharedValue<number>;
  ny: SharedValue<number>;
  mag: SharedValue<number>;
  pressRotateX: SharedValue<number>;
  isPressed: SharedValue<number>;
  rotation: SharedValue<number>;
  /** 0→1→0 on server-confirmed attestation — full shimmer (level-2 feedback). */
  attestGlow: SharedValue<number>;
  isFront: DerivedValue<boolean>;
  motionEnabled: boolean;
}

const TiltContext = createContext<TiltContextValue | null>(null);

export const TiltProvider = ({
  value,
  children,
}: {
  value: TiltContextValue;
  children: ReactNode;
}) => <TiltContext.Provider value={value}>{children}</TiltContext.Provider>;

export const useTilt = (): TiltContextValue => {
  const ctx = useContext(TiltContext);
  if (!ctx) {
    throw new Error('useTilt must be used within a TiltProvider');
  }
  return ctx;
};

interface ParallaxLayerProps {
  /** Depth of this layer; see the elevation constants above. */
  elevation: number;
  /** Which face the layer belongs to (back layers translate in mirror). */
  face?: 'front' | 'back';
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Wraps content and offsets it in-plane by an amount proportional to the current
 * tilt and its `elevation`. The translate is applied on a wrapper OUTSIDE any
 * `scaleX: -1` mirror the caller adds, so back-side content parallaxes correctly.
 */
export const ParallaxLayer = ({
  elevation,
  face = 'front',
  pointerEvents,
  children,
  style,
}: ParallaxLayerProps) => {
  const { yawDeg, pitchDeg, pressRotateX } = useTilt();
  const facing = face === 'front' ? 1 : -1;

  const animatedStyle = useAnimatedStyle(() => {
    const yr = yawDeg.value * DEG_TO_RAD;
    const pr = (pitchDeg.value + pressRotateX.value) * DEG_TO_RAD;
    return {
      transform: [
        { translateX: facing * elevation * PARALLAX_SCALE * Math.sin(yr) },
        { translateY: -elevation * PARALLAX_SCALE * Math.sin(pr) },
      ],
    };
  });

  return (
    <Animated.View pointerEvents={pointerEvents} style={[style, animatedStyle]}>
      {children}
    </Animated.View>
  );
};
