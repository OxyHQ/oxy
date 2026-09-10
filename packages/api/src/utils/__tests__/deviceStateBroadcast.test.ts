jest.mock('../logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { initializeIO, closeIO, broadcastDeviceState, broadcastSessionAccountsChanged } from '../socket';
import type { DeviceSessionState } from '@oxy.so/contracts';
import { SESSION_ACCOUNTS_CHANGED_EVENT } from '@oxy.so/contracts';

const state: DeviceSessionState = { deviceId: 'd1', accounts: [], activeAccountId: null, revision: 5, updatedAt: 1720000000000 };

afterEach(() => closeIO());

describe('broadcastDeviceState', () => {
  it('emits session_state to the device room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    initializeIO({ to } as never);
    broadcastDeviceState(state);
    expect(to).toHaveBeenCalledWith('device:d1');
    expect(emit).toHaveBeenCalledWith('session_state', state);
  });

  it('is a no-op when io is not initialised', () => {
    closeIO();
    expect(() => broadcastDeviceState(state)).not.toThrow();
  });
});

describe('broadcastSessionAccountsChanged', () => {
  it('emits the token-free signal to a single user room', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    initializeIO({ to } as never);
    broadcastSessionAccountsChanged('user-1', 7, 'add');
    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith(SESSION_ACCOUNTS_CHANGED_EVENT, { userId: 'user-1', revision: 7, reason: 'add' });
    // Signal only — never carries a token/secret.
    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['reason', 'revision', 'userId']);
  });

  it('de-duplicates and drops blank ids across an array of users', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    initializeIO({ to } as never);
    broadcastSessionAccountsChanged(['user-1', 'user-1', '', 'user-2'], 3, 'signout');
    expect(to).toHaveBeenCalledTimes(2);
    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(to).toHaveBeenCalledWith('user:user-2');
  });

  it('is a no-op when io is not initialised', () => {
    closeIO();
    expect(() => broadcastSessionAccountsChanged('user-1', 1, 'login')).not.toThrow();
  });
});
