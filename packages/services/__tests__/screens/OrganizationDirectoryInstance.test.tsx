import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { actionStatus, DataProvider, environment, Store } from '@oxy.so/bloom-data';
import { OxyServices } from '@oxy.so/core';
jest.mock('@oxy.so/core/session', () => jest.requireActual('../../../core/src/session/index'), {
  virtual: true,
});
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { OxyRuntimeContext } from '../../src/ui/context/oxyRuntimeContext';
import { OxyRuntimeHandleProvider } from '../../src/ui/runtime/runtimeContext';
import { createOxyRuntime } from '../../src/ui/runtime/createOxyRuntime';
import { OrganizationDirectorySearch } from '../../src/ui/components/organizations/OrganizationDirectorySearch';

const token = (id: string) =>
  `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: `session-${id}`, exp: 2000000000 })).toString('base64url')}.fixture`;
const organization = {
  accountId: 'existing-org',
  name: 'Acme',
  username: 'acme',
  organizationType: 'business',
  claimStatus: 'unclaimed',
  status: 'active',
  websiteUrl: null,
  countryCode: null,
  legalName: null,
  avatar: null,
  aliases: [],
  verifiedDomains: [],
  mergedIntoAccountId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
function instance(id: string) {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  oxy.session.setAccessToken(token(id));
  jest
    .spyOn(oxy.organizations, 'search')
    .mockResolvedValue({ items: [organization], nextCursor: null } as never);
  const user = { id, kind: 'personal' };
  const runtime = createOxyRuntime({
    oxyServices: oxy,
    sessionClient: {
      getState: () => null,
      getDirectory: () => null,
      subscribe: () => () => {},
      refreshDirectory: async () => {},
      activateContext: async () => {},
      signOutContext: async () => {},
      signOutPrincipal: async () => {},
    },
    sessionClientHost: { setCurrentAccountId: () => {} },
    identity: null,
    onDeviceEmpty: async () => {},
    logger: () => {},
  });
  runtime.batch(() => {
    runtime.setAccount(user as never);
    runtime.setActiveSessionId(`session-${id}`);
  });
  return { oxy, runtime, user };
}
/** Every call the store's actions made has ended. */
async function settled(store: Store) {
  await act(async () => {});
  await waitFor(() => expect(actionStatus(store)).toEqual({ pending: 0, paused: 0 }));
}
function retainedHandler(button: HTMLElement): () => void {
  const key = Object.keys(button).find((name) => name.startsWith('__reactProps$'));
  if (!key) throw new Error('React button props not found');
  return (button as unknown as Record<string, { onClick: () => void }>)[key].onClick;
}
it('rejects a retained A handler after provider instance A to B to A', async () => {
  const a = instance('alice');
  const b = instance('bob');
  expect(a.runtime.getAccountSessionRevision()).toBe(b.runtime.getAccountSessionRevision());
  expect(a.oxy.http.getSessionEpoch()).toBe(b.oxy.http.getSessionEpoch());
  const store = new Store();
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      data: {
        id: 'claim1',
        accountId: 'existing-org',
        claimantUserId: 'alice',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  }));
  global.fetch = fetchMock as never;
  const tree = (entry: typeof a) => (
    <DataProvider store={store}>
      <OxyRuntimeHandleProvider value={entry.runtime}>
        <OxyRuntimeContext.Provider
          value={
            {
              oxyServices: entry.oxy,
              user: entry.user,
              activeSessionId: `session-${entry.user.id}`,
              canUsePrivateApi: true,
            } as never
          }
        >
          <OrganizationDirectorySearch onCreateAccount={jest.fn()} />
        </OxyRuntimeContext.Provider>
      </OxyRuntimeHandleProvider>
    </DataProvider>
  );
  try {
    const view = render(tree(a));
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    const retained = retainedHandler(
      screen.getByRole('button', { name: 'organizationDirectory.claim' }),
    );
    view.rerender(tree(b));
    view.rerender(tree(a));
    act(() => retained());
    await settled(store);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    cleanup();
    void store.close();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    a.oxy.dispose();
    b.oxy.dispose();
  }
});

it('discards A form on provider replacement and permits a fresh B claim', async () => {
  const a = instance('alice');
  const b = instance('bob');
  const store = new Store();
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      data: {
        id: 'claim2',
        accountId: 'existing-org',
        claimantUserId: 'bob',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  }));
  global.fetch = fetchMock as never;
  const tree = (entry: typeof a) => (
    <DataProvider store={store}>
      <OxyRuntimeHandleProvider value={entry.runtime}>
        <OxyRuntimeContext.Provider
          value={
            {
              oxyServices: entry.oxy,
              user: entry.user,
              activeSessionId: `session-${entry.user.id}`,
              canUsePrivateApi: true,
            } as never
          }
        >
          <OrganizationDirectorySearch onCreateAccount={jest.fn()} />
        </OxyRuntimeContext.Provider>
      </OxyRuntimeHandleProvider>
    </DataProvider>
  );
  try {
    const view = render(tree(a));
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    const retained = retainedHandler(
      screen.getByRole('button', { name: 'organizationDirectory.claim' }),
    );
    view.rerender(tree(b));
    expect(screen.queryByLabelText('organizationDirectory.evidence')).toBeNull();
    act(() => retained());
    await settled(store);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:bob' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((options.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${token('bob')}`,
    );
    expect(options.body).toContain('private-case:bob');
  } finally {
    cleanup();
    void store.close();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    a.oxy.dispose();
    b.oxy.dispose();
  }
});

