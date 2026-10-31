import { StrictMode, Suspense, startTransition, useLayoutEffect } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { OxyServices } from '@oxy.so/core';
import { useSessionOwner } from '../../src/ui/hooks/useSessionOwner';
import { createTestRuntime } from '../helpers/runtimeHarness';

const token = (userId: string, version: number, sessionId = userId) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId, version })).toString('base64url')}.fixture`;
const subOnly = `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.fixture`;

it('checks live state synchronously, keeps refresh, and invalidates A to B to A', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const { result, rerender, unmount } = renderHook(
    ({ account }) => useSessionOwner(oxy, runtime, account, 'require-match'),
    { initialProps: { account: 'alice' } },
  );
  const alice = result.current;
  expect(alice()).toBe(true);
  act(() => {
    oxy.session.setAccessToken(token('alice', 2));
    expect(alice()).toBe(true);
    runtime.setAccount({ id: 'alice', username: 'new-profile' } as never);
    expect(alice()).toBe(true);
  });
  act(() => {
    oxy.session.setAccessToken(token('bob', 1));
    // React has not rerendered yet.
    expect(alice()).toBe(false);
    runtime.setAccount({ id: 'bob' } as never);
  });
  rerender({ account: 'bob' });
  expect(result.current()).toBe(true);
  act(() => {
    oxy.session.setAccessToken(token('alice', 3));
    runtime.setAccount({ id: 'alice' } as never);
  });
  rerender({ account: 'alice' });
  expect(alice()).toBe(false);
  expect(result.current()).toBe(true);
  const current = result.current;
  act(() => oxy.session.setAccessToken(token('alice', 4, 'other-session')));
  expect(current()).toBe(false);
  unmount();
  oxy.dispose();
});

it('rejects a runtime bound to a different client even when subjects match', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const other = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: other });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  other.session.setAccessToken(token('alice', 1));
  const { result, unmount } = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  expect(result.current()).toBe(false);
  unmount();
  oxy.dispose();
  other.dispose();
});

it('rejects an externally supplied bearer which can change without a notification', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  let external = token('alice', 1);
  oxy.http.setAccessTokenProvider(() => external);
  const { result, unmount } = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  const old = result.current;
  expect(old()).toBe(true);
  external = token('bob', 1);
  expect(old()).toBe(false);
  unmount();
  oxy.dispose();
});

it('rejects a provider removed after an unobserved bearer switch', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  let external = token('alice', 1);
  oxy.http.setAccessTokenProvider(() => external);
  const { result, unmount } = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  const old = result.current;
  external = token('bob', 1);
  oxy.http.setAccessTokenProvider(null);
  expect(old()).toBe(false);
  unmount();
  oxy.dispose();
});

it('cannot activate a callback captured before a bearer is installed', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  const { result, unmount } = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  const empty = result.current;
  expect(empty()).toBe(false);
  act(() => oxy.session.setAccessToken(token('alice', 1)));
  expect(empty()).toBe(false);
  expect(result.current()).toBe(true);
  unmount();
  oxy.dispose();
});

it('invalidates synchronously inside runtime batches even if the snapshot ends at A', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const { result, unmount } = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  const old = result.current;
  expect(old()).toBe(true);
  act(() => runtime.batch(() => {
    runtime.setAccount({ id: 'bob' } as never);
    expect(runtime.getSnapshot().account?.id).toBe('alice');
    expect(old()).toBe(false);
    runtime.setAccount({ id: 'alice' } as never);
    expect(old()).toBe(false);
  }));
  expect(old()).toBe(false);
  unmount();
  oxy.dispose();
});

it('suppresses an asynchronous success effect after logout and a new account', async () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const { result, unmount } = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  const belongsToAlice = result.current;
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  const effects: string[] = [];
  const operation = pending.then(() => { if (belongsToAlice()) effects.push('alice'); });
  act(() => {
    oxy.session.clear();
    runtime.clearSession();
    oxy.session.setAccessToken(token('bob', 1));
    runtime.setAccount({ id: 'bob' } as never);
  });
  resolve();
  await operation;
  expect(effects).toEqual([]);
  unmount();
  oxy.dispose();
});

it('invalidates retained callbacks on projected A to B to A even without token changes', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const { result, rerender, unmount } = renderHook(
    ({ account }) => useSessionOwner(oxy, runtime, account, 'require-match'),
    { initialProps: { account: 'alice' } },
  );
  const alice = result.current;
  rerender({ account: 'bob' });
  expect(alice()).toBe(false);
  expect(result.current()).toBe(false);
  rerender({ account: 'alice' });
  expect(alice()).toBe(false);
  expect(result.current()).toBe(true);
  const last = result.current;
  rerender({ account: 'alice' });
  expect(last()).toBe(true);
  unmount();
  expect(last()).toBe(false);
  oxy.dispose();
});

it('invalidates the old owner before child layout effects after a projection change', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const observed: boolean[] = [];
  let old: (() => boolean) | undefined;
  function Child({ account }: { account: string }) {
    useLayoutEffect(() => {
      if (account === 'bob') observed.push(old!());
    }, [account]);
    return null;
  }
  function Parent({ account }: { account: string }) {
    const owner = useSessionOwner(oxy, runtime, account, 'require-match');
    useLayoutEffect(() => {
      if (account === 'alice' && !old) old = owner;
    }, [account, owner]);
    return <Child account={account} />;
  }
  const view = render(<Parent account="alice" />);
  view.rerender(<Parent account="bob" />);
  expect(observed).toEqual([false]);
  view.unmount();
  oxy.dispose();
});

it('invalidates the owner before child layout cleanup on unmount', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const observed: boolean[] = [];
  function Child({ owner }: { owner: () => boolean }) {
    useLayoutEffect(() => () => { observed.push(owner()); }, [owner]);
    return null;
  }
  function Parent() {
    const owner = useSessionOwner(oxy, runtime, 'alice', 'require-match');
    return <Child owner={owner} />;
  }
  const view = render(<Parent />);
  view.unmount();
  expect(observed).toEqual([false]);
  oxy.dispose();
});

it('documents that a child ref cleanup can precede projection invalidation', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  let old: (() => boolean) | undefined;
  const observed: boolean[] = [];
  function Child({ account }: { account: string }) {
    return <div ref={node => { if (!node && account === 'alice') observed.push(old!()); }} />;
  }
  function Parent({ account }: { account: string }) {
    const owner = useSessionOwner(oxy, runtime, account, 'require-match');
    useLayoutEffect(() => { if (account === 'alice') old = owner; }, [account, owner]);
    return <Child account={account} />;
  }
  const view = render(<Parent account="alice" />);
  view.rerender(<Parent account="bob" />);
  expect(observed).toEqual([true]);
  view.unmount();
  oxy.dispose();
});

it('invalidates synchronously on a runtime subject change before a child ref cleanup', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  let old: (() => boolean) | undefined;
  const observed: boolean[] = [];
  function Child({ account }: { account: string }) {
    return <div ref={node => { if (!node && account === 'alice') observed.push(old!()); }} />;
  }
  function Parent({ account }: { account: string }) {
    const owner = useSessionOwner(oxy, runtime, account, 'require-match');
    useLayoutEffect(() => { if (account === 'alice' && !old) old = owner; }, [account, owner]);
    return <Child account={account} />;
  }
  const view = render(<Parent account="alice" />);
  act(() => runtime.setAccount({ id: 'bob' } as never));
  expect(old!()).toBe(false);
  view.rerender(<Parent account="bob" />);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(value => !value)).toBe(true);
  view.unmount();
  oxy.dispose();
});

it.each(['opaque-token', subOnly])('requires an explicit choice for unknown subject: %s', (bearer) => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(bearer);
  const strict = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'require-match'));
  const compatible = renderHook(() => useSessionOwner(oxy, runtime, 'alice', 'allow-unknown'));
  expect(strict.result.current()).toBe(false);
  expect(compatible.result.current()).toBe(true);
  act(() => oxy.session.setAccessToken(token('bob', 1)));
  expect(compatible.result.current()).toBe(false);
  act(() => oxy.session.clear());
  expect(compatible.result.current()).toBe(false);
  strict.unmount();
  compatible.unmount();
  oxy.dispose();
});

it('maintains the contract in StrictMode without a render loop', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const { result, rerender, unmount } = renderHook(
    ({ account }) => useSessionOwner(oxy, runtime, account, 'require-match'),
    { initialProps: { account: 'alice' }, wrapper: StrictMode },
  );
  const previous = result.current;
  expect(previous()).toBe(true);
  rerender({ account: 'bob' });
  expect(previous()).toBe(false);
  rerender({ account: 'alice' });
  expect(previous()).toBe(false);
  const current = result.current;
  expect(current()).toBe(true);
  unmount();
  expect(current()).toBe(false);
  oxy.dispose();
});

it('does not publish the owner from a suspended, abandoned render', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  const never = new Promise<never>(() => {});
  let committed: (() => boolean) | undefined;
  let attempted: (() => boolean) | undefined;
  function Screen({ account }: { account: string }) {
    const owner = useSessionOwner(oxy, runtime, account, 'require-match');
    useLayoutEffect(() => {
      committed = owner;
    }, [owner]);
    if (account === 'bob') {
      attempted = owner;
      throw never;
    }
    return <span>{account}</span>;
  }
  const view = render(<Suspense fallback={<span>loading</span>}><Screen account="alice" /></Suspense>);
  const alice = committed!;
  act(() => {
    startTransition(() => view.rerender(<Suspense fallback={<span>loading</span>}><Screen account="bob" /></Suspense>));
  });
  expect(attempted).toBeDefined();
  expect(attempted!()).toBe(false);
  expect(alice()).toBe(true);
  view.rerender(<Suspense fallback={<span>loading</span>}><Screen account="alice" /></Suspense>);
  expect(alice()).toBe(true);
  view.unmount();
  oxy.dispose();
});

it('fails closed during server rendering before an owner can be committed', () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  oxy.session.setAccessToken(token('alice', 1));
  let duringRender = true;
  function Screen() {
    duringRender = useSessionOwner(oxy, runtime, 'alice', 'require-match')();
    return null;
  }
  renderToString(<Screen />);
  expect(duringRender).toBe(false);
  oxy.dispose();
});
