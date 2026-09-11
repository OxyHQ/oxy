/**
 * `POST /assets/service/linked-url` — the ONE route by which a service token
 * reaches file BYTES.
 *
 * ## What is actually being guarded
 *
 * The route's authorization is a single predicate — "a `file_links` row whose
 * `app` is the caller's and whose `created_by` is the file's `owner_user_id`" —
 * and every plausible weaker spelling of it is an escalation, so each one is
 * refused here by its own case:
 *
 *   - "the caller holds a service token"   → every case below holds one.
 *   - "a link for this app exists"          → `linkedByAnotherUser`.
 *     THIS IS THE REAL ATTACK. `assetService.linkFile` performs no ownership
 *     check, so any authenticated user can link any file id they can name into
 *     any app. Under a bare link test, an attacker with any account turns this
 *     route into "read any file whose id you can guess".
 *   - "the file is linked somewhere"        → `linkedToAnotherApp`.
 *   - "the file is readable in Oxy"         → `systemOwned` (a federation cache
 *     entry has no owner who could have consented).
 *
 * ## Absence is the only refusal, and that is deliberate
 *
 * A refused id is OMITTED. There is no placeholder, no empty string, no 403 for
 * the batch, so a caller cannot distinguish "no such file" from "not yours" —
 * which is why every negative case below asserts the same observable
 * (`ids` absent from `data`) rather than a distinct error, and why each is
 * checked ALONGSIDE an authorized id in the same request. A response of `[]` is
 * satisfied by a broken route that returns nothing; a response carrying the
 * authorized id and not the refused one is not.
 *
 * The asset service, the S3 client, both auth middlewares and the rate limiter
 * are stubbed at the module boundary, so the router is exercised over real
 * `node:http` round-trips with no S3 and no database.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const OWNER_ID = '64a0000000000000000000a1';
const ATTACKER_ID = '64a0000000000000000000a2';
const CALLER_APP = 'mercaria';
const OTHER_APP = 'mention';

const mockServiceAuthMiddleware = jest.fn();
const mockAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockOptionalAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockGetFilesByIds = jest.fn();
const mockGetPresignedDownloadUrl = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));

jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (...args: unknown[]) => mockOptionalAuthMiddleware(...args),
  getUserId: () => undefined,
  getMediaViewerUserId: () => undefined,
}));

jest.mock('../../middleware/mediaHeaders', () => ({
  mediaHeadersMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/placeholders', () => ({
  generateMissingFilePlaceholder: () => '<svg/>',
  TRANSPARENT_PNG_PLACEHOLDER: '',
}));

const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../utils/logger', () => ({ logger: mockLogger }));

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFilesByIds: (...args: unknown[]) => mockGetFilesByIds(...args),
    findActiveFilesBySha256: jest.fn(),
    getPublicCdnUrl: jest.fn(),
  },
}));

jest.mock('../../services/s3ServiceSingleton', () => ({
  s3Service: {
    getPresignedDownloadUrl: (...args: unknown[]) => mockGetPresignedDownloadUrl(...args),
  },
}));

import assetsRouter from '../assets';
import { errorHandler } from '../../middleware/errorHandler';

interface TestLink {
  app: string;
  entityType: string;
  entityId: string;
  createdBy: string;
}

interface LinkedUrlEntry {
  id: string;
  url: string;
  expiresIn: number;
  mime: string;
  size: number;
  sha256: string;
}

/**
 * A file row as `getFilesByIds` returns it — every field the route could
 * possibly read, so a case cannot pass because the fixture happened to omit the
 * field that would have admitted it.
 */
function fileRow(
  id: string,
  options: { ownerUserId: string | null; links: TestLink[]; status?: string },
) {
  return {
    id,
    sha256: `sha-${id}`,
    mime: 'model/stl',
    size: 4096,
    status: options.status ?? 'active',
    visibility: 'private',
    ownerUserId: options.ownerUserId,
    systemOwner: options.ownerUserId === null ? '__federation__' : null,
    storageKey: `private/${id}.stl`,
    originalName: `${id}.stl`,
    links: options.links,
    variants: [],
  };
}

