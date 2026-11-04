import type { CapabilityTicketClaims } from '@oxy.so/contracts';
import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketError } from '../capabilityTicket';
import {
  createCapabilityTicketMiddleware,
  inputSatisfiesCapabilityLimits,
  issueCapabilityTicket,
  readCapabilityAuthorization,
  verifyCapabilityTicket,
} from '../capabilityTicket';

const NOW = new Date('2026-09-01T10:00:00.000Z');
const KEY_PAIR = generateKeyPairSync('ed25519');
const KEY_ID = 'capability-test-1';

const claims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
  aud: 'inbox-api',
  sub: 'agent-1',
  runId: 'run-1',
  executionAuthorization: { kind: 'direct_request', id: 'authorization-1' },
  coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
  requesterAccountId: 'owner-1',
  ownerAccountId: 'owner-1',
  actor: { type: 'agent', accountId: 'agent-1' },
  resource: {
    appId: 'inbox',
    effectiveAccountId: 'business-1',
    resourceType: 'mailbox',
    resourceId: 'mailbox-1',
  },
  tool: 'sendEmail',
  capabilities: ['email.send'],
  limits: [],
  autonomy: 'execute_on_request',
};

describe('capability tickets', () => {
  it('parses the Capability HTTP authentication scheme case-insensitively', () => {
    expect(readCapabilityAuthorization('Capability signed-ticket')).toBe('signed-ticket');
    expect(readCapabilityAuthorization('capability signed-ticket')).toBe('signed-ticket');
    expect(readCapabilityAuthorization('Bearer signed-ticket')).toBeNull();
    expect(readCapabilityAuthorization('Capability signed-ticket extra')).toBeNull();
  });

  it('round-trips exact actor, effective account, resource and run claims', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so',
      privateKey: KEY_PAIR.privateKey,
      keyId: KEY_ID,
      now: NOW,
      jti: 'ticket-1',
      ttlSeconds: 60,
    });
    const verified = verifyCapabilityTicket(token, {
      audience: 'inbox-api',
      issuer: 'https://api.oxy.so',
      resolvePublicKey: (keyId) => (keyId === KEY_ID ? KEY_PAIR.publicKey : undefined),
      now: new Date('2026-09-01T10:00:30.000Z'),
    });

    expect(verified.actor).toEqual({ type: 'agent', accountId: 'agent-1' });
    expect(verified.resource.effectiveAccountId).toBe('business-1');
    expect(verified.resource.resourceId).toBe('mailbox-1');
    expect(verified.runId).toBe('run-1');
  });

  it('rejects cross-app replay even when the signature is valid', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so',
      privateKey: KEY_PAIR.privateKey,
      keyId: KEY_ID,
      now: NOW,
    });

    expect(() =>
      verifyCapabilityTicket(token, {
        audience: 'mention-api',
        resolvePublicKey: () => KEY_PAIR.publicKey,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'wrong_audience' }));
    expect(() =>
      verifyCapabilityTicket(token, {
        audience: 'inbox-api',
        resolvePublicKey: () => undefined,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'unknown_key' }));
  });

  it('rejects expired, tampered and overlong tickets', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so',
      privateKey: KEY_PAIR.privateKey,
      keyId: KEY_ID,
      now: NOW,
      ttlSeconds: 60,
    });
    expect(() =>
      verifyCapabilityTicket(token, {
        audience: 'inbox-api',
        resolvePublicKey: () => KEY_PAIR.publicKey,
        now: new Date('2026-09-01T10:01:00.000Z'),
      }),
    ).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'expired' }));

    const [header, payload, signature] = token.split('.');
    expect(() =>
      verifyCapabilityTicket(`${header}.${payload}x.${signature}`, {
        audience: 'inbox-api',
        resolvePublicKey: () => KEY_PAIR.publicKey,
        now: NOW,
      }),
    ).toThrow(
      expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'invalid_signature' }),
    );

    expect(() =>
      issueCapabilityTicket(claims, {
        issuer: 'https://api.oxy.so',
        privateKey: KEY_PAIR.privateKey,
        keyId: KEY_ID,
        now: NOW,
        ttlSeconds: 301,
      }),
    ).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'ttl_exceeded' }));
  });

  it('enforces numeric and boolean limits carried by a ticket', () => {
    const limits = [
      { tool: 'sendPayment', key: 'amount', value: 100 },
      { tool: 'sendPayment', key: 'confirmed', value: true },
    ];
    expect(
      inputSatisfiesCapabilityLimits('sendPayment', { amount: 75, confirmed: true }, limits),
    ).toBe(true);
    expect(
      inputSatisfiesCapabilityLimits('sendPayment', { amount: 101, confirmed: true }, limits),
    ).toBe(false);
    expect(
      inputSatisfiesCapabilityLimits('sendPayment', { amount: 75, confirmed: false }, limits),
    ).toBe(false);
    expect(inputSatisfiesCapabilityLimits('sendPayment', { amount: 75 }, limits)).toBe(false);
    expect(
      inputSatisfiesCapabilityLimits('otherTool', { amount: 75, confirmed: true }, limits),
    ).toBe(false);
    expect(
      inputSatisfiesCapabilityLimits(
        'updateFlags',
        {
          flags: { seen: true },
        },
        [{ tool: 'updateFlags', key: 'flags.seen', value: true }],
      ),
    ).toBe(true);
  });
});

describe('createCapabilityTicketMiddleware with an asynchronous key lookup', () => {
  function run(
    token: string,
    resolvePublicKey: (keyId: string) => Promise<import('node:crypto').KeyObject | undefined>,
  ) {
    const authorize = jest.fn(async () => ({ allowed: true }) as never);
    const middleware = createCapabilityTicketMiddleware({
      audience: 'inbox-api',
      issuer: 'https://api.oxy.so',
      now: NOW,
      resolvePublicKey,
      authorize,
    });
    const response = { statusCode: 200, body: undefined as unknown };
    const res = {
      status(code: number) {
        response.statusCode = code;
        return this;
      },
      json(body: unknown) {
        response.body = body;
        return this;
      },
    };
    const next = jest.fn();
    const req = {
      header: (name: string) => (name === 'authorization' ? `Capability ${token}` : undefined),
    };
    return {
      done: middleware(req as never, res as never, next),
      response,
      next,
      authorize,
    };
  }

  const token = () =>
    issueCapabilityTicket(claims, {
      privateKey: KEY_PAIR.privateKey,
      keyId: KEY_ID,
      issuer: 'https://api.oxy.so',
      now: NOW,
    });

  it('awaits the lookup with the ticket kid and admits a valid ticket', async () => {
    const resolvePublicKey = jest.fn(async (keyId: string) =>
      keyId === KEY_ID ? KEY_PAIR.publicKey : undefined,
    );
    const call = run(token(), resolvePublicKey);
    await call.done;
    expect(resolvePublicKey).toHaveBeenCalledWith(KEY_ID);
    expect(call.next).toHaveBeenCalledWith();
  });

  it('answers 401 unknown_key when the key set has no such key or cannot be read', async () => {
    for (const resolvePublicKey of [
      async () => undefined,
      async () => {
        throw new Error('jwks unreachable');
      },
    ]) {
      const call = run(token(), resolvePublicKey);
      await call.done;
      expect(call.response).toEqual({
        statusCode: 401,
        body: { error: 'invalid_capability_ticket', code: 'unknown_key' },
      });
      expect(call.authorize).not.toHaveBeenCalled();
    }
  });
});
