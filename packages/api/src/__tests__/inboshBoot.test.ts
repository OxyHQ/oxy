/**
 * What the inbosh role starts at boot — and what it must not.
 *
 * `bootstrap()` of the real `server.ts`, role `inbosh`, against a real throwaway
 * database, with the starters observed. The email maintenance (the 60 s cron) and
 * the Inbox event outbox must run in exactly one service, so the inbosh service
 * starts neither by default; none of the platform's own schedules and workers may
 * start here at all, and the server must still listen once the gate is passed.
 */

jest.unmock('socket.io');

process.env.ACCESS_TOKEN_SECRET ??= 'inbosh-boot-access-token-secret-32-chars';
process.env.REFRESH_TOKEN_SECRET ??= 'inbosh-boot-refresh-token-secret-32-chars';
process.env.AWS_REGION ??= 'us-west-2';
process.env.AWS_ACCESS_KEY_ID ??= 'inbosh-boot';
process.env.AWS_SECRET_ACCESS_KEY ??= 'inbosh-boot';
process.env.R2_BUCKET ??= 'inbosh-boot';
process.env.OXY_API_ROLE = 'inbosh';
delete process.env.EMAIL_MAINTENANCE_ENABLED;
delete process.env.INBOX_EVENT_OUTBOX_WORKER_ENABLED;

jest.mock('../queue/backgroundJobs', () => ({
  startBackgroundJobs: jest.fn(async () => undefined),
  stopBackgroundJobs: jest.fn(async () => undefined),
}));
jest.mock('../services/followOutbox.worker', () => ({
  ...jest.requireActual('../services/followOutbox.worker'),
  startFollowOutboxWorker: jest.fn(),
}));
jest.mock('../services/kaanaCatalogueSync.service', () => ({
  ...jest.requireActual('../services/kaanaCatalogueSync.service'),
  startKaanaCatalogueSyncSchedule: jest.fn(),
}));
jest.mock('../services/cloudflareWebActivity.service', () => ({
  ...jest.requireActual('../services/cloudflareWebActivity.service'),
  startCloudflareWebActivityPoller: jest.fn(),
}));
jest.mock('../config/reconcileOfficialRedirectUris', () => ({
  ...jest.requireActual('../config/reconcileOfficialRedirectUris'),
  reconcileOfficialRedirectUris: jest.fn(async () => undefined),
}));

import { createServer } from 'node:net';
import type { Server } from 'node:http';
import { closePostgres } from '../config/postgres';
import { reconcileOfficialRedirectUris } from '../config/reconcileOfficialRedirectUris';
import { createTestDatabase, dropTestDatabase } from '../db/testDatabase';
import { startBackgroundJobs } from '../queue/backgroundJobs';
import { startCloudflareWebActivityPoller } from '../services/cloudflareWebActivity.service';
import { startFollowOutboxWorker } from '../services/followOutbox.worker';
import { startKaanaCatalogueSyncSchedule } from '../services/kaanaCatalogueSync.service';

const SLOW_STEP_TIMEOUT_MS = 180_000;

let server: Server;
let bootstrap: (startupTimeoutMs?: number) => Promise<void>;
let ownDatabaseUrl = '';
let sharedDatabaseUrl: string | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not resolve a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeAll(async () => {
  sharedDatabaseUrl = process.env.DATABASE_URL;
  ownDatabaseUrl = await createTestDatabase();
  process.env.PORT = String(await freePort());
  const module = await import('../server');
  server = module.default;
  bootstrap = module.bootstrap;
}, SLOW_STEP_TIMEOUT_MS);

afterAll(async () => {
  await closeServer();
  await closePostgres();
  await dropTestDatabase(ownDatabaseUrl);
  process.env.DATABASE_URL = sharedDatabaseUrl;
}, SLOW_STEP_TIMEOUT_MS);

afterEach(async () => {
  await closeServer();
  jest.clearAllMocks();
  delete process.env.EMAIL_MAINTENANCE_ENABLED;
});

describe('bootstrap in the inbosh role', () => {
  it(
    'listens, and starts neither the email maintenance nor any platform schedule or worker',
    async () => {
      await bootstrap();
      expect(server.listening).toBe(true);
      expect(startBackgroundJobs).not.toHaveBeenCalled();
      expect(startFollowOutboxWorker).not.toHaveBeenCalled();
      expect(startKaanaCatalogueSyncSchedule).not.toHaveBeenCalled();
      expect(startCloudflareWebActivityPoller).not.toHaveBeenCalled();
      // It reads the origin registry but repairs nothing the platform owns.
      expect(reconcileOfficialRedirectUris).not.toHaveBeenCalled();
    },
    SLOW_STEP_TIMEOUT_MS,
  );

  it(
    'runs the email maintenance only when EMAIL_MAINTENANCE_ENABLED=true hands it over',
    async () => {
      process.env.EMAIL_MAINTENANCE_ENABLED = 'true';
      await bootstrap();
      expect(startBackgroundJobs).toHaveBeenCalledTimes(1);
      expect(startFollowOutboxWorker).not.toHaveBeenCalled();
    },
    SLOW_STEP_TIMEOUT_MS,
  );
});
