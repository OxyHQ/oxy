/**
 * The interest tags offered during onboarding, after the Oxy account exists.
 *
 * A tag is pure data: an id, a label and a colour. HOW it is drawn lives with
 * the canvas — `scripts/generate-interest-glyph-paths.mjs` maps each id to a
 * Bloom glyph and writes its SVG path to
 * `constants/interestTagGlyphs.generated.ts`, which the Skia canvas draws.
 * There used to be an `icon` name here plus an `ICON_GLYPHS` codepoint table,
 * both tied to the MaterialCommunityIcons TTF the app no longer ships.
 */
export interface InterestTag {
  id: string;
  label: string;
  color: string;
}

export const INTEREST_TAGS: InterestTag[] = [
  { id: 'code', label: 'Code', color: '#ffe4e1' },
  { id: 'design', label: 'Design', color: '#fffacd' },
  { id: 'music', label: 'Music', color: '#e0ffff' },
  { id: 'travel', label: 'Travel', color: '#f0e68c' },
  { id: 'finance', label: 'Finance', color: '#dda0dd' },
  { id: 'cook', label: 'Cook', color: '#90ee90' },
  { id: 'meditate', label: 'Meditate', color: '#add8e6' },
  { id: 'work', label: 'Work', color: '#ffb6c1' },
  { id: 'learn', label: 'Learn', color: '#fafad2' },
  { id: 'exercise', label: 'Exercise', color: '#87cefa' },
  { id: 'photo', label: 'Photo', color: '#d3d3d3' },
  { id: 'garden', label: 'Garden', color: '#98fb98' },
  { id: 'explore', label: 'Explore', color: '#afeeee' },
  { id: 'write', label: 'Write', color: '#ffdead' },
  { id: 'research', label: 'Research', color: '#e6e6fa' },
];
