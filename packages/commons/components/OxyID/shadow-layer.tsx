/**
 * Float shadow for the Oxy ID card.
 *
 * Rendered as a sibling BEHIND the card inside the un-clipped outer wrapper, so
 * the blurred shadow can spill past the card's rounded-rect clip. It stays flat
 * on the "ground" to sell the card floating above the surface.
 *
 * Reacts ONLY to the discrete press state (`isPressed`), never to per-frame
 * tilt: when the card is pressed it sinks toward the surface, so the shadow
 * tightens and lightens (less lift → less shadow). Because the press is a
 * discrete on/off — not a 120Hz-continuous signal — the RNSkia `<Canvas>`
 * (an Android `TextureView` that updates below the display rate) only redraws
 * on press-down/up, so it never lags/stutters the way a tilt-driven redraw
 * would.
 */

import { Canvas, RoundedRect, Shadow } from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';

import { useTilt } from './tilt-context';

// Extra room around the card so the blurred shadow is not clipped by the canvas.
const PAD = 40;

interface ShadowLayerProps {
  width: number;
  height: number;
  radius?: number;
}

export const ShadowLayer = ({ width, height, radius = 24 }: ShadowLayerProps) => {
  const { isPressed } = useTilt();

  // Pressed → the card sinks toward the surface: pull the shadow in (smaller
  // offset + blur) and fade it (lower opacity) so it reads as less lift.
  const dy = useDerivedValue(() => 13 - isPressed.value * 6);
  const blur = useDerivedValue(() => 20 - isPressed.value * 8);
  const shadowColor = useDerivedValue(() => `rgba(0,0,0,${0.34 - isPressed.value * 0.14})`);

  return (
    <Canvas
      style={{
        position: 'absolute',
        left: -PAD,
        top: -PAD,
        width: width + PAD * 2,
        height: height + PAD * 2,
      }}
      pointerEvents="none"
    >
      <RoundedRect x={PAD} y={PAD} width={width} height={height} r={radius} color="black">
        <Shadow dx={0} dy={dy} blur={blur} color={shadowColor} shadowOnly />
      </RoundedRect>
    </Canvas>
  );
};
