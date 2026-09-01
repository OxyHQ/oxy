/**
 * The interest tags offered during onboarding, after the Oxy account exists.
 *
 * `icon` names come from MaterialCommunityIcons (`@expo/vector-icons`).
 * Skia cannot render an icon component, so `ICON_GLYPHS` carries the matching
 * codepoint for each icon — the canvas draws it as text from the same TTF.
 */
export interface InterestTag {
  id: string;
  label: string;
  color: string;
  icon: string;
}

export const INTEREST_TAGS: InterestTag[] = [
  { id: 'code', label: 'Code', color: '#ffe4e1', icon: 'code-tags' },
  { id: 'design', label: 'Design', color: '#fffacd', icon: 'brush' },
  { id: 'music', label: 'Music', color: '#e0ffff', icon: 'music-note' },
  { id: 'travel', label: 'Travel', color: '#f0e68c', icon: 'airplane' },
  { id: 'finance', label: 'Finance', color: '#dda0dd', icon: 'wallet-outline' },
  { id: 'cook', label: 'Cook', color: '#90ee90', icon: 'chef-hat' },
  { id: 'meditate', label: 'Meditate', color: '#add8e6', icon: 'meditation' },
  { id: 'work', label: 'Work', color: '#ffb6c1', icon: 'laptop' },
  { id: 'learn', label: 'Learn', color: '#fafad2', icon: 'book-open-variant' },
  { id: 'exercise', label: 'Exercise', color: '#87cefa', icon: 'run-fast' },
  { id: 'photo', label: 'Photo', color: '#d3d3d3', icon: 'camera-outline' },
  { id: 'garden', label: 'Garden', color: '#98fb98', icon: 'flower-outline' },
  { id: 'explore', label: 'Explore', color: '#afeeee', icon: 'compass-outline' },
  { id: 'write', label: 'Write', color: '#ffdead', icon: 'pencil-outline' },
  { id: 'research', label: 'Research', color: '#e6e6fa', icon: 'flask-outline' },
];

/** MaterialCommunityIcons codepoints, for Skia's text-based glyph rendering. */
export const ICON_GLYPHS: Record<string, string> = {
  'code-tags': String.fromCodePoint(0xf0174),
  brush: String.fromCodePoint(0xf00e3),
  'music-note': String.fromCodePoint(0xf0387),
  airplane: String.fromCodePoint(0xf001d),
  'wallet-outline': String.fromCodePoint(0xf0bdd),
  'chef-hat': String.fromCodePoint(0xf0b7c),
  meditation: String.fromCodePoint(0xf117b),
  laptop: String.fromCodePoint(0xf0322),
  'book-open-variant': String.fromCodePoint(0xf14f7),
  'run-fast': String.fromCodePoint(0xf046e),
  'camera-outline': String.fromCodePoint(0xf0d5d),
  'flower-outline': String.fromCodePoint(0xf09f0),
  'compass-outline': String.fromCodePoint(0xf018c),
  'pencil-outline': String.fromCodePoint(0xf0cb6),
  'flask-outline': String.fromCodePoint(0xf0096),
};
