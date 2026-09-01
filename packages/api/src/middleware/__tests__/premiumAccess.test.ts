const mockResolveUserSubscriptionPlan = jest.fn();
const mockIsPremiumSubscriptionPlan = jest.fn();

jest.mock('../../utils/subscriptionPlan', () => ({
  resolveUserSubscriptionPlan: (...args: unknown[]) => mockResolveUserSubscriptionPlan(...args),
  isPremiumSubscriptionPlan: (...args: unknown[]) => mockIsPremiumSubscriptionPlan(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../auth';
import { checkPremiumAccess } from '../premiumAccess';

function createResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('checkPremiumAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated requests', async () => {
    const req = {} as AuthRequest;
    const res = createResponse();
    const next = jest.fn() as NextFunction;

    await checkPremiumAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects basic-plan subscribers', async () => {
    mockResolveUserSubscriptionPlan.mockResolvedValue('basic');
    mockIsPremiumSubscriptionPlan.mockReturnValue(false);

    const req = {
      user: {
        _id: 'user-1',
        privacySettings: { analyticsSharing: true },
      },
    } as unknown as AuthRequest;
    const res = createResponse();
    const next = jest.fn() as NextFunction;

    await checkPremiumAccess(req, res, next);

    expect(mockResolveUserSubscriptionPlan).toHaveBeenCalledWith('user-1');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'PREMIUM_REQUIRED' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('allows premium subscribers with analytics sharing enabled', async () => {
    mockResolveUserSubscriptionPlan.mockResolvedValue('pro');
    mockIsPremiumSubscriptionPlan.mockReturnValue(true);

    const req = {
      user: {
        _id: 'user-1',
        privacySettings: { analyticsSharing: true },
      },
    } as unknown as AuthRequest;
    const res = createResponse();
    const next = jest.fn() as NextFunction;

    await checkPremiumAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects premium subscribers who opted out of analytics sharing', async () => {
    mockResolveUserSubscriptionPlan.mockResolvedValue('pro');
    mockIsPremiumSubscriptionPlan.mockReturnValue(true);

    const req = {
      user: {
        _id: 'user-1',
        privacySettings: { analyticsSharing: false },
      },
    } as unknown as AuthRequest;
    const res = createResponse();
    const next = jest.fn() as NextFunction;

    await checkPremiumAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'ANALYTICS_OPT_OUT' }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
