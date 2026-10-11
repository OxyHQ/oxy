/**
 * Base holographic layer of the Oxy ID card — a WHITE card with a fine engraved
 * GUILLOCHÉ pattern (smooth rosette curves, like the engine-turned lines on
 * official ID / banknote holograms). The card itself is white; the rainbow is
 * ONLY the holographic effect that lives on the guilloché lines and SHIFTS as
 * the phone tilts.
 *
 * The iridescence uses a LINEAR gradient (a directional band, NO centre pivot) so
 * there is no visible "colour-wheel" hotspot. Uses only plain GPU gradients +
 * stroked Paths — no `Mask`/`BlurMask` (blocky on Android).
 */

import { type FC, useMemo } from 'react';

import {
  Canvas,
  Group,
  LinearGradient,
  Path,
  RoundedRect,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import { useDerivedValue } from 'react-native-reanimated';

import { useTilt } from './OxyID/tilt-context';

interface HolographicCardProps {
  width: number;
  height: number;
}

// Full-spectrum iridescence for the line shimmer.
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

// Commons emblem (three interlocking lenses) engraved into the hologram as a
// corner watermark. Path mirrors `assets/images/commons-logo.svg` (viewBox
// "0 -960 960 960"); it's transformed into card space + filled with the same
// tilt-driven iridescence as the guilloché so it shimmers as part of the texture.
const COMMONS_LOGO_PATH =
  'M640-162q-18.09 0-34.9-1.57-16.8-1.57-34.1-5.43 72-63 113.5-143.5Q726-393.01 726-480q0-88-41.5-168T571-791q16.89-3.62 34.1-5.31Q622.3-798 640-798q132.45 0 225.22 92.89Q958-612.22 958-479.61T865.22-254.5Q772.45-162 640-162Zm-160-43q-71-42-114.5-114.5T322-480q0-88 43.5-160.5T480-755q71 42 114.5 114.5T638-480q0 88-43.5 160.5T480-205Zm-160 43q-132.45 0-225.22-92.89Q2-347.78 2-480.39T94.78-705.5Q187.55-798 320-798q18.09 0 34.9 1.57 16.8 1.57 34.1 5.43-72 63-113.5 143.16Q234-567.67 234-480.29 234-385 274.5-304 315-223 382-167q-14.47 2.63-30.22 3.82Q336.03-162 320-162Z';

const EMBLEM_SIZE = 30;
const EMBLEM_PAD = 16;

// Guilloché rosette: a set of nested flower curves (radius modulated by a
// sinusoid) with alternating phase, so the rings interleave into the classic
// engine-turned weave. Smooth curves — no straight-chord mesh.
const buildGuilloche = (width: number, height: number) => {
  const builder = Skia.PathBuilder.Make();
  const cx = width / 2;
  const cy = height / 2;
  const aspect = width / height;
  const maxR = Math.min(width, height) * 0.52;
  const rings = 7;
  const petals = 14;
  const steps = 260;
  for (let m = 1; m <= rings; m++) {
    const baseR = (m / rings) * maxR;
    const amp = baseR * 0.16;
    const phase = m % 2 === 0 ? Math.PI / petals : 0;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const r = baseR + amp * Math.cos(petals * t + phase);
      const x = cx + r * Math.cos(t) * aspect;
      const y = cy + r * Math.sin(t);
      if (i === 0) {
        builder.moveTo(x, y);
      } else {
        builder.lineTo(x, y);
      }
    }
  }
  return builder.detach();
};

