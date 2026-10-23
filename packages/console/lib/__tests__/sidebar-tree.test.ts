import {
  APP_TABS,
  activeAppIdOf,
  appHref,
  appTreeKey,
  buildApplicationRows,
  selectedNavKeyOf,
  selectedTreeKeyOf,
  visibleApplications,
} from '../sidebar-tree';

const apps = Array.from({ length: 12 }, (_, index) => ({ _id: `a${index}`, name: `App ${index}` }));
const base = {
  open: {},
  onOpenChange: () => undefined,
  tabLabel: (tab: string) => tab,
  tabIcon: () => () => null,
  leading: () => null,
  actions: () => null,
};

describe('selection', () => {
  it('derives the active application and the selected row from the pathname', () => {
    expect(activeAppIdOf('/apps')).toBeUndefined();
    expect(activeAppIdOf('/usage')).toBeUndefined();
    expect(activeAppIdOf('/apps/abc')).toBe('abc');
    expect(selectedTreeKeyOf('/apps')).toBeUndefined();
    expect(selectedTreeKeyOf('/apps/abc')).toBe('app:abc:general');
    expect(selectedTreeKeyOf('/apps/abc/credentials')).toBe('app:abc:credentials');
    expect(selectedTreeKeyOf('/apps/abc/credentials/x')).toBe('app:abc:credentials');
    expect(selectedTreeKeyOf('/apps/abc/nonsense')).toBe('app:abc:general');
  });

  it('leaves the section row unselected inside an application', () => {
    const section = (path: string) => `/${path.split('/')[1] ?? ''}`;
    expect(selectedNavKeyOf('/apps', section)).toBe('/apps');
    expect(selectedNavKeyOf('/apps/abc/usage', section)).toBeUndefined();
    expect(selectedNavKeyOf('/billing', section)).toBe('/billing');
  });
});

describe('visibleApplications', () => {
  it('limits the list and reports the rest', () => {
    expect(visibleApplications(apps, 8)).toMatchObject({ hidden: 4 });
    expect(visibleApplications(apps, 8).shown).toHaveLength(8);
  });

  it('keeps the active application even past the limit', () => {
    const result = visibleApplications(apps, 8, 'a10');
    expect(result.shown.map((app) => app._id)).toContain('a10');
    expect(result.hidden).toBe(3);
  });

  it('shows everything under the limit', () => {
    expect(visibleApplications(apps.slice(0, 3), 8)).toEqual({ shown: apps.slice(0, 3), hidden: 0 });
  });
});

describe('buildApplicationRows', () => {
  it('builds a row per application with every sub-page linked', () => {
    const { rows, hidden } = buildApplicationRows(apps.slice(0, 2), base);
    expect(hidden).toBe(0);
    expect(rows.map((row) => row.key)).toEqual(['app:a0', 'app:a1']);
    expect(rows[0]?.href).toBe('/apps/a0');
    expect(rows[0]?.items?.map((item) => item.href)).toEqual(
      APP_TABS.map((tab) => appHref('a0', tab)),
    );
    expect(rows[0]?.items?.map((item) => item.key)).toEqual(
      APP_TABS.map((tab) => appTreeKey('a0', tab)),
    );
    expect(rows[0]?.actionsVisibility).toBe('hover');
  });

  it('opens the active application unless told otherwise', () => {
    const [first, second] = buildApplicationRows(apps.slice(0, 2), {
      ...base,
      activeAppId: 'a1',
      open: { a0: true },
    }).rows;
    expect(first?.open).toBe(true);
    expect(second?.open).toBe(true);
    const [closed] = buildApplicationRows(apps.slice(0, 2), {
      ...base,
      activeAppId: 'a0',
      open: { a0: false },
    }).rows;
    expect(closed?.open).toBe(false);
  });

  it('reports the hidden count', () => {
    expect(buildApplicationRows(apps, base).hidden).toBe(4);
  });
});

describe('hrefs', () => {
  it('maps general to the bare route', () => {
    expect(appHref('x')).toBe('/apps/x');
    expect(appHref('x', 'webhooks')).toBe('/apps/x/webhooks');
  });
});
