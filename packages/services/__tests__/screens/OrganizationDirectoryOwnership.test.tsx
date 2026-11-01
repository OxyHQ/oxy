import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  dehydrate,
  hydrate,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { OxyServices } from '@oxy.so/core';
jest.mock('@oxy.so/core/session', () => jest.requireActual('../../../core/src/session/index'), {
  virtual: true,
});
import { createOxyRuntime } from '../../src/ui/runtime/createOxyRuntime';
import { attachQueryPersistence } from '../../src/ui/hooks/queryClient';

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
let client: QueryClient;

beforeEach(() => {
  onlineManager.setOnline(true);
  user = { id: 'alice', kind: 'personal' };
  sessionId = 'session-alice';
  runtime.setAccount(user as never);
  runtime.setActiveSessionId(sessionId);
  oxy.session.setAccessToken(token('alice'));
  jest
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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  onlineManager.setOnline(true);
  cleanup();
  client.clear();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});
afterAll(() => oxy.dispose());

function tree() {
  return (
    <QueryClientProvider client={client}>
      <OrganizationDirectorySearch key={user.id} onCreateAccount={jest.fn()} />
    </QueryClientProvider>
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
  act(() => onlineManager.setOnline(false));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.claim' }));
  await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.isPaused).toBe(true));
  return view;
}
async function resume() {
  await act(async () => {
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
  });
}

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

it('does not put claim evidence or owner identifiers in dehydrated mutation variables', async () => {
  await startPausedClaim();
  const state = dehydrate(client);
  expect(state.mutations).toHaveLength(1);
  expect(state.mutations[0].state.variables).toEqual({});
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain('private-case:alice');
  expect(serialized).not.toContain('session-alice');
  expect(serialized).not.toContain(token('alice'));
});

it('does not write claim evidence or owner identifiers to the shared persister', async () => {
  const storage = {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async (_key: string, _value: string) => {}),
    removeItem: jest.fn(async () => {}),
  };
  const persistence = attachQueryPersistence(client, storage as never);
  try {
    await persistence.restored;
    await startPausedClaim();
    await waitFor(
      () =>
        expect(
          storage.setItem.mock.calls.some(
            ([, value]) => JSON.parse(value).clientState.mutations.length === 1,
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    const writes = storage.setItem.mock.calls.map(([, value]) => value);
    expect(writes.some((value) => JSON.parse(value).clientState.mutations.length === 1)).toBe(true);
    const serialized = writes.join('');
    expect(serialized).not.toContain('private-case:alice');
    expect(serialized).not.toContain('session-alice');
    expect(serialized).not.toContain(token('alice'));
  } finally {
    persistence.unsubscribe();
  }
});

it('cannot replay a restored mutation without its in-memory operation', async () => {
  await startPausedClaim();
  const saved = dehydrate(client);
  cleanup();
  client.clear();
  const restored = new QueryClient();
  try {
    hydrate(restored, saved);
    act(() => onlineManager.setOnline(true));
    await restored.resumePausedMutations();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(restored.getMutationCache().getAll()[0]?.state.status).toBe('error');
  } finally {
    restored.clear();
  }
});

it('does not publish a late claim after A to B to A', async () => {
  let release: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const invalidate = jest.spyOn(client, 'invalidateQueries');
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
  const mutation = client.getMutationCache().getAll()[0];
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
    await waitFor(() => expect(mutation.state.status).not.toBe('pending'));
  });
  expect(screen.queryByText('organizationDirectory.claimSent')).toBeNull();
  expect(invalidate).not.toHaveBeenCalled();
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
  await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe('error'));
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
  act(() => onlineManager.setOnline(false));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.isPaused).toBe(true));
  const state = JSON.stringify(dehydrate(client).mutations);
  expect(state).not.toContain('Acme');
  expect(state).not.toContain('session-alice');
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

it('does not retry a non-idempotent claim even if the host enables mutation retries', async () => {
  client.setDefaultOptions({ queries: { retry: false }, mutations: { retry: 2, retryDelay: 0 } });
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
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const view = render(tree());
  fireEvent.change(screen.getByLabelText('organizationDirectory.search'), {
    target: { value: 'Acme' },
  });
  await screen.findByRole('button', { name: 'Acme' });
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  fireEvent.click(screen.getByRole('button', { name: 'organizationDirectory.addDirectory' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const mutation = client.getMutationCache().getAll()[0];
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
    await waitFor(() => expect(mutation.state.status).not.toBe('pending'));
  });
  expect(screen.queryByText('organizationDirectory.unclaimed')).toBeNull();
  expect(invalidate).not.toHaveBeenCalled();
});

it('keeps a claim pending across a same-context token refresh and accepts its response', async () => {
  let release: ((response: unknown) => void) | undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const invalidate = jest.spyOn(client, 'invalidateQueries');
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
  expect(invalidate).toHaveBeenCalledTimes(1);
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
    const mutation = client.getMutationCache().getAll()[0];
    await act(async () => {
      oxy.session.setAccessToken(token('bob'));
      finish?.(token('bob'));
      await waitFor(() => expect(mutation.state.status).toBe('error'));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    oxy.http.setAuthRefreshHandler(null);
  }
});

it('continues a paused claim after leaving the screen if the same owner remains', async () => {
  const view = await startPausedClaim();
  view.unmount();
  await resume();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
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
  await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe('error'));
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a retained new-account callback after an observed A to B to A transition', async () => {
  const onCreate = jest.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <OrganizationDirectorySearch onCreateAccount={onCreate} />
    </QueryClientProvider>,
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
      <QueryClientProvider client={client}>
        <OrganizationDirectorySearch onCreateAccount={onCreate} />
      </QueryClientProvider>,
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
  await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe('error'));
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
