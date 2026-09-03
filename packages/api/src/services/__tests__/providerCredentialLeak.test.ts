import { providerConnectionSchema } from '@oxyhq/contracts';
import { getTableColumns } from 'drizzle-orm';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { ProviderCredentialValue } from '../kaanaCredentialControl';
import { containsDeep } from '../secretLeakProbe';

describe('provider credential leak boundary', () => {
  it('has no plaintext, ciphertext, secret locator or provider-key column', () => {
    const columns = Object.keys(getTableColumns(inferenceProviderConnections));
    expect(columns).toEqual(
      expect.arrayContaining(['credentialHandle', 'credentialRevision', 'custodyState']),
    );
    for (const forbidden of [
      'secret',
      'secretRef',
      'apiKey',
      'ciphertext',
      'encryptedCredential',
      'providerKey',
      'keyPrefix',
      'fingerprint',
      'secretSha256',
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('redacts request-only plaintext from string, JSON and inspection', () => {
    const plaintext = 'customer-provider-credential';
    const wrapped = new ProviderCredentialValue(plaintext);
    expect(String(wrapped)).not.toContain(plaintext);
    expect(JSON.stringify({ wrapped })).not.toContain(plaintext);
    expect(containsDeep({ wrapped }, plaintext)).toBe(false);
  });

  it('keeps the public DTO strict against all credential-bearing fields', () => {
    const safe = {
      schemaVersion: 2,
      connectionId: 'conn_1',
      provider: 'openai',
      ownerAccountId: 'account_1',
      scope: { kind: 'account', accountId: 'account_1' },
      environment: 'production',
      status: 'active',
      custodyState: 'ready',
      credentialHandle: `kcred_${'a'.repeat(26)}`,
      credentialRevision: 1,
      validation: { state: 'valid' },
      upstreamBillsCustomerDirectly: true,
      createdAt: '2026-09-02T00:00:00.000Z',
    };
    expect(providerConnectionSchema.safeParse(safe).success).toBe(true);
    for (const extra of [
      { secret: 'credential' },
      { apiKey: 'credential' },
      { secretRef: 'vault:anything' },
      { keyPrefix: 'sk-prefix' },
      { fingerprint: 'digest' },
      { secretSha256: 'digest' },
      { ciphertext: 'encrypted' },
    ]) {
      expect(providerConnectionSchema.safeParse({ ...safe, ...extra }).success).toBe(false);
    }
  });
});
