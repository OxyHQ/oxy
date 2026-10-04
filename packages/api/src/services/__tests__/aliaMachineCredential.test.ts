import { introspectAliaMachineCredential } from '../aliaMachineCredential.service';
import { OXY_ALIA_RESOURCE_APPLICATION_ID } from '@oxy.so/core/server';
import type { MachineCredentialResolution } from '../../middleware/machineCredential';

const principal = {
  applicationId: 'caller-app', credentialId: 'caller-credential', applicationName: 'Caller',
  ownerAccountId: 'payer-account', environment: 'production' as const,
  scopes: ['alia:chat', 'inference:invoke', 'user:read'] as ('alia:chat' | 'inference:invoke' | 'user:read')[],
};
describe('canonical Alia resource introspection', () => {
  const resolve = jest.fn<Promise<MachineCredentialResolution>, [string]>();
  beforeEach(() => { resolve.mockReset(); resolve.mockResolvedValue({ ok: true, principal }); });
  it('never resolves a key for a different receiving application', async () => {
    expect(await introspectAliaMachineCredential('other-trusted-service', 'secret', resolve)).toEqual({ active: false });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('returns narrowed machine metadata, not a user or trusted-service principal', async () => {
    const result = await introspectAliaMachineCredential(OXY_ALIA_RESOURCE_APPLICATION_ID, 'secret', resolve);
    expect(result).toEqual({ active: true, principal: {
      kind: 'machine', audience: OXY_ALIA_RESOURCE_APPLICATION_ID, applicationId: 'caller-app',
      credentialId: 'caller-credential', ownerAccountId: 'payer-account', environment: 'production',
      scopes: ['alia:chat', 'inference:invoke'],
    } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each([{ scopes: ['inference:invoke'] }, { scopes: ['alia:chat'] }, { scopes: [] }] as const)('does not infer missing capability from %j', async ({ scopes }) => {
    resolve.mockResolvedValueOnce({ ok: true, principal: { ...principal, scopes: [...scopes] } });
    expect(await introspectAliaMachineCredential(OXY_ALIA_RESOURCE_APPLICATION_ID, 'secret', resolve)).toEqual({ active: false });
  });
  it.each(['unknown_credential', 'revoked', 'expired', 'environment_mismatch'] as const)('does not disclose credential refusal %s', async reason => {
    resolve.mockResolvedValueOnce({ ok: false, reason } as MachineCredentialResolution);
    expect(await introspectAliaMachineCredential(OXY_ALIA_RESOURCE_APPLICATION_ID, 'secret', resolve)).toEqual({ active: false });
  });
});
