import express from "express";
import http from "http";
import { count, ne, sql } from "drizzle-orm";
import { Server as SocketIOServer, type Socket } from "socket.io";
import profilesRouter from "./routes/profiles";
import usersRouter from "./routes/users";
import notificationsRouter from "./routes/notifications.routes";
import sessionRouter from "./routes/session";
import sessionDeviceRouter from "./routes/sessionDevice";
import browserHubRouter from "./routes/browserHub";
import dotenv from "dotenv";
import searchRoutes from "./routes/search";
import { rateLimiter, authRateLimiter, userRateLimiter, federationServiceLimiter, bruteForceProtection, securityHeaders } from "./middleware/security";
import privacyRoutes from "./routes/privacy";
import analyticsRoutes from "./routes/analytics.routes";
import paymentRoutes from './routes/payment.routes';
import walletRoutes from './routes/wallet.routes';
import reputationRoutes from './routes/reputation.routes';
import moderationReputationRoutes from './routes/moderationReputation.routes';
import linkMetadataRoutes from './routes/linkMetadata';
import linksRoutes from './routes/links';
import storeRoutes from './routes/store';
import locationSearchRoutes from './routes/locationSearch';
import authRoutes from './routes/auth';
import assetRoutes from './routes/assets';
import cdnRoutes from './routes/cdn';
import storageRoutes from './routes/storage';
import applicationRoutes from './routes/applications';
import accountRoutes from './routes/accounts';
import devicesRouter from './routes/devices';
import securityRoutes from './routes/security';
import subscriptionRoutes from './routes/subscription.routes';
import authLinkingRoutes from './routes/authLinking';
import reputationService from './services/reputation.service';
import moderationReputationService from './services/moderationReputation.service';
import {
  BASELINE_CONDUCT_FAMILIES,
  BASELINE_MULTI_FINDING_CAP,
  BASELINE_MULTI_FINDING_SECONDARY_SHARE,
  BASELINE_OXY_CONDUCT_POLICY_VERSION,
  BASELINE_REPETITION_MULTIPLIERS,
  BASELINE_REPETITION_WINDOW_DAYS,
  BASELINE_SEVERITY_RULES,
  BASELINE_STANDING_THRESHOLDS,
} from './utils/moderation.constants';
import emailRoutes from './routes/email';
import emailProxyRoutes from './routes/emailProxy';
import emailInboundRoutes, {
  inboundRateLimit,
  verifyEmailInboundWebhookSecret,
} from './routes/emailInbound';
import aliaRoutes from './routes/alia';
import creditsRoutes from './routes/credits';
import billingRoutes from './routes/billing';
import accountBillingRoutes from './routes/accountBilling';
import costCenterRoutes from './routes/costCenters';
import inferenceCatalogueRoutes from './routes/inferenceCatalogue';
import inferenceEdgeRoutes from './routes/inferenceEdge';
import inferenceAdminRoutes from './routes/inferenceAdmin';
import inferenceRoutingPolicyRoutes from './routes/inferenceRoutingPolicies';
import inferenceProviderConnectionRoutes from './routes/inferenceProviderConnections';
import inferenceReportingRoutes from './routes/inferenceReporting';
import platformStatsRoutes from './routes/platform-stats';
import topicsRoutes from './routes/topics.routes';
import followsV2Routes, { meFollowsRouter } from './routes/follows.v2.routes';
import followRegistryV2Routes from './routes/followRegistry.v2.routes';
import contactsRouter from './routes/contacts';
import userDataRouter from './routes/userData';
import appSignalsRouter from './routes/appSignals';
import identityRoutes from './routes/identity';
import chainsRoutes from './routes/chains';
import identityBackupRoutes from './routes/identityBackup';
import deviceTransferRoutes from './routes/deviceTransfer';
import civicRoutes from './routes/civic';
import nodeRoutes from './routes/nodes';
import { sweepValidations } from './services/civic/validator.service';
import { sweepPersonhoodAudits } from './services/civic/personhoodAudit.service';
import { sweepNodeLiveness } from './services/nodeRegistry.service';
import { expireDueFollows } from './services/followCommand.service';
import { runAutoRechargeSweep } from './services/stripeAccountBilling.service';
import { AUTO_RECHARGE_SWEEP_INTERVAL_MS } from './db/schema/billingAutoRechargeAttempts';
import { VALIDATION_SWEEP_INTERVAL_MS, PERSONHOOD_AUDIT_SWEEP_INTERVAL_MS } from './utils/civic.constants';
import { FOLLOW_EXPIRY_SWEEP_INTERVAL_MS } from './utils/follow.constants';
import { NODE_LIVENESS_SWEEP_INTERVAL_MS } from './utils/nodes.constants';
import didRoutes from './routes/did';
import transparencyRoutes from './routes/transparency';
import updatesManifestRoutes from './routes/updates';
import updatesAdminRoutes from './routes/updatesAdmin';
import { startSmtpInbound, stopSmtpInbound } from './services/smtp.inbound';
import { smtpOutbound } from './services/smtp.outbound';
import {
  startFollowOutboxWorker,
  stopFollowOutboxWorker,
} from './services/followOutbox.worker';
import { startBackgroundJobs, stopBackgroundJobs } from './queue/backgroundJobs';
import { startNodeIngestJobs, stopNodeIngestJobs } from './queue/nodeIngest.queue';
import {
  startTransparencyCheckpointJobs,
  stopTransparencyCheckpointJobs,
} from './queue/transparencyCheckpoint.queue';
import { startLinkPreviewWarmJobs, stopLinkPreviewWarmJobs } from './queue/linkPreviewWarm.queue';
import { startAssetVariantJobs, stopAssetVariantJobs } from './queue/assetVariants.queue';
import {
  startConductRiskExpiryJobs,
  stopConductRiskExpiryJobs,
} from './queue/conductRiskExpiry.queue';
import {
  startSubscriptionExpiryJobs,
  stopSubscriptionExpiryJobs,
} from './queue/subscriptionExpiry.queue';
import { getEnvBoolean, validateRequiredEnvVars, getSanitizedConfig, getEnvNumber } from './config/env';
import { logger } from './utils/logger';
import type { Response } from 'express';
import { authMiddleware } from './middleware/auth';
import cookieParser from 'cookie-parser';
import { csrfProtection, getCsrfToken } from './middleware/csrf';
import { createCorsMiddleware, SOCKET_IO_CORS_CONFIG } from './config/cors';
import { refreshOriginRegistry } from './config/dynamicOriginRegistry';
import { reconcileOfficialRedirectUris } from './config/reconcileOfficialRedirectUris';
import { createAdapter } from '@socket.io/redis-adapter';
import { getRedisClient, closeRedis } from './config/redis';
import { startUserCacheInvalidationSubscriber } from './utils/userCacheInvalidationSubscriber';
import { initializeIO, socketRoomsFor } from './utils/socket';
import { resolveSocketIdentity } from './utils/socketAuth';
import performanceMiddleware, { getMemoryStats, getDatabaseStats } from './middleware/performance';
import { performanceMonitor } from './utils/performanceMonitor';
import { isDatabaseReachable, waitForDatabaseConnection } from './utils/dbConnection';
import { closePostgres, getDb } from './config/postgres';
import { users } from './db/schema/users';
import { isFederatableUser } from './utils/profileQuery';
import { errorHandler } from './middleware/errorHandler';
import compression from 'compression';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './config/swagger';

