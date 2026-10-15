import express from 'express';
import request from 'supertest';
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: 'selected-person', id: 'selected-person' };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { getSession: jest.fn() },
}));
jest.mock('../../services/deviceSession.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/accountInvitation.service', () => ({
  accountInvitationService: {
    accept: jest.fn().mockResolvedValue({ success: true }),
    preview: jest.fn().mockResolvedValue({ invitation: {} }),
  },
}));
import router from '../accounts';
import { errorHandler } from '../../middleware/errorHandler';
import { accountInvitationService } from '../../services/accountInvitation.service';
const app = express();
app.use(express.json());
app.use('/accounts', router);
app.use(errorHandler);
const token = 'x'.repeat(43);
beforeEach(() => jest.clearAllMocks());
test('cannot nominate an unrelated identity in the acceptance body', async () => {
  const res = await request(app)
    .post('/accounts/invitations/accept')
    .send({ token, selectedUserId: 'another-person', confirmed: true });
  expect(res.status).toBe(403);
  expect(accountInvitationService.accept).not.toHaveBeenCalled();
});
test('explicit confirmation is required', async () => {
  const res = await request(app)
    .post('/accounts/invitations/accept')
    .send({ token, selectedUserId: 'selected-person' });
  expect(res.status).toBe(400);
  expect(accountInvitationService.accept).not.toHaveBeenCalled();
});
test('confirmed verified selected account is passed to the consuming service', async () => {
  const res = await request(app)
    .post('/accounts/invitations/accept')
    .send({ token, selectedUserId: 'selected-person', confirmed: true });
  expect(res.status).toBe(200);
  expect(accountInvitationService.accept).toHaveBeenCalledWith(token, 'selected-person');
});
test('preview never consumes and has no-store response', async () => {
  const res = await request(app).post('/accounts/invitations/preview').send({ token });
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(accountInvitationService.accept).not.toHaveBeenCalled();
});
test('legacy add-member API cannot bypass recipient consent', async () => {
  const res = await request(app)
    .post('/accounts/organization/members')
    .send({ usernameOrEmail: 'anyone', role: 'admin' });
  expect(res.status).toBe(410);
});
