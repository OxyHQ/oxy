jest.mock('@oxy.so/bloom/icons/RiAddLine', () => ({ RiAddLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiCodeSLine', () => ({ RiCodeSLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiPlayLine', () => ({ RiPlayLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiSearchLine', () => ({ RiSearchLine: () => null }));
jest.mock('@/lib/navigation', () => ({
  CONSOLE_NAV: [
    { key: 'dashboard', href: '/dashboard', labelKey: 'nav.dashboard', icon: () => null },
    { key: 'apps', href: '/apps', labelKey: 'nav.apps', icon: () => null },
  ],
}));

import { buildCommandItems } from '../command-menu-items';

const t = (key: string) => key;

describe('buildCommandItems', () => {
  it('lists the create action, every sidebar section and the sections the sidebar omits', () => {
    const items = buildCommandItems(t, () => undefined);
    expect(items.map((item) => item.id)).toEqual([
      'create-app',
      'nav-dashboard',
      'nav-apps',
      'nav-playground',
      'nav-examples',
      'nav-clarity',
    ]);
  });

  it('groups actions apart from navigation', () => {
    const items = buildCommandItems(t, () => undefined);
    expect(items[0]?.group).toBe('commandMenu.groups.actions');
    expect(items.slice(1).every((item) => item.group === 'commandMenu.groups.navigation')).toBe(
      true,
    );
  });

  it('navigates to the entry href when selected', () => {
    const navigate = jest.fn();
    const items = buildCommandItems(t, navigate);
    items.find((item) => item.id === 'nav-apps')?.onSelect();
    items.find((item) => item.id === 'nav-playground')?.onSelect();
    items.find((item) => item.id === 'create-app')?.onSelect();
    expect(navigate.mock.calls).toEqual([['/apps'], ['/playground'], ['/apps']]);
  });
});