// Load environment variables
dotenv.config();

// Validate configuration early - fail fast with clear errors
try {
  validateRequiredEnvVars();
  logger.info('Environment configuration validated', getSanitizedConfig());
} catch (error) {
  logger.error('Configuration error:', error);
  process.exit(1);
}

const app = express();

// Trust proxy - required when behind a reverse proxy (Cloudflare, nginx, etc.)
// This is needed for express-rate-limit to work correctly with X-Forwarded-For headers
app.set('trust proxy', 1);

// Security headers middleware (first, before any other middleware)
app.use(securityHeaders);

// Compress responses (gzip/brotli)
app.use(compression());

// Cookie parser middleware (before CSRF and body parsing)
app.use(cookieParser());

// Some routes need their raw request body before the global JSON/urlencoded
// parsers run. The `/api/` prefix-strip middleware runs AFTER body parsing, so
// at parse time the path may still carry the prefix — guard against BOTH the
// stripped and prefixed forms.
const CACHE_UPLOAD_PATH = '/assets/service/cache';
const CACHE_UPLOAD_PATH_API_PREFIXED = '/api/assets/service/cache';
const FEDERATION_UPLOAD_PATH = '/assets/service/federation';
const FEDERATION_UPLOAD_PATH_API_PREFIXED = '/api/assets/service/federation';
const USER_MEDIA_UPLOAD_PATH = '/assets/service/user-media';
const USER_MEDIA_UPLOAD_PATH_API_PREFIXED = '/api/assets/service/user-media';
const EMAIL_INBOUND_PATH = '/email/inbound';
const EMAIL_INBOUND_PATH_API_PREFIXED = '/api/email/inbound';

/**
 * True only for the service-token media stream-upload requests. Uses `req.path`
 * so a querystring never breaks the match.
 */
function isCacheUploadRequest(req: express.Request): boolean {
  return (
    req.method === 'POST' &&
    (
      req.path === CACHE_UPLOAD_PATH ||
      req.path === CACHE_UPLOAD_PATH_API_PREFIXED ||
      req.path === FEDERATION_UPLOAD_PATH ||
      req.path === FEDERATION_UPLOAD_PATH_API_PREFIXED ||
      req.path === USER_MEDIA_UPLOAD_PATH ||
      req.path === USER_MEDIA_UPLOAD_PATH_API_PREFIXED
    )
  );
}

function isEmailInboundWebhookRequest(req: express.Request): boolean {
  return (
    req.method === 'POST' &&
    (req.path === EMAIL_INBOUND_PATH || req.path === EMAIL_INBOUND_PATH_API_PREFIXED)
  );
}

// Body parsing middleware - IMPORTANT: Add this before any routes
// Stripe webhook needs raw body for signature verification (must be before express.json)
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
// Email inbound webhook needs raw body for MIME parsing (must be before express.json).
// Authenticate and rate-limit before raw parsing so unauthenticated clients
// cannot force 25 MiB body buffering or consume the Cloudflare Worker quota.
app.use(
  [EMAIL_INBOUND_PATH, EMAIL_INBOUND_PATH_API_PREFIXED],
  verifyEmailInboundWebhookSecret,
  inboundRateLimit,
  express.raw({ type: '*/*', limit: '25mb' })
);
// Skip the global body parsers for routes that require raw bodies so their
// handlers receive the request in the expected format.
const jsonParser = express.json({ limit: '1mb' });
const urlencodedParser = express.urlencoded({ extended: true, limit: '1mb' });
app.use((req, res, next) =>
  isCacheUploadRequest(req) || isEmailInboundWebhookRequest(req) ? next() : jsonParser(req, res, next)
);
app.use((req, res, next) =>
  isCacheUploadRequest(req) || isEmailInboundWebhookRequest(req) ? next() : urlencodedParser(req, res, next)
);

// Request timeout to prevent slow clients holding connections. The cache
// stream-upload legitimately takes longer than a normal request (it pipes up
// to 256 MiB to S3), so it gets a longer socket timeout; everything else keeps
// the tight default.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CACHE_UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60_000;
app.use((req, res, next) => {
  const timeoutMs = isCacheUploadRequest(req)
    ? CACHE_UPLOAD_REQUEST_TIMEOUT_MS
    : DEFAULT_REQUEST_TIMEOUT_MS;
  req.setTimeout(timeoutMs, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'REQUEST_TIMEOUT', message: 'Request timeout' });
    }
  });
  next();
});

// Performance monitoring middleware (before routes)
app.use(performanceMiddleware);

// CORS middleware - reflects request origin with credentials
app.use(createCorsMiddleware());

// Create server for local development and testing
const server = http.createServer(app);

// Setup Socket.IO with centralized CORS config
const io = new SocketIOServer(server, {
  cors: SOCKET_IO_CORS_CONFIG,
});
initializeIO(io);

// Attach Redis adapter for multi-instance broadcast (if Redis available)
const redis = getRedisClient();
let userCacheInvalidationSubscriber: { stop: () => Promise<void> } | null = null;
if (redis) {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.IO Redis adapter enabled');
  userCacheInvalidationSubscriber = startUserCacheInvalidationSubscriber(redis);
}

