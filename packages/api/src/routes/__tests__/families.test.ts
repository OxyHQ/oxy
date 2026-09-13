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
const mockGetMyFamily = jest.fn();
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
    getMyFamily: (...args: unknown[]) => mockGetMyFamily(...args),
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
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
  ) => {
    req.user = { _id: OPERATOR_ID, id: OPERATOR_ID };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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
  it("returns the caller's family and roster", async () => {
    mockGetMyFamily.mockResolvedValue({ family: fakeFamily(), members: [fakeMembership()] });

    const res = await request(app).get('/families/me').set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(mockGetMyFamily).toHaveBeenCalledWith(OPERATOR_ID);
  });

  it('answers 404 when the caller belongs to no family', async () => {
    mockGetMyFamily.mockResolvedValue(null);

    const res = await request(app).get('/families/me').set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(404);
  });
});

describe('GET /families/invites', () => {
  it('lists pending invites addressed to the caller', async () => {
    mockListPendingInvites.mockResolvedValue([
      { membership: fakeMembership({ role: 'member', status: 'invited', joinedAt: null }), family: fakeFamily() },
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
      fakeMembership({ memberUserId: 'target-user', role: 'member', status: 'invited', joinedAt: null })
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
      new ForbiddenError('Only the family organizer may invite members')
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
    mockGetMyFamily.mockRejectedValue(new NotFoundError('You do not belong to a family'));

    const res = await request(app).get('/families/me').set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/do not belong to a family/i);
  });
});
