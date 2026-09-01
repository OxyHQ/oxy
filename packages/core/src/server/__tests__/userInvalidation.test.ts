import { OXY_USER_INVALIDATION_CHANNEL } from '@oxyhq/contracts';

import {
  createOxyUserInvalidationHandler,
  publishOxyUserInvalidation,
} from '../userInvalidation';
// The key enumeration this subscriber sweeps is platform-neutral and shared
// with the client mixins — see `utils/identityCacheSweep` and its own suite.
import type { OxyIdentityCacheEvictor } from '../../utils/identityCacheSweep';

function makePublisher() {
  const calls: Array<{ channel: string; message: string }> = [];
  return {
    calls,
    publish(channel: string, message: string) {
      calls.push({ channel, message });
      return Promise.resolve(1);
    },
  };
}

function makeEvictor() {
  const entries: string[] = [];
  const prefixes: string[] = [];
  const evictor: OxyIdentityCacheEvictor = {
    clearCacheEntry: (key) => {
      entries.push(key);
    },
    clearCacheByPrefix: (prefix) => {
      prefixes.push(prefix);
      return 0;
    },
  };
  return { evictor, entries, prefixes };
}

describe('@oxyhq/core/server publishOxyUserInvalidation', () => {
  it('publishes a profile change on the contract channel', () => {
    const publisher = makePublisher();
    const published = publishOxyUserInvalidation(publisher, 'user-1', 'profile');

    expect(published).toBe(true);
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].channel).toBe(OXY_USER_INVALIDATION_CHANNEL);

    const payload = JSON.parse(publisher.calls[0].message);
    expect(payload.userId).toBe('user-1');
    expect(payload.reason).toBe('profile');
    expect(typeof payload.at).toBe('number');
  });

  it('puts NOTHING on the wire for graph churn', () => {
    // The whole point of the suppression: not a message subscribers discard,
    // but no message at all. Bulk follow moves up to 200 edges per call.
    const publisher = makePublisher();
    const published = publishOxyUserInvalidation(publisher, 'user-1', 'graph');

    expect(published).toBe(false);
    expect(publisher.calls).toHaveLength(0);
  });

  it('publishes nothing for an empty user id', () => {
    const publisher = makePublisher();
    expect(publishOxyUserInvalidation(publisher, '', 'profile')).toBe(false);
    expect(publisher.calls).toHaveLength(0);
  });

  it('never throws when the client throws synchronously', () => {
    const boom = new Error('redis down');
    const publisher = {
      publish() {
        throw boom;
      },
    };
    const onError = jest.fn();

    expect(() => publishOxyUserInvalidation(publisher, 'user-1', 'profile', onError)).not.toThrow();
    expect(publishOxyUserInvalidation(publisher, 'user-1', 'profile', onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('never surfaces a rejected publish as an unhandled rejection', async () => {
    const boom = new Error('publish rejected');
    const publisher = {
      publish: () => Promise.reject(boom),
    };
    const onError = jest.fn();

    // Returns true — the message was handed to the client; the failure is async.
    expect(publishOxyUserInvalidation(publisher, 'user-1', 'profile', onError)).toBe(true);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('tolerates a client whose publish returns a non-promise', () => {
    const calls: string[] = [];
    const publisher = {
      publish: (_channel: string, message: string) => {
        calls.push(message);
        return 1;
      },
    };
    expect(publishOxyUserInvalidation(publisher, 'user-1', 'profile')).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('@oxyhq/core/server createOxyUserInvalidationHandler', () => {
  const validMessage = JSON.stringify({ userId: 'user-1', reason: 'profile', at: 1 });

  it('sweeps the SDK identity cache for the invalidated user', () => {
    const { evictor, entries, prefixes } = makeEvictor();
    createOxyUserInvalidationHandler({ oxy: evictor })(validMessage);

    expect(entries).toEqual(['GET:/users/user-1']);
    expect(prefixes).toEqual([
      'GET:/session/user/',
      'GET:/users/me',
      'GET:/auth/lookup/',
      'GET:/profiles/username/',
      'GET:/profiles/resolve',
    ]);
  });

  it('hands the parsed event to app-specific eviction', () => {
    const onInvalidate = jest.fn();
    createOxyUserInvalidationHandler({ onInvalidate })(validMessage);

    expect(onInvalidate).toHaveBeenCalledWith({ userId: 'user-1', reason: 'profile', at: 1 });
  });

  it('drops an unparseable message without throwing', () => {
    const onInvalidate = jest.fn();
    const onError = jest.fn();
    const handle = createOxyUserInvalidationHandler({ onInvalidate, onError });

    expect(() => handle('not json at all')).not.toThrow();
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('drops a message that fails the contract schema', () => {
    const onInvalidate = jest.fn();
    const onError = jest.fn();
    const handle = createOxyUserInvalidationHandler({ onInvalidate, onError });

    handle(JSON.stringify({ userId: 'user-1', reason: 'graph', at: 1 }));
    handle(JSON.stringify({ reason: 'profile', at: 1 }));

    expect(onInvalidate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('never throws when app eviction throws', () => {
    // The handler runs inside the Redis client's message dispatch. An escape
    // there kills the subscription — silently and permanently — which is far
    // worse than losing the one message that caused it.
    const boom = new Error('app eviction failed');
    const onError = jest.fn();
    const handle = createOxyUserInvalidationHandler({
      onInvalidate: () => {
        throw boom;
      },
      onError,
    });

    expect(() => handle(validMessage)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom, validMessage);
  });

  it('never throws when app eviction rejects', async () => {
    const boom = new Error('async eviction failed');
    const onError = jest.fn();
    const handle = createOxyUserInvalidationHandler({
      onInvalidate: () => Promise.reject(boom),
      onError,
    });

    expect(() => handle(validMessage)).not.toThrow();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(boom, validMessage);
  });

  it('still runs app eviction when the SDK sweep throws', () => {
    const onInvalidate = jest.fn();
    const onError = jest.fn();
    const evictor: OxyIdentityCacheEvictor = {
      clearCacheEntry: () => {
        throw new Error('sweep failed');
      },
      clearCacheByPrefix: () => 0,
    };

    createOxyUserInvalidationHandler({ oxy: evictor, onInvalidate, onError })(validMessage);

    expect(onInvalidate).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('is a no-op with no options configured', () => {
    expect(() => createOxyUserInvalidationHandler()(validMessage)).not.toThrow();
  });
});
