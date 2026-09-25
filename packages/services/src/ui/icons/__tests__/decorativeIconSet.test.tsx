/**
 * Icon-font glyphs are private-use code points in a `Text` node; unhidden, a
 * screen reader announces them (`"\u{F0140}"` beside "Switch account" in the
 * Android account menu, OxyHQ/oxy#1375). Both SDK icon families hide every
 * glyph, and a caller cannot switch that back on.
 */

import { render } from '@testing-library/react';
import Ionicons from '../Ionicons';
import MaterialCommunityIcons from '../MaterialCommunityIcons';
import { decorativeIconSet } from '../decorativeIconSet';

describe('the SDK icon families are decorative', () => {
  it.each([
    ['MaterialCommunityIcons', MaterialCommunityIcons, 'chevron-down'],
    ['Ionicons', Ionicons, 'add'],
  ] as const)('%s hides its glyph from assistive technology', (_family, Icon, name) => {
    const { container } = render(<Icon name={name as never} size={20} />);

    expect(container.querySelector(`[data-icon="${name}"]`)?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the glyph hidden even when a caller asks otherwise', () => {
    const { container } = render(
      <MaterialCommunityIcons name="chevron-down" aria-hidden={false} />,
    );

    expect(container.querySelector('[data-icon]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries the family statics, so it stays a drop-in for the family', () => {
    expect(MaterialCommunityIcons.glyphMap['chevron-down']).toEqual(expect.any(Number));
    expect(Ionicons.glyphMap.add).toEqual(expect.any(Number));

    const Family = Object.assign(() => null, { glyphMap: { a: 1 }, getFontFamily: () => 'F' });
    const Wrapped = decorativeIconSet(Family, 'Wrapped');
    expect(Wrapped.glyphMap).toBe(Family.glyphMap);
    expect(Wrapped.getFontFamily()).toBe('F');
  });
});
