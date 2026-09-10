import type { NextFunction, Request, Response } from 'express';
import type { OxyServices } from '../../OxyServices';
import {
  createOxyAuthMiddleware,
  getOxyUserId,
  getRequiredOxyUserId,
  requireOxyAuth,
  type OxyAuthRequest,
} from '../auth';

function makeResponse(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function makeNext(): NextFunction {
  return jest.fn() as unknown as NextFunction;
}

describe('@oxy.so/core/server auth helpers', () => {
  it('reads the current user id from userId, user.id, or user._id', () => {
    expect(getOxyUserId({ userId: 'user-from-request' } as OxyAuthRequest)).toBe('user-from-request');
    expect(getOxyUserId({ user: { id: 'user-from-id' } } as OxyAuthRequest)).toBe('user-from-id');
    expect(getOxyUserId({ user: { id: '', _id: 'user-from-mongo-id' } } as OxyAuthRequest)).toBe('user-from-mongo-id');
    expect(getOxyUserId({ user: { id: '' } } as OxyAuthRequest)).toBeNull();
  });

  it('throws when a required user id is missing', () => {
    expect(() => getRequiredOxyUserId({} as Request)).toThrow('User not authenticated');
  });

  it('returns a consistent 401 when auth is missing', () => {
    const req = {} as Request;
    const res = makeResponse();
    const next = makeNext();

    requireOxyAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('normalizes an authenticated request before continuing', () => {
    const req = { user: { id: '', _id: 'mongo-user-id' } } as OxyAuthRequest;
    const res = makeResponse();
    const next = makeNext();

    requireOxyAuth(req, res, next);

    expect(req.userId).toBe('mongo-user-id');
    expect(req.user?.id).toBe('mongo-user-id');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('can resolve and require auth as one middleware', () => {
    const oxy = {
      auth: jest.fn(() => (req: OxyAuthRequest, _res: Response, next: NextFunction) => {
        req.user = { id: 'resolved-user' };
        next();
      }),
    } as unknown as OxyServices;
    const req = {} as OxyAuthRequest;
    const res = makeResponse();
    const next = makeNext();

    createOxyAuthMiddleware(oxy)(req, res, next);

    expect(oxy.auth).toHaveBeenCalledWith({ optional: true });
    expect(req.userId).toBe('resolved-user');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
