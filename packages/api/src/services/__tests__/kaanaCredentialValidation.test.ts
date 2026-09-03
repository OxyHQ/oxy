import { generateKeyPairSync, verify } from 'node:crypto';
import {
  HttpKaanaCredentialValidationDispatcher,
  KaanaCredentialValidationUnavailableError,
  kaanaCredentialValidationSigningInput,
} from '../kaanaCredentialValidation';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const config = {
  baseUrl: 'https://kaana.ai' as const,
  keyId: 'validation-key',
  privateKey,
};
const task = {
  schemaVersion: 1 as const,
  operationId: 'operation_exact',
  applicationId: 'application_exact',
  provider: 'openai',
  ownerAccountId: 'account_exact',
  connectionId: 'connection_exact',
  environment: 'production' as const,
  credentialHandle: `kcred_${'a'.repeat(26)}`,
  credentialRevision: 3,
  deploymentId: 'kaana_deployment_exact',
};

afterEach(() => jest.restoreAllMocks());

describe('Kaana credential validation dispatcher', () => {
  it('uses a dedicated signature domain and binds every exact selector', async () => {
    let body: Buffer | undefined;
    let headers: Record<string, string> | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe(
        'https://kaana.ai/internal/v1/customer-provider-credentials/validations',
      );
      if (!Buffer.isBuffer(init?.body)) throw new Error('expected Buffer body');
      body = Buffer.from(init.body);
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ ...task, state: 'pending' }), {
        status: 202,
        headers: { 'cache-control': 'no-store' },
      });
    });

    await new HttpKaanaCredentialValidationDispatcher(config).dispatch(task);
    if (body === undefined || headers === undefined) throw new Error('request not captured');
    expect(JSON.parse(body.toString('utf8'))).toEqual(task);
    const timestamp = Number(headers['X-Oxy-Kaana-Timestamp']);
    const signature = Buffer.from(headers['X-Oxy-Kaana-Signature'].slice(3), 'base64');
    expect(
      verify(
        null,
        kaanaCredentialValidationSigningInput(config.keyId, timestamp, body),
        publicKey,
        signature,
      ),
    ).toBe(true);
  });

  it('refuses a successful-looking response rebound to another deployment', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ...task, deploymentId: 'kaana_other', state: 'valid' }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    );
    await expect(
      new HttpKaanaCredentialValidationDispatcher(config).dispatch(task),
    ).rejects.toBeInstanceOf(KaanaCredentialValidationUnavailableError);
  });
});
