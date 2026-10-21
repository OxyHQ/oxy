/**
 * Revocable play sessions over a file's HLS ladder (ADR 0043 stage 4c,
 * `file_play_sessions`).
 *
 * An application that owns a file, or may read a person's file
 * (`fileReference.service.mayApplicationRead`), opens a session and receives
 * URLs under `/assets/streams/<sessionId>.<secret>/` — master playlist,
 * renditions, segments, the AES-128 key, an audio file's preview and waveform.
 * EVERY request under that prefix is checked here: the session exists, the
 * secret hashes to the stored SHA-256, it is neither revoked nor expired, the
 * file is `active`, and the application may still read it. So a revocation —
 * by the application (`DELETE /assets/service/streams/:id`), by the owner
 * (revoking the application's access), or the file leaving `active` — stops the
 * next segment, not the next session.
 *
 * ## The per-task cache
 *
 * A play fetches a segment every few seconds, so a session is cached per task
 * for {@link SESSION_CACHE_TTL_MS}. The cache rides the stage-4b cross-task
 * file-cache channel: every task drops its cached sessions of a file whenever
 * that file's record is invalidated (`fileCache.onInvalidate`), and every
 * revocation here ends with `fileCache.invalidate(fileId)` after its commit.
 * Without Redis the bound is the TTL.
 *
 * ## A rendition allow-list
 *
 * `renditions` limits a session to some rungs of the ladder (a product capping
 * a free listener at `hls_a64`/`hls_a128`). It is stored on the row, so the
 * serving path enforces it on EVERY request (`hlsStreamServing.ts`): the
 * master lists only those rungs, and any other rung's playlist, segment or key
 * is 404. NULL — no list — is the whole ladder.
 */

import crypto from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { readResponseJson, safeFetch } from '@oxy.so/core/server';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema';
import {
  filePlaySessions,
  type FilePlaySessionRow,
  PLAY_SESSION_RENDITIONS,
  type PlaySessionEncryption,
  type PlaySessionKeyAuthorization,
  type PlaySessionRendition,
  type PlaySessionRevoker,
} from '../db/schema/filePlaySessions';
import type { FileRecord, FileVariantRecord } from '../types/file.types';
import { ApiError, BadRequestError, NotFoundError } from '../utils/error';
import fileCache from '../utils/fileCache';
import { logger } from '../utils/logger';
import { openSecret, sealSecret } from '../utils/secretBox';
import {
  FILE_EVENT_SIGNATURE_HEADER,
  fileEventSignatureHeader,
  openFileWebhookSecret,
} from './fileEvents.service';

export const PLAY_SESSION_DEFAULT_TTL_SECONDS = 60 * 60;
export const PLAY_SESSION_MIN_TTL_SECONDS = 60;
export const PLAY_SESSION_MAX_TTL_SECONDS = 12 * 60 * 60;

/** How long a task trusts its cached copy of a session without asking the database. */
export const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_MAX_ENTRIES = 20_000;

/**
 * The application's key-authorization endpoint must send its headers within
 * this, and then its body within it again.
 */
export const KEY_AUTHORIZATION_TIMEOUT_MS = 3_000;
/** Largest key-authorization answer read; a larger one is no answer. */
const KEY_AUTHORIZATION_MAX_BODY_BYTES = 16 * 1024;
/** How long an `allow` from the application's endpoint is reused for the same session. */
export const KEY_AUTHORIZATION_CACHE_MS = 60_000;
export const KEY_AUTHORIZATION_EVENT_TYPE = 'stream.key_authorization';

const KEY_BYTES = 16;

