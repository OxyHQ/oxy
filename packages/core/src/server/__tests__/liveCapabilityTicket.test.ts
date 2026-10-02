import { generateKeyPairSync, sign } from 'node:crypto';
import { issueCapabilityTicket, verifyCapabilityTicket } from '../capabilityTicket';
import { createLiveCapabilityTicketVerifier } from '../liveCapabilityTicket';
import type { CapabilityTicketClaims } from '@oxy.so/contracts';

const keys = generateKeyPairSync('ed25519');
const terms: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
  aud: 'inbox-api', sub: 'alia:owner', requesterAccountId: 'owner', ownerAccountId: 'owner',
  actor: { type: 'alia', ownerAccountId: 'owner' }, coordinator: { applicationId: 'alia', credentialId: 'credential' },
  executionAuthorization: { kind: 'direct_request', id: 'authorization' }, runId: 'run', tool: 'read',
  resource: { appId: 'inbox', effectiveAccountId: 'workspace', resourceType: 'mailbox', resourceId: 'mailbox' },
  catalog: { registrationId: 'registration', version: '1', digest: 'a'.repeat(64) },
  capabilities: ['mail.read'], autonomy: 'read_only', limits: [],
};
const verification = { audience: 'inbox-api', issuer: 'https://api.oxy.so', resolvePublicKey: () => keys.publicKey };
function ticket() { return issueCapabilityTicket(terms, { privateKey: keys.privateKey, keyId: 'key', issuer: verification.issuer }); }

it('requires an exact active introspection of the signature-verified claims on every request', async () => {
  const value = ticket();
  const claims = verifyCapabilityTicket(value, verification);
  const introspect = jest.fn(async () => ({ active: true, claims }));
  const verify = createLiveCapabilityTicketVerifier({ ...verification, introspect });
  await expect(verify(value)).resolves.toEqual(claims);
  await verify(value);
  expect(introspect).toHaveBeenCalledTimes(2);
  introspect.mockResolvedValue({ active: true, claims: { ...claims, resource: { ...claims.resource, resourceId: 'other' } } });
  await expect(verify(value)).rejects.toThrow('claims mismatch');
  introspect.mockResolvedValue({ active: false, claims });
  await expect(verify(value)).rejects.toThrow('inactive');
});

it('fails closed on timeout and abort while introspection is in flight', async () => {
  const signals: AbortSignal[] = [];
  const introspect = jest.fn((_ticket: string, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return new Promise<never>(() => {});
  });
  const verify = createLiveCapabilityTicketVerifier({ ...verification, introspect, timeoutMs: 10 });
  await expect(verify(ticket())).rejects.toThrow('timed out');
  expect(signals[0].aborted).toBe(true);
  const abort = new AbortController();
  const pending = verify(ticket(), { signal: abort.signal });
  abort.abort(new Error('request cancelled'));
  await expect(pending).rejects.toThrow('request cancelled');
  expect(signals[1].aborted).toBe(true);
});

it('rejects a validly signed OAuth-format proof, wrong audience and issuer before any live call', async () => {
  const value = ticket();
  const [, payload] = value.split('.');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'at+jwt', kid: 'key' })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const oauth = `${signingInput}.${sign(null, Buffer.from(signingInput), keys.privateKey).toString('base64url')}`;
  const introspect = jest.fn();
  const verify = createLiveCapabilityTicketVerifier({ ...verification, introspect });
  await expect(verify(oauth)).rejects.toThrow('header');
  await expect(createLiveCapabilityTicketVerifier({ ...verification, audience: 'other-app', introspect })(value)).rejects.toThrow('audience');
  await expect(createLiveCapabilityTicketVerifier({ ...verification, issuer: 'https://other-authority', introspect })(value)).rejects.toThrow('issuer');
  expect(introspect).not.toHaveBeenCalled();
});

it('rechecks expiry after the live response and rejects legacy or tampered proof before introspection', async () => {
  jest.useFakeTimers();
  try {
    const value = ticket();
    const claims = verifyCapabilityTicket(value, verification);
    const introspect = jest.fn(async () => {
      jest.setSystemTime(new Date((claims.exp + 1) * 1000));
      return { active: true, claims };
    });
    const verify = createLiveCapabilityTicketVerifier({ ...verification, introspect });
    await expect(verify(value)).rejects.toThrow('expired');
    introspect.mockClear();
    const { catalog: _catalog, ...legacy } = terms;
    const old = issueCapabilityTicket(legacy, { privateKey: keys.privateKey, keyId: 'key', issuer: verification.issuer });
    await expect(verify(old)).rejects.toThrow('catalogue binding');
    await expect(verify(`${old.slice(0, -2)}aa`)).rejects.toThrow();
    expect(introspect).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
