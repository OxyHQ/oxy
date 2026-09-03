import { generateKeyPairSync, verify } from 'node:crypto';
import {
  HttpKaanaCredentialValidationDispatcher,
  KaanaCredentialValidationUnavailableError,
  kaanaCredentialValidationSigningInput,
  requireKaanaCredentialValidationDispatcher,
} from '../kaanaCredentialValidation';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const config = {
  baseUrl: 'https://kaana.ai' as const,
  keyId: 'validation-key',
  privateKey,
};
const kaanaEnvironment = [
  'KAANA_BASE_URL',
  'KAANA_EDGE_SIGNING_KEY_ID',
  'KAANA_EDGE_SIGNING_PRIVATE_KEY',
] as const;
const originalKaanaEnvironment = Object.fromEntries(
  kaanaEnvironment.map((name) => [name, process.env[name]]),
);
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

afterEach(() => {
  jest.restoreAllMocks();
  for (const name of kaanaEnvironment) {
    const value = originalKaanaEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Kaana credential validation dispatcher', () => {
  it('fails closed without the complete signing configuration and constructs only from the exact canonical one', () => {
    for (const name of kaanaEnvironment) delete process.env[name];

    expect(() => requireKaanaCredentialValidationDispatcher()).toThrow(
      KaanaCredentialValidationUnavailableError,
    );

    process.env.KAANA_BASE_URL = config.baseUrl;
    process.env.KAANA_EDGE_SIGNING_KEY_ID = config.keyId;
    process.env.KAANA_EDGE_SIGNING_PRIVATE_KEY = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    expect(requireKaanaCredentialValidationDispatcher()).toBeInstanceOf(
      HttpKaanaCredentialValidationDispatcher,
    );
  });

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
