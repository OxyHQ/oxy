/**
 * `AppAssertionManager` (ADR 0045): the SDK obtains and refreshes the app's
 * assertion for the signed-in session by itself, by platform, and never lets
 * an assertion outlive the session it names.
 */
import { AppAssertionManager } from '../../src/ui/appAssertion/appAssertionManager';
import {
  CHALLENGE,
  createMemoryStorage,
  fakeIntegrity,
  fakeOxy,
  KEY_ID,
  platform,
  refusal,
} from './fakes';

const SESSION = { userId: 'person-1', sessionId: 'session-1' };

function harness(
  integrity: ReturnType<typeof platform>,
  options: { clientId?: string | null; storage?: ReturnType<typeof createMemoryStorage> } = {},
) {
  let now = Date.parse('2026-10-16T12:00:00.000Z');
  const timers: { run: () => void; at: number }[] = [];
  const oxy = fakeOxy({ now: () => now });
  const storage = options.storage ?? createMemoryStorage();
  const manager = new AppAssertionManager({
    oxyServices: oxy as never,
    clientId: options.clientId === undefined ? 'oxy_dk_mention' : options.clientId,
    integrity,
    storage: () => storage,
    storageKeyPrefix: 'oxy',
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { run, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  /** Move the clock and fire what is due. */
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    await flush();
  };
  return { manager, oxy, storage, advance, timers, now: () => now };
}

/** Let every pending promise chain settle (the manager's timers are the harness's own). */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('web', () => {
  it('asks for an assertion as soon as there is a session, with no app code', async () => {
    const { manager, oxy } = harness(platform('web'));
    expect(manager.getSnapshot().status).toBe('idle');
    manager.setSession(SESSION);
    await flush();
    expect(oxy.getPublic).toHaveBeenCalledWith('oxy_dk_mention');
    expect(oxy.assertions.create).toHaveBeenCalledWith({
      applicationId: 'mention-app',
      platform: 'web',
    });
    expect(manager.getSnapshot()).toMatchObject({
      status: 'ready',
      assertion: 'head.assertion-1.sig',
      applicationId: 'mention-app',
      platform: 'web',
    });
    await expect(manager.getAppAssertion()).resolves.toBe('head.assertion-1.sig');
    await expect(manager.getAppAssertionHeaders()).resolves.toEqual({
      'X-Oxy-App-Assertion': 'head.assertion-1.sig',
    });
    expect(oxy.assertions.create).toHaveBeenCalledTimes(1);
  });

  it('refreshes a minute before it expires', async () => {
    const { manager, oxy, advance } = harness(platform('web'));
    manager.setSession(SESSION);
    await flush();
    await advance(239_000);
    expect(oxy.assertions.create).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(oxy.assertions.create).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().assertion).toBe('head.assertion-2.sig');
  });

  it('drops the assertion the moment the session changes, and ignores a late answer', async () => {
    const { manager, oxy } = harness(platform('web'));
    let release: () => void = () => undefined;
    oxy.assertions.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              assertion: 'head.stale.sig',
              applicationId: 'mention-app',
              platform: 'web',
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            });
        }),
    );
    manager.setSession(SESSION);
    await flush();
    manager.setSession({ userId: 'person-2', sessionId: 'session-2' });
    release();
    await flush();
    expect(manager.getSnapshot().assertion).toBe('head.assertion-1.sig');
    manager.setSession(null);
    expect(manager.getSnapshot()).toMatchObject({ status: 'idle', assertion: null });
    await expect(manager.getAppAssertion()).resolves.toBeNull();
    await expect(manager.getAppAssertionHeaders()).resolves.toEqual({});
  });

  it('does not ask again for a refusal that will not change for this session', async () => {
    const { manager, oxy, advance } = harness(platform('web'));
    oxy.assertions.create.mockRejectedValue(refusal('origin_not_registered'));
    manager.setSession(SESSION);
    await flush();
    expect(manager.getSnapshot()).toMatchObject({
      status: 'unavailable',
      error: 'origin_not_registered',
    });
    await expect(manager.getAppAssertion()).resolves.toBeNull();
    await advance(3_600_000);
    expect(oxy.assertions.create).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure with a backoff', async () => {
    const { manager, oxy, advance } = harness(platform('web'));
    oxy.assertions.create.mockRejectedValueOnce(refusal('request_failed', 503));
    manager.setSession(SESSION);
    await flush();
    expect(manager.getSnapshot().status).toBe('unavailable');
    await expect(manager.getAppAssertion()).resolves.toBeNull();
    expect(oxy.assertions.create).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(manager.getSnapshot().status).toBe('ready');
  });

  it('keeps an assertion that is still good when a refresh fails', async () => {
    const { manager, oxy, advance } = harness(platform('web'));
    manager.setSession(SESSION);
    await flush();
    oxy.assertions.create.mockRejectedValueOnce(refusal('request_failed', 503));
    await advance(240_000);
    expect(manager.getSnapshot()).toMatchObject({
      status: 'ready',
      assertion: 'head.assertion-1.sig',
    });
    await advance(30_000);
    expect(manager.getSnapshot().assertion).toBe('head.assertion-2.sig');
  });

  it('cannot assert without a registered clientId', async () => {
    const { manager, oxy } = harness(platform('web'), { clientId: null });
    manager.setSession(SESSION);
    await flush();
    expect(manager.getSnapshot()).toMatchObject({
      status: 'unsupported',
      error: 'client_id_missing',
    });
    expect(oxy.assertions.create).not.toHaveBeenCalled();
  });
});