/** The one shape that must be admitted: the owner linked it to the caller. */
function ownerLinked(id: string) {
  return fileRow(id, {
    ownerUserId: OWNER_ID,
    links: [{ app: CALLER_APP, entityType: 'asset_file', entityId: 'av_1', createdBy: OWNER_ID }],
  });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/assets', assetsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  // The default caller: a real service token for the calling app, holding the
  // scope. Every negative case below therefore fails on the LINK, never on
  // authentication — which is the only way the link predicate is what is
  // being measured.
  mockServiceAuthMiddleware.mockImplementation(
    (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
      req.serviceApp = { appId: CALLER_APP, scopes: ['files:linked:read'] };
      next();
    },
  );
  mockGetPresignedDownloadUrl.mockImplementation(
    async (key: string) => `https://s3.example/${key}?X-Amz-Signature=deadbeef`,
  );
});

async function postLinkedUrl(ids: string[]): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/assets/service/linked-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** The ids present in a 200 response, so every case asserts on one vocabulary. */
function resolvedIds(body: { data?: LinkedUrlEntry[] }): string[] {
  return (body.data ?? []).map((entry) => entry.id);
}

describe('POST /assets/service/linked-url — what it admits', () => {
  it('mints a URL for a file the OWNER linked to the calling app', async () => {
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    const { status, body } = await postLinkedUrl(['f_ok']);

    expect(status).toBe(200);
    expect(resolvedIds(body)).toEqual(['f_ok']);
    // The URL comes from the STORAGE KEY, not from the id: a route that built a
    // public CDN URL from the id would 404 on every private deliverable.
    expect(mockGetPresignedDownloadUrl).toHaveBeenCalledWith('private/f_ok.stl', 300);
    expect(body.data[0].url).toContain('X-Amz-Signature');
    expect(body.data[0].expiresIn).toBe(300);
  });

  it('returns the metadata a downloader needs and NOTHING that is storage detail', async () => {
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    const { body } = await postLinkedUrl(['f_ok']);

    // Asserted as an exact key set, not by containment: containment goes green
    // when a field is ADDED, which is the direction that leaks. `storageKey`,
    // `ownerUserId`, `links` and `visibility` are all on the row the handler
    // read and none of them is the caller's business.
    expect(Object.keys(body.data[0]).sort()).toEqual(
      ['expiresIn', 'id', 'mime', 'sha256', 'size', 'url'].sort(),
    );
  });
});