it('rejects reentry from the replacement tree layout phase', async () => {
  const { useLayoutEffect } = await import('react');
  const a = instance('alice');
  const b = instance('bob');
  const store = new Store();
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      data: {
        id: 'claim1',
        accountId: 'existing-org',
        claimantUserId: 'alice',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  }));
  global.fetch = fetchMock as never;
  const Invoke = ({ handler }: { handler: () => void }) => {
    useLayoutEffect(() => {
      handler();
    }, [handler]);
    return null;
  };
  const tree = (entry: typeof a, handler?: () => void) => (
    <DataProvider store={store}>
      <OxyRuntimeHandleProvider value={entry.runtime}>
        <OxyRuntimeContext.Provider
          value={
            {
              oxyServices: entry.oxy,
              user: entry.user,
              activeSessionId: `session-${entry.user.id}`,
              canUsePrivateApi: true,
            } as never
          }
        >
          <OrganizationDirectorySearch onCreateAccount={jest.fn()} />
          {handler ? <Invoke handler={handler} /> : null}
        </OxyRuntimeContext.Provider>
      </OxyRuntimeHandleProvider>
    </DataProvider>
  );
  try {
    const view = render(tree(a));
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    const retained = retainedHandler(
      screen.getByRole('button', { name: 'organizationDirectory.claim' }),
    );
    view.rerender(tree(b, retained));
    await settled(store);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    cleanup();
    void store.close();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    a.oxy.dispose();
    b.oxy.dispose();
  }
});

it('does not replay a queued A claim after the provider is replaced with B', async () => {
  const a = instance('alice');
  const b = instance('bob');
  const store = new Store();
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      data: {
        id: 'claim1',
        accountId: 'existing-org',
        claimantUserId: 'alice',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  }));
  global.fetch = fetchMock as never;
  const tree = (entry: typeof a) => (
    <DataProvider store={store}>
      <OxyRuntimeHandleProvider value={entry.runtime}>
        <OxyRuntimeContext.Provider
          value={
            {
              oxyServices: entry.oxy,
              user: entry.user,
              activeSessionId: `session-${entry.user.id}`,
              canUsePrivateApi: true,
            } as never
          }
        >
          <OrganizationDirectorySearch onCreateAccount={jest.fn()} />
        </OxyRuntimeContext.Provider>
      </OxyRuntimeHandleProvider>
    </DataProvider>
  );
  try {
    const view = render(tree(a));
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    act(() => environment.setOnline(false));
    fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
    await waitFor(() => expect(actionStatus(store).paused).toBe(1));
    view.rerender(tree(b));
    await act(async () => {
      environment.setOnline(true);
    });
    await settled(store);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    environment.setOnline(true);
    cleanup();
    void store.close();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    a.oxy.dispose();
    b.oxy.dispose();
  }
});

it('does not replay A when replacement B resumes mutations from a layout effect', async () => {
  const { useLayoutEffect } = await import('react');
  const a = instance('alice');
  const b = instance('bob');
  const store = new Store();
  const originalFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({
      data: {
        id: 'claim1',
        accountId: 'existing-org',
        claimantUserId: 'alice',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  }));
  global.fetch = fetchMock as never;
  const Resume = () => {
    useLayoutEffect(() => {
      environment.setOnline(true);
    }, []);
    return null;
  };
  const tree = (entry: typeof a, resume = false) => (
    <DataProvider store={store}>
      <OxyRuntimeHandleProvider value={entry.runtime}>
        <OxyRuntimeContext.Provider
          value={
            {
              oxyServices: entry.oxy,
              user: entry.user,
              activeSessionId: `session-${entry.user.id}`,
              canUsePrivateApi: true,
            } as never
          }
        >
          <OrganizationDirectorySearch onCreateAccount={jest.fn()} />
          {resume ? <Resume /> : null}
        </OxyRuntimeContext.Provider>
      </OxyRuntimeHandleProvider>
    </DataProvider>
  );
  try {
    const view = render(tree(a));
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    act(() => environment.setOnline(false));
    fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
    await waitFor(() => expect(actionStatus(store).paused).toBe(1));
    view.rerender(tree(b, true));
    await settled(store);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    environment.setOnline(true);
    cleanup();
    void store.close();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    a.oxy.dispose();
    b.oxy.dispose();
  }
});
