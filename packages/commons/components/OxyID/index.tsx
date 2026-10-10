/**
 * The flippable, tilt-reactive Oxy ID card.
 *
 * Three-level tree so depth reads convincingly:
 *   - outer wrapper: no clip, no rotation. Hosts the float shadow (which must
 *     escape the clip) and the card.
 *   - card clip: rounded-rect + overflow hidden, carries the container
 *     perspective/flip/tilt/press transform.
 *   - inside the clip: base hologram, parallaxed front/back content, and the
 *     specular gloss on top. All share tilt via `TiltProvider`.
 *
 * True 3D comes from the container `perspective + rotateX/rotateY` driven by the
 * device's real attitude (`useDeviceTilt`); per-layer parallax (`ParallaxLayer`)
 * makes the avatar/text/badge float above the card face.
 */

import { StyleSheet, View } from 'react-native';

import { type FC, memo, type ReactNode, useMemo, useState } from 'react';

import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { HolographicCard } from '../holographic-card';
import { useDeviceTilt } from '../../hooks/use-device-tilt';
import { ShadowLayer } from './shadow-layer';
import {
  HOLOGRAM_ELEVATION,
  ParallaxLayer,
  TEXT_ELEVATION,
  TiltProvider,
  type TiltContextValue,
} from './tilt-context';

// Hold this long to reveal the QR on the back (deliberate, so it never shows by
// accident).
const QR_REVEAL_MS = 700;

type TicketProps = {
  width: number;
  height: number;
  frontSide?: ReactNode;
  backSide?: ReactNode;
  /** Optional QR face, revealed by a long-press (tap only flips front↔back). */
  qrSide?: ReactNode;
  /** Level-2 attestation-confirmed feedback value (0→1→0). Internal default: inert. */
  attestGlow?: SharedValue<number>;
};

