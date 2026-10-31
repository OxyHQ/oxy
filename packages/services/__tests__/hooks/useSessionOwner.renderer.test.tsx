import { useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { OxyServices } from '@oxy.so/core';
import { useSessionOwner } from '../../src/ui/hooks/useSessionOwner';
import { createTestRuntime } from '../helpers/runtimeHarness';

it('fences a projection switch before child layout and unmount in the test renderer', async () => {
  const oxy = new OxyServices({ baseURL: 'https://identity.example' });
  const runtime = createTestRuntime({ oxyServices: oxy });
  runtime.setAccount({ id: 'alice' } as never);
  const payload = Buffer.from(JSON.stringify({ userId: 'alice', sessionId: 's1' })).toString('base64url');
  oxy.session.setAccessToken(`e30.${payload}.fixture`);
  const oldChecks: boolean[] = [];
  let old: (() => boolean) | undefined;
  let tree: ReactTestRenderer;
  function Child({ account }: { account: string }) {
    useLayoutEffect(() => {
      if (account === 'bob') oldChecks.push(old!());
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
  try {
    await act(async () => { tree = create(<Parent account="alice" />); });
    expect(old!()).toBe(true);
    await act(async () => { tree.update(<Parent account="bob" />); });
    expect(oldChecks).toEqual([false]);
    await act(async () => { tree.update(<Parent account="alice" />); });
    expect(old!()).toBe(false);
    await act(async () => { tree.unmount(); });
  } finally {
    oxy.dispose();
  }
});