// Store io instance in app for use in controllers
app.set('io', io);

// Custom socket interface to include user property
interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
    deviceId?: string;
    [key: string]: any;
  };
  /**
   * Anonymous device socket: the server-resolved deviceId for a cookie- or
   * device-token-authed connection with NO user identity (a signed-out tab
   * listening on its `device:<id>` room). Never set from client input.
   */
  deviceId?: string;
}

// Socket.IO rate limiting (applied before auth to protect against unauthenticated floods)
import { createSocketRateLimiter } from './middleware/socketRateLimit';
io.use(createSocketRateLimiter(100, 10_000)); // 100 events per 10s

// Socket.IO authentication middleware — bearer OR device credential.
io.use((socket: AuthenticatedSocket, next) => {
  resolveSocketIdentity(socket.handshake)
    .then((identity) => {
      if (!identity) {
        next(new Error('Authentication error'));
        return;
      }
      if (identity.kind === 'user') {
        socket.user = identity.user;
      } else {
        socket.deviceId = identity.deviceId;
      }
      next();
    })
    .catch((error) => {
      logger.error('Socket authentication error:', error);
      next(new Error('Authentication error'));
    });
});

// Socket connection handling — authenticated users and device-scoped listeners.
io.on('connection', (socket: AuthenticatedSocket) => {
  logger.debug('Socket connected', { socketId: socket.id });

  const rooms = socket.user
    ? socketRoomsFor({ user: socket.user })
    : socket.deviceId
      ? socketRoomsFor({ deviceId: socket.deviceId })
      : [];
  for (const room of rooms) {
    socket.join(room);
  }
  if (rooms.length > 0) {
    logger.debug('Socket joined rooms', { socketId: socket.id, rooms });
  }

  socket.on('disconnect', () => {
    logger.debug('Socket disconnected', { socketId: socket.id });
  });

  // For debugging in development only
  if (process.env.NODE_ENV === 'development') {
    socket.onAny((event, ...args) => {
      logger.debug('Socket event received', { socketId: socket.id, event, args });
    });
  }
});

// ============================================
// Auth Session Socket Namespace (Unauthenticated)
// Used for cross-app authentication via QR code
// ============================================
import { initAuthSessionNamespace } from './utils/authSessionSocket';
import { initDevicePairNamespace } from './utils/devicePairSocket';

const authSessionNamespace = io.of('/auth-session');
authSessionNamespace.use(createSocketRateLimiter(20, 10_000)); // Stricter: 20 events per 10s
initAuthSessionNamespace(authSessionNamespace);

// No authentication required for this namespace
authSessionNamespace.on('connection', (socket) => {
  logger.debug('Auth session socket connected', { socketId: socket.id });
  
  // Client joins a room for their session token
  socket.on('join', (sessionToken: string) => {
    if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length < 10) {
      socket.emit('error', { message: 'Invalid session token' });
      return;
    }
    
    const room = `auth:${sessionToken}`;
    socket.join(room);
    logger.debug('Client joined auth session room', { socketId: socket.id, room });
    socket.emit('joined', { room: sessionToken });
  });
  
  socket.on('leave', (sessionToken: string) => {
    const room = `auth:${sessionToken}`;
    socket.leave(room);
    logger.debug('Client left auth session room', { socketId: socket.id, room });
  });
  
  socket.on('disconnect', () => {
    logger.debug('Auth session socket disconnected', { socketId: socket.id });
  });
});

// ============================================
// Device-Pair Socket Namespace (Unauthenticated)
// Used for device-to-device identity transfer ("add a device"). The waiting new
// device joins room `devicepair:<pairingId>`; the server pushes a lightweight
// status signal when the old device approves/denies. No key material flows over
// this socket — the transferred bytes are E2E-encrypted regardless.
// ============================================
const devicePairNamespace = io.of('/device-pair');
devicePairNamespace.use(createSocketRateLimiter(20, 10_000)); // Stricter: 20 events per 10s
initDevicePairNamespace(devicePairNamespace);

devicePairNamespace.on('connection', (socket) => {
  logger.debug('Device-pair socket connected', { socketId: socket.id });

  socket.on('join', (pairingId: string) => {
    if (!pairingId || typeof pairingId !== 'string' || pairingId.length < 8) {
      socket.emit('error', { message: 'Invalid pairing id' });
      return;
    }
    const room = `devicepair:${pairingId}`;
    socket.join(room);
    logger.debug('Client joined device-pair room', { socketId: socket.id, room });
    socket.emit('joined', { pairingId });
  });

  socket.on('leave', (pairingId: string) => {
    if (!pairingId || typeof pairingId !== 'string') return;
    socket.leave(`devicepair:${pairingId}`);
  });

  socket.on('disconnect', () => {
    logger.debug('Device-pair socket disconnected', { socketId: socket.id });
  });
});

// Helper for emitting session_update
export function emitSessionUpdate(userId: string, payload: any) {
  const room = `user:${userId}`;
  logger.debug('Emitting session_update', { room, payload });
  io.to(room).emit('session_update', payload);
}

