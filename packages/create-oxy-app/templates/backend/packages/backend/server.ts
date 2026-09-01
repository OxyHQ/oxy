import http from 'node:http';
import express from 'express';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import type { Socket } from 'socket.io';
import { oxyClient } from '@oxyhq/core';
import {
  createOxyAuthMiddleware,
  createOxyCors,
  createOxyRateLimit,
  getRequiredOxyUserId,
} from '@oxyhq/core/server';
import type { OxyAuthenticatedRequest } from '@oxyhq/core/server';
import type { HealthResponse } from '@{{APP_SLUG}}/shared-types';
import {
  assertMigrationsCurrent,
  checkPostgresHealth,
  closePostgres,
  connectPostgres,
} from './src/db/postgres';
import { logger } from './src/utils/logger';

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);

// The Oxy apex family (*.oxy.so) is allowed automatically by createOxyCors, so
// only non-apex dev origins (the Expo dev server) need listing here.
const APP_ORIGINS = ['http://localhost:8081', 'http://localhost:19006'];

const oxy = oxyClient;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(createOxyCors({ appOrigins: APP_ORIGINS }));

// Liveness — always 200 while the process is up.
app.get('/health', (_req, res) => {
  const body: HealthResponse = { status: 'ok', service: '{{APP_SLUG}}-backend' };
  res.json(body);
});

// Readiness — Postgres answers AND this build's migrations have all been
// applied. Connectivity alone is not enough: a task whose database is behind the
// schema it was built against still starts, still connects, and then fails every
// query, by which point traffic has been routed to it.
app.get('/ready', async (_req, res) => {
  if (!(await checkPostgresHealth())) {
    res.status(503).json({ status: 'not-ready', reason: 'database-unreachable' });
    return;
  }
  try {
    await assertMigrationsCurrent();
  } catch (error) {
    logger.warn('Not ready — migrations are not current', error);
    res.status(503).json({ status: 'not-ready', reason: 'migrations-pending' });
    return;
  }
  res.json({ status: 'ready' });
});

// API router. Per-user rate limiting (resolves the Oxy session) is mounted on
// the router so EVERY API route — including authenticated ones — is throttled;
// the liveness/readiness probes above are intentionally left unlimited.
const api = express.Router();
api.use(createOxyRateLimit(oxy));

// Example authenticated route. Identity comes from the Oxy session — never from
// the request body.
api.get('/me', createOxyAuthMiddleware(oxy), (req, res) => {
  res.json({ userId: getRequiredOxyUserId(req as OxyAuthenticatedRequest) });
});
app.use('/api', api);

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: APP_ORIGINS, methods: ['GET', 'POST'], credentials: true },
});

// Socket auth: only authenticated clients connect; rooms derive from the
// authenticated user id, never from client-supplied values.
type AuthedSocket = Socket & { user?: { id: string } };
io.use(oxy.authSocket());
io.on('connection', (socket: AuthedSocket) => {
  const userId = socket.user?.id;
  if (!userId) {
    socket.disconnect(true);
    return;
  }
  socket.join(`user:${userId}`);
  socket.on('disconnect', () => socket.leave(`user:${userId}`));
});

// ECS/Kubernetes stop a task with SIGTERM. Draining the HTTP server before the
// pool means in-flight requests finish against a live connection instead of
// erroring on a socket closed underneath them.
function shutdown(signal: string): void {
  logger.info(`Received ${signal} — shutting down`);
  server.close(() => {
    void closePostgres().finally(() => process.exit(0));
  });
}

async function boot(): Promise<void> {
  try {
    await connectPostgres();
    server.listen(PORT, () => logger.info(`{{APP_NAME}} backend listening on :${PORT}`));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server — could not connect to PostgreSQL', error);
    process.exit(1);
  }
}

if (require.main === module) {
  void boot();
}

export { app, server, io };
