import { parseRgb } from '@oxy.so/bloom/theme';

/**
 * Commons-only colour helpers. Parsing and alpha composition are Bloom's
 * (`parseRgb` / `withAlpha` from `@oxy.so/bloom/theme`), which accept both the
 * `rgb(r g b)` tokens and the hex status colours a theme emits.
 */

/** Clamp `t` to [0, 1]. */
function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  return Math.min(Math.max(t, 0), 1);
}

/**
 * Linearly interpolate between two colors, `t` in [0, 1] (`0` → `a`, `1` → `b`).
 * Used to build a related-tonality ramp (e.g. success → info) across the
 * distribution bar's category segments. Emits modern `rgb(r g b)`.
 */
export function mixColors(a: string, b: string, t: number): string {
  const ca = parseRgb(a);
  const cb = parseRgb(b);
  if (!ca || !cb) return a;
  const amount = clamp01(t);
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return `rgb(${lerp(ca.r, cb.r)} ${lerp(ca.g, cb.g)} ${lerp(ca.b, cb.b)})`;
}
