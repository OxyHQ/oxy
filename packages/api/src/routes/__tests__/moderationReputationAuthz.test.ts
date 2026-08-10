/**
 * /reputation/moderation authorization tests.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE NEGATIVE ONE: `reputation:write` must
 * NOT open this door.
 *
 * `reputation:write` is the broad ledger-write authority every official Oxy
 * application already holds — it can mint arbitrary points for arbitrary users
 * through `POST /reputation/award`. If it also satisfied the bridge, then every
 * official application would silently gain the power to penalise conduct, open a
 * jury and act across tenants, which is exactly the conflation the dedicated
 * scope exists to undo. So the two are independent: neither implies the other,
 * and holding both has to be an explicit decision.
 *
 * The other invariant here is shape rather than policy: no endpoint on this router
 * accepts points, risk, standing or duration. Not because a caller would be
 * rejected, but because the request schema has no such field — which is what makes
 * the one-way direction structural instead of policed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockServiceAuthMiddleware = jest.fn();
const mockAuthMiddleware = jest.fn();
const mockApply = jest.fn();
const mockReverse = jest.fn();
const mockFinalize = jest.fn();
const mockReconcile = jest.fn();
const mockRegisterBinding = jest.fn();
const mockResolveUserIdToObjectId = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/requireStaff', () => ({
  requireStaff: (req: { user?: { isStaff?: boolean } }, res: { status: (c: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (req.user?.isStaff === true) {
      next();
      return;
    }
    res.status(403).json({ error: 'Forbidden', message: 'Staff privileges required' });
  },
}));

jest.mock('../../utils/validation', () => ({
  resolveUserIdToObjectId: (...args: unknown[]) => mockResolveUserIdToObjectId(...args),
}));

jest.mock('../../services/moderationReputation.service', () => ({
  __esModule: true,
  default: {
    applyModerationDecision: (...args: unknown[]) => mockApply(...args),
    reverseModerationDecision: (...args: unknown[]) => mockReverse(...args),
    finalizeModerationDecision: (...args: unknown[]) => mockFinalize(...args),
    reconcileModerationIncident: (...args: unknown[]) => mockReconcile(...args),
  },
}));

jest.mock('../../services/identityBinding.service', () => ({
  registerIdentityBinding: (...args: unknown[]) => mockRegisterBinding(...args),
}));

jest.mock('../../services/reputation.service', () => ({
  __esModule: true,
  default: { getBalance: jest.fn() },
}));

jest.mock('../../models/ModerationEffect', () => ({
  __esModule: true,
  ModerationEffect: {
    find: () => ({ sort: () => ({ limit: async () => [] }) }),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import moderationRouter from '../moderationReputation.routes';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: { error?: string; message?: string; data?: Record<string, unknown> };
}

async function post(server: http.Server, path: string, payload: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          authorization: 'Bearer service-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          connection: 'close',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Make the service middleware present a credential with exactly `scopes`. */
function withServiceScopes(scopes: string[]): void {
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = {
        type: 'service',
        appId: '64aaaaaaaaaaaaaaaaaaaaaa',
        appName: 'Moderation Service',
        credentialId: '64bbbbbbbbbbbbbbbbbbbbbb',
        scopes,
      };
      next();
    }
  );
}

const VALID_EVENT = {
  eventId: 'evt_1',
  reportedApplicationId: '64cccccccccccccccccccccc',
  type: 'moderation.decision.finalized.v1',
  caseId: 'case_1',
  incidentId: 'inc_1',
  decisionId: 'dec_1',
  decisionRevision: 1,
  subject: {
    principalType: 'oxy_user',
    principalId: '64dddddddddddddddddddddd',
    bindingProofId: '64eeeeeeeeeeeeeeeeeeeeee',
  },
  findings: [
    {
      code: 'harassment.targeted_abuse',
      severity: 'medium',
      scope: 'oxy_network',
      attribution: 'author',
      family: 'harassment',
    },
  ],
  decisionStatus: 'final',
  policyVersions: {
    universal: '2026.1',
    application: 'mention.2026.07',
    oxyConduct: 'oxy.2026.1',
  },
  occurredAt: '2026-06-01T00:00:00.000Z',
  proofHash: 'sha256:abc',
};

let server: http.Server;

