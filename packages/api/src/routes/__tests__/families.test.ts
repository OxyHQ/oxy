/**
 * `/families` route wiring — auth, validation and status codes. The business
 * rules themselves are covered against a real Postgres in
 * `services/__tests__/family.service.test.ts`; this file only proves the thin
 * router calls the service correctly and translates its answers into the
 * right HTTP shape, mirroring `routes/__tests__/accountsCreate.test.ts`.
 */

import express from 'express';
import request from 'supertest';
import { ForbiddenError, NotFoundError } from '../../utils/error';

const OPERATOR_ID = '6c0000000000000000000001';

const mockCreateFamily = jest.fn();
const mockGetMyFamilies = jest.fn();
const mockListPendingInvites = jest.fn();
const mockInviteMember = jest.fn();
const mockAcceptInvite = jest.fn();
const mockDeclineInvite = jest.fn();
const mockRemoveMember = jest.fn();
const mockLeaveFamily = jest.fn();

jest.mock('../../services/family.service', () => ({
  __esModule: true,
  familyService: {
    createFamily: (...args: unknown[]) => mockCreateFamily(...args),
    getMyFamilies: (...args: unknown[]) => mockGetMyFamilies(...args),
    listPendingInvites: (...args: unknown[]) => mockListPendingInvites(...args),
    inviteMember: (...args: unknown[]) => mockInviteMember(...args),
    acceptInvite: (...args: unknown[]) => mockAcceptInvite(...args),
    declineInvite: (...args: unknown[]) => mockDeclineInvite(...args),
    removeMember: (...args: unknown[]) => mockRemoveMember(...args),
    leaveFamily: (...args: unknown[]) => mockLeaveFamily(...args),
  },
}));

const mockResolveUserByIdentifier = jest.fn();
jest.mock('../../utils/resolveUserIdentifier', () => ({
  resolveUserByIdentifier: (...args: unknown[]) => mockResolveUserByIdentifier(...args),
}));