// The database connection lives entirely in the startup gate below
// (`waitForDatabaseConnection` → `connectPostgres`), which is what removing
// Mongoose from this file finally allowed.
//
// What used to sit here was a SECOND, independent connect: a module-level
// `mongoose.connect(...)` with its own pool options, its own `process.exit(1)`
// on failure, and four `mongoose.connection.on(...)` monitors — running at
// import time, in parallel with the Postgres gate, and in EVERY process that
// imported this module (including jest). It is deleted rather than translated:
// `connectPostgres()` is idempotent and the single place a pool is opened in
// this package, and pool sizing belongs there (`PG_MAX_POOL_SIZE`) rather than
// in a second copy here. The connection-event monitors have no `postgres.js`
// counterpart — `GET /health` reports reachability with a real round trip,
// which is strictly better than a driver-side flag.
//
// `ensureFileSha256LiveUniqueIndex()` also used to run here: boot-time index
// reconciliation that dropped the legacy global `sha256_1` index and recreated
// the live-rows-only partial unique on every start — and CRASHED the API on a
// fresh empty database, because `.indexes()` on a collection that does not exist
// yet throws and this `.catch` exits the process. `files_sha256_live_key` is
// declared in the schema and created by a migration, which is what index
// reconciliation is for; there is nothing left for a boot hook to do.

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received, starting graceful shutdown`);

  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  server.close(() => {
    logger.info('HTTP server closed');
  });

  stopFollowOutboxWorker();
  await stopBackgroundJobs();
  await stopNodeIngestJobs();
  await stopTransparencyCheckpointJobs();
  await stopLinkPreviewWarmJobs();
  await stopAssetVariantJobs();
  await stopConductRiskExpiryJobs();
  await stopSubscriptionExpiryJobs();
  await stopSmtpInbound();
  smtpOutbound.shutdown();
  if (userCacheInvalidationSubscriber) {
    await userCacheInvalidationSubscriber.stop();
    userCacheInvalidationSubscriber = null;
  }
  await closeRedis();
  await closePostgres();

  logger.info('All connections closed, exiting');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// API Routes
app.get("/", async (req, res) => {
  try {
    const [{ value: usersCount }] = await getDb().select({ value: count() }).from(users);
    res.json({
      message: "Welcome to the API",
      users: usersCount,
    });
  } catch (error) {
    logger.error("Error in root endpoint:", error);
    res.status(500).json({ message: "Error fetching stats", error: error instanceof Error ? error.message : String(error) });
  }
});

// Health check endpoint
//
// This is the ALB target-group check: a 503 here drains the task out of the
// load balancer, so its meaning must stay exactly what it was — the DATABASE
// being unusable is the only condition that returns 503.
//
// The probe is a real `select 1` round trip, NOT the existence of a connection
// object. `mongoose.connection.readyState === 1` reported "connected" from a
// driver-side flag, which is why this endpoint could report a healthy database
// while it was refusing work. `isDatabaseReachable()` cannot: it either gets a
// row back over the same pool real requests use, or it does not.
//
// A mutation test on `isDatabaseReachable` that stops the database BEFORE
// startup SURVIVES — no pool is ever published, so both the honest and the
// broken implementation answer "down". The honest test drops the database out
// from under a LIVE pool; that is the only way the difference between "the
// pool object exists" and "the server answers" becomes observable. See
// `src/__tests__/healthGate.test.ts`.
app.get("/health", async (req, res) => {
  try {
    const isDatabaseUp = await isDatabaseReachable();
    const redisClient = getRedisClient();
    const redisStatus = redisClient ? (redisClient.status === 'ready' ? "connected" : "disconnected") : "not configured";

    // Only the database being down is truly unhealthy (503).
    // Redis is used for caching/sockets — brief reconnections are "degraded" not "down".
    const isRedisDown = redisClient && redisClient.status !== 'ready';

    res.status(isDatabaseUp ? 200 : 503).json({
      status: isDatabaseUp ? (isRedisDown ? "degraded" : "operational") : "down",
      timestamp: new Date().toISOString(),
      database: isDatabaseUp ? "connected" : "disconnected",
      redis: redisStatus,
    });
  } catch (error) {
    logger.error("Health check error:", error);
    res.status(503).json({
      status: "down",
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// Performance monitoring endpoint (protected, for admin/internal use)
app.get("/metrics", authMiddleware, (req: any, res: Response) => {
  try {
    const memoryStats = getMemoryStats();
    const connectionStats = getDatabaseStats();
    const perfSummary = performanceMonitor.getSummary();
    const slowOperations = performanceMonitor.getSlowOperations(1000);
    
    res.json({
      timestamp: new Date().toISOString(),
      memory: memoryStats,
      database: connectionStats,
      performance: {
        summary: perfSummary,
        slowOperations: slowOperations.map(op => ({
          operation: op.operation,
          avgDuration: op.avgDuration,
          count: op.count,
          maxDuration: op.maxDuration,
        })),
      },
    });
  } catch (error) {
    logger.error("Metrics endpoint error:", error);
    res.status(500).json({
      error: "Failed to retrieve metrics",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

// Strip /api/ prefix — SDK clients and Next.js BFF may prepend /api before paths
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/') || req.url === '/api') {
    req.url = req.url.slice(4) || '/';
  }
  next();
});

// Apply rate limiting middleware globally (before routes)
// Note: Auth routes have their own stricter rate limiting
app.use(rateLimiter);
app.use(bruteForceProtection);

// CSRF token endpoint (must be before CSRF protection)
app.get('/csrf-token', getCsrfToken);

// API Routes
// Apply stricter rate limiting to auth routes
app.use("/auth", authRateLimiter, authRoutes);
app.use("/auth", userRateLimiter, csrfProtection, authLinkingRoutes); // Auth linking (requires auth)
app.use("/assets", assetRoutes);
// Public CDN origin for cloud.oxy.so/<id> (CloudFront OriginPath = /cdn). No
// auth, no CSRF — serves ONLY public CDN-backed assets via 302; 404 otherwise.
app.use("/cdn", cdnRoutes);
// Oxy Updates (self-hosted expo-updates). The PUBLIC manifest endpoint has NO
// auth and NO CSRF — devices fetch it with only expo-updates headers — so it is
// mounted here, before the CSRF group, with its own limiter. The admin router
// (bearer/service-token authenticated writes, no CSRF) shares the /updates/v1
// base; Express falls through to it for any path the manifest router does not
// own. `/updates/v1` is namespaced strictly under `/updates` so it never clashes
// with the bare `/v1` alia-compat mount below.
app.use("/updates/v1", updatesManifestRoutes);
app.use("/updates/v1", updatesAdminRoutes);
app.use("/storage", userRateLimiter, csrfProtection, storageRoutes);
app.use("/search", searchRoutes);
app.use("/profiles", csrfProtection, profilesRouter);
// Mount the user app-data KV store BEFORE the generic /users mount so the
// `/users/me/app-data/:namespace[/:key]` paths are owned by their dedicated
// router. Mounting after /users would still work in practice (no route inside
// `usersRouter` matches `/me/app-data/...`) but the explicit ordering makes
// the routing topology unambiguous.
app.use("/users/me/app-data", userRateLimiter, csrfProtection, userDataRouter);
app.use("/users", userRateLimiter, csrfProtection, usersRouter); // Per-user rate limiting for authenticated routes
app.use("/session/device", userRateLimiter, sessionDeviceRouter);
// The browser DeviceSession hub (issue #937 Phase 5). Mounted BEFORE `/session`
// so its own router owns the prefix, and deliberately OUTSIDE `csrfProtection`:
// three of its four endpoints carry no bearer and no cookie — the raw hub
// handle in the body is the credential — and the fourth is bearer-gated with
// its own same-site origin guard. An app-local CSRF token would be a token the
// only legitimate caller (the IdP edge, a server) can never hold.
app.use("/session/browser-hub", userRateLimiter, browserHubRouter);
app.use("/session", userRateLimiter, csrfProtection, sessionRouter);
app.use("/privacy", userRateLimiter, csrfProtection, privacyRoutes);
app.use("/analytics", userRateLimiter, authMiddleware, analyticsRoutes);
app.use('/payments', userRateLimiter, csrfProtection, paymentRoutes);
app.use('/notifications', userRateLimiter, csrfProtection, notificationsRouter);
// Mounted BEFORE `/reputation` so the more specific prefix wins: the parent
// router applies `authMiddleware` to everything after its own public reads, and
// the bridge's service-credential routes must not pass through it.
app.use('/reputation/moderation', csrfProtection, moderationReputationRoutes);
app.use('/reputation', csrfProtection, reputationRoutes);
app.use('/wallet', userRateLimiter, csrfProtection, walletRoutes);
app.use('/link-metadata', userRateLimiter, linkMetadataRoutes);
// Ecosystem link-preview (URL unfurl) service. Bearer/service-token reads (no
// cookie writes → no CSRF); the route applies its own per-principal limiter.
app.use('/links', linksRoutes);
// The app store. Mounted bare because the router serves both a public
// storefront and authenticated writes, so auth and CSRF are declared per route
// inside it — a blanket middleware here would lock the storefront or leave the
// reviews open.
app.use('/store', storeRoutes);
app.use('/location-search', locationSearchRoutes);
app.use('/applications', csrfProtection, applicationRoutes);
// Unified Account graph (tree + membership + service credentials). Per-route
// rate limiters (rl:accounts:*) live inside the router.
app.use('/accounts', csrfProtection, accountRoutes);
app.use('/devices', userRateLimiter, csrfProtection, devicesRouter);
app.use('/security', userRateLimiter, csrfProtection, securityRoutes);
app.use('/subscription', userRateLimiter, csrfProtection, subscriptionRoutes);
app.use('/email/proxy', emailProxyRoutes); // public, no auth — must be before /email
app.use('/email/inbound', emailInboundRoutes); // Cloudflare Email Routing webhook — must be before /email
app.use('/email', userRateLimiter, csrfProtection, emailRoutes);
app.use('/alia', userRateLimiter, aliaRoutes);
// The public inference edge (issue #972 workstream 4, ADR 0010). Mounted at
// `/v1` BEFORE `aliaRoutes` and BEFORE `/v1/models`, so it owns `/v1/responses`,
// `/v1/chat/completions` and `/v1/generations/:id`. It carries no
// `userRateLimiter`: its callers are application credentials, not users, and it
// applies its own per-credential and per-application budgets (`rl:machine:*`,
// `rl:inference:edge:`) keyed on the credential rather than on an IP.
app.use('/v1', inferenceEdgeRoutes);
// The SAME catalogue router that serves `/models`, so `GET /v1/models` and
// `GET /models` can never diverge — one selectability predicate, one audience
// rule, one code path.
app.use('/v1/models', inferenceCatalogueRoutes);
// What the Alia proxy still owns under `/v1`: `/v1/voice/token` and
// `/v1/voice/transcribe`. ADR 0010 states these are Alia PRODUCT endpoints that
// happen to live here and are not part of the inference edge; where they end up
// is workstream 14's decision. `/v1/chat/completions` is no longer among them —
// the edge above takes it, and the proxy's own mount at `/alia/chat/completions`
// keeps every platform-trusted caller working, one base URL apart.
app.use('/v1', userRateLimiter, aliaRoutes);
app.use('/credits', userRateLimiter, csrfProtection, creditsRoutes);
// Account-scoped billing (issue #972, sections 7.1/7.4/7.5). Mounted BEFORE
// `/billing`, or Express hands `accounts` and `cost-centers` to the
// personal-billing router as ordinary paths and every route below 404s. The
// pre-existing `/billing` routes stay exactly as they are: they key on the
// bearer's own subject, which is correct for a person managing their own
// API-credit product, and these are the account-scoped INFERENCE money surface.
app.use('/billing/accounts', accountBillingRoutes);
app.use('/billing/cost-centers', costCenterRoutes);
app.use('/billing', billingRoutes);
// The canonical model catalogue (issue #972, ADR 0008). The mount path is
// unchanged because Console still calls `GET /models/stats`; what it serves is
// now real catalogue data instead of four hardcoded product tiers.
app.use('/models', inferenceCatalogueRoutes);
// The staff-only commercial-permission workflow. A separate mount rather than a
// path under `/models`, because approving a route is not a catalogue read and
// must never be reachable by widening a read route's matcher.
app.use('/inference/admin', inferenceAdminRoutes);
// The customer's own routing configuration (issue #972, workstream 6). NOT under
// `/models`: a routing POLICY is a per-account constraint set, while the
// catalogue's routing PROFILES are shared objects Oxy publishes — ADR 0008 keeps
// the two apart, and one mount serving both would be the first place they blur.
app.use('/inference/routing-policies', inferenceRoutingPolicyRoutes);
// BYOK provider connections (issue #972, workstream 10). Its own mount for the
// same reason the routing policies have one: a customer's own upstream
// credential is not a catalogue object, and Oxy holds only a REFERENCE to it —
// never the credential, in any table, response or log.
app.use('/inference/provider-connections', inferenceProviderConnectionRoutes);
// The customer's own usage, spend, balance and budgets (issue #972, workstream
// 8). Its own mount, and NOT under `/billing`: that surface is the Stripe and
// credits lane, while this one reads the exact inference ledger and the usage
// rollups. One mount serving both would be the first place "what Stripe
// charged" and "what the ledger recorded" blur, which is the distinction the
// whole workstream exists to keep.
app.use('/inference/reporting', inferenceReportingRoutes);
app.use('/platform-stats', platformStatsRoutes);
app.use('/topics', topicsRoutes);
// The follow graph. `/v2` because these are new operations rather than a new
// spelling of the legacy toggle — the two coexist while applications migrate.
app.use('/v2/follows', userRateLimiter, followsV2Routes);
app.use('/v2/me', userRateLimiter, meFollowsRouter);
// The registry an application talks to: namespaces, kinds, targets. Separate
// from `/v2/follows` because it is authorized on the application's ownership of
// a namespace rather than on the user's own graph.
app.use('/v2/follow-targets', userRateLimiter, followRegistryV2Routes);
app.use('/contacts', userRateLimiter, csrfProtection, contactsRouter);
// Service-token-only cross-app signal ingest (endorsements + interests). No
// csrfProtection — Bearer-authenticated service writes are exempt (no ambient
// cookie credentials), per the bearer-write CSRF rule.
app.use('/app-signals', appSignalsRouter);
// Encrypted off-device identity backup (b3 Feature 1). Mixed private (bearer
// upsert/status/delete) + public (restore-by-locator) routes; each gates its own
// auth, so no csrfProtection (bearer-write CSRF rule + public GET). Mounted
// BEFORE `/identity` so the more specific `/identity/backup` prefix wins.
app.use('/identity/backup', identityBackupRoutes);
// Device-to-device identity transfer ("add a device"). Mounted BEFORE `/identity`
// so its specific prefix wins over the identity router. Public init/info/deny +
// bearer+signature approve; the relay is E2E-encrypted (no CSRF — no ambient
// cookie credentials, per the bearer-write CSRF rule).
app.use('/identity/device-transfer', deviceTransferRoutes);
// Self-sovereign identity layer: signed records + verified-domain badges.
// Mixed public/private routes (each gates its own auth); writes are
// Bearer-authenticated, so no csrfProtection (bearer-write CSRF rule).
app.use('/identity', identityRoutes);
// Civic / Commons layer: public signed DNI card (more routes in Fase 2/3).
// Public read (each route gates its own auth); no csrfProtection (public GET).
// App-authored chain writes: a SERVICE credential appending to a person's chain
// on behalf of an Oxy app. Service-token authenticated (no ambient cookie, so no
// csrfProtection). Deliberately NOT under /identity — that router binds a record's
// subject to the authenticated user, which is the opposite of what this does.
app.use('/chains', chainsRoutes);
app.use('/civic', civicRoutes);
// User nodes (F5a decentralization): the caller's node status + revoke. Bearer-
// authenticated (each route gates its own auth); no csrfProtection (bearer-write
// rule). Node registration itself flows through POST /identity/records.
app.use('/nodes', nodeRoutes);

// ActivityPub endpoints — serves actor profiles and public keys for federation.
import { getInstanceActor, getUserActor, isOwnFederationDomain } from './services/federation.service';
import federationRoutes from './routes/federation';

// Federation domain constant — used by nodeinfo, webfinger, and actor endpoints
const AP_DOMAIN = process.env.FEDERATION_DOMAIN || 'oxy.so';

/**
 * The one account whose username matches, case-insensitively, or `undefined`.
 *
 * Written against the EXPRESSION `users_lower_username_key` is built on
 * (`lower(btrim(username))`), which is what makes it an index seek. Mongo
 * indexed `username` case-SENSITIVELY while both callers below ran an anchored
 * `/i` regex, so each actor/WebFinger lookup was a full collection scan.
 *
 * The projection is exactly the union of what `isFederatableUser` gates on and
 * what `getUserActor` renders — `select: false` does not survive into drizzle,
 * so a bare `select()` here would pull `phone`, `refresh_token` and the contact
 * hashes into a public, unauthenticated handler.
 */
async function findFederatableUserByUsername(username: string) {
  const [row] = await getDb()
    .select({
      username: users.username,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
      avatar: users.avatar,
      bio: users.bio,
      description: users.description,
      kind: users.kind,
      accountStatus: users.accountStatus,
      reputationTier: users.reputationTier,
      fediverseSharing: users.privacyFediverseSharing,
    })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);

  if (!row) {
    return undefined;
  }

  // `isFederatableUser` is the SHARED discovery predicate (`utils/profileQuery.ts`),
  // and it reads the Mongo-shaped `privacySettings.fediverseSharing`. Reshaping
  // here keeps ONE authority for "may this account be discovered over
  // ActivityPub" rather than a second copy of the rule written in SQL.
  return {
    ...row,
    privacySettings: { fediverseSharing: row.fediverseSharing },
  };
}

// Instance actor
app.get('/ap/actor', async (_req: any, res: Response) => {
  try {
    const actor = await getInstanceActor();
    res.setHeader('Content-Type', 'application/activity+json');
    res.json(actor);
  } catch (err) {
    logger.error('[ap/actor] failed to build instance actor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-user actor profiles
app.get('/ap/users/:username', async (req: any, res: Response) => {
  try {
    const { username } = req.params;

    // Instance actor
    if (username === 'instance') {
      const actor = await getInstanceActor();
      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Cache-Control', 'max-age=1800');
      return res.json(actor);
    }

    // Per-user actor
    const user = await findFederatableUserByUsername(username);
    if (!user || !isFederatableUser(user)) return res.status(404).json({ error: 'User not found' });

    const actor = await getUserActor({
      username: user.username,
      name: { first: user.nameFirst, last: user.nameLast },
      avatar: user.avatar,
      bio: user.bio,
      description: user.description,
      kind: user.kind,
    });
    if (!actor) return res.status(500).json({ error: 'Failed to build actor' });

    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Cache-Control', 'max-age=1800');
    return res.json(actor);
  } catch (err: any) {
    logger.error('Actor endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// NodeInfo — required by some servers (e.g. Threads) to validate federation
app.get('/.well-known/nodeinfo', (_req: any, res: Response) => {
  res.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: `https://${AP_DOMAIN}/nodeinfo/2.0`,
      },
    ],
  });
});

