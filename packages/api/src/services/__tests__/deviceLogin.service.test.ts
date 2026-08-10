/**
 * deviceLogin.service unit tests — device-first login finalization.
 *
 * Covers `finalizeDeviceLogin`:
 *  - ADD-ONLY: registers the session with `activate: 'if-empty'` (never steals
 *    the active account) and broadcasts only when the set changed.
 *  - mints the rotating `deviceSecret` the client persists first-party and
 *    returns it in the extras.
 *  - best-effort: a registration/mint failure never throws.
 *  - records the device account context on the session (issue #937, Phase 6)
 *    AFTER the deviceSecret mint, so a binding failure cannot cost the sign-in
 *    its only restore credential.
 */

const mockAddAccount = jest.fn();
const mockIssueDeviceSecret = jest.fn();
const mockBindSessionToContext = jest.fn();
jest.mock('../deviceSession.service', () => {
  const svc = {
    addAccount: (...a: unknown[]) => mockAddAccount(...a),
    issueDeviceSecret: (...a: unknown[]) => mockIssueDeviceSecret(...a),
    bindSessionToContext: (...a: unknown[]) => mockBindSessionToContext(...a),
  };
  // deviceLogin.service dynamically imports the NAMED `deviceSessionService`.
  return { __esModule: true, default: svc, deviceSessionService: svc };
});

const mockBroadcastDeviceState = jest.fn();
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: (...a: unknown[]) => mockBroadcastDeviceState(...a),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { finalizeDeviceLogin } from '../deviceLogin.service';

const SESSION = { sessionId: 'sess-1', deviceId: 'dev-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAddAccount.mockResolvedValue({ state: { deviceId: 'dev-1', accounts: [], activeAccountId: null, revision: 1 }, changed: true });
  mockIssueDeviceSecret.mockResolvedValue('ds_minted_secret');
  mockBindSessionToContext.mockResolvedValue(true);
});

describe('finalizeDeviceLogin', () => {
  it('registers the session add-only (activate: if-empty) and returns the minted deviceSecret', async () => {
    const result = await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });

    expect(mockAddAccount).toHaveBeenCalledWith(
      'dev-1',
      { accountId: 'user-1', sessionId: 'sess-1' },
      { activate: 'if-empty' },
    );
    expect(mockIssueDeviceSecret).toHaveBeenCalledWith('dev-1');
    expect(result).toEqual({ deviceSecret: 'ds_minted_secret' });
  });

  it('threads operatedByUserId into the device-set registration when present', async () => {
    await finalizeDeviceLogin({ session: SESSION, userId: 'user-1', operatedByUserId: 'op-9' });
    expect(mockAddAccount).toHaveBeenCalledWith(
      'dev-1',
      { accountId: 'user-1', sessionId: 'sess-1', operatedByUserId: 'op-9' },
      { activate: 'if-empty' },
    );
  });

  it('broadcasts the device state only when the set changed', async () => {
    mockAddAccount.mockResolvedValueOnce({ state: { deviceId: 'dev-1', accounts: [], activeAccountId: null, revision: 0 }, changed: false });
    await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });
    expect(mockBroadcastDeviceState).not.toHaveBeenCalled();

    mockAddAccount.mockResolvedValueOnce({ state: { deviceId: 'dev-1', accounts: [], activeAccountId: null, revision: 2 }, changed: true });
    await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });
    expect(mockBroadcastDeviceState).toHaveBeenCalledTimes(1);
  });

  it('omits deviceSecret when the mint returns null', async () => {
    mockIssueDeviceSecret.mockResolvedValueOnce(null);
    const result = await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });
    expect(result).toEqual({});
  });

  it('never throws when device registration fails (best-effort)', async () => {
    mockAddAccount.mockRejectedValueOnce(new Error('db down'));
    const result = await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });
    expect(result).toEqual({});
  });

  it('records the device account context on the session (issue #937, Phase 6)', async () => {
    await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });

    expect(mockBindSessionToContext).toHaveBeenCalledWith('dev-1', 'sess-1');
  });

  it('still returns the deviceSecret when the context binding blows up', async () => {
    // The ordering guard. Every statement in the block shares one catch, so a
    // binding placed BEFORE the mint would swallow the sign-in's only restore
    // credential — the token picks the context up on its next mint, but the
    // secret is handed over exactly once.
    mockBindSessionToContext.mockRejectedValueOnce(new Error('db down'));

    const result = await finalizeDeviceLogin({ session: SESSION, userId: 'user-1' });

    expect(result).toEqual({ deviceSecret: 'ds_minted_secret' });
  });
});
