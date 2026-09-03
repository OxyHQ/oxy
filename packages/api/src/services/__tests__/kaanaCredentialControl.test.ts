import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HttpKaanaCredentialControl,
  KaanaCredentialConflictError,
  KaanaCredentialOutcomeUnavailableError,
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
const operationActor = 'user:user_1';
const handle = `kcred_${'a'.repeat(26)}`;

function applied(operationId: string, action: 'create' | 'rotate' | 'revoke', revision: number) {
  return {
    schemaVersion: 1,
    operationId,
    action,
    status: 'applied',
    credentialHandle: handle,
    revision,
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(() => jest.restoreAllMocks());

describe('HttpKaanaCredentialControl', () => {
  it('signs the exact mutation body and sends the persisted operation identity', async () => {
    let requestBody: Buffer | undefined;
    let requestHeaders: Record<string, string> | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (!Buffer.isBuffer(init?.body)) throw new Error('expected a buffer request body');
      requestBody = Buffer.from(init.body);
      requestHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify(applied('op_create_1', 'create', 1)), { status: 201 });
    });

    const secret = new ProviderCredentialValue('customer-provider-key');
    await new HttpKaanaCredentialControl(config).create({
      ...identity,
      operationId: 'op_create_1',
      operationActor,
      secret,
    });

    if (requestBody === undefined || requestHeaders === undefined) {
      throw new Error('signed request was not captured');
    }
    const decoded = JSON.parse(requestBody.toString('utf8')) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      schemaVersion: 1,
      operationId: 'op_create_1',
      action: 'create',
      ...identity,
      operationActor,
      secretBase64: Buffer.from('customer-provider-key', 'utf8').toString('base64'),
    });
    expect(decoded.actor).toBeUndefined();

    const timestamp = Number(requestHeaders['X-Oxy-Kaana-Timestamp']);
    const signature = Buffer.from(requestHeaders['X-Oxy-Kaana-Signature'].slice(3), 'base64');
    expect(
      verify(
        null,
        kaanaCredentialControlSigningInput(config.keyId, timestamp, requestBody),
        publicKey,
        signature,
      ),
    ).toBe(true);
  });

  it('uses the signed outcome route with the same id after a lost mutation response', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!Buffer.isBuffer(init?.body)) throw new Error('expected a buffer request body');
      const body = JSON.parse(init.body.toString('utf8')) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      if (requests.length === 1) throw new Error('response lost after Kaana committed');
      return new Response(JSON.stringify(applied('op_rotate_1', 'rotate', 2)), { status: 200 });
    });

    const secret = new ProviderCredentialValue('new-customer-provider-key');
    await expect(
      new HttpKaanaCredentialControl(config).rotate({
        ...identity,
        operationId: 'op_rotate_1',
        operationActor,
        credentialHandle: handle,
        expectedRevision: 1,
        secret,
      }),
    ).resolves.toEqual(applied('op_rotate_1', 'rotate', 2));

    expect(requests.map((request) => request.url)).toEqual([
      'https://kaana.ai/internal/v1/customer-provider-credentials/mutations',
      'https://kaana.ai/internal/v1/customer-provider-credentials/outcomes',
    ]);
    expect(requests[1]?.body).toEqual({
      schemaVersion: 1,
      operationId: 'op_rotate_1',
      action: 'rotate',
      ...identity,
      credentialHandle: handle,
      expectedRevision: 1,
    });
    expect(requests[1]?.body.operationActor).toBeUndefined();
    expect(requests[1]?.body.secretBase64).toBeUndefined();
  });

  it('never forwards a signed credential body or signature through a redirect', async () => {
    let redirectedRequests = 0;
    const receiver = createServer((request, response) => {
      request.resume();
      redirectedRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(applied('op_redirect', 'create', 1)));
    });
    const receiverUrl = await listen(receiver);
    let canonicalRequests = 0;
    const canonical = createServer((request, response) => {
      request.resume();
      canonicalRequests += 1;
      response.writeHead(307, { location: `${receiverUrl}/stolen` });
      response.end();
    });
    const canonicalUrl = await listen(canonical);

    try {
      const secret = new ProviderCredentialValue('customer-provider-key');
      await expect(
        new HttpKaanaCredentialControl({
          ...config,
          baseUrl: canonicalUrl as 'https://kaana.ai',
        }).create({
          ...identity,
          operationId: 'op_redirect',
          operationActor,
          secret,
        }),
      ).rejects.toBeInstanceOf(KaanaCredentialOutcomeUnavailableError);
      expect(canonicalRequests).toBe(2);
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([close(canonical), close(receiver)]);
    }
  });

  it('treats only an exact confirmed 409 as a manual conflict', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          operationId: 'op_revoke_1',
          action: 'revoke',
          status: 'conflict',
        }),
        { status: 409 },
      ),
    );
    await expect(
      new HttpKaanaCredentialControl(config).revoke({
        ...identity,
        operationId: 'op_revoke_1',
        operationActor: 'platform',
        credentialHandle: handle,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialConflictError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps 404 and network outcome lookups unresolved', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    await expect(
      new HttpKaanaCredentialControl(config).outcome({
        schemaVersion: 1,
        operationId: 'op_create_404',
        action: 'create',
        ...identity,
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialOutcomeUnavailableError);

    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));
    await expect(
      new HttpKaanaCredentialControl(config).outcome({
        schemaVersion: 1,
        operationId: 'op_create_network',
        action: 'create',
        ...identity,
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialOutcomeUnavailableError);
  });

  it('maps an exact signed 409 outcome to manual conflict', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          operationId: 'op_revoke_outcome_conflict',
          action: 'revoke',
          status: 'conflict',
        }),
        { status: 409 },
      ),
    );
    await expect(
      new HttpKaanaCredentialControl(config).outcome({
        schemaVersion: 1,
        operationId: 'op_revoke_outcome_conflict',
        action: 'revoke',
        ...identity,
        credentialHandle: handle,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialConflictError);
  });

  it('refuses a mismatched outcome instead of inferring success', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(applied('different_operation', 'rotate', 2)), { status: 200 }),
    );
    await expect(
      new HttpKaanaCredentialControl(config).outcome({
        schemaVersion: 1,
        operationId: 'op_rotate_expected',
        action: 'rotate',
        ...identity,
        credentialHandle: handle,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialOutcomeUnavailableError);
  });

  it('redacts plaintext and accepts only the header-safe credential subset', () => {
    const secret = new ProviderCredentialValue('customer-provider-key');
    expect(String(secret)).not.toContain(secret.reveal());
    expect(JSON.stringify(secret)).not.toContain(secret.reveal());
    expect(() => new ProviderCredentialValue('a'.repeat(4096))).not.toThrow();
    expect(() => new ProviderCredentialValue('a'.repeat(4097))).toThrow(/4096/);
    for (const invalid of ['valid\0tail', 'valid\ttail', ' customer-key ', 'credencial-ñ']) {
      expect(() => new ProviderCredentialValue(invalid)).toThrow(/visible ASCII/);
    }
  });

  it('bounds both mutation and reconciliation responses without exposing their bodies', async () => {
    const oversizedResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        { status: 503 },
      );
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => oversizedResponse());
    const secret = new ProviderCredentialValue('customer-provider-key');
    await expect(
      new HttpKaanaCredentialControl(config).create({
        ...identity,
        operationId: 'op_create_large',
        operationActor: 'platform',
        secret,
      }),
    ).rejects.toBeInstanceOf(KaanaCredentialOutcomeUnavailableError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