beforeAll((done) => {
  process.env.ACCESS_TOKEN_SECRET = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/reputation/moderation', moderationRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockApply.mockResolvedValue({ applied: false, skipReason: 'no_binding_proof', idempotent: false });
  mockReverse.mockResolvedValue({ reversed: [], idempotent: true });
  mockFinalize.mockResolvedValue([]);
  mockReconcile.mockResolvedValue({
    incidentId: 'inc_1',
    effectsExamined: 0,
    strikesRepaired: 0,
    supersededReversed: 0,
    balancesRecalculated: 0,
  });
  mockAuthMiddleware.mockImplementation(
    (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { _id: { toString: () => '64dddddddddddddddddddddd' }, isStaff: false };
      next();
    }
  );
});

describe('POST /reputation/moderation/effects — the scope gate', () => {
  it('rejects a credential with NO scopes', async () => {
    withServiceScopes([]);
    const res = await post(server, '/reputation/moderation/effects', VALID_EVENT);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/reputation:moderation:apply/);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('REJECTS a credential carrying reputation:write', async () => {
    /*
     * THE LOAD-BEARING NEGATIVE. `reputation:write` is held by every official
     * application already. If it satisfied this endpoint, every one of them would
     * silently gain the authority to penalise conduct — the exact conflation the
     * dedicated scope exists to undo.
     */
    withServiceScopes(['reputation:write']);
    const res = await post(server, '/reputation/moderation/effects', VALID_EVENT);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/reputation:moderation:apply/);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects a credential carrying only the BINDING scope', async () => {
    // Registering a binding and imposing a consequence are different authorities.
    withServiceScopes(['reputation:binding:register']);
    const res = await post(server, '/reputation/moderation/effects', VALID_EVENT);
    expect(res.status).toBe(403);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('accepts a credential carrying reputation:moderation:apply', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    const res = await post(server, '/reputation/moderation/effects', VALID_EVENT);
    expect(res.status).toBe(200);
    expect(mockApply).toHaveBeenCalledTimes(1);
  });

  it('derives the emitter identity from the CREDENTIAL, never the body', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    await post(server, '/reputation/moderation/effects', {
      ...VALID_EVENT,
      emitterApplicationId: 'spoofed',
      emitterCredentialId: 'spoofed',
    });
    expect(mockApply).toHaveBeenCalledWith(
      expect.anything(),
      {
        emitterApplicationId: '64aaaaaaaaaaaaaaaaaaaaaa',
        emitterCredentialId: '64bbbbbbbbbbbbbbbbbbbbbb',
      }
    );
  });

  it('a skip is a 200, so an emitter stops retrying something that will never change', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    mockApply.mockResolvedValue({
      applied: false,
      skipReason: 'application_not_permitted',
      idempotent: false,
    });
    const res = await post(server, '/reputation/moderation/effects', VALID_EVENT);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ applied: false, skipReason: 'application_not_permitted' });
  });
});