app.get('/nodeinfo/2.0', async (_req: any, res: Response) => {
  try {
    const [{ value: total }] = await getDb()
      .select({ value: count() })
      .from(users)
      .where(ne(users.accountStatus, 'archived'));
    res.json({
      version: '2.0',
      software: { name: 'oxy', version: '2.0.0' },
      protocols: ['activitypub'],
      usage: { users: { total, activeMonth: total, activeHalfyear: total }, localPosts: 0 },
      openRegistrations: false,
    });
  } catch (err) {
    logger.error('NodeInfo 2.0 failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// WebFinger endpoint
app.get('/.well-known/webfinger', async (req: any, res: Response) => {
  try {
    const resource = req.query.resource as string;
    if (!resource?.startsWith('acct:')) return res.status(400).json({ error: 'Invalid resource' });

    const acct = resource.replace('acct:', '');
    const atIndex = acct.indexOf('@');
    if (atIndex === -1) return res.status(400).json({ error: 'Invalid acct format' });

    const canonicalUsername = acct.substring(0, atIndex).trim().toLowerCase();
    const domain = acct.substring(atIndex + 1);

    if (!isOwnFederationDomain(domain)) return res.status(404).json({ error: 'Domain not served here' });

    const user = await findFederatableUserByUsername(canonicalUsername);
    if (!user || !isFederatableUser(user)) return res.status(404).json({ error: 'User not found' });

    res.setHeader('Content-Type', 'application/jrd+json');
    res.setHeader('Cache-Control', 'max-age=3600');
    return res.json({
      subject: `acct:${canonicalUsername}@${AP_DOMAIN}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: `https://${AP_DOMAIN}/ap/users/${canonicalUsername}`,
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `https://${AP_DOMAIN}/@${canonicalUsername}`,
        },
      ],
    });
  } catch (err: any) {
    logger.error('WebFinger error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Federation identity & sign-on-behalf endpoints.
//
// The private key NEVER leaves Oxy. Relying apps (e.g. Mention) publish their
// actor's `publicKey` block via `GET /federation/public-key/:username` and
// obtain HTTP-Signature signatures via `POST /federation/sign`, both gated by a
// service token with the `federation:write` scope and bound to the credential's
// own registered domain. The legacy `GET /federation/keypair/:username` route —
// which returned `privateKeyPem` — has been removed in favour of these.
// The federation sign-on-behalf surface is service-to-service (federation:write
// service token) and legitimately high-frequency: a relying app fans its whole
// outbound-signing workload (outbox backfill, delivery fan-out) through one NAT
// egress IP. It is therefore EXCLUDED from the per-IP browser budget (rl:general)
// — which a backfill would exhaust in seconds → 429 → silent federation outage —
// and capped instead by this dedicated high-ceiling limiter. Mounted before the
// router so it also bounds unauthenticated floods.
app.use('/federation', federationServiceLimiter, federationRoutes);

// Self-sovereign DID documents (did:web). Public, cacheable, CORS-open, no
// auth/CSRF — served at the API root beside the WebFinger/ActivityPub handlers
// (the apex proxy must forward `/u/*/did.json` + `/.well-known/did.json`).
app.use('/', didRoutes);

// Transparency log — signed checkpoints over every subject's chain head, plus
// the inclusion proofs that let anyone audit their own history WITHOUT trusting
// this server. Public, cacheable, CORS-open, no auth/CSRF (an audit trail nobody
// can read is not an audit trail); own rate-limit prefix inside the router.
app.use('/transparency', transparencyRoutes);

// Swagger API documentation (non-production only)
if (process.env.NODE_ENV !== 'production') {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Oxy API Documentation',
  }));
  // Serve raw OpenAPI spec as JSON
  app.get('/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

// 404 handler for undefined routes
app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
});

// Global error handler — standardised { error, message, details? } format
// Must be registered last so it catches errors from all routes and middleware above
app.use(errorHandler);

// The 4100 default is a LOCAL DEV default only — ECS injects PORT explicitly
// (oxy-infra terraform-uswest2/app-services.tf sets it to 8080). 4100 is
// oxy-api's slot in the per-app port map so several Oxy backends can run
// side by side on one machine.
const PORT = getEnvNumber('PORT', 4100);

/** How long startup keeps retrying the database before the process gives up. */
const DATABASE_STARTUP_TIMEOUT_MS = 30_000;

/**
 * The startup gate, and everything chained behind it.
 *
 * **`server.listen` MUST stay inside this function, after the `await`.** A task
 * that listens before the database answers joins the ALB target group and
 * starts serving 500s; the gate is what makes "in the target group" mean "can
 * actually serve". `waitForDatabaseConnection` RETRIES inside the deadline
 * because `postgres.js` makes a single connection attempt where the Mongo
 * driver retried internally — on ECS a task can start before RDS finishes a
 * failover, and a single attempt would turn seconds of unavailability into a
 * crash loop.
 *
 * Exported, and taking the deadline as a parameter, for exactly one reason:
 * this body used to live inside `if (require.main === module)`, where it could
 * never run under a test runner — so the gate, the single most consequential
 * ordering in the file, was unreachable by any in-process test and every version
 * of that test was really a test of something else. `__tests__/bootGate.test.ts`
 * calls it directly, with a short deadline for the unreachable-database case.
 * The entry point below is unchanged in behaviour.
 */
export async function bootstrap(
  startupTimeoutMs: number = DATABASE_STARTUP_TIMEOUT_MS,
): Promise<void> {
  // Open the Postgres pool and wait for it to actually answer before starting
  // the server. This prevents queries from executing before the database is
  // ready.
  await waitForDatabaseConnection(startupTimeoutMs);

  // Build the dynamic CORS origin snapshot from the Application registry now
  // that the database is connected. The registry boot-seeds from the
  // bootstrap-core set synchronously at import, so requests before this
  // resolves are still safe; this adds the registered
  // first-party/third-party app origins.
  // Background-safe (fail-soft) — never blocks startup.
  await refreshOriginRegistry();
  await reconcileOfficialRedirectUris();

  // Seed platform-default reputation rules (idempotent) — currently the
  // cross-app `endorsement_received` rule awarded by /app-signals/ingest.
  await reputationService.seedDefaultRules();

  // Seed the baseline Oxy Conduct Policy (idempotent, and NOT an upsert of
  // the values — a published policy version is immutable, so an existing
  // document is left untouched). Without it the bridge rejects every event
  // naming that version rather than silently applying today's tuning.
  await moderationReputationService.seedBaselinePolicy({
    policyVersion: BASELINE_OXY_CONDUCT_POLICY_VERSION,
    severityRules: BASELINE_SEVERITY_RULES,
    conductFamilies: BASELINE_CONDUCT_FAMILIES,
    repetitionMultipliers: BASELINE_REPETITION_MULTIPLIERS,
    repetitionWindowDays: BASELINE_REPETITION_WINDOW_DAYS,
    multiFindingSecondaryShare: BASELINE_MULTI_FINDING_SECONDARY_SHARE,
    multiFindingCap: BASELINE_MULTI_FINDING_CAP,
    standingThresholds: BASELINE_STANDING_THRESHOLDS,
  });

  // Periodically re-tally / expire stale civic validation requests. Unref'd
  // so it never keeps the process alive; failures are logged, never thrown.
  const validationSweep = setInterval(() => {
    sweepValidations().catch((err) =>
      logger.error('Civic validation sweep failed', err instanceof Error ? err : new Error(String(err))),
    );
  }, VALIDATION_SWEEP_INTERVAL_MS);
  validationSweep.unref();

  // Periodically open random personhood audits (Fase 3) for a sample of
  // confirmed real persons — REUSES the validator jury; a failed audit
  // triggers the staking slash cascade. Unref'd + failures logged, like the
  // validation sweep above.
  const personhoodAuditSweep = setInterval(() => {
    sweepPersonhoodAudits().catch((err) =>
      logger.error('Civic personhood audit sweep failed', err instanceof Error ? err : new Error(String(err))),
    );
  }, PERSONHOOD_AUDIT_SWEEP_INTERVAL_MS);
  personhoodAuditSweep.unref();

  // Periodically re-probe registered user nodes (F5a) so the cached liveness
  // badge stays current WITHOUT any request ever touching a node. All probes
  // are SSRF-safe `safeFetch`es. Unref'd + failures logged, like the sweeps
  // above.
  const nodeLivenessSweep = setInterval(() => {
    sweepNodeLiveness().catch((err) =>
      logger.error('User-node liveness sweep failed', err instanceof Error ? err : new Error(String(err))),
    );
  }, NODE_LIVENESS_SWEEP_INTERVAL_MS);
  nodeLivenessSweep.unref();

  // Expire timed follow relationships whose `expiresAt` has passed. Routed
  // through `expireDueFollows` so removals emit events and update the account
  // graph exactly like a manual unfollow.
  const followExpirySweep = setInterval(() => {
    expireDueFollows().catch((err) =>
      logger.error('Follow expiry sweep failed', err instanceof Error ? err : new Error(String(err))),
    );
  }, FOLLOW_EXPIRY_SWEEP_INTERVAL_MS);
  followExpirySweep.unref();

  // Top up accounts that have fallen below their configured auto-recharge
  // threshold (issue #972 section 7.1). THIS registration is what stops
  // `autoRecharge.enabled` being a setting that reads as on and never fires —
  // the claim/charge/settle machinery is complete, and without a caller the
  // customer's balance would simply run out.
  //
  // It self-disables where it cannot work: with no `STRIPE_SECRET_KEY` the sweep
  // returns `processor-unconfigured` without touching an account, so a
  // development deployment logs one line per interval rather than an error per
  // candidate. Unref'd + failures logged, like the sweeps above.
  const autoRechargeSweep = setInterval(() => {
    runAutoRechargeSweep().catch((err) =>
      logger.error('Auto-recharge sweep failed', err instanceof Error ? err : new Error(String(err))),
    );
  }, AUTO_RECHARGE_SWEEP_INTERVAL_MS);
  autoRechargeSweep.unref();

  // Start SMTP inbound server if enabled
  if (getEnvBoolean('SMTP_ENABLED', false)) {
    try {
      startSmtpInbound();
      logger.info('SMTP inbound server enabled');
    } catch (err) {
      logger.error('SMTP inbound server failed to start', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Drain the `follow_events` outbox. OFF unless this deployment asks for it:
  // acknowledging an event is a claim that its delivery happened, and the
  // handler set today observes rather than delivers. The WRITE is never gated —
  // events accumulate regardless, so switching the loop on later loses nothing.
  startFollowOutboxWorker();

  // Start background jobs: durable BullMQ scheduling when REDIS_URL is set,
  // otherwise the in-process cron fallback. Never throws.
  await startBackgroundJobs();

  // Start the F5b node-ingest subsystem (node → Oxy two-way sync): a
  // fleet-wide pull sweep + on-demand per-user ingests, BullMQ when REDIS_URL
  // is set else an in-process interval. All node I/O is background-only —
  // never in a request's read path. Never throws.
  await startNodeIngestJobs();

  // Publish the periodic transparency checkpoint: one signed Merkle
  // commitment to every subject's chain head, so anyone can prove their own
  // history was not rewritten or suppressed without trusting this server.
  // Never throws; a failed publish retries on the next tick.
  await startTransparencyCheckpointJobs();

  // Start the ecosystem link-preview warm subsystem: per-URL background
  // resolves (BullMQ when REDIS_URL is set, else an in-process pending set).
  // All remote I/O is background-only — never on a request's read path.
  await startLinkPreviewWarmJobs();

  // Drain asset variant generation (sharp / ffmpeg) off the upload path. The
  // worker's concurrency is deliberately small — this is the CPU- and
  // memory-heaviest work the process does, and running it unbounded is what
  // starved the JS thread until the ELB health check timed out.
  await startAssetVariantJobs();

  // Let active moderation consequences lapse on schedule. The ledger row
  // stays permanently; only the active risk decays, so a minor error does
  // not become a life sentence. Idempotent — a missed tick only delays a
  // recovery. Never throws.
  await startConductRiskExpiryJobs();

  // Materialize `status = 'expired'` on lapsed subscriptions. This REPLACES
  // a Mongo TTL index that DELETED the subscription record when its period
  // closed; nothing is deleted now. Entitlement never depends on this
  // running — every read derives expiry from `end_date` itself — so a missed
  // tick delays a label and nothing more. Never throws.
  await startSubscriptionExpiryJobs();

  await new Promise<void>((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${PORT}`, {
        database: 'connected',
      });
      resolve();
    });
  });
}

// Only boot if this module is run directly.
if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('Failed to start server - database startup failed:', error);
    process.exit(1);
  });
}

export default server;
