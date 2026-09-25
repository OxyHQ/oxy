/**
 * A lost access token is a question, not a sign-out (OxyHQ/Mention#1140).
 *
 * The provider used to sign the user out on ANY cleared bearer. HttpService
 * clears it whenever a 401's refresh comes back empty — including when the mint
 * is merely cooling down after a 429 or the network blipped — and with no token
 * the refresh scheduler stops, so the session never came back until a relaunch
 * re-minted from the device credential that had been intact the whole time.
 */
import {
  createTokenLossRecovery,
  MAX_KEYED_RECOVERY_ATTEMPTS,
  TOKEN_RECOVERY_BACKOFF_MS,
  type TokenLossRecoveryDeps,
} from '../tokenLossRecovery';

interface Harness {
  deps: TokenLossRecoveryDeps;
  state: { signedIn: boolean; token: string | null; credential: boolean; keyed: boolean };
  remint: jest.Mock<Promise<string | null>, []>;
  signOutLocally: jest.Mock<Promise<void>, []>;
  sleeps: number[];
}

function harness(remintAnswers: Array<string | null | 'drop-credential'>): Harness {
  const state = { signedIn: true, token: null as string | null, credential: true, keyed: false };
  const sleeps: number[] = [];
  const remint = jest.fn(async (): Promise<string | null> => {
    const answer = remintAnswers.length > 0 ? remintAnswers.shift() : null;
    if (answer === 'drop-credential') {
      // What the refresh handler does on `invalid_device_secret` /
      // `no_active_session`: the credential goes, and the mint returns nothing.
      state.credential = false;
      return null;
    }
    if (answer) {
      state.token = answer;
    }
    return answer ?? null;
  });
  const signOutLocally = jest.fn(async () => {
    state.signedIn = false;
  });
  const deps: TokenLossRecoveryDeps = {
    remint,
    hasDeviceCredential: async () => state.credential,
    hasKeyedRecovery: async () => state.keyed,
    isSignedIn: () => state.signedIn,
    hasToken: () => state.token !== null,
    signOutLocally,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, state, remint, signOutLocally, sleeps };
}

async function runToCompletion(recovery: ReturnType<typeof createTokenLossRecovery>): Promise<void> {
  for (let i = 0; i < 200 && recovery.isRecovering(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(recovery.isRecovering()).toBe(false);
}

describe('token loss recovery', () => {
  it('keeps a user with an intact device credential signed in through transient failures, then restores the token', async () => {
    // The incident: the mint is rate limited / cooling down for a while, then
    // succeeds — exactly what a relaunch a few minutes later did.
    const h = harness([null, null, null, 'fresh']);
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.signOutLocally).not.toHaveBeenCalled();
    expect(h.state.token).toBe('fresh');
    expect(h.remint).toHaveBeenCalledTimes(4);
    expect(h.sleeps).toEqual(TOKEN_RECOVERY_BACKOFF_MS.slice(0, 3));
  });

  it('signs out once a re-mint gets a definitive verdict and no key can re-establish the session', async () => {
    const h = harness([null, 'drop-credential']);
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.signOutLocally).toHaveBeenCalledTimes(1);
    expect(h.remint).toHaveBeenCalledTimes(2);
  });

  it('signs out at once when the credential was already gone and there is no key-based lane (the old behaviour for a real revocation)', async () => {
    const h = harness([]);
    h.state.credential = false;
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.remint).not.toHaveBeenCalled();
    expect(h.signOutLocally).toHaveBeenCalledTimes(1);
  });

  it('re-establishes through the shared identity when the credential is gone, like the cold boot does', async () => {
    const h = harness([null, 'from-shared-key']);
    h.state.credential = false;
    h.state.keyed = true;
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.signOutLocally).not.toHaveBeenCalled();
    expect(h.state.token).toBe('from-shared-key');
  });

  it('gives the key-based lane a bounded number of tries, then signs out', async () => {
    const h = harness([]);
    h.state.credential = false;
    h.state.keyed = true;
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.remint).toHaveBeenCalledTimes(MAX_KEYED_RECOVERY_ATTEMPTS);
    expect(h.signOutLocally).toHaveBeenCalledTimes(1);
  });

  it('stops without touching the session when the user signs out meanwhile', async () => {
    const h = harness([]);
    h.remint.mockImplementation(async () => {
      h.state.signedIn = false;
      return null;
    });
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.remint).toHaveBeenCalledTimes(1);
    expect(h.signOutLocally).not.toHaveBeenCalled();
  });

  it('stops when another lane planted a token first', async () => {
    const h = harness([]);
    h.remint.mockImplementation(async () => {
      h.state.token = 'planted-by-a-sign-in';
      return null;
    });
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.remint).toHaveBeenCalledTimes(1);
    expect(h.signOutLocally).not.toHaveBeenCalled();
  });

  it('runs one recovery at a time', async () => {
    const h = harness([null, 'fresh']);
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    recovery.start();
    await runToCompletion(recovery);

    expect(h.remint).toHaveBeenCalledTimes(2);
  });

  it('signs out rather than strand a signed-in UI with no bearer when recovery itself throws', async () => {
    const h = harness([]);
    h.deps.hasDeviceCredential = async () => {
      throw new Error('store exploded');
    };
    const recovery = createTokenLossRecovery(h.deps);

    recovery.start();
    await runToCompletion(recovery);

    expect(h.signOutLocally).toHaveBeenCalledTimes(1);
  });

  it('does nothing after dispose', async () => {
    const h = harness([]);
    const recovery = createTokenLossRecovery(h.deps);

    recovery.dispose();
    recovery.start();
    await runToCompletion(recovery);

    expect(h.remint).not.toHaveBeenCalled();
    expect(h.signOutLocally).not.toHaveBeenCalled();
  });
});