describe('the request shape cannot express an effect', () => {
  it('strips a caller-supplied points / risk / standing from the event', async () => {
    /*
     * The direction is one-way by SHAPE, not by policy. The schema declares no
     * points, risk, standing or duration, so a caller cannot state a consequence
     * even with the right scope — and zod drops what it does not declare rather
     * than forwarding it.
     */
    withServiceScopes(['reputation:moderation:apply']);
    await post(server, '/reputation/moderation/effects', {
      ...VALID_EVENT,
      points: -9999,
      activeRisk: 100,
      standing: 'restricted',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    const [event] = mockApply.mock.calls[0] as [Record<string, unknown>];
    expect(event).not.toHaveProperty('points');
    expect(event).not.toHaveProperty('activeRisk');
    expect(event).not.toHaveProperty('standing');
    expect(event).not.toHaveProperty('expiresAt');
  });

  it('rejects an event missing its binding proof outright', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    const { subject, ...withoutSubject } = VALID_EVENT;
    const res = await post(server, '/reputation/moderation/effects', {
      ...withoutSubject,
      subject: { principalType: 'oxy_user', principalId: subject.principalId },
    });
    expect(res.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('rejects a decision revision below 1', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    const res = await post(server, '/reputation/moderation/effects', {
      ...VALID_EVENT,
      decisionRevision: 0,
    });
    expect(res.status).toBe(400);
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('POST /reputation/moderation/effects/reverse', () => {
  it('requires the apply scope', async () => {
    withServiceScopes(['reputation:write']);
    const res = await post(server, '/reputation/moderation/effects/reverse', {
      decisionId: 'dec_1',
      decisionRevision: 1,
      reason: 'Appeal accepted',
    });
    expect(res.status).toBe(403);
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('accepts the apply scope and names no figure of its own', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    const res = await post(server, '/reputation/moderation/effects/reverse', {
      decisionId: 'dec_1',
      decisionRevision: 1,
      reason: 'Appeal accepted',
      // A caller cannot choose how much to give back.
      points: 9999,
    });
    expect(res.status).toBe(200);
    expect(mockReverse).toHaveBeenCalledWith(
      'dec_1',
      1,
      'Appeal accepted',
      '64bbbbbbbbbbbbbbbbbbbbbb'
    );
  });

  it('requires a reason — a reversal without one is unexplainable', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    const res = await post(server, '/reputation/moderation/effects/reverse', {
      decisionId: 'dec_1',
      decisionRevision: 1,
    });
    expect(res.status).toBe(400);
    expect(mockReverse).not.toHaveBeenCalled();
  });
});

describe('POST /reputation/moderation/bindings', () => {
  it('requires the binding scope, and the apply scope does not substitute', async () => {
    withServiceScopes(['reputation:moderation:apply']);
    const res = await post(server, '/reputation/moderation/bindings', {
      localPrincipalId: 'local-1',
      userProofToken: 'user-token',
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/reputation:binding:register/);
    expect(mockRegisterBinding).not.toHaveBeenCalled();
  });

  it('resolves applicationId from the credential and ignores any body value', async () => {
    withServiceScopes(['reputation:binding:register']);
    mockRegisterBinding.mockResolvedValue({
      id: 'bind1',
      applicationId: '64aaaaaaaaaaaaaaaaaaaaaa',
      userId: '64dddddddddddddddddddddd',
      localPrincipalId: 'local-1',
      bindingType: 'session_proof',
      status: 'active',
      verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const res = await post(server, '/reputation/moderation/bindings', {
      localPrincipalId: 'local-1',
      userProofToken: 'user-token',
      applicationId: 'spoofed-application',
    });

    expect(res.status).toBe(201);
    expect(mockRegisterBinding).toHaveBeenCalledWith({
      applicationId: '64aaaaaaaaaaaaaaaaaaaaaa',
      credentialId: '64bbbbbbbbbbbbbbbbbbbbbb',
      localPrincipalId: 'local-1',
      userProofToken: 'user-token',
    });
  });

  it('requires the user proof token — a body an application composes alone is no proof', async () => {
    withServiceScopes(['reputation:binding:register']);
    const res = await post(server, '/reputation/moderation/bindings', {
      localPrincipalId: 'local-1',
    });
    expect(res.status).toBe(400);
    expect(mockRegisterBinding).not.toHaveBeenCalled();
  });

  it('never echoes the proof token back', async () => {
    withServiceScopes(['reputation:binding:register']);
    mockRegisterBinding.mockResolvedValue({
      id: 'bind1',
      applicationId: '64aaaaaaaaaaaaaaaaaaaaaa',
      userId: '64dddddddddddddddddddddd',
      localPrincipalId: 'local-1',
      bindingType: 'session_proof',
      status: 'active',
      verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const res = await post(server, '/reputation/moderation/bindings', {
      localPrincipalId: 'local-1',
      userProofToken: 'super-secret-user-token',
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-user-token');
  });
});

describe('a user session can never satisfy a bridge route', () => {
  it('a staff session does not stand in for the emitting credential', async () => {
    // Letting a privileged session substitute would make "a moderation service
    // emitted this decision" unfalsifiable.
    mockServiceAuthMiddleware.mockImplementation(
      (req: { serviceApp?: unknown; user?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = undefined;
        req.user = { _id: { toString: () => 'staff1' }, isStaff: true };
        next();
      }
    );
    const res = await post(server, '/reputation/moderation/effects', VALID_EVENT);
    expect(res.status).toBe(401);
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('staff-only reconciliation', () => {
  it('a non-staff session cannot reconcile an incident', async () => {
    withServiceScopes([]);
    const res = await post(server, '/reputation/moderation/incidents/inc_1/reconcile', {});
    expect(res.status).toBe(403);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('a staff session can', async () => {
    withServiceScopes([]);
    mockAuthMiddleware.mockImplementation(
      (req: { user?: unknown }, _res: unknown, next: () => void) => {
        req.user = { _id: { toString: () => 'staff1' }, isStaff: true };
        next();
      }
    );
    const res = await post(server, '/reputation/moderation/incidents/inc_1/reconcile', {});
    expect(res.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith('inc_1');
  });
});