export const Ticket: FC<TicketProps> = memo(
  ({ width, height, frontSide, backSide, qrSide, attestGlow: attestGlowProp }) => {
    // Drift-free device attitude driving the 3D turn.
    const tilt = useDeviceTilt();
    const { pitchDeg, yawDeg } = tilt;

    // Flip (0 = front, 180 = back).
    const rotation = useSharedValue(0);

    // Effect channel — an inert local value unless the screen supplies a live one.
    const internalAttestGlow = useSharedValue(0);
    const attestGlow = attestGlowProp ?? internalAttestGlow;

    // The back shows the public-key face by default; a long-press swaps it to the
    // QR. Tap always returns to the public-key back.
    const [showQr, setShowQr] = useState(false);

    // Press interaction.
    const pressRotateX = useSharedValue(0);
    const pressTranslateY = useSharedValue(0);
    const isPressed = useSharedValue(0);

    // Which face is visible — keyed off the FLIP only, so ±tilt never flips it.
    const isFront = useDerivedValue(() => {
      const r = ((rotation.value % 360) + 360) % 360;
      return r < 90 || r > 270;
    });

    const tiltContext = useMemo<TiltContextValue>(
      () => ({
        pitchDeg: tilt.pitchDeg,
        yawDeg: tilt.yawDeg,
        nx: tilt.nx,
        ny: tilt.ny,
        mag: tilt.mag,
        pressRotateX,
        isPressed,
        rotation,
        attestGlow,
        isFront,
        motionEnabled: tilt.motionEnabled,
      }),
      [tilt, pressRotateX, isPressed, rotation, attestGlow, isFront],
    );

    // Press tilt (Pan with minDistance 0 catches any touch).
    const pressGesture = Gesture.Pan()
      .minDistance(0)
      .maxPointers(1)
      .onBegin((event) => {
        'worklet';
        isPressed.value = 1;
        const normalizedY = (event.y - height / 2) / (height / 2);
        const maxTilt = 6;
        pressRotateX.value = withTiming(-normalizedY * maxTilt, { duration: 80 });
        pressTranslateY.value = withTiming(5, { duration: 80 });
      })
      .onUpdate((event) => {
        'worklet';
        const normalizedY = (event.y - height / 2) / (height / 2);
        const maxTilt = 6;
        pressRotateX.value = -normalizedY * maxTilt;
      })
      .onEnd(() => {
        'worklet';
        isPressed.value = 0;
        pressRotateX.value = withSpring(0, { dampingRatio: 3 });
        pressTranslateY.value = withSpring(0, { dampingRatio: 3 });
      })
      .onFinalize(() => {
        'worklet';
        isPressed.value = 0;
        pressRotateX.value = withSpring(0, { dampingRatio: 3 });
        pressTranslateY.value = withSpring(0, { dampingRatio: 3 });
      });

    // Tap flips between front and the public-key back (never the QR).
    const tapGesture = Gesture.Tap().onEnd(() => {
      scheduleOnRN(Haptics.selectionAsync);
      scheduleOnRN(setShowQr, false);
      rotation.value = withSpring(rotation.value === 0 ? 180 : 0, {
        dampingRatio: 1.5,
        duration: 500,
      });
    });

    // Long-press (>2s) reveals the QR on the back face.
    const longPressGesture = Gesture.LongPress()
      .minDuration(QR_REVEAL_MS)
      .maxDistance(40)
      .onStart(() => {
        scheduleOnRN(Haptics.selectionAsync);
        scheduleOnRN(setShowQr, true);
        rotation.value = withSpring(180, { dampingRatio: 1.5, duration: 500 });
      });

    // Press-tilt runs alongside; long-press wins over tap when held.
    const gesture = Gesture.Simultaneous(
      pressGesture,
      Gesture.Exclusive(longPressGesture, tapGesture),
    );

    const rTiltStyle = useAnimatedStyle(() => ({
      transform: [
        { perspective: 900 },
        { translateY: pressTranslateY.value },
        { rotateY: `${rotation.value + yawDeg.value}deg` }, // flip composed with tilt-yaw
        { rotateX: `${pitchDeg.value + pressRotateX.value}deg` },
        { rotateZ: `${yawDeg.value * 0.15}deg` }, // subtle micro-roll
      ],
    }));

    const rFrontStyle = useAnimatedStyle(() => ({
      opacity: isFront.value ? 1 : 0,
      zIndex: isFront.value ? 1 : 0,
    }));

    const rBackStyle = useAnimatedStyle(() => ({
      opacity: isFront.value ? 0 : 1,
      zIndex: isFront.value ? 0 : 1,
    }));

    return (
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.outerWrapper, { width, height }]}>
          <TiltProvider value={tiltContext}>
            {/* Float shadow — behind the card, escapes the clip. */}
            <ShadowLayer width={width} height={height} />

            {/* The clipped, rotated card. */}
            <Animated.View style={[styles.cardClip, { width, height }, rTiltStyle]}>
              {/* Base hologram (recedes slightly under tilt). */}
              <ParallaxLayer
                elevation={HOLOGRAM_ELEVATION}
                pointerEvents="none"
                style={StyleSheet.absoluteFill}
              >
                <HolographicCard width={width} height={height} />
              </ParallaxLayer>

              {/* Front content (its own avatar/text parallax is internal). */}
              <Animated.View style={[StyleSheet.absoluteFill, rFrontStyle]}>
                {frontSide}
              </Animated.View>

              {/* Back content, parallaxed as a unit outside its mirror. */}
              <Animated.View style={[StyleSheet.absoluteFill, rBackStyle]}>
                <ParallaxLayer
                  elevation={TEXT_ELEVATION}
                  face="back"
                  style={StyleSheet.absoluteFill}
                >
                  <View style={[StyleSheet.absoluteFill, styles.backMirror]}>
                    {showQr && qrSide ? qrSide : backSide}
                  </View>
                </ParallaxLayer>
              </Animated.View>
            </Animated.View>
          </TiltProvider>
        </Animated.View>
      </GestureDetector>
    );
  },
);

Ticket.displayName = 'Ticket';

const styles = StyleSheet.create({
  outerWrapper: {
    position: 'relative',
  },
  cardClip: {
    overflow: 'hidden',
    borderRadius: 24,
    // White stock hides any 1–2px edge exposed by the hologram's parallax.
    backgroundColor: '#FFFFFF',
  },
  backMirror: {
    transform: [{ scaleX: -1 }],
  },
});
