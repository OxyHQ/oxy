import { generateKeyPairSync, verify } from 'node:crypto';
import {
  HttpKaanaCredentialControl,
  KaanaCredentialConflictError,
  ProviderCredentialValue,
  kaanaCredentialControlSigningInput,
} from '../kaanaCredentialControl';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const config = {
  baseUrl: 'https://kaana.ai' as const,
  keyId: 'control-1',
  privateKey,
};
const identity = {
  provider: 'openai',
  ownerAccountId: 'acc_1',
  connectionId: 'conn_1',
  environment: 'production' as const,
};

afterEach(() => jest.restoreAllMocks());

describe('HttpKaanaCredentialControl', () => {
  it('signs the exact body in the dedicated domain and derives operationActor from the actor', async () => {
    let request: RequestInit | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      request = init;
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          credentialHandle: `kcred_${'a'.repeat(26)}`,
          revision: 1,
        }),
        { status: 201 },
      );
    });

    await new HttpKaanaCredentialControl(config).create({
      ...identity,
      secret: new ProviderCredentialValue('customer-provider-key'),
      actor: { kind: 'user', userId: 'user_1' },
    });

    const body = request?.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    const bytes = body as Buffer;
    const decoded = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(decoded.operationActor).toBe('user:user_1');
    expect(decoded.actor).toBeUndefined();
    expect(decoded.secretBase64).toBe(
      Buffer.from('customer-provider-key', 'utf8').toString('base64'),
    );

    const headers = request?.headers as Record<string, string>;
    const timestamp = Number(headers['X-Oxy-Kaana-Timestamp']);
    const signature = Buffer.from(headers['X-Oxy-Kaana-Signature'].slice(3), 'base64');
    expect(
      verify(
        null,
        kaanaCredentialControlSigningInput(config.keyId, timestamp, bytes),
        publicKey,
        signature,
      ),
    ).toBe(true);
  });

  it('treats an exact create conflict reference as idempotent recovery', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          credentialHandle: `kcred_${'b'.repeat(26)}`,
          revision: 1,
        }),
        { status: 409 },
      ),
    );
    await expect(
      new HttpKaanaCredentialControl(config).create({
        ...identity,
        secret: new ProviderCredentialValue('customer-provider-key'),
        actor: { kind: 'platform' },
      }),
    ).resolves.toEqual({
      credentialHandle: `kcred_${'b'.repeat(26)}`,
      revision: 1,
    });
  });

  it('fails closed on a rotate revision conflict', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'credential_conflict' }), {
        status: 409,
      }),
    );
    await expect(
      new HttpKaanaCredentialControl(config).rotate({
        ...identity,
        credentialHandle: `kcred_${'c'.repeat(26)}`,
        revision: 1,
        secret: new ProviderCredentialValue('new-customer-provider-key'),
        actor: { kind: 'platform' },
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialConflictError);
  });

  it('redacts the plaintext in every implicit serializer', () => {
    const secret = new ProviderCredentialValue('customer-provider-key');
    expect(String(secret)).not.toContain(secret.reveal());
    expect(JSON.stringify(secret)).not.toContain(secret.reveal());
  });

  it("enforces Kaana's 4096-byte UTF-8 bound, not JavaScript character count", () => {
    expect(() => new ProviderCredentialValue('é'.repeat(2048))).not.toThrow();
    expect(() => new ProviderCredentialValue('é'.repeat(2049))).toThrow(/4096 bytes/);
  });

  it('stops reading a response once the 16 KiB cap is crossed', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(oversized, { status: 503 }));
    await expect(
      new HttpKaanaCredentialControl(config).create({
        ...identity,
        secret: new ProviderCredentialValue('customer-provider-key'),
        actor: { kind: 'platform' },
      }),
    ).rejects.toThrow(/response exceeded/);
  });
});
