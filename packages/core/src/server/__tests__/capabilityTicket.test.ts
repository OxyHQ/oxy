import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import type { CapabilityTicketError } from '../capabilityTicket';
import {
  inputSatisfiesCapabilityLimits,
  issueCapabilityTicket,
  verifyCapabilityTicket,
} from '../capabilityTicket';

const NOW = new Date('2026-09-01T10:00:00.000Z');
const SECRET = 'test-only-capability-ticket-secret-at-least-32-bytes';

const claims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
  aud: 'inbox-api',
  sub: 'agent-1',
  runId: 'run-1',
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
  it('round-trips exact actor, effective account, resource and run claims', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so',
      secret: SECRET,
      now: NOW,
      jti: 'ticket-1',
      ttlSeconds: 60,
    });
    const verified = verifyCapabilityTicket(token, {
      audience: 'inbox-api',
      issuer: 'https://api.oxy.so',
      secret: SECRET,
      now: new Date('2026-09-01T10:00:30.000Z'),
    });

    expect(verified.actor).toEqual({ type: 'agent', accountId: 'agent-1' });
    expect(verified.resource.effectiveAccountId).toBe('business-1');
    expect(verified.resource.resourceId).toBe('mailbox-1');
    expect(verified.runId).toBe('run-1');
  });

  it('rejects cross-app replay even when the signature is valid', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so', secret: SECRET, now: NOW,
    });

    expect(() => verifyCapabilityTicket(token, {
      audience: 'mention-api', secret: SECRET, now: NOW,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'wrong_audience' }));
  });

  it('rejects expired, tampered and overlong tickets', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so', secret: SECRET, now: NOW, ttlSeconds: 60,
    });
    expect(() => verifyCapabilityTicket(token, {
      audience: 'inbox-api', secret: SECRET, now: new Date('2026-09-01T10:01:00.000Z'),
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'expired' }));

    const [header, payload, signature] = token.split('.');
    expect(() => verifyCapabilityTicket(`${header}.${payload}x.${signature}`, {
      audience: 'inbox-api', secret: SECRET, now: NOW,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'invalid_signature' }));

    expect(() => issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so', secret: SECRET, now: NOW, ttlSeconds: 301,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'ttl_exceeded' }));
  });

  it('enforces amount and recipient limits carried by a ticket', () => {
    const limits = [
      { key: 'amount', value: 100 },
      { key: 'recipient', value: ['vendor-1', 'vendor-2'] },
    ];
    expect(inputSatisfiesCapabilityLimits({ amount: 75, recipient: 'vendor-1' }, limits)).toBe(true);
    expect(inputSatisfiesCapabilityLimits({ amount: 101, recipient: 'vendor-1' }, limits)).toBe(false);
    expect(inputSatisfiesCapabilityLimits({ amount: 75, recipient: 'attacker' }, limits)).toBe(false);
  });
});
