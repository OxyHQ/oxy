import type { CapabilityTicketClaims } from '@oxyhq/contracts';
import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketError } from '../capabilityTicket';
import {
  inputSatisfiesCapabilityLimits,
  issueCapabilityTicket,
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
      resolvePublicKey: (keyId) => keyId === KEY_ID ? KEY_PAIR.publicKey : undefined,
      now: new Date('2026-09-01T10:00:30.000Z'),
    });

    expect(verified.actor).toEqual({ type: 'agent', accountId: 'agent-1' });
    expect(verified.resource.effectiveAccountId).toBe('business-1');
    expect(verified.resource.resourceId).toBe('mailbox-1');
    expect(verified.runId).toBe('run-1');
  });

  it('rejects cross-app replay even when the signature is valid', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so', privateKey: KEY_PAIR.privateKey, keyId: KEY_ID, now: NOW,
    });

    expect(() => verifyCapabilityTicket(token, {
      audience: 'mention-api', resolvePublicKey: () => KEY_PAIR.publicKey, now: NOW,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'wrong_audience' }));
    expect(() => verifyCapabilityTicket(token, {
      audience: 'inbox-api', resolvePublicKey: () => undefined, now: NOW,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'unknown_key' }));
  });

  it('rejects expired, tampered and overlong tickets', () => {
    const token = issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so', privateKey: KEY_PAIR.privateKey, keyId: KEY_ID, now: NOW, ttlSeconds: 60,
    });
    expect(() => verifyCapabilityTicket(token, {
      audience: 'inbox-api', resolvePublicKey: () => KEY_PAIR.publicKey, now: new Date('2026-09-01T10:01:00.000Z'),
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'expired' }));

    const [header, payload, signature] = token.split('.');
    expect(() => verifyCapabilityTicket(`${header}.${payload}x.${signature}`, {
      audience: 'inbox-api', resolvePublicKey: () => KEY_PAIR.publicKey, now: NOW,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'invalid_signature' }));

    expect(() => issueCapabilityTicket(claims, {
      issuer: 'https://api.oxy.so', privateKey: KEY_PAIR.privateKey, keyId: KEY_ID, now: NOW, ttlSeconds: 301,
    })).toThrow(expect.objectContaining<Partial<CapabilityTicketError>>({ code: 'ttl_exceeded' }));
  });

  it('enforces amount and recipient limits carried by a ticket', () => {
    const limits = [
      { tool: 'sendPayment', key: 'amount', value: 100 },
      { tool: 'sendPayment', key: 'recipient', value: ['vendor-1', 'vendor-2'] },
    ];
    expect(inputSatisfiesCapabilityLimits('sendPayment', { amount: 75, recipient: 'vendor-1' }, limits)).toBe(true);
    expect(inputSatisfiesCapabilityLimits('sendPayment', { amount: 101, recipient: 'vendor-1' }, limits)).toBe(false);
    expect(inputSatisfiesCapabilityLimits('sendPayment', { amount: 75, recipient: 'attacker' }, limits)).toBe(false);
    expect(inputSatisfiesCapabilityLimits('sendPayment', { amount: 75 }, limits)).toBe(false);
    expect(inputSatisfiesCapabilityLimits('otherTool', { amount: 75, recipient: 'vendor-1' }, limits)).toBe(false);
    expect(inputSatisfiesCapabilityLimits('sendEmail', {
      to: [{ address: 'allowed@example.com' }],
    }, [{ tool: 'sendEmail', key: 'to.address', value: ['allowed@example.com'] }])).toBe(true);
    expect(inputSatisfiesCapabilityLimits('sendEmail', {
      to: [{ address: 'allowed@example.com' }, { address: 'blocked@example.com' }],
    }, [{ tool: 'sendEmail', key: 'to.address', value: ['allowed@example.com'] }])).toBe(false);
  });
});
