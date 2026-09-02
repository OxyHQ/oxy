/**
 * The transparent end of a colour ramp.
 *
 * Fading to the keyword `transparent` means fading to `rgba(0,0,0,0)`, which
 * tints the middle of a gradient grey. Fading to the SAME colour at zero alpha
 * keeps the ramp clean. Falls back to the keyword for colour formats this
 * cannot extend (named colours, `hsl(...)`).
 */
export function fadeOut(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}00`;
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    const [, r, g, b] = color.match(/^#(.)(.)(.)$/i) ?? [];
    return `#${r}${r}${g}${g}${b}${b}00`;
  }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((v) => v.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, 0)`;
  }
  return 'transparent';
}
