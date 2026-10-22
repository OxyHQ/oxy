jest.mock('@oxy.so/bloom/icons/RiAddLine', () => ({ RiAddLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiBuilding2Line', () => ({ RiBuilding2Line: () => null }));
jest.mock('@oxy.so/bloom/icons/RiSearchLine', () => ({ RiSearchLine: () => null }));
jest.mock('@/lib/navigation', () => ({
  CONSOLE_NAV: [
    { href: '/dashboard', labelKey: 'nav.dashboard', icon: () => null },
    { href: '/apps', labelKey: 'nav.apps', icon: () => null },
    { href: '/docs', labelKey: 'nav.documentation', icon: () => null, external: 'https://docs' },
  ],
  SETTINGS_NAV: { key: 'settings', labelKey: 'nav.settings', icon: () => null },
}));

import { buildCommandItems } from '../command-menu-items';

const t = (key: string) => key;
const noop = () => undefined;
const actions = (overrides: Partial<Parameters<typeof buildCommandItems>[1]> = {}) => ({
  navigate: noop,
  openExternal: noop,
  openSettings: noop,
  createWorkspace: noop,
  ...overrides,
});

describe('buildCommandItems', () => {
  it('lists the actions, every section, Settings and the routes the sidebar omits once each', () => {
    const ids = buildCommandItems(t, actions()).map((item) => item.id);
    expect(ids).toEqual([
      'create-app',
      'create-workspace',
      'nav:/dashboard',
      'nav:/apps',
      'nav:/docs',
      'nav:settings',
      'nav:/clarity',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups actions apart from navigation', () => {
    const items = buildCommandItems(t, actions());
    expect(items.slice(0, 2).every((item) => item.group === 'commandMenu.groups.actions')).toBe(
      true,
    );
    expect(items.slice(2).every((item) => item.group === 'commandMenu.groups.navigation')).toBe(
      true,
    );
  });

  it('routes selections to the matching callback', () => {
    const navigate = jest.fn();
    const openExternal = jest.fn();
    const openSettings = jest.fn();
    const createWorkspace = jest.fn();
    const items = buildCommandItems(
      t,
      actions({ navigate, openExternal, openSettings, createWorkspace }),
    );
    for (const id of ['nav:/apps', 'create-app', 'nav:/docs', 'nav:settings', 'create-workspace']) {
      items.find((item) => item.id === id)?.onSelect();
    }
    expect(navigate.mock.calls).toEqual([['/apps'], ['/apps']]);
    expect(openExternal).toHaveBeenCalledWith('https://docs');
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });
});
