/**
 * The Alia proxy router — the interim first-party gate on EVERY route it serves
 * (`/chat/completions` from #981; `/voice/token` and `/voice/transcribe` from
 * #972 workstream 2.3), and the proxy's own error shaping.
 *
 * The gate runs against a REAL Postgres and REAL service JWTs rather than a
 * stubbed application row, because everything it decides is a registry fact:
 * whether the credential the token names still exists, whether it is still
 * usable, and whether the application it belongs to is still active and still
 * platform-trusted. A stubbed row would let all three drift from what the
 * service-token mint and the CORS registry read.
 *
 * Every refusal case asserts BOTH the refusal and that `axios.post` was never
 * called — a gate that refuses after spending the upstream budget would satisfy
 * a status-code assertion and none of the issue.
 */

import express from 'express';
import http, { IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import axios from 'axios';

jest.mock('axios');

// `jest.setup.cjs` stubs `jsonwebtoken` globally (verify → a fixed user-session
// payload). This suite mints REAL service tokens and the gate's whole job is to
// tell a service token from a user one, so restore the real module.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { logger } from '../../utils/logger';

// Read at module load by `routes/alia.ts`, so it must be set before the router
// is imported below.
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';
process.env.ALIA_API_KEY = 'test-alia-key';

import aliaRouter from '../alia';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedLogger = logger as jest.Mocked<typeof logger>;

interface RawResponse {
  status: number;
  body: string;
}

let server: http.Server;

const request = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> => {
  const { port } = server.address() as AddressInfo;
  const payload = JSON.stringify(body);

  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );

    req.on('error', reject);
    req.end(payload);
  });
};

interface ServiceCaller {
  token: string;
  applicationId: string;
  credentialId: string;
  appName: string;
}

/**
 * A real application + service credential + a real service JWT for it.
 *
 * The defaults describe the ALLOWED caller — an internal, platform-trusted
 * application with an active service credential. Each refusal case overrides
 * exactly one field, so what it proves is that field and not a broken fixture.
 */
async function serviceCaller(
  appFields: Partial<typeof applications.$inferInsert> = {},
  credentialFields: Partial<typeof applicationCredentials.$inferInsert> = {},
): Promise<ServiceCaller> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const appName = `App ${randomUUID()}`;
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: appName,
      type: 'internal',
      isInternal: true,
      scopes: ['user:read'],
      ...appFields,
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });

  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'service',
      type: 'service',
      environment: 'production',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      secretHash: 'unused-by-this-route',
      ...credentialFields,
    })
    .returning({ id: applicationCredentials.id });

  return {
    token: mintServiceToken({
      appId: app.id,
      appName,
      credentialId: credential.id,
      ownerAccountId: owner.id,
    }),
    applicationId: app.id,
    credentialId: credential.id,
    appName,
  };
}

