/**
 * Icon-font glyphs are `Text` nodes holding a private-use code point, and
 * TalkBack read them aloud ("\u{F030B}") on the ID screen (OxyHQ/oxy#1375 item
 * 19). Commons draws every glyph through `components/icons/*`, which hides it
 * from assistive technology after the caller's props.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from '@testing-library/react';
// The raw family, to compare the wrapper's glyphMap against.
// eslint-disable-next-line no-restricted-imports
import BaseMaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import MaterialCommunityIcons from '@/components/icons/MaterialCommunityIcons';
import Ionicons from '@/components/icons/Ionicons';

describe('decorative icon wrappers', () => {
  it.each([
    ['MaterialCommunityIcons', MaterialCommunityIcons],
    ['Ionicons', Ionicons],
  ] as const)('%s hides the glyph from assistive technology', (_name, Icon) => {
    const { container } = render(<Icon name="key-variant" size={22} color="#000" />);
    expect(container.querySelector('[data-icon="key-variant"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('cannot be switched back on by the caller', () => {
    const { container } = render(
      <MaterialCommunityIcons name="qrcode-scan" aria-hidden={false} />,
    );
    expect(container.querySelector('[data-icon="qrcode-scan"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('keeps glyphMap, so icon-name types still derive from it', () => {
    expect(MaterialCommunityIcons.glyphMap).toBe(BaseMaterialCommunityIcons.glyphMap);
  });
});

describe('no screen imports the icon font directly', () => {
  const root = path.resolve(__dirname, '../../..');
  const sourceDirs = ['app', 'components', 'hooks', 'lib', 'constants', 'utils', 'types'];

  function sourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(tsx?|jsx?)$/.test(entry.name) ? [full] : [];
    });
  }

  it('routes every family through components/icons', () => {
    const files = sourceDirs.flatMap((dir) => sourceFiles(path.join(root, dir)));
    // Guard against a vacuous pass from a wrong root.
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((file) => !file.includes(`${path.sep}components${path.sep}icons${path.sep}`))
      .filter((file) => /from\s+['"]@expo\/vector-icons/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