// Same shape `authMiddleware` produces in production: `_id` is what
// `requireOperatorId`/`resolveOperatorId` reads.
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: {
      headers: { authorization?: string };
      user?: { _id: string; id: string };
      oxyToken?: { applicationId: string };
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: OPERATOR_ID, id: OPERATOR_ID };
    if (req.headers.authorization === 'Bearer third-party-token') {
      req.oxyToken = { applicationId: 'third-party-app' };
    }
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/firstPartyDeviceAccess', () => ({
  requireFirstPartyDeviceAccess: (
    req: { oxyToken?: { applicationId: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (req.oxyToken?.applicationId === 'third-party-app') {
      res.status(403).json({ error: 'third_party_device_access_denied' });
      return;
    }
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import familiesRouter from '../families';
import { errorHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/families', familiesRouter);
app.use(errorHandler);

const now = new Date();
function fakeMembership(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'member-1',
    familyId: 'family-1',
    memberUserId: OPERATOR_ID,
    role: 'organizer',
    status: 'active',
    invitedByUserId: null,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeFamily(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'family-1', name: null, createdAt: now, updatedAt: now, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('application authorization', () => {
  it.each([
    ['read', 'get', '/families/me'],
    ['write', 'post', '/families'],
  ] as const)(
    'rejects a third-party application-bound token before a %s operation',
    async (_lane, method, path) => {
      const res = await request(app)
        [method](path)
        .set('Authorization', 'Bearer third-party-token')
        .send(method === 'post' ? { name: 'Compromised' } : undefined);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'third_party_device_access_denied' });
      expect(mockGetMyFamilies).not.toHaveBeenCalled();
      expect(mockCreateFamily).not.toHaveBeenCalled();
    },
  );
});

describe('POST /families', () => {
  it('creates a family with the caller as organizer', async () => {
    mockCreateFamily.mockResolvedValue({
      family: fakeFamily({ name: 'The Smiths' }),
      membership: fakeMembership(),
    });

    const res = await request(app)
      .post('/families')
      .set('Authorization', 'Bearer user-token')
      .send({ name: 'The Smiths' });

    expect(res.status).toBe(201);
    expect(res.body.family.name).toBe('The Smiths');
    expect(res.body.membership.role).toBe('organizer');
    expect(mockCreateFamily).toHaveBeenCalledWith(OPERATOR_ID, 'The Smiths');
  });

  it('rejects a name over the length limit (400) before the service is called', async () => {
    const res = await request(app)
      .post('/families')
      .set('Authorization', 'Bearer user-token')
      .send({ name: 'x'.repeat(101) });

    expect(res.status).toBe(400);
    expect(mockCreateFamily).not.toHaveBeenCalled();
  });
});

describe('GET /families/me', () => {
  it('returns every family the caller actively belongs to, each with its roster', async () => {
    mockGetMyFamilies.mockResolvedValue([
      { family: fakeFamily(), members: [fakeMembership()] },
      {
        family: fakeFamily({ id: 'family-2' }),
        members: [fakeMembership({ familyId: 'family-2' })],
      },
    ]);

    const res = await request(app).get('/families/me').set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(200);
    expect(res.body.families).toHaveLength(2);
    expect(res.body.families[0].members).toHaveLength(1);
    expect(mockGetMyFamilies).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('answers 200 with an empty list when the caller belongs to no family', async () => {
    mockGetMyFamilies.mockResolvedValue([]);

    const res = await request(app).get('/families/me').set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(200);
    expect(res.body.families).toEqual([]);
  });
});

describe('GET /families/invites', () => {
  it('lists pending invites addressed to the caller', async () => {
    mockListPendingInvites.mockResolvedValue([
      {
        membership: fakeMembership({ role: 'member', status: 'invited', joinedAt: null }),
        family: fakeFamily(),
      },
    ]);

    const res = await request(app)
      .get('/families/invites')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0].membership.status).toBe('invited');
  });
});

describe('POST /families/:id/members', () => {
  it('resolves the identifier and invites the target user', async () => {
    mockResolveUserByIdentifier.mockResolvedValue({ id: 'target-user' });
    mockInviteMember.mockResolvedValue(
      fakeMembership({
        memberUserId: 'target-user',
        role: 'member',
        status: 'invited',
        joinedAt: null,
      }),
    );

    const res = await request(app)
      .post('/families/family-1/members')
      .set('Authorization', 'Bearer user-token')
      .send({ usernameOrEmail: 'alice' });

    expect(res.status).toBe(201);
    expect(mockInviteMember).toHaveBeenCalledWith('family-1', OPERATOR_ID, 'target-user');
  });

  it('answers 404 when the identifier resolves to nobody, without calling the service', async () => {
    mockResolveUserByIdentifier.mockResolvedValue(null);

    const res = await request(app)
      .post('/families/family-1/members')
      .set('Authorization', 'Bearer user-token')
      .send({ usernameOrEmail: 'nobody' });

    expect(res.status).toBe(404);
    expect(mockInviteMember).not.toHaveBeenCalled();
  });

  it("propagates the service's 403 when the caller is not the organizer", async () => {
    mockResolveUserByIdentifier.mockResolvedValue({ id: 'target-user' });
    mockInviteMember.mockRejectedValue(
      new ForbiddenError('Only the family organizer may invite members'),
    );

    const res = await request(app)
      .post('/families/family-1/members')
      .set('Authorization', 'Bearer user-token')
      .send({ usernameOrEmail: 'alice' });

    expect(res.status).toBe(403);
  });
});

describe('POST /families/:id/members/:memberId/accept', () => {
  it('accepts the invite', async () => {
    mockAcceptInvite.mockResolvedValue(fakeMembership({ status: 'active' }));

    const res = await request(app)
      .post('/families/family-1/members/member-1/accept')
      .set('Authorization', 'Bearer user-token')
      .send();

    expect(res.status).toBe(200);
    expect(mockAcceptInvite).toHaveBeenCalledWith('family-1', 'member-1', OPERATOR_ID);
  });
});

describe('POST /families/:id/members/:memberId/decline', () => {
  it('declines the invite', async () => {
    mockDeclineInvite.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/families/family-1/members/member-1/decline')
      .set('Authorization', 'Bearer user-token')
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockDeclineInvite).toHaveBeenCalledWith('family-1', 'member-1', OPERATOR_ID);
  });
});

describe('DELETE /families/:id/members/:memberId', () => {
  it('removes a member', async () => {
    mockRemoveMember.mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/families/family-1/members/member-2')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(200);
    expect(mockRemoveMember).toHaveBeenCalledWith('family-1', 'member-2', OPERATOR_ID);
  });
});

describe('POST /families/:id/leave', () => {
  it('leaves the family', async () => {
    mockLeaveFamily.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/families/family-1/leave')
      .set('Authorization', 'Bearer user-token')
      .send();

    expect(res.status).toBe(200);
    expect(mockLeaveFamily).toHaveBeenCalledWith('family-1', OPERATOR_ID);
  });
});

// Keeps the `NotFoundError` import live and asserts the route's 404 really
// comes from that class, not an incidental empty-body 404 from Express.
describe('error shape', () => {
  it('a thrown NotFoundError serialises to a 404 with a message', async () => {
    mockLeaveFamily.mockRejectedValue(new NotFoundError('You are not a member of this family'));

    const res = await request(app)
      .post('/families/family-1/leave')
      .set('Authorization', 'Bearer user-token')
      .send();

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not a member of this family/i);
  });
});
