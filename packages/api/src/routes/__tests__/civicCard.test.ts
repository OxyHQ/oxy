/**
 * Route-shape tests for the public DNI card endpoint (Fase 1).
 *
 * Locks the EXACT public response shape a scanner consumes:
 *  - GET /civic/:userId/card → { card, attestation } (signedPublicCardSchema)
 *  - unknown user → 404; an id that names no account → 404 (whatever its FORMAT)
 *  - PUBLIC (no auth) + CORS-open + cacheable; the attestation signature is present.
 *
 * The publicCard SERVICE is mocked; this suite only locks the HTTP envelope.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const USER_ID = '507f1f77bcf86cd799439011';

const mockBuild = jest.fn();

jest.mock('../../services/civic/publicCard.service', () => ({
  buildSignedPublicCard: (...args: unknown[]) => mockBuild(...args),
}));
// The civic route also wires POST /attestations; mock its deps so this card-only
// suite does not transitively load the real service + model chain.
jest.mock('../../services/civic/realLife.service', () => ({ submitRealLifeAttestation: jest.fn() }));
jest.mock('../../services/civic/validator.service', () => ({
  openValidationRequest: jest.fn(),
  submitVote: jest.fn(),
  denyValidation: jest.fn(),
  getValidatorInbox: jest.fn(),
}));
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
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/validate', () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/validation', () => ({ isValidObjectId: (id: string) => /^[a-f0-9]{24}$/i.test(id) }));

import civicRoutes from '../civic';
import { errorHandler } from '../../middleware/errorHandler';

function signedCard() {
  return {
    card: {
      did: `did:web:oxy.so:u:${USER_ID}`,
      userId: USER_ID,
      name: 'Nate Isern',
      username: 'nate',
      avatarUrl: 'https://cloud.oxy.so/fileabc',
      trustTier: 'trusted',
      personhoodStatus: 'unverified',
      verifiedDomains: ['oxy.so'],
      credentialBadges: [],
      issuedAt: 1_700_000_000_000,
    },
    attestation: {
      issuer: 'did:web:oxy.so',
      publicKey: 'pk',
      alg: 'ES256K-DER-SHA256',
      signature: 'deadbeef',
      signedAt: 1_700_000_000_000,
    },
  };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

async function request(server: http.Server, path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {}, headers: res.headers }),
      );
    });
    req.on('error', reject);
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
beforeEach(() => { jest.clearAllMocks(); });

describe('GET /civic/:userId/card', () => {
  it('returns { card, attestation } with the signature present', async () => {
    mockBuild.mockResolvedValueOnce(signedCard());

    const res = await request(server, `/civic/${USER_ID}/card`);

    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ did: `did:web:oxy.so:u:${USER_ID}`, trustTier: 'trusted' });
    expect((res.body.attestation as { signature?: string }).signature).toBe('deadbeef');
    // Public + CORS-open + cacheable.
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('returns 404 for an unknown user', async () => {
    mockBuild.mockResolvedValueOnce(null);
    const res = await request(server, `/civic/${USER_ID}/card`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an id that names no account, whatever its format', async () => {
    // The route USED to short-circuit on an ObjectId-format check without
    // calling the service. That check is deleted: after the cutover every new
    // account id is a uuid v7, so a format gate would 404 the entire new id
    // space. The service is now the one authority on "no such card" and answers
    // 404 for an unresolvable id of any shape.
    mockBuild.mockResolvedValueOnce(null);
    const res = await request(server, '/civic/not-an-objectid/card');
    expect(res.status).toBe(404);
    expect(mockBuild).toHaveBeenCalledWith('not-an-objectid');
  });
});
