import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  actionStatus,
  DataProvider,
  environment,
  type PersistBatch,
  type Persister,
  Store,
} from '@oxy.so/bloom-data';
import { OxyServices } from '@oxy.so/core';
jest.mock('@oxy.so/core/session', () => jest.requireActual('../../../core/src/session/index'), {
  virtual: true,
});
import { createOxyRuntime } from '../../src/ui/runtime/createOxyRuntime';

const oxy = new OxyServices({ baseURL: 'https://identity.example' });
let user = { id: 'alice', kind: 'personal' };
let sessionId = 'session-alice';
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
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({ oxyServices: oxy, user, activeSessionId: sessionId, canUsePrivateApi: true }),
}));
jest.mock('../../src/ui/runtime/runtimeContext', () => ({ useOxyRuntime: () => runtime }));
jest.mock('../../src/ui/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { OrganizationDirectorySearch } from '../../src/ui/components/organizations/OrganizationDirectorySearch';

const token = (id: string, session = `session-${id}`) =>
  `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: session, exp: 2000000000 })).toString('base64url')}.fixture`;
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
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
let store: Store;
let searchSpy: jest.SpyInstance;

beforeEach(() => {
  environment.setOnline(true);
  user = { id: 'alice', kind: 'personal' };
  sessionId = 'session-alice';
  runtime.setAccount(user as never);
  runtime.setActiveSessionId(sessionId);
  oxy.session.setAccessToken(token('alice'));
  searchSpy = jest
    .spyOn(oxy.organizations, 'search')
    .mockResolvedValue({ items: [organization], nextCursor: null } as never);
  fetchMock = jest.fn(async () => ({
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
  store = new Store();
});
afterEach(() => {
  environment.setOnline(true);
  cleanup();
  void store.close();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});
afterAll(() => oxy.dispose());

function tree() {
  return (
    <DataProvider store={store}>
      <OrganizationDirectorySearch key={user.id} onCreateAccount={jest.fn()} />
    </DataProvider>
  );
}
async function startPausedClaim() {
  const view = render(tree());
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
  return view;
}
async function resume() {
  await act(async () => {
    environment.setOnline(true);
  });
  await settled();
}
/** Every call the store's actions made has ended. */
async function settled() {
  await act(async () => {});
  await waitFor(() => expect(actionStatus(store)).toEqual({ pending: 0, paused: 0 }));
}
/** The directory search was read again: a claim or creation was published. */
const searchesAfter = (count: number) => expect(searchSpy).toHaveBeenCalledTimes(count);

it('does not send a paused claim after A changes to B', async () => {
  const view = await startPausedClaim();
  act(() => {
    user = { id: 'bob', kind: 'personal' };
    sessionId = 'session-bob';
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(tree());
  });
  await resume();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('still sends a paused claim when the same owner resumes', async () => {
  await startPausedClaim();
  await resume();
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/claims'))).toBe(true),
  );
  const [, options] = fetchMock.mock.calls.find(([url]) =>
    String(url).includes('/claims'),
  ) as unknown as [string, RequestInit];
  expect((options.headers as Record<string, string>).Authorization).toBe(
    `Bearer ${token('alice')}`,
  );
  expect(options.body).toContain('private-case:alice');
});

it.each(['same subject, new session', 'A to B to A', 'bearer changes before projection'])(
  'does not replay across %s',
  async (scenario) => {
    const view = await startPausedClaim();
    act(() => {
      if (scenario === 'same subject, new session') {
        sessionId = 'session-alice-2';
        oxy.session.setAccessToken(token('alice', sessionId));
        runtime.setActiveSessionId(sessionId);
      } else {
        oxy.session.setAccessToken(token('bob'));
        if (scenario === 'A to B to A') {
          runtime.batch(() => {
            runtime.setAccount({ id: 'bob', kind: 'personal' } as never);
            runtime.setActiveSessionId('session-bob');
          });
          oxy.session.setAccessToken(token('alice'));
          runtime.batch(() => {
            runtime.setAccount(user as never);
            runtime.setActiveSessionId(sessionId);
          });
        }
      }
      view.rerender(tree());
    });
    await resume();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('keeps a paused claim in memory only: nothing of it reaches the durable copy', async () => {
  const writes: PersistBatch[] = [];
  const persister: Persister = {
    open: async () => {},
    readRecords: async () => [],
    readList: async () => null,
    write: async (batch) => {
      writes.push(batch);
    },
    close: async () => {},
    destroy: async () => {},
  };
  store = new Store({ persister });
  await startPausedClaim();
  await act(() => store.flush());
  const serialized = JSON.stringify(writes);
  expect(serialized).not.toContain('private-case:alice');
  expect(serialized).not.toContain('session-alice');
  expect(serialized).not.toContain(token('alice'));
});

it('does not publish a late claim after A to B to A', async () => {
  let release: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => {
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount({ id: 'bob', kind: 'personal' } as never);
      runtime.setActiveSessionId('session-bob');
    });
    oxy.session.setAccessToken(token('alice'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(tree());
  });
  await act(async () => {
    release?.({
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
    });
    await waitFor(() => expect(actionStatus(store).pending).toBe(0));
  });
  expect(screen.queryByText('organizationDirectory.claimSent')).toBeNull();
  searchesAfter(1);
});

it('refuses a claim when the installed bearer has a known different subject', async () => {
  render(tree());
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
  act(() => oxy.session.setAccessToken(token('bob')));
  expect(screen.queryByLabelText('organizationDirectory.evidence')).toBeNull();
  act(() => retained());
  await settled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('preserves the existing opaque-token attempt with no decoded subject', async () => {
  oxy.session.setAccessToken('opaque-fixture');
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/claims'))).toBe(true),
  );
  const [, options] = fetchMock.mock.calls.find(([url]) =>
    String(url).includes('/claims'),
  ) as unknown as [string, RequestInit];
  // Core's current transport omits authorization for an opaque token; this
  // test does not claim that the server would accept the anonymous request.
  expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
});

it('does not replay a paused creation after the owner changes', async () => {
  const view = render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByRole('button', { name: 'Acme' });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  act(() => environment.setOnline(false));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await waitFor(() => expect(actionStatus(store).paused).toBe(1));
  act(() => {
    user = { id: 'bob', kind: 'personal' };
    sessionId = 'session-bob';
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(tree());
  });
  await resume();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('never retries a non-idempotent claim', async () => {
  fetchMock.mockRejectedValue(new Error('network failure'));
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await screen.findByText('organizationDirectory.claimFailed');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('continues an unchanged sub-only token through the real transport', async () => {
  const subOnly = `e30.${Buffer.from(JSON.stringify({ sub: 'alice', exp: 2000000000 })).toString('base64url')}.fixture`;
  oxy.session.setAccessToken(subOnly);
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/claims'))).toBe(true),
  );
  const [, options] = fetchMock.mock.calls.find(([url]) =>
    String(url).includes('/claims'),
  ) as unknown as [string, RequestInit];
  expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${subOnly}`);
});

it('publishes a successful creation for the unchanged owner', async () => {
  fetchMock.mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: organization }),
  }));
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByRole('button', { name: 'Acme' });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await screen.findByText('organizationDirectory.unclaimed');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect((options.headers as Record<string, string>).Authorization).toBe(
    `Bearer ${token('alice')}`,
  );
});

it('does not publish a late creation after the observed account changes', async () => {
  let release: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByRole('button', { name: 'Acme' });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => {
    user = { id: 'bob', kind: 'personal' };
    sessionId = 'session-bob';
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(tree());
  });
  await act(async () => {
    release?.({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ data: organization }),
    });
    await waitFor(() => expect(actionStatus(store).pending).toBe(0));
  });
  expect(screen.queryByText('organizationDirectory.unclaimed')).toBeNull();
  searchesAfter(1);
});

it('keeps a claim pending across a same-context token refresh and accepts its response', async () => {
  let release: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const epoch = oxy.http.getSessionEpoch();
  const rotated = `e30.${Buffer.from(JSON.stringify({ userId: 'alice', sessionId, exp: 2000000100, version: 2 })).toString('base64url')}.fixture`;
  act(() => oxy.session.setAccessToken(rotated));
  expect(oxy.http.getSessionEpoch()).toBe(epoch);
  expect(
    screen.getByRole('button', { name: 'organizationDirectory.claim' }).hasAttribute('disabled'),
  ).toBe(true);
  await act(async () => {
    release?.({
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
    });
  });
  await screen.findByText('organizationDirectory.claimSent');
  await waitFor(() => searchesAfter(2));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not send a claim when the account changes during auth preflight', async () => {
  let began: (() => void) | undefined;
  let finish: ((value: string) => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const refresh = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const nearExpiry = `e30.${Buffer.from(JSON.stringify({ userId: 'alice', sessionId, exp: Math.floor(Date.now() / 1000) + 10 })).toString('base64url')}.fixture`;
  oxy.session.setAccessToken(nearExpiry);
  oxy.http.setAuthRefreshHandler(async () => {
    began?.();
    return refresh;
  });
  try {
    render(tree());
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
    await waiting;
    await act(async () => {
      oxy.session.setAccessToken(token('bob'));
      finish?.(token('bob'));
      await waitFor(() => expect(actionStatus(store).pending).toBe(0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    oxy.http.setAuthRefreshHandler(null);
  }
});

it('does not replay a paused claim after leaving the screen, even if the owner remains', async () => {
  const view = await startPausedClaim();
  view.unmount();
  await resume();
  await settled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not cancel a claim already in HTTP preflight when the screen unmounts', async () => {
  let began: (() => void) | undefined;
  let finish: ((value: string) => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const refresh = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const nearExpiry = `e30.${Buffer.from(JSON.stringify({ userId: 'alice', sessionId, exp: Math.floor(Date.now() / 1000) + 10 })).toString('base64url')}.fixture`;
  oxy.session.setAccessToken(nearExpiry);
  oxy.http.setAuthRefreshHandler(async () => {
    began?.();
    return refresh;
  });
  try {
    const view = render(tree());
    fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
    fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
      target: { value: 'private-case:alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
    await waiting;
    expect(fetchMock).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      finish?.(token('alice'));
      await waitFor(() => expect(actionStatus(store).pending).toBe(0));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    searchesAfter(1);
  } finally {
    oxy.http.setAuthRefreshHandler(null);
  }
});

it('keeps an offline claim through a same-context bearer refresh', async () => {
  await startPausedClaim();
  const epoch = oxy.http.getSessionEpoch();
  const rotated = `e30.${Buffer.from(JSON.stringify({ userId: 'alice', sessionId, exp: 2000000100, version: 2 })).toString('base64url')}.fixture`;
  act(() => oxy.session.setAccessToken(rotated));
  expect(oxy.http.getSessionEpoch()).toBe(epoch);
  await resume();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${rotated}`);
});

it('does not replay an unmounted claim after a later account change', async () => {
  const view = await startPausedClaim();
  view.unmount();
  act(() => {
    user = { id: 'bob', kind: 'personal' };
    sessionId = 'session-bob';
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
  });
  await resume();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('keeps the originally submitted evidence through a rerender while paused', async () => {
  await startPausedClaim();
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'new-unsent-value' },
  });
  await resume();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(options.body).toContain('private-case:alice');
  expect(options.body).not.toContain('new-unsent-value');
});

/** The test button exposes the handler that a delayed confirmation may retain. */
function retainedHandler(button: HTMLElement): () => void {
  const key = Object.keys(button).find((name) => name.startsWith('__reactProps$'));
  if (!key) throw new Error('React button props not found');
  return (button as unknown as Record<string, { onClick: () => void }>)[key].onClick;
}

it('rejects a retained claim handler after an observed A to B to A transition', async () => {
  const view = render(tree());
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
  act(() => {
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount({ id: 'bob', kind: 'personal' } as never);
      runtime.setActiveSessionId('session-bob');
    });
    oxy.session.setAccessToken(token('alice'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(tree());
  });
  act(() => retained());
  await settled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a retained new-account callback after an observed A to B to A transition', async () => {
  const onCreate = jest.fn();
  const view = render(
    <DataProvider store={store}>
      <OrganizationDirectorySearch onCreateAccount={onCreate} />
    </DataProvider>,
  );
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  const retained = retainedHandler(
    await screen.findByRole('button', { name: 'organizationDirectory.newAccount' }),
  );
  act(() => {
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount({ id: 'bob', kind: 'personal' } as never);
      runtime.setActiveSessionId('session-bob');
    });
    oxy.session.setAccessToken(token('alice'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(
      <DataProvider store={store}>
        <OrganizationDirectorySearch onCreateAccount={onCreate} />
      </DataProvider>,
    );
  });
  act(() => retained());
  expect(onCreate).not.toHaveBeenCalled();
});

it('rejects a retained handler after bearer A to B to A before runtime projection', async () => {
  render(tree());
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
  act(() => {
    oxy.session.setAccessToken(token('bob'));
    oxy.session.setAccessToken(token('alice'));
  });
  act(() => retained());
  await settled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('refuses a new claim while the bearer subject differs from the projected personal user', async () => {
  render(tree());
  act(() => oxy.session.setAccessToken(token('bob')));
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await screen.findByText('organizationDirectory.claimFailed');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sends one claim for synchronous presses and unlocks after failure', async () => {
  let rejectFirst: ((reason: Error) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  fetchMock.mockRejectedValue(new Error('offline'));
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  const button = screen.getByRole('button', { name: 'organizationDirectory.claim' });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(actionStatus(store).pending).toBe(1);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => {
    rejectFirst?.(new Error('offline'));
  });
  await screen.findByText('organizationDirectory.claimFailed');
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('sends one creation for synchronous presses and unlocks after failure', async () => {
  let rejectFirst: ((reason: Error) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  fetchMock.mockRejectedValue(new Error('offline'));
  render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByRole('button', { name: 'Acme' });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  const button = screen.getByRole('button', { name: 'organizationDirectory.addDirectory' });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(actionStatus(store).pending).toBe(1);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => {
    rejectFirst?.(new Error('offline'));
  });
  await screen.findByText('organizationDirectory.saveFailed');
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('does not let an in-flight claim under A block a fresh claim under B', async () => {
  let releaseA: ((value: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseA = resolve;
      }),
  );
  fetchMock.mockResolvedValue({
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
  });
  const view = render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => {
    user = { id: 'bob', kind: 'personal' };
    sessionId = 'session-bob';
    oxy.session.setAccessToken(token('bob'));
    runtime.batch(() => {
      runtime.setAccount(user as never);
      runtime.setActiveSessionId(sessionId);
    });
    view.rerender(tree());
  });
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:bob' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [, options] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
  expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${token('bob')}`);
  await act(async () => {
    releaseA?.({
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
    });
    await waitFor(() => expect(actionStatus(store).pending).toBe(0));
  });
});

it('suppresses local completion effects after unmount without claiming remote cancellation', async () => {
  let release: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Acme' }));
  fireEvent.change(screen.getByLabelText('organizationDirectory.evidence'), {
    target: { value: 'private-case:alice' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => {
    release?.({
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
    });
    await waitFor(() => expect(actionStatus(store).pending).toBe(0));
  });
  searchesAfter(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