describe('POST /assets/service/linked-url — what it refuses, and how', () => {
  /**
   * Every refusal case, each paired with an authorized id in the SAME request.
   *
   * The pairing is the control. `expect(resolvedIds).toEqual([])` would pass
   * against a route that resolved nothing at all; `toEqual(['f_ok'])` can only
   * pass if the route is working AND refused the other id.
   */
  const cases: Array<{ name: string; row: ReturnType<typeof fileRow>; why: string }> = [
    {
      name: 'linkedByAnotherUser',
      why:
        'THE ATTACK: `linkFile` checks no ownership, so an attacker links a '
        + 'stranger\'s file into this app and asks for its bytes.',
      row: fileRow('f_attack', {
        ownerUserId: OWNER_ID,
        links: [
          { app: CALLER_APP, entityType: 'asset_file', entityId: 'av_x', createdBy: ATTACKER_ID },
        ],
      }),
    },
    {
      name: 'linkedToAnotherApp',
      why: 'the owner consented to a DIFFERENT application, not to this one',
      row: fileRow('f_otherapp', {
        ownerUserId: OWNER_ID,
        links: [{ app: OTHER_APP, entityType: 'avatar', entityId: 'u_1', createdBy: OWNER_ID }],
      }),
    },
    {
      name: 'notLinkedAtAll',
      why: 'a file the owner never attached anywhere',
      row: fileRow('f_unlinked', { ownerUserId: OWNER_ID, links: [] }),
    },
    {
      name: 'systemOwned',
      why:
        'a federation-cache entry has no owner, so nobody could have consented; '
        + '`created_by` is NOT NULL so no link can ever match a NULL owner',
      row: fileRow('f_system', {
        ownerUserId: null,
        links: [
          { app: CALLER_APP, entityType: 'asset_file', entityId: 'av_y', createdBy: ATTACKER_ID },
        ],
      }),
    },
    {
      name: 'deletedTombstone',
      why: 'the bytes are gone; a presigned URL for them is a 404 with a signature on it',
      row: fileRow('f_deleted', {
        ownerUserId: OWNER_ID,
        status: 'deleted',
        links: [
          { app: CALLER_APP, entityType: 'asset_file', entityId: 'av_z', createdBy: OWNER_ID },
        ],
      }),
    },
  ];

  it.each(cases)('omits $name — $why', async ({ row }) => {
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok'), row]);

    const { status, body } = await postLinkedUrl(['f_ok', row.id]);

    expect(status).toBe(200);
    expect(resolvedIds(body)).toEqual(['f_ok']);
    // No URL was minted for the refused id — the refusal happens BEFORE the S3
    // call, so a signed URL never exists even transiently.
    expect(mockGetPresignedDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it('omits an id no row came back for, without failing the batch', async () => {
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    const { status, body } = await postLinkedUrl(['f_ok', 'f_nonexistent']);

    expect(status).toBe(200);
    expect(resolvedIds(body)).toEqual(['f_ok']);
  });

  it('gives a SECOND app nothing for the same file, on the same link', async () => {
    // The app identity comes off the TOKEN, never off the request, so the same
    // stored link admits one caller and not another. A route that read an `app`
    // from the body would pass every case above and fail this one.
    mockServiceAuthMiddleware.mockImplementation(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = { appId: OTHER_APP, scopes: ['files:linked:read'] };
        next();
      },
    );
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    const { status, body } = await postLinkedUrl(['f_ok']);

    expect(status).toBe(200);
    expect(resolvedIds(body)).toEqual([]);
    expect(mockGetPresignedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('POST /assets/service/linked-url — the scope', () => {
  it('refuses a service token WITHOUT files:linked:read', async () => {
    mockServiceAuthMiddleware.mockImplementation(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = { appId: CALLER_APP, scopes: [] };
        next();
      },
    );
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    const { status } = await postLinkedUrl(['f_ok']);

    expect(status).toBe(403);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });

  it('refuses a token holding files:read, which does NOT imply this scope', async () => {
    // The whole reason for a separate vocabulary entry. `files:read` is
    // metadata-only; if it reached this route, byte access would have been
    // handed to every application already holding it, silently.
    mockServiceAuthMiddleware.mockImplementation(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = { appId: CALLER_APP, scopes: ['files:read', 'files:write'] };
        next();
      },
    );
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    const { status } = await postLinkedUrl(['f_ok']);

    expect(status).toBe(403);
  });

  it('refuses a token carrying no application identity at all', async () => {
    // Defence in depth for a middleware shape change: an absent appId must not
    // reach the link comparison.
    mockServiceAuthMiddleware.mockImplementation(
      (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
        req.serviceApp = { scopes: ['files:linked:read'] };
        next();
      },
    );

    const { status } = await postLinkedUrl(['f_ok']);

    expect(status).toBe(403);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });
});

describe('POST /assets/service/linked-url — the batch bound', () => {
  it('accepts 25 ids', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `f_${index}`);
    mockGetFilesByIds.mockResolvedValue(ids.map((id) => ownerLinked(id)));

    const { status, body } = await postLinkedUrl(ids);

    expect(status).toBe(200);
    expect(resolvedIds(body)).toHaveLength(25);
  });

  it('refuses 26', async () => {
    const { status } = await postLinkedUrl(Array.from({ length: 26 }, (_, i) => `f_${i}`));

    expect(status).toBe(400);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
  });

  it('refuses an empty batch', async () => {
    const { status } = await postLinkedUrl([]);

    expect(status).toBe(400);
  });
});

describe('POST /assets/service/linked-url — the minted URL is a credential', () => {
  it('never writes a URL or a file id into a log line', async () => {
    mockGetFilesByIds.mockResolvedValue([ownerLinked('f_ok')]);

    await postLinkedUrl(['f_ok']);

    const logged = JSON.stringify([
      mockLogger.debug.mock.calls,
      mockLogger.info.mock.calls,
      mockLogger.warn.mock.calls,
      mockLogger.error.mock.calls,
    ]);
    // Vacuity floor: the route DID log, so the two assertions below are reading
    // real log lines rather than an empty array.
    expect(mockLogger.debug).toHaveBeenCalled();
    expect(logged).not.toContain('X-Amz-Signature');
    expect(logged).not.toContain('private/f_ok.stl');
  });
});
