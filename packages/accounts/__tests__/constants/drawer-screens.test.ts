import fs from 'node:fs';
import path from 'node:path';
import { DRAWER_SCREENS } from '@/constants/drawer-screens';

const TABS_DIR = path.resolve(__dirname, '../../app/(tabs)');
const EN_LOCALE = path.resolve(__dirname, '../../lib/i18n/locales/en.json');

/** Resolve a dot-path (e.g. `drawer.home`) against a nested dict. */
function resolveKey(dict: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object') {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, dict);
}

/** True when a route file exists for the given drawer name (file or directory). */
function routeExists(name: string): boolean {
  const candidates = [
    path.join(TABS_DIR, `${name}.tsx`),
    path.join(TABS_DIR, `${name}.native.tsx`),
    path.join(TABS_DIR, name, 'index.tsx'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

describe('DRAWER_SCREENS', () => {
  it('declares at least the eleven visible primary screens', () => {
    const visible = DRAWER_SCREENS.filter((s) => !s.hidden);
    expect(visible.length).toBeGreaterThanOrEqual(11);
  });

  it('uses unique route names', () => {
    const names = DRAWER_SCREENS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('maps every screen name to a real route file under app/(tabs)', () => {
    const missing = DRAWER_SCREENS.map((s) => s.name).filter((name) => !routeExists(name));
    expect(missing).toEqual([]);
  });

  // expo-router 58's Drawer renders ONLY the screens its layout declares: a
  // route file missing from this list exports as an empty page, with no error.
  it('declares every route under app/(tabs), and none is web-excluded', () => {
    const routes = fs
      .readdirSync(TABS_DIR, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('_') && !entry.name.startsWith('+'))
      .filter((entry) => entry.isDirectory() || /\.tsx?$/.test(entry.name))
      .map((entry) => entry.name.replace(/(\.native|\.web)?\.tsx?$/, ''))
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    const declared = DRAWER_SCREENS.map((s) => s.name as string).sort();
    expect(declared).toEqual(routes);
    // A `platform: 'native'` entry is not registered on web, so its route would
    // be blank there; only a route that has no web file may carry it.
    const webBlank = DRAWER_SCREENS.filter(
      (s) => s.platform === 'native' && fs.existsSync(path.join(TABS_DIR, `${s.name}.tsx`)),
    ).map((s) => s.name);
    expect(webBlank).toEqual([]);
  });

  it('every labelKey and titleKey resolves to a string in en.json', () => {
    const en = JSON.parse(fs.readFileSync(EN_LOCALE, 'utf8')) as Record<string, unknown>;
    const unresolved: string[] = [];
    for (const screen of DRAWER_SCREENS) {
      for (const key of [screen.labelKey, screen.titleKey]) {
        if (key && typeof resolveKey(en, key) !== 'string') {
          unresolved.push(key);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('gives every visible screen a drawer label', () => {
    const missingLabel = DRAWER_SCREENS.filter((s) => !s.hidden && !s.labelKey).map((s) => s.name);
    expect(missingLabel).toEqual([]);
  });

  it('hides scan-qr from the drawer and disables its header', () => {
    const scanQr = DRAWER_SCREENS.find((s) => s.name === 'scan-qr');
    expect(scanQr?.hidden).toBe(true);
    expect(scanQr?.headerShown).toBe(false);
  });
});
