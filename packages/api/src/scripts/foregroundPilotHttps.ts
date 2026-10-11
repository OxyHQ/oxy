import type { AppCapabilityCatalog } from '@oxy.so/contracts';
/** Only the canonical Oxy origin receives the ephemeral registrar credential. */
import { z } from 'zod';

const ORIGIN = 'https://api.oxy.so';
const MAX_BYTES = 64 * 1024;
const MAX_WAIT_MS = 10_000;
const tokenResponse = z.object({
  data: z.object({
    token: z.string().min(1).max(16_384),
    expiresIn: z.number().int().positive().max(300),
    appName: z.string(),
  }),
});

export class ForegroundPilotHttps {
  constructor(private readonly transport: typeof fetch = fetch) {}

  private async post(
    path: '/auth/service-token' | '/capabilities/catalogs/register',
    body: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new Error('I05 HTTPS cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MAX_WAIT_MS);
    try {
      const response = await this.transport(`${ORIGIN}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== `${ORIGIN}${path}`)
      ) {
        throw new Error('I05 canonical HTTPS response rejected');
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
        throw new Error('I05 HTTPS response exceeds bound');
      if (!response.body) throw new Error('I05 HTTPS response absent');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BYTES) throw new Error('I05 HTTPS response exceeds bound');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      if (controller.signal.aborted) throw new Error('I05 HTTPS cancelled');
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      // Never expose response bodies, fetch diagnostics, bearer, API key or secret.
      throw new Error('I05 canonical HTTPS operation failed; reconcile persisted intent');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async mint(credential: { publicKey: string; secret: string }, signal?: AbortSignal) {
    return tokenResponse.parse(
      await this.post(
        '/auth/service-token',
        {
          apiKey: credential.publicKey,
          apiSecret: credential.secret,
        },
        undefined,
        signal,
      ),
    ).data.token;
  }

  async register(catalog: AppCapabilityCatalog, token: string, signal?: AbortSignal) {
    if (catalog.appId !== 'oxy' || catalog.internalBaseUrl !== ORIGIN)
      throw new Error('I05 catalogue canonical origin mismatch');
    await this.post('/capabilities/catalogs/register', { catalog }, token, signal);
    // The HTTP DTO is not authority: the executor separately reads SQL identity/digest.
  }
}
