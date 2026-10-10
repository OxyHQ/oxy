/**
 * The Oxy issuer mark rendered as a holographic FOIL — the card's header logo.
 *
 * The Oxy mark is a solid brand shape (an overlapping-lens silhouette with an
 * interior detail), so — unlike the line-based Commons emblem — it can't be
 * reduced to strokes without falling apart into loose construction outlines.
 * Instead it keeps its true, recognizable form and swaps the solid brand fill for
 * a tilt-driven iridescent gradient (the SAME band as the card's guilloché), so
 * it reads as a foil-stamped logo that shifts colour as the phone turns. The
 * interior marks stay white, exactly as in the brand logo.
 *
 * Rendered as face content (not the shared hologram layer) so the back face's
 * counter-mirror keeps it upright. Must be mounted inside the card `TiltProvider`.
 */

import { type FC, useMemo } from 'react';

import { Canvas, Group, LinearGradient, Path, PathOp, Skia, vec } from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';

import { useTilt } from './tilt-context';
import {
  OXY_INNER_OFFSET,
  OXY_INNER_PATH,
  OXY_LETTERS_PATH,
  OXY_OUTER_PATH,
  OXY_VIEWBOX,
} from './logo-paths';

// Full-spectrum iridescence, matching the guilloché hologram on the card body.
const IRIDESCENT = [
  '#ff4d6d',
  '#ff9e2c',
  '#ffe14d',
  '#43e97b',
  '#22d3ee',
  '#4f8dff',
  '#a06bff',
  '#ff6bd6',
];

// A hair of padding so the mark isn't clipped by the canvas edge.
const PAD = 1.5;

const ASPECT = OXY_VIEWBOX.width / OXY_VIEWBOX.height;

/**
 * Reproduce the three LogoIcon layers, each scaled to a `size`-tall box: the
 * outer silhouette and the inner detail (the "foil" fill), plus the interior
 * marks (drawn white on top). The inner two carry the source's translate(465,188).
 */
const buildOxyParts = (size: number) => {
  const outer = Skia.Path.MakeFromSVGString(OXY_OUTER_PATH);
  const inner = Skia.Path.MakeFromSVGString(OXY_INNER_PATH);
  const letters = Skia.Path.MakeFromSVGString(OXY_LETTERS_PATH);
  if (!outer || !inner || !letters) return null;

  // Inner paths are drawn under translate(465,188) in LogoIcon.
  const offset = Skia.Matrix([1, 0, OXY_INNER_OFFSET.x, 0, 1, OXY_INNER_OFFSET.y, 0, 0, 1]);
  inner.transform(offset);
  letters.transform(offset);

  // viewBox → padded size-box (uniform scale, top-left origin).
  const s = size / OXY_VIEWBOX.height;
  const scale = Skia.Matrix([
    s,
    0,
    PAD - OXY_VIEWBOX.minX * s,
    0,
    s,
    PAD - OXY_VIEWBOX.minY * s,
    0,
    0,
    1,
  ]);
  outer.transform(scale);
  inner.transform(scale);
  letters.transform(scale);

  // Merge the silhouette + inner detail into one foil body so it fills with a
  // single gradient. A true UNION (not addPath) makes the single fill identical
  // to painting both layers — no winding cancellation where they overlap.
  if (!outer.op(inner, PathOp.Union)) {
    outer.addPath(inner);
  }
  return { body: outer, letters };
};

interface HolographicLogoProps {
  /** Height of the mark in px (width follows the logo aspect ratio). */
  size?: number;
}

export const HolographicLogo: FC<HolographicLogoProps> = ({ size = 22 }) => {
  const { nx, ny, mag } = useTilt();

  const parts = useMemo(() => buildOxyParts(size), [size]);

  const w = size * ASPECT + PAD * 2;
  const h = size + PAD * 2;

  // Diagonal iridescence band whose endpoints slide with tilt — the SAME motion
  // as the card's guilloché, so the foil shifts colour in step with the hologram.
  // `w`/`h` are render-scope values, so declare them as explicit deps.
  const start = useDerivedValue(
    () => vec(w * (-0.3 + nx.value * 0.6), h * (-0.3 + ny.value * 0.6)),
    [w, h],
  );
  const end = useDerivedValue(
    () => vec(w * (1.3 + nx.value * 0.6), h * (1.3 + ny.value * 0.6)),
    [w, h],
  );
  // Always clearly visible (it's the logo), with a small flare on tilt.
  const opacity = useDerivedValue(() => Math.min(1, 0.9 + mag.value * 0.1));

  if (!parts) return null;

  return (
    <Canvas style={{ width: w, height: h }} pointerEvents="none">
      {/* Foil body: the Oxy silhouette + inner detail, filled with the
                tilt-driven iridescence in place of the solid brand colour. */}
      <Group opacity={opacity}>
        <Path path={parts.body}>
          <LinearGradient start={start} end={end} colors={IRIDESCENT} />
        </Path>
      </Group>
      {/* Interior marks, white on top — exactly as in the brand logo. */}
      <Path path={parts.letters} color="#FFFFFF" />
    </Canvas>
  );
};
