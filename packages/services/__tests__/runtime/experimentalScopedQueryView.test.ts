import { QueryClient } from '@tanstack/react-query';
import { ExperimentalContextBarrier } from '../../../core/src/session/experimentalContextBarrier';
import {
  createExperimentalScopedQueryView,
  createExperimentalStagedQueryPublisher,
} from '../../src/ui/hooks/experimentalScopedQueryView';

const alice = { actorId: 'alice', accountId: 'org', sessionId: 's-alice' };
const nate = { actorId: 'nate', accountId: 'org', sessionId: 's-nate' };

function fixture() {
  let actor = 'alice';
  let token = 'old';
  const gate = new ExperimentalContextBarrier({
    getCredential: () => ({ deviceId: 'device', deviceSecret: 'secret' }),
    getAccessToken: () => token,
    setAccessToken: (value) => {
      token = value;
    },
    mint: async () => ({
      version: 1,
      deviceId: 'device',
      deviceSessionId: 'instance',
      revision: actor === 'alice' ? 1 : 2,
      contextId: `ctx-${actor}`,
      actorId: actor,
      accountId: 'org',
      sessionId: `s-${actor}`,
      accessToken: `token-${actor}`,
      expiresAt: '2099-01-01T00:00:00Z',
    }),
    readState: async () => ({
      deviceId: 'device',
      revision: actor === 'alice' ? 1 : 2,
      updatedAt: 1,
      activeAccountId: 'org',
      accounts: [
        { accountId: 'org', sessionId: `s-${actor}`, authuser: 0, operatedByUserId: actor },
      ],
    }),
    readDirectory: async () => ({
      deviceId: 'device',
      revision: actor === 'alice' ? 1 : 2,
      updatedAt: 1,
      activeContextId: `ctx-${actor}`,
      principals: [
        {
          id: `p-${actor}`,
          userId: actor,
          authuser: 0,
          user: { id: actor, username: actor },
          contexts: [
            {
              id: `ctx-${actor}`,
              accountId: 'org',
              kind: 'organization',
              relationship: 'member',
              account: { id: 'org', username: 'org' },
              onDevice: true,
              available: true,
              active: true,
              lastUsedAt: null,
            },
          ],
        },
      ],
    }),
  });
  return {
    gate,
    switchToNate: () => {
      actor = 'nate';
      gate.invalidate();
    },
  };
}

it('closes old reads and deferred navigation while a separately staged owner becomes active', async () => {
  const f = fixture();
  const aliceClient = new QueryClient();
  const nateClient = new QueryClient();
  try {
    const publisher = createExperimentalStagedQueryPublisher(f.gate);
    publisher.stage(alice, aliceClient);
    expect(() => publisher.publish()).toThrow('Context binding unavailable');
    expect(await f.gate.reconcile()).toBe(true);
    aliceClient.setQueryData(['private', 'inbox'], { actor: 'alice' });
    nateClient.setQueryData(['private', 'inbox'], { actor: 'nate' });
    const oldView = publisher.publish();
    expect(() => publisher.stage(nate, nateClient)).toThrow('must be closed');
    const retained = oldView.read<{ actor: string }>(['private', 'inbox']);
    const observed: unknown[] = [];
    const unsubscribe = oldView.subscribe(() => observed.push(oldView.read(['private', 'inbox'])));
    const navigate = jest.fn();
    f.switchToNate();
    expect(oldView.read(['private', 'inbox'])).toBeUndefined();
    expect(oldView.runIfCurrent(navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(observed).toContain(undefined);
    publisher.stage(nate, nateClient);
    expect(() => publisher.publish()).toThrow('Context binding unavailable');
    expect(await f.gate.reconcile()).toBe(true);
    const nextView = publisher.publish();
    expect(nextView.read(['private', 'inbox'])).toEqual({ actor: 'nate' });
    expect(nextView.runIfCurrent(navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(oldView.read(['private', 'inbox'])).toBeUndefined();
    // Data and raw clients handed out earlier cannot be revoked by this facade.
    expect(retained).toEqual({ actor: 'alice' });
    expect(aliceClient.getQueryData(['private', 'inbox'])).toEqual({ actor: 'alice' });
    unsubscribe();
  } finally {
    aliceClient.clear();
    nateClient.clear();
  }
});

it('rechecks after query-key serialization reenters and closes the gate', async () => {
  const f = fixture();
  const client = new QueryClient();
  try {
    expect(await f.gate.reconcile()).toBe(true);
    client.setQueryData(['private', { key: 'x' }], 'alice-data');
    const view = createExperimentalScopedQueryView(client, f.gate, alice);
    const key = {
      toJSON() {
        f.gate.invalidate();
        return { key: 'x' };
      },
    };
    expect(view.read(['private', key])).toBeUndefined();
    expect(
      view.runIfCurrent(() => {
        throw new Error('must not navigate');
      }),
    ).toBe(false);
  } finally {
    client.clear();
  }
});

it('refuses to publish a staged tree for a different bound owner', async () => {
  const f = fixture();
  const client = new QueryClient();
  try {
    const publisher = createExperimentalStagedQueryPublisher(f.gate);
    publisher.stage(nate, client);
    expect(await f.gate.reconcile()).toBe(true);
    expect(() => publisher.publish()).toThrow('Context binding unavailable');
  } finally {
    client.clear();
  }
});

it('baseline: a misconfigured staging caller can label an old raw client as a new owner', async () => {
  const f = fixture();
  const aliceClient = new QueryClient();
  try {
    aliceClient.setQueryData(['private', 'inbox'], { actor: 'alice' });
    f.switchToNate();
    const publisher = createExperimentalStagedQueryPublisher(f.gate);
    publisher.stage(nate, aliceClient);
    expect(await f.gate.reconcile()).toBe(true);
    expect(publisher.publish().read(['private', 'inbox'])).toEqual({ actor: 'alice' });
  } finally {
    aliceClient.clear();
  }
});
