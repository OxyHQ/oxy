/**
 * The HTTP edge must reject payload-shaped agency fields before any persistence
 * edge is reached. Contract and CHECK tests cover the inner barriers; these
 * requests prove the router wiring cannot write first and validate later.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: 'requester-account', id: 'requester-account' };
    next();
  },
  serviceAuthMiddleware: (
    req: { serviceApp?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      appId: 'alia-app',
      credentialId: 'alia-credential',
      ownerAccountId: 'owner-account',
      environment: 'production',
      scopes: ['capability-audit:write'],
    };
    next();
  },
}));

jest.mock('../../config/postgres', () => ({ getDb: jest.fn() }));

jest.mock('../../services/agencyServicePrincipal.service', () => ({
  resolveLiveAgencyServicePrincipal: jest.fn(async () => ({
    applicationId: 'alia-app',
    credentialId: 'alia-credential',
    ownerAccountId: 'owner-account',
    scopes: ['capability-audit:write'],
    capabilities: [],
  })),
  resolveLiveAgencyCoordinator: jest.fn(),
  principalHasCatalogCapability: jest.fn(() => true),
}));

jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  persistCapabilityAuditEvent: jest.fn(),
}));

import { getDb } from '../../config/postgres';
import { persistCapabilityAuditEvent } from '../../services/capabilityRuntimeStore.service';
import capabilitiesRouter from '../capabilities';

const app = express();
app.use(express.json());
app.use('/capabilities', capabilitiesRouter);

const resource = {
  appId: 'inbox',
  effectiveAccountId: 'owner-account',
  resourceType: 'mailbox',
  resourceId: 'mailbox-1',
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('rejects string-shaped grant limits with 400 and no database access', async () => {
  const response = await request(app).post('/capabilities/grants').send({
    ownerAccountId: 'owner-account',
    actorAccountId: 'agent-account',
    resource,
    capabilityPackages: ['read'],
    capabilities: ['email.read'],
    toolOverrides: [],
    limits: [{ tool: 'searchEmails', key: 'q', value: 'private prompt marker' }],
    maximumAutonomy: 'read_only',
    canRedelegate: false,
    expiresAt: null,
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe('invalid_grant');
  expect(getDb).not.toHaveBeenCalled();
});

it('rejects list-shaped execution limits with 400 and no database access', async () => {
  const response = await request(app).post('/capabilities/execution-authorizations').send({
    kind: 'direct_request',
    ownerAccountId: 'owner-account',
    coordinatorApplicationId: 'alia-app',
    coordinatorCredentialId: 'alia-credential',
    actor: { type: 'alia', ownerAccountId: 'owner-account' },
    resource,
    tool: 'searchEmails',
    runId: 'run-1',
    maximumAutonomy: 'read_only',
    limits: [{ tool: 'searchEmails', key: 'q', value: ['private prompt marker'] }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe('invalid_execution_authorization');
  expect(getDb).not.toHaveBeenCalled();
});

it('rejects a direct execution authorization without its exact run', async () => {
  const response = await request(app).post('/capabilities/execution-authorizations').send({
    kind: 'direct_request',
    ownerAccountId: 'owner-account',
    coordinatorApplicationId: 'alia-app',
    coordinatorCredentialId: 'alia-credential',
    actor: { type: 'alia', ownerAccountId: 'owner-account' },
    resource,
    tool: 'searchEmails',
    maximumAutonomy: 'read_only',
    limits: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe('invalid_execution_authorization');
  expect(getDb).not.toHaveBeenCalled();
});

it('rejects a durable automation authorization pre-bound to a future run', async () => {
  const response = await request(app).post('/capabilities/execution-authorizations').send({
    kind: 'automation',
    ownerAccountId: 'owner-account',
    coordinatorApplicationId: 'alia-app',
    coordinatorCredentialId: 'alia-credential',
    actor: { type: 'agent', accountId: 'agent-account' },
    resource,
    tool: 'searchEmails',
    runId: 'future-run',
    automationId: 'automation-1',
    maximumAutonomy: 'autonomous',
    limits: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe('invalid_execution_authorization');
  expect(getDb).not.toHaveBeenCalled();
});

it('rejects free-form audit messages with 400 and no persistence edge', async () => {
  const response = await request(app).post('/capabilities/audit').send({
    ticket: 'capability-ticket',
    result: {
      status: 'denied',
      code: 'policy_denied',
      message: 'private prompt marker',
    },
    rollback: { supported: false, attempted: false },
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe('invalid_audit_event');
  expect(persistCapabilityAuditEvent).not.toHaveBeenCalled();
  expect(getDb).not.toHaveBeenCalled();
});