/** A service JWT with exactly the claims `POST /auth/service-token` mints. */
function mintServiceToken(claims: {
  appId: string;
  appName: string;
  credentialId: string;
  /**
   * The owning account (ADR 0007). REQUIRED by `verifyServiceToken`, so a
   * fixture without it is not a service token at all — the positive controls
   * below would quietly become second negatives.
   */
  ownerAccountId: string;
}): string {
  return jwt.sign(
    {
      type: 'service',
      appId: claims.appId,
      appName: claims.appName,
      credentialId: claims.credentialId,
      ownerAccountId: claims.ownerAccountId,
      scopes: ['user:read'],
      environment: 'production',
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h', issuer: 'oxy-auth', audience: 'oxy-api' },
  );
}

/** A user SESSION access token — the credential every signed-in Oxy client holds. */
function mintUserSessionToken(): string {
  return jwt.sign(
    {
      type: 'access',
      userId: randomUUID(),
      sessionId: randomUUID(),
      deviceId: randomUUID(),
      sid: randomUUID(),
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '15m' },
  );
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const CHAT_BODY = { model: 'alia-v1', messages: [{ role: 'user', content: 'hi' }] };

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  // BOTH mounts, exactly as `server.ts` registers them: the gate lives on the
  // router, so a fix that only covered one of them would show up here.
  app.use('/v1', aliaRouter);
  app.use('/alia', aliaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` clears CALLS but not queued `mockResolvedValueOnce`
  // implementations. A test whose request is refused before reaching axios
  // therefore leaves its queued value behind for the NEXT test to consume, which
  // is how gating the voice routes turned one failure into two: the second test
  // ate the first's leftover and reported an unrelated status. `mockReset` drains
  // the queue; nothing here relies on a persistent implementation.
  mockedAxios.post.mockReset();
});

describe('POST /v1/chat/completions — first-party inference gate (#981)', () => {
  it('ALLOWS a caller acting for a platform-trusted application (positive control)', async () => {
    const caller = await serviceCaller();
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'cmpl-1', choices: [] } });

    const response = await request('/v1/chat/completions', CHAT_BODY, bearer(caller.token));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ id: 'cmpl-1', choices: [] });
    // The upstream call carries the SERVER key, never the caller's bearer.
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.alia.onl/v1/chat/completions',
      CHAT_BODY,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-alia-key' }),
      }),
    );
  });

  it('allows a first_party application that is not flagged internal', async () => {
    const caller = await serviceCaller({ type: 'first_party', isInternal: false });
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'cmpl-2', choices: [] } });

    const response = await request('/v1/chat/completions', CHAT_BODY, bearer(caller.token));

    expect(response.status).toBe(200);
  });

  it('REFUSES a third-party caller, even though its application is active', async () => {
    const caller = await serviceCaller({
      type: 'third_party',
      isInternal: false,
      isOfficial: false,
    });

    const response = await request('/v1/chat/completions', CHAT_BODY, bearer(caller.token));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ENDPOINT_NOT_PUBLIC',
      message: 'This endpoint is not publicly available.',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();

    // The refusal names no application, and the detail reaches the log instead.
    expect(response.body).not.toContain(caller.appName);
    expect(response.body).not.toContain(caller.applicationId);
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'inference.gate.refused',
      expect.objectContaining({
        reason: 'untrusted_application',
        applicationId: caller.applicationId,
      }),
    );
  });

  it('REFUSES a caller whose application cannot be resolved — fails closed', async () => {
    // A perfectly valid, correctly signed service token naming a credential row
    // that does not exist. Nothing about the TOKEN is wrong; the registry simply
    // cannot complete the credential → application chain.
    //
    // That this is a refusal by the gate and not a broken fixture is what the
    // positive control above establishes: the same `mintServiceToken` claims, the
    // same request path and the same body return 200 when the credential row is
    // present.
    const token = mintServiceToken({
      appId: randomUUID(),
      appName: 'Ghost',
      credentialId: randomUUID(),
      ownerAccountId: randomUUID(),
    });

    const response = await request('/v1/chat/completions', CHAT_BODY, bearer(token));

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ENDPOINT_NOT_PUBLIC',
      message: 'This endpoint is not publicly available.',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'inference.gate.refused',
      expect.objectContaining({ reason: 'unresolvable_credential' }),
    );
  });

  it('REFUSES an ordinary user session bearer', async () => {
    const response = await request(
      '/v1/chat/completions',
      CHAT_BODY,
      bearer(mintUserSessionToken()),
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ENDPOINT_NOT_PUBLIC',
      message: 'This endpoint is not publicly available.',
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('REFUSES a request with no bearer at all', async () => {
    const response = await request('/v1/chat/completions', CHAT_BODY);

    expect(response.status).toBe(401);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('REFUSES a service token whose credential has since been revoked', async () => {
    const caller = await serviceCaller();
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, caller.credentialId));

    const response = await request('/v1/chat/completions', CHAT_BODY, bearer(caller.token));

    expect(response.status).toBe(403);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('REFUSES a trusted application that has since been suspended', async () => {
    const caller = await serviceCaller();
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, caller.applicationId));

    const response = await request('/v1/chat/completions', CHAT_BODY, bearer(caller.token));

    expect(response.status).toBe(403);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('applies the same gate on the /alia compatibility mount', async () => {
    const response = await request(
      '/alia/chat/completions',
      CHAT_BODY,
      bearer(mintUserSessionToken()),
    );

    expect(response.status).toBe(403);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

/**
 * The voice routes carry the SAME gate as chat since #972 workstream 2.3.
 *
 * #981 left them on `authMiddleware` alone, reasoning that Oxy's own voice
 * surfaces reached them with a user session and no service credential. A
 * read-only census across every repository under `~/Oxy` found no caller of
 * either route at all — Inbox's voice feature calls `https://api.alia.onl`
 * directly through the installed `@alia.onl/sdk`, never this proxy — so the
 * exemption was protecting nothing while leaving one shared upstream key
 * spendable by any signed-in user.
 *
 * These cases are the refusals that exemption used to allow. They matter more
 * than the positive control below: the positive control would still pass if the
 * gate were removed.
 */
describe('voice routes — the same first-party gate (#972 w2.3)', () => {
  it('REFUSES a voice token request with no bearer at all', async () => {
    const response = await request('/v1/voice/token', { model: 'alia-v1-voice' });

    expect(response.status).toBe(401);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('REFUSES a voice token request carrying an ordinary user session bearer', async () => {
    const response = await request(
      '/v1/voice/token',
      { model: 'alia-v1-voice' },
      bearer(mintUserSessionToken()),
    );

    expect(response.status).toBe(403);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('REFUSES a transcribe request carrying an ordinary user session bearer', async () => {
    const response = await request(
      '/v1/voice/transcribe',
      { audio: 'AAAA' },
      bearer(mintUserSessionToken()),
    );

    expect(response.status).toBe(403);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('REFUSES a third-party caller whose application is active but untrusted', async () => {
    const caller = await serviceCaller({
      type: 'third_party',
      isInternal: false,
      isOfficial: false,
    });

    const response = await request(
      '/v1/voice/transcribe',
      { audio: 'AAAA' },
      bearer(caller.token),
    );

    expect(response.status).toBe(403);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('Alia proxy — upstream error shaping', () => {
  it('proxies voice token requests to the Alia API with the server key', async () => {
    const caller = await serviceCaller();
    mockedAxios.post.mockResolvedValueOnce({
      data: { token: 'lk-token', url: 'wss://livekit.example', roomName: 'room', sessionId: 'sess' },
    });

    const response = await request(
      '/v1/voice/token',
      { model: 'alia-v1-voice', voice: 'nova' },
      bearer(caller.token),
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.alia.onl/v1/voice/token',
      { model: 'alia-v1-voice', voice: 'nova' },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-alia-key' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      token: 'lk-token',
      url: 'wss://livekit.example',
      roomName: 'room',
      sessionId: 'sess',
    });
  });

  it('returns a safe JSON error when an upstream streaming request fails with a stream body', async () => {
    const caller = await serviceCaller();
    const streamBody = new IncomingMessage(null as never);

    mockedAxios.post.mockRejectedValueOnce({ response: { status: 400, data: streamBody } });

    const response = await request(
      '/alia/chat/completions',
      { stream: true, model: 'invalid' },
      bearer(caller.token),
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.alia.onl/v1/chat/completions',
      { stream: true, model: 'invalid' },
      expect.objectContaining({ responseType: 'stream' }),
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ALIA_PROXY_ERROR',
      message: 'Failed to reach Alia API',
    });
  });
});
