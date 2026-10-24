/**
 * The 3D avatar character a `bot` account carries.
 *
 * ONE definition for the wire shape, its validator and the generator that picks
 * a look for a new bot, shared by the Oxy API (which stores and serves it) and
 * every client. It mirrors Bloom's flat `AvatarCharacter`
 * (`@oxy.so/bloom/agent-avatar`).
 *
 * ## The vocabulary is Bloom's and is NOT enforced here
 *
 * Bloom is a React Native package this one cannot depend on, so the ids a
 * character is made of are restated below as a curated SUBSET, only to PICK a
 * look for a new bot ({@link avatarCharacterFor}). A STORED character is never
 * checked against them: validating against a stale copy of somebody else's
 * catalogue is how a working look starts being refused. What the schema checks
 * is the SHAPE of what a client writes: only the keys a character has, each an
 * id-like string, a `#rrggbb` paint, a spacing in range. The client resolves
 * the ids and falls back on a default look for one it cannot draw.
 */

import { z } from 'zod';

/** The flat shape of Bloom's `AvatarCharacter`; every field is optional (a preset supplies the rest). */
export interface AvatarCharacter {
  preset?: string;
  shape?: string;
  eyes?: string;
  eyewear?: string;
  accessory?: string;
  /** Named paint. */
  color?: string;
  /** Exact paint, `#rrggbb`; it wins over `color`. */
  bodyColor?: string;
  /** A multiplier (0.5 to 1.5) on the shape's eye separation. */
  eyeSpacing?: number;
}

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Bounds of {@link AvatarCharacter.eyeSpacing}. */
export const AVATAR_EYE_SPACING = { min: 0.5, max: 1.5 } as const;

const idSchema = z.string().regex(ID);

/**
 * A character a client sends. `.strict()` so a misspelled field is a refusal
 * now rather than a look that never takes effect. A character with nothing in
 * it draws nothing: it needs a preset, or a shape and a paint.
 */
export const avatarCharacterSchema: z.ZodType<AvatarCharacter, unknown> = z
  .object({
    preset: idSchema.optional(),
    shape: idSchema.optional(),
    eyes: idSchema.optional(),
    eyewear: idSchema.optional(),
    accessory: idSchema.optional(),
    color: idSchema.optional(),
    bodyColor: z
      .string()
      .regex(HEX)
      .transform((hex) => hex.toLowerCase())
      .optional(),
    eyeSpacing: z
      .number()
      .finite()
      .min(AVATAR_EYE_SPACING.min)
      .max(AVATAR_EYE_SPACING.max)
      .optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.preset !== undefined ||
      (c.shape !== undefined && (c.color !== undefined || c.bodyColor !== undefined)),
    { message: 'A character needs a preset, or a shape and a color' },
  );

/** The validated character, or `null` for anything that is not one. */
export function parseAvatarCharacter(value: unknown): AvatarCharacter | null {
  const parsed = avatarCharacterSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The parts a new bot's look is picked from: the plain, friendly shapes, in the editor's order. */
export const AVATAR_PICKABLE_SHAPES = [
  'rounded_triangle',
  'capsule',
  'rounded_head_two_ears',
  'six_lobed_flower',
  'heart',
  'four_lobed_butterfly',
  'circle_two_ears',
  'twelve_scalloped_rosette',
  'rounded_cube',
  'rounded_diamond',
  'slender',
  'pocket',
  'petal',
  'star',
  'cloud',
  'shield',
  'pebble',
  'squircle',
] as const;

/** Bloom's named paints. */
export const AVATAR_PICKABLE_COLORS = [
  'pink',
  'orchid',
  'violet',
  'blue',
  'cyan',
  'teal',
  'lime',
  'yellow',
  'coral',
] as const;

/** A small, stable hash: the same seed always picks the same look. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A look for a new bot, picked from its seed (its handle): a shape and a paint,
 * plain oval eyes, nothing on its head. Stable — the same seed is the same look
 * — and the owner changes it afterwards.
 */
export function avatarCharacterFor(seed: string): AvatarCharacter {
  const h = hash(seed);
  return {
    shape: AVATAR_PICKABLE_SHAPES[h % AVATAR_PICKABLE_SHAPES.length],
    eyes: 'oval',
    eyewear: 'none',
    accessory: 'none',
    color:
      AVATAR_PICKABLE_COLORS[
        Math.floor(h / AVATAR_PICKABLE_SHAPES.length) % AVATAR_PICKABLE_COLORS.length
      ],
  };
}