function keyContext(sessionId: string): string {
  return `play-session-key|${sessionId}`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface OpenPlaySessionInput {
  file: FileRecord;
  applicationId: string;
  endUserId: string | null;
  ttlSeconds: number;
  encryption: PlaySessionEncryption;
  keyAuthorization: PlaySessionKeyAuthorization;
  /** The rungs the session may serve ({@link normalizeRenditionAllowList}), or `null` for all. */
  renditions: PlaySessionRendition[] | null;
}

/**
 * An allow-list as stored: distinct, in ladder order. `undefined` (none asked)
 * is `null`, the whole ladder.
 */
export function normalizeRenditionAllowList(
  renditions: readonly PlaySessionRendition[] | undefined,
): PlaySessionRendition[] | null {
  if (renditions === undefined) return null;
  const asked = new Set(renditions);
  return PLAY_SESSION_RENDITIONS.filter((type) => asked.has(type));
}

/** A session's allow-list as the serving path checks it: `null` for the whole ladder. */
export function renditionAllowList(row: FilePlaySessionRow): ReadonlySet<string> | null {
  return row.renditions ? new Set(row.renditions) : null;
}

/** `active` until it is revoked or expires. */
export type PlaySessionStatus = 'active' | 'revoked' | 'expired';

export function playSessionStatus(row: FilePlaySessionRow, now = new Date()): PlaySessionStatus {
  if (row.revokedAt) return 'revoked';
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
}

/** The ready master playlist of a file's ladder, or `undefined`. */
export function readyMasterPlaylist(file: FileRecord): FileVariantRecord | undefined {
  return file.variants.find((variant) => variant.type === 'hls_master' && variant.readyAt);
}

/**
 * Open a session. The CALLER decided the application may read the file and
 * that its ladder is ready; this validates the options and writes the row.
 * Returns the row and the URL secret, which exists only in this answer.
 */
export async function openPlaySession(
  input: OpenPlaySessionInput,
): Promise<{ row: FilePlaySessionRow; secret: string }> {
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < PLAY_SESSION_MIN_TTL_SECONDS ||
    input.ttlSeconds > PLAY_SESSION_MAX_TTL_SECONDS
  ) {
    throw new BadRequestError(
      `ttlSeconds must be between ${PLAY_SESSION_MIN_TTL_SECONDS} and ${PLAY_SESSION_MAX_TTL_SECONDS}`,
    );
  }
  if (input.keyAuthorization === 'webhook') {
    if (input.encryption !== 'aes-128') {
      throw new BadRequestError('keyAuthorization "webhook" needs encryption "aes-128"');
    }
    const [application] = await getDb()
      .select({
        url: applications.filesWebhookUrl,
        verifiedAt: applications.filesWebhookVerifiedAt,
      })
      .from(applications)
      .where(eq(applications.id, input.applicationId))
      .limit(1);
    if (!application?.url || !application.verifiedAt) {
      throw new ApiError(
        409,
        'Key authorization asks your verified file-events endpoint; register one first (PUT /applications/:appId/files-webhook)',
        'FILES_WEBHOOK_REQUIRED',
      );
    }
  }

  if (input.renditions !== null && input.renditions.length === 0) {
    throw new BadRequestError('renditions must name at least one rendition');
  }

  const id = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('base64url');
  const contentKey =
    input.encryption === 'aes-128' ? crypto.randomBytes(KEY_BYTES).toString('base64') : null;
  let row: FilePlaySessionRow;
  try {
    [row] = await getDb()
      .insert(filePlaySessions)
      .values({
        id,
        fileId: input.file.id,
        applicationId: input.applicationId,
        endUserId: input.endUserId,
        tokenSha256: sha256Hex(secret),
        encryption: input.encryption,
        keyAuthorization: input.keyAuthorization,
        contentKeyCiphertext: contentKey ? sealSecret(contentKey, keyContext(id)) : null,
        renditions: input.renditions,
        expiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds})`,
      })
      .returning();
  } catch (error) {
    // `end_user_id` names no account (a foreign-key violation).
    for (
      let current: unknown = error;
      current instanceof Error;
      current = Reflect.get(current, 'cause')
    ) {
      if (Reflect.get(current, 'code') === '23503') {
        throw new BadRequestError('endUserId must be an existing Oxy account');
      }
    }
    throw error;
  }
  logger.info('Play session opened', {
    sessionId: row.id,
    fileId: row.fileId,
    applicationId: row.applicationId,
    encryption: row.encryption,
    keyAuthorization: row.keyAuthorization,
    renditions: row.renditions,
  });
  return { row, secret };
}

/** The calling application's session `sessionId`, or 404 (another application's answers the same). */
export async function loadApplicationPlaySession(
  sessionId: string,
  applicationId: string,
): Promise<FilePlaySessionRow> {
  const [row] = await getDb()
    .select()
    .from(filePlaySessions)
    .where(
      and(eq(filePlaySessions.id, sessionId), eq(filePlaySessions.applicationId, applicationId)),
    )
    .limit(1);
  if (!row) throw new NotFoundError('Play session not found');
  return row;
}

/** Revoke one of the application's sessions now. Idempotent. */
export async function revokePlaySession(
  row: FilePlaySessionRow,
  by: PlaySessionRevoker,
): Promise<FilePlaySessionRow> {
  const [revoked] = await getDb()
    .update(filePlaySessions)
    .set({ revokedAt: sql`now()`, revokedBy: by })
    .where(and(eq(filePlaySessions.id, row.id), isNull(filePlaySessions.revokedAt)))
    .returning();
  fileCache.invalidate(row.fileId);
  return revoked ?? row;
}

/**
 * Revoke every live session of `applicationId` matching `filter` (a file, an
 * end user, or both). Returns how many.
 */
export async function revokePlaySessionsWhere(
  applicationId: string,
  filter: { fileId?: string; endUserId?: string },
  by: PlaySessionRevoker,
): Promise<number> {
  if (!filter.fileId && !filter.endUserId) {
    throw new BadRequestError('Name a fileId, an endUserId, or both');
  }
  const revoked = await getDb()
    .update(filePlaySessions)
    .set({ revokedAt: sql`now()`, revokedBy: by })
    .where(
      and(
        eq(filePlaySessions.applicationId, applicationId),
        isNull(filePlaySessions.revokedAt),
        gt(filePlaySessions.expiresAt, sql`now()`),
        filter.fileId ? eq(filePlaySessions.fileId, filter.fileId) : undefined,
        filter.endUserId ? eq(filePlaySessions.endUserId, filter.endUserId) : undefined,
      ),
    )
    .returning({ fileId: filePlaySessions.fileId });
  fileCache.invalidateMany(revoked.map((row) => row.fileId));
  return revoked.length;
}

/** Every live session `applicationId` holds for `fileId` (the owner revoked its access). */
export async function revokePlaySessionsForFileApplication(
  fileId: string,
  applicationId: string,
  by: PlaySessionRevoker,
): Promise<number> {
  return revokePlaySessionsWhere(applicationId, { fileId }, by);
}

// ---------------------------------------------------------------------------
// Serving: the session behind a URL token, cached per task.
// ---------------------------------------------------------------------------

/** A session as the serving path needs it. */
export interface ServingSession {
  row: FilePlaySessionRow;
  /**
   * The application is `active` (read with the session, so cached with it): a
   * suspended application's sessions stop within the cache's TTL, a deleted
   * one's at once (its deletion revokes them).
   */
  applicationActive: boolean;
  /** The AES-128 key, for an encrypted session. */
  contentKey: Buffer | null;
  /** The rungs it may serve, or `null` for the whole ladder ({@link renditionAllowList}). */
  allowedRenditions: ReadonlySet<string> | null;
}

interface CachedSession {
  session: ServingSession;
  cachedAt: number;
}

const sessionCache = new Map<string, CachedSession>();
/** fileId → the cached session ids of that file, so an invalidation touches only those. */
const sessionsByFile = new Map<string, Set<string>>();
const keyDecisions = new Map<string, number>();

function forgetSession(sessionId: string): void {
  const cached = sessionCache.get(sessionId);
  sessionCache.delete(sessionId);
  keyDecisions.delete(sessionId);
  if (!cached) return;
  const ids = sessionsByFile.get(cached.session.row.fileId);
  ids?.delete(sessionId);
  if (ids?.size === 0) sessionsByFile.delete(cached.session.row.fileId);
}

function rememberSession(session: ServingSession, cachedAt: number): void {
  if (sessionCache.size >= SESSION_CACHE_MAX_ENTRIES) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) forgetSession(oldest);
  }
  sessionCache.set(session.row.id, { session, cachedAt });
  const ids = sessionsByFile.get(session.row.fileId) ?? new Set<string>();
  ids.add(session.row.id);
  sessionsByFile.set(session.row.fileId, ids);
}

function dropSessionsOf(fileIds: readonly string[]): void {
  for (const fileId of fileIds) {
    for (const sessionId of [...(sessionsByFile.get(fileId) ?? [])]) forgetSession(sessionId);
  }
}

fileCache.onInvalidate(dropSessionsOf);

/** For tests: forget every cached session and key decision. */
export function clearPlaySessionCache(): void {
  sessionCache.clear();
  sessionsByFile.clear();
  keyDecisions.clear();
}

/** `<sessionId>.<secret>` → its parts, or `null` when malformed. */
export function parsePlayToken(token: string): { sessionId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.length > 200) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(sessionId) || !/^[A-Za-z0-9_-]{20,100}$/.test(secret)) return null;
  return { sessionId, secret };
}

/**
 * The live session a URL token names, or `null` (unknown, wrong secret,
 * revoked, expired). The file's own checks (status, consent) are the
 * caller's: they read the file record, which has its own cache.
 */
export async function resolveServingSession(token: string): Promise<ServingSession | null> {
  const parsed = parsePlayToken(token);
  if (!parsed) return null;
  const now = Date.now();
  let cached = sessionCache.get(parsed.sessionId);
  if (cached && now - cached.cachedAt > SESSION_CACHE_TTL_MS) {
    forgetSession(parsed.sessionId);
    cached = undefined;
  }
  let session = cached?.session;
  if (!session) {
    const readStartedAt = Date.now();
    const [found] = await getDb()
      .select({ row: filePlaySessions, applicationStatus: applications.status })
      .from(filePlaySessions)
      .innerJoin(applications, eq(applications.id, filePlaySessions.applicationId))
      .where(eq(filePlaySessions.id, parsed.sessionId))
      .limit(1);
    if (!found) return null;
    const row = found.row;
    session = {
      row,
      applicationActive: found.applicationStatus === 'active',
      contentKey: row.contentKeyCiphertext
        ? Buffer.from(openSecret(row.contentKeyCiphertext, keyContext(row.id)), 'base64')
        : null,
      allowedRenditions: renditionAllowList(row),
    };
    if (!fileCache.wasInvalidatedSince(row.fileId, readStartedAt)) {
      rememberSession(session, readStartedAt);
    }
  }
  const expected = Buffer.from(session.row.tokenSha256, 'hex');
  const presented = crypto.createHash('sha256').update(parsed.secret).digest();
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    return null;
  }
  if (!session.applicationActive) return null;
  if (playSessionStatus(session.row, new Date(now)) !== 'active') return null;
  return session;
}

/** The application's key-authorization POST: its status and parsed JSON body. */
export type KeyAuthorizationTransport = (request: {
  url: string;
  body: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; body: unknown }>;

async function postKeyAuthorization(request: {
  url: string;
  body: string;
  headers: Record<string, string>;
}): Promise<{ status: number; body: unknown }> {
  const result = await safeFetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    maxRedirects: 0,
    headersTimeoutMs: KEY_AUTHORIZATION_TIMEOUT_MS,
    signal: AbortSignal.timeout(KEY_AUTHORIZATION_TIMEOUT_MS),
  });
  const answer = await readResponseJson(result.response, {
    maxBytes: KEY_AUTHORIZATION_MAX_BODY_BYTES,
    timeoutMs: KEY_AUTHORIZATION_TIMEOUT_MS,
  });
  if (answer.kind === 'timeout') throw new Error('key authorization body timed out');
  if (answer.kind === 'error') throw answer.error;
  return { status: result.status, body: answer.kind === 'ok' ? answer.value : null };
}

let keyAuthorizationTransport: KeyAuthorizationTransport = postKeyAuthorization;

/** For tests: replace how the application's endpoint is called. */
export function setKeyAuthorizationTransport(transport: KeyAuthorizationTransport | null): void {
  keyAuthorizationTransport = transport ?? postKeyAuthorization;
}

/**
 * Whether the session's key may be released now. `none`: yes. `webhook`: the
 * application's verified file-events endpoint is asked, signed like a file
 * event, and only a 2xx `{ "allow": true }` within
 * {@link KEY_AUTHORIZATION_TIMEOUT_MS} releases it; an `allow` is reused for
 * {@link KEY_AUTHORIZATION_CACHE_MS} (a player fetches the key again on a
 * rendition switch). Fails closed: no endpoint, an error, a timeout, anything
 * else is a refusal.
 */
export async function authorizeKeyRelease(session: ServingSession): Promise<boolean> {
  const { row } = session;
  if (row.keyAuthorization === 'none') return true;
  const allowedUntil = keyDecisions.get(row.id);
  if (allowedUntil !== undefined && allowedUntil > Date.now()) return true;

  const [application] = await getDb()
    .select({
      url: applications.filesWebhookUrl,
      secret: applications.filesWebhookSecretCiphertext,
      verifiedAt: applications.filesWebhookVerifiedAt,
      status: applications.status,
    })
    .from(applications)
    .where(eq(applications.id, row.applicationId))
    .limit(1);
  if (
    !application?.url ||
    !application.secret ||
    !application.verifiedAt ||
    application.status === 'deleted'
  ) {
    return false;
  }
  const eventId = crypto.randomUUID();
  const body = JSON.stringify({
    id: eventId,
    type: KEY_AUTHORIZATION_EVENT_TYPE,
    occurredAt: new Date().toISOString(),
    session: {
      id: row.id,
      fileId: row.fileId,
      endUserId: row.endUserId,
      expiresAt: row.expiresAt.toISOString(),
    },
  });
  try {
    const answer = await keyAuthorizationTransport({
      url: application.url,
      body,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'oxy-event-id': eventId,
        'oxy-event-type': KEY_AUTHORIZATION_EVENT_TYPE,
        [FILE_EVENT_SIGNATURE_HEADER]: fileEventSignatureHeader(
          openFileWebhookSecret(row.applicationId, application.secret),
          body,
        ),
      },
    });
    const allow =
      answer.status >= 200 &&
      answer.status < 300 &&
      typeof answer.body === 'object' &&
      answer.body !== null &&
      (answer.body as { allow?: unknown }).allow === true;
    if (allow) keyDecisions.set(row.id, Date.now() + KEY_AUTHORIZATION_CACHE_MS);
    else keyDecisions.delete(row.id);
    return allow;
  } catch (error) {
    logger.warn('Play session key authorization failed', {
      sessionId: row.id,
      applicationId: row.applicationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