describe('android: Play Integrity', () => {
  it('prepares the provider once, binds the token to the challenge, and asserts', async () => {
    const integrity = fakeIntegrity();
    const { manager, oxy, advance } = harness(platform('android', integrity));
    manager.setSession(SESSION);
    await flush();
    expect(oxy.assertions.challenge).toHaveBeenCalledWith({
      applicationId: 'mention-app',
      platform: 'android',
    });
    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledWith('424242424242');
    const requestHash = (await oxy.assertions.challenge.mock.results[0]?.value).requestHash;
    expect(integrity.requestIntegrityCheckAsync).toHaveBeenCalledWith(requestHash);
    expect(oxy.assertions.create).toHaveBeenCalledWith({
      applicationId: 'mention-app',
      platform: 'android',
      proof: { challenge: CHALLENGE, integrityToken: 'play-integrity-token' },
    });
    expect(manager.getSnapshot().status).toBe('ready');

    await advance(240_000);
    expect(oxy.assertions.create).toHaveBeenCalledTimes(2);
    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(1);
  });

  it('prepares again after Play fails', async () => {
    const integrity = fakeIntegrity({
      requestIntegrityCheckAsync: jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 'ERR_INTEGRITY' }))
        .mockResolvedValue('play-integrity-token'),
    });
    const { manager, advance } = harness(platform('android', integrity));
    manager.setSession(SESSION);
    await flush();
    expect(manager.getSnapshot().status).toBe('unavailable');
    await advance(30_000);
    expect(manager.getSnapshot().status).toBe('ready');
    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(2);
  });

  it('is unsupported in a binary without the native module', async () => {
    const { manager, oxy } = harness(platform('android', null));
    manager.setSession(SESSION);
    await flush();
    expect(manager.getSnapshot()).toMatchObject({
      status: 'unsupported',
      error: 'integrity_module_unavailable',
    });
    expect(oxy.assertions.challenge).not.toHaveBeenCalled();
  });
});

describe('ios: App Attest', () => {
  it('attests a key once, keeps its id, and asserts with it from then on', async () => {
    const integrity = fakeIntegrity();
    const { manager, oxy, storage, advance } = harness(platform('ios', integrity));
    manager.setSession(SESSION);
    await flush();
    expect(integrity.generateKeyAsync).toHaveBeenCalledTimes(1);
    expect(oxy.assertions.challenge).toHaveBeenNthCalledWith(1, {
      applicationId: 'mention-app',
      platform: 'ios',
      purpose: 'attest_key',
    });
    expect(oxy.assertions.registerAttestKey).toHaveBeenCalledWith({
      applicationId: 'mention-app',
      keyId: KEY_ID,
      challenge: CHALLENGE,
      attestation: 'YXR0ZXN0YXRpb24=',
    });
    expect(oxy.assertions.create).toHaveBeenCalledWith({
      applicationId: 'mention-app',
      platform: 'ios',
      proof: { challenge: CHALLENGE, keyId: KEY_ID, assertion: 'YXNzZXJ0aW9u' },
    });
    await expect(storage.getItem('oxy_app_attest_key_mention-app')).resolves.toBe(KEY_ID);

    await advance(240_000);
    expect(oxy.assertions.create).toHaveBeenCalledTimes(2);
    expect(integrity.generateKeyAsync).toHaveBeenCalledTimes(1);
    expect(oxy.assertions.registerAttestKey).toHaveBeenCalledTimes(1);
  });

  it('attests a new key when Oxy no longer knows the stored one', async () => {
    const storage = createMemoryStorage();
    await storage.setItem('oxy_app_attest_key_mention-app', 'old-key');
    const integrity = fakeIntegrity();
    const { manager, oxy } = harness(platform('ios', integrity), { storage });
    oxy.assertions.create.mockRejectedValueOnce(refusal('attest_key_unknown'));
    manager.setSession(SESSION);
    await flush();
    expect(integrity.generateAssertionAsync).toHaveBeenNthCalledWith(
      1,
      'old-key',
      expect.any(String),
    );
    expect(oxy.assertions.registerAttestKey).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().status).toBe('ready');
    await expect(storage.getItem('oxy_app_attest_key_mention-app')).resolves.toBe(KEY_ID);
  });

  it('is unsupported where App Attest is not', async () => {
    const { manager, oxy } = harness(platform('ios', fakeIntegrity({ isSupported: false })));
    manager.setSession(SESSION);
    await flush();
    expect(manager.getSnapshot()).toMatchObject({
      status: 'unsupported',
      error: 'app_attest_unsupported',
    });
    expect(oxy.assertions.challenge).not.toHaveBeenCalled();
  });
});
