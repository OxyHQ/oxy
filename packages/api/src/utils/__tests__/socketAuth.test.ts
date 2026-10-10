/**
 * socketAuth unit tests — the single authority for who a Socket.IO connection is
 * allowed to be.
 */
import jwt from 'jsonwebtoken';

const mockGetStateBySecret = jest.fn();

jest.mock('../../services/deviceSession.service', () => ({
  __esModule: true,
  default: {
    getStateBySecret: (...args: unknown[]) => mockGetStateBySecret(...args),
  },
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { resolveSocketIdentity, type SocketHandshakeAuthInput } from '../socketAuth';
import { socketRoomsFor } from '../socket';

const mockVerify = jwt.verify as unknown as jest.Mock;

const SECRET = 'test-access-secret';

function handshake(over: Partial<SocketHandshakeAuthInput> = {}): SocketHandshakeAuthInput {
  return { auth: {}, ...over };
}

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = SECRET;
});
beforeEach(() => {
  mockVerify.mockReset().mockReturnValue({ userId: 'u1', deviceId: 'd1', sessionId: 's1' });
  mockGetStateBySecret.mockReset();
});

describe('resolveSocketIdentity', () => {
  it('resolves an authenticated user identity from a valid bearer', async () => {
    const id = await resolveSocketIdentity(handshake({ auth: { token: 'valid.jwt.here' } }));
    expect(id).toEqual({
      kind: 'user',
      user: expect.objectContaining({ id: 'u1', deviceId: 'd1' }),
    });
    expect(mockVerify).toHaveBeenCalledWith('valid.jwt.here', SECRET);
  });

  it('resolves a device-only identity from deviceId + deviceSecret', async () => {
    mockGetStateBySecret.mockResolvedValue({
      deviceId: 'd-hub',
      accounts: [],
      activeAccountId: null,
      revision: 0,
      updatedAt: Date.now(),
    });
    const id = await resolveSocketIdentity(
      handshake({ auth: { deviceId: 'd-hub', deviceSecret: 'sec' } }),
    );
    expect(id).toEqual({ kind: 'device', deviceId: 'd-hub' });
    expect(mockGetStateBySecret).toHaveBeenCalledWith('d-hub', 'sec');
  });

  it('rejects (null) when the bearer is present but invalid', async () => {
    mockVerify.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    const id = await resolveSocketIdentity(handshake({ auth: { token: 'not-a-jwt' } }));
    expect(id).toBeNull();
  });

  it('rejects (null) when there is no bearer or device credential', async () => {
    const id = await resolveSocketIdentity(handshake());
    expect(id).toBeNull();
  });

  it('rejects (null) when the bearer decodes without a userId', async () => {
    mockVerify.mockReturnValue({ deviceId: 'd1' });
    const id = await resolveSocketIdentity(handshake({ auth: { token: 'valid.jwt.here' } }));
    expect(id).toBeNull();
  });

  it('rejects (null) when device credentials do not match', async () => {
    mockGetStateBySecret.mockResolvedValue(null);
    const id = await resolveSocketIdentity(
      handshake({ auth: { deviceId: 'd1', deviceSecret: 'bad' } }),
    );
    expect(id).toBeNull();
  });
});

describe('socketRoomsFor', () => {
  it('an authenticated user joins BOTH the user and device rooms', () => {
    expect(socketRoomsFor({ user: { id: 'u1', deviceId: 'd1' } })).toEqual([
      'user:u1',
      'device:d1',
    ]);
  });

  it('a device-only socket joins only the device room', () => {
    expect(socketRoomsFor({ deviceId: 'd1' })).toEqual(['device:d1']);
  });

  it('an authenticated user without a device claim joins only the user room', () => {
    expect(socketRoomsFor({ user: { id: 'u1' } })).toEqual(['user:u1']);
  });

  it('returns no rooms for an unresolved identity', () => {
    expect(socketRoomsFor({})).toEqual([]);
  });
});