export const HolographicCard: FC<HolographicCardProps> = ({ width, height }) => {
  const { nx, ny, mag, isPressed, attestGlow } = useTilt();

  const guilloche = useMemo(() => buildGuilloche(width, height), [width, height]);

  // Commons emblem scaled from its 960-unit viewBox and pinned to the
  // bottom-right corner (affine: scale s, translate to the corner).
  const emblem = useMemo(() => {
    const path = Skia.Path.MakeFromSVGString(COMMONS_LOGO_PATH);
    if (!path) return null;
    const s = EMBLEM_SIZE / 960;
    const ex = width - EMBLEM_PAD - EMBLEM_SIZE;
    const ey = height - EMBLEM_PAD;
    path.transform(Skia.Matrix([s, 0, ex, 0, s, ey, 0, 0, 1]));
    return path;
  }, [width, height]);

  // Diagonal iridescence band (NO centre pivot). Its endpoints shift with tilt,
  // so the rainbow slides along the guilloché lines as the phone turns.
  const irisStart = useDerivedValue(() =>
    vec(width * (-0.3 + nx.value * 0.6), height * (-0.3 + ny.value * 0.6)),
  );
  const irisEnd = useDerivedValue(() =>
    vec(width * (1.3 + nx.value * 0.6), height * (1.3 + ny.value * 0.6)),
  );

  // Subtle at rest → flares as you tilt (the reflejo); attestGlow boosts it
  // further on server-confirmed attestation (level-2 feedback).
  const irisOpacity = useDerivedValue(() =>
    Math.min(1, 0.32 + mag.value * 0.45 + isPressed.value * 0.16 + attestGlow.value * 0.5),
  );

  // Glossy laminate sheen — a bright diagonal glare streak that sweeps across
  // the surface (opposite the tilt), like light on a plastic card. A cool tint
  // so it reads as a glass reflection on the white stock.
  const glossStart = useDerivedValue(() =>
    vec(
      width * (0.5 - nx.value * 0.7) - width * 0.5,
      height * (0.5 - ny.value * 0.7) - height * 0.5,
    ),
  );
  const glossEnd = useDerivedValue(() =>
    vec(
      width * (0.5 - nx.value * 0.7) + width * 0.5,
      height * (0.5 - ny.value * 0.7) + height * 0.5,
    ),
  );
  const glossOpacity = useDerivedValue(() =>
    Math.min(0.7, 0.28 + mag.value * 0.4 + isPressed.value * 0.22),
  );

  // Attestation-confirmed edge glow (clamped so a spring overshoot past 1
  // can't push the opacity out of range).
  const attestEdgeOpacity = useDerivedValue(() => Math.min(1, Math.max(0, attestGlow.value)) * 0.9);

  return (
    <Canvas style={{ width, height, backgroundColor: 'transparent' }}>
      <Group>
        {/* White card stock. */}
        <RoundedRect x={0} y={0} width={width} height={height} r={24} color="#FFFFFF" />

        {/* Faint engraved guilloché — always visible on white so the
                    pattern reads even where the rainbow is dim. */}
        <Path path={guilloche} style="stroke" strokeWidth={0.5} color="rgba(120,120,140,0.13)" />

        {/* Holographic iridescence on the SAME lines — a diagonal rainbow
                    band (no pivot) that slides with tilt. */}
        <Group opacity={irisOpacity}>
          <Path path={guilloche} style="stroke" strokeWidth={0.9}>
            <LinearGradient start={irisStart} end={irisEnd} colors={IRIDESCENT} />
          </Path>
        </Group>

        {/* Commons issuer emblem, engraved into the hologram: a faint base
                    glyph plus the SAME tilt-driven iridescence as the guilloché, so
                    it shimmers as part of the security texture. */}
        {emblem && (
          <>
            <Path path={emblem} style="stroke" strokeWidth={0.9} color="rgba(120,120,140,0.22)" />
            <Group opacity={irisOpacity}>
              <Path path={emblem} style="stroke" strokeWidth={1.1}>
                <LinearGradient start={irisStart} end={irisEnd} colors={IRIDESCENT} />
              </Path>
            </Group>
          </>
        )}

        {/* Glossy laminate sheen — the bright diagonal glare that sweeps
                    across the surface, giving the physical-card feel. */}
        <Group opacity={glossOpacity}>
          <RoundedRect x={0} y={0} width={width} height={height} r={24}>
            <LinearGradient
              start={glossStart}
              end={glossEnd}
              colors={[
                'rgba(235,244,255,0)',
                'rgba(235,244,255,0)',
                'rgba(240,248,255,0.85)',
                'rgba(255,255,255,0.95)',
                'rgba(240,248,255,0.85)',
                'rgba(235,244,255,0)',
                'rgba(235,244,255,0)',
              ]}
              positions={[0, 0.4, 0.47, 0.5, 0.53, 0.6, 1]}
            />
          </RoundedRect>
        </Group>

        {/* Attestation-confirmed iridescent edge glow (attestGlow-driven). */}
        <Group opacity={attestEdgeOpacity}>
          <RoundedRect
            x={1.5}
            y={1.5}
            width={width - 3}
            height={height - 3}
            r={23}
            style="stroke"
            strokeWidth={3}
          >
            <LinearGradient start={vec(0, 0)} end={vec(width, height)} colors={IRIDESCENT} />
          </RoundedRect>
        </Group>

        {/* Subtle edge definition. */}
        <RoundedRect
          x={1}
          y={1}
          width={width - 2}
          height={height - 2}
          r={23}
          style="stroke"
          strokeWidth={1}
          color="rgba(150,150,170,0.25)"
        />
      </Group>
    </Canvas>
  );
};
