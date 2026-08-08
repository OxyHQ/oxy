/**
 * Route-shape tests for POST /civic/attestations (Fase 2 Part A).
 *
 * Locks the HTTP contract: auth required, success → 201 with the
 * RealLifeAttestationResult, and each service rejection reason maps to the right
 * status (403 excluded, 409 nonce/cooldown/chain, 404 subject, 400 otherwise).
 * The realLife SERVICE, rate limiter, and body validator are mocked.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const B = 'b'.repeat(24);

const mockSubmit = jest.fn();
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));

jest.mock('../../utils/socket', () => ({ getIO: () => ({ to: mockTo }) }));
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: B, id: B };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/civic/validator.service', () => ({
  openValidationRequest: jest.fn(),
  submitVote: jest.fn(),
  denyValidation: jest.fn(),
  getValidatorInbox: jest.fn(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/validate', () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/civic/realLife.service', () => ({
  submitRealLifeAttestation: (...a: unknown[]) => mockSubmit(...a),
}));
jest.mock('../../services/civic/publicCard.service', () => ({ buildSignedPublicCard: jest.fn() }));
jest.mock('../../services/civic/personhood.service', () => ({
  vouchForPerson: jest.fn(),
  withdrawVouch: jest.fn(),
  recomputePersonhood: jest.fn(),
}));
jest.mock('../../services/civic/credential.service', () => ({
  issueCredential: jest.fn(),
  listCredentialsForHolder: jest.fn(),
  verifyCredential: jest.fn(),
  revokeCredential: jest.fn(),
}));
jest.mock('../../utils/validation', () => ({ isValidObjectId: (id: string) => /^[a-f0-9]{24}$/i.test(id) }));

import civicRoutes from '../civic';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse { status: number; body: Record<string, unknown>; }

async function post(server: http.Server, path: string, payload: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST', host: '127.0.0.1', port: address.port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/civic', civicRoutes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockEmit.mockClear();
  mockTo.mockClear();
});

describe('POST /civic/attestations', () => {
  it('returns 201 with the attestation result on success', async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: true, recordId: 'rec-1', subjectUserId: 'a'.repeat(24), attestorUserId: B, points: 25,
    });

    const res = await post(server, '/civic/attestations', { type: 'real_life_attestation' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      accepted: true, recordId: 'rec-1', subjectUserId: 'a'.repeat(24), attestorUserId: B, points: 25,
    });
  });

  it('maps an exclusion reason to 403', async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: 'excluded_graph_neighbor' });
    const res = await post(server, '/civic/attestations', {});
    expect(res.status).toBe(403);
  });

  it('maps nonce reuse to 409', async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: 'nonce_used' });
    const res = await post(server, '/civic/attestations', {});
    expect(res.status).toBe(409);
  });

  it('maps subject_not_found to 404', async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: 'subject_not_found' });
    const res = await post(server, '/civic/attestations', {});
    expect(res.status).toBe(404);
  });

  it('maps a generic rejection to 400', async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: 'invalid_record' });
    const res = await post(server, '/civic/attestations', {});
    expect(res.status).toBe(400);
  });

  it('emits civic:attested to the subject user room on success', async () => {
    mockSubmit.mockResolvedValueOnce({
      ok: true, recordId: 'rec-1', subjectUserId: 'a'.repeat(24), attestorUserId: B, points: 25,
    });

    const res = await post(server, '/civic/attestations', { type: 'real_life_attestation' });

    expect(res.status).toBe(201);
    expect(mockTo).toHaveBeenCalledWith(`user:${'a'.repeat(24)}`);
    expect(mockEmit).toHaveBeenCalledWith('civic:attested', expect.objectContaining({
      subjectUserId: 'a'.repeat(24),
      byUserId: B,
      recordId: 'rec-1',
      points: 25,
      at: expect.any(String),
    }));
  });

  it('does NOT emit civic:attested when the attestation is rejected', async () => {
    mockSubmit.mockResolvedValueOnce({ ok: false, reason: 'nonce_used' });
    const res = await post(server, '/civic/attestations', {});
    expect(res.status).toBe(409);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
