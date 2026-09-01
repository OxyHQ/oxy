/**
 * The account's own audit trail — the write and read halves of
 * `GET /security/activity`.
 *
 * ## The cutover bug this port removes
 *
 * `logSecurityEvent` opened with
 *
 * ```ts
 * if (!Types.ObjectId.isValid(userId)) {
 *   logger.error('Invalid userId provided to logSecurityEvent', …);
 *   throw new Error('Invalid userId');
 * }
 * ```
 *
 * and `getUserSecurityActivity` / `getRecentSecurityActivity` carried the same
 * test. That regex rejects the **uuid v7 every account created after the
 * Postgres cutover carries** (`@oxyhq/db`'s `generatedId()`), so for such
 * an account the trail stopped being written at all: sign-in, sign-out, email
 * change, device added, profile update — every one of them threw before
 * touching a table. Most callers `await` the helper inside a `try` that swallows
 * (`session.controller.ts`, `user.service.ts`, `webauthn.ts`), so the visible
 * symptom was an audit history that simply stayed empty; on
 * `POST /security/activity/{private-key-exported,backup-created}` the same throw
 * surfaced as an HTTP 500.
 *
 * The guards are DELETED, not widened. They only ever existed to stop a
 * malformed string reaching Mongoose as a `CastError`; `security_activities.
 * user_id` is now a `text` column with a real foreign key to `users.id`, so a
 * read for an unknown id returns no rows — exactly what a malformed one always
 * produced — and a WRITE for one is refused by the FK rather than by a regex
 * guessing at the id's shape. `__tests__/securityActivityService.test.ts` pins
 * this: reinstate the guard and the post-cutover-account cases go red.
 *
 * ## No IP, anywhere
 *
 * Under the platform-wide no-user-IPs-at-rest invariant (threat model:
 * state-actor harassment) there is no IP column on `security_activities` and
 * nothing here derives, hashes or logs one. `userAgent` is a client string, not
 * a network address. `metadata` is the one open surface — a writer could smuggle
 * an address into it — which is a call-site rule a schema cannot state; nothing
 * in this module puts one there.
 *
 * ## `timestamp` → `occurred_at`
 *
 * The column is `occurred_at`: the EVENT time, distinct from `created_at`, the
 * row's write time. The WIRE contract is unchanged — `securityActivity.
 * controller.ts` still emits the field as `timestamp`, and
 * `controllers/__tests__/securityActivity.controller.test.ts` fails if the
 * rename ever reaches a client.
 */

import { and, count, desc, eq, gte } from 'drizzle-orm';
import type { Request } from 'express';
import { getDb } from '../config/postgres';
import {
  SECURITY_EVENT_SEVERITY_MAP,
  securityActivities,
  type SecurityEventSeverity,
  type SecurityEventType,
} from '../db/schema/securityActivities';
import { extractDeviceInfo } from '../utils/deviceUtils';
import { logger } from '../utils/logger';
import { validatePagination } from '../utils/validation';

/**
 * Per-event detail. Genuinely shape-less — every event type carries a different
 * set of keys, which is the one thing the `jsonb` column is for. The named
 * members are the keys this module itself writes.
 */
export interface SecurityEventMetadata {
  [key: string]: unknown;
  deviceName?: string;
  deviceType?: string;
  platform?: string;
  oldValue?: string;
  newValue?: string;
  reason?: string;
}

export interface LogSecurityEventOptions {
  userId: string;
  eventType: SecurityEventType;
  eventDescription: string;
  metadata?: SecurityEventMetadata;
  req?: Request;
  severity?: SecurityEventSeverity;
  deviceId?: string;
}

/**
 * One stored event, as the surface reads it.
 *
 * `metadata` is narrowed from the column's `unknown` at the ONE place a value
 * enters the table (every write in this module goes through
 * {@link SecurityActivityService.logSecurityEvent}, which stores a
 * {@link SecurityEventMetadata}), so a reader does not have to re-narrow it row
 * by row.
 */
export interface SecurityActivityRecord {
  id: string;
  userId: string;
  eventType: SecurityEventType;
  eventDescription: string;
  metadata: SecurityEventMetadata;
  userAgent: string | null;
  deviceId: string | null;
  /** When the EVENT happened. Serialized to the wire as `timestamp`. */
  occurredAt: Date;
  severity: SecurityEventSeverity;
  createdAt: Date;
}

/**
 * The columns every read of this table selects.
 *
 * Explicit rather than a bare `select()`: `updated_at` is row bookkeeping no
 * surface shows, and naming the set here is what makes
 * {@link SecurityActivityRecord} and the query provably the same shape — a
 * column added to the table cannot silently join the DTO.
 */
const ACTIVITY_COLUMNS = {
  id: securityActivities.id,
  userId: securityActivities.userId,
  eventType: securityActivities.eventType,
  eventDescription: securityActivities.eventDescription,
  metadata: securityActivities.metadata,
  userAgent: securityActivities.userAgent,
  deviceId: securityActivities.deviceId,
  occurredAt: securityActivities.occurredAt,
  severity: securityActivities.severity,
  createdAt: securityActivities.createdAt,
};

/** A selected row, before `metadata` is narrowed off the column's `unknown`. */
type SelectedActivity = Omit<SecurityActivityRecord, 'metadata'> & { metadata: unknown };

/**
 * Present a stored row as a {@link SecurityActivityRecord}.
 *
 * `jsonb` reads back as `unknown`, and the narrowing is a real check rather than
 * a cast: a row whose `metadata` is a JSON scalar, an array or `null` (which
 * `psql`, a backfill, or a future writer can all produce, whatever this module
 * stores) becomes `{}` instead of a value a consumer would spread and get
 * nonsense from.
 */
function toRecord(row: SelectedActivity): SecurityActivityRecord {
  const { metadata, ...rest } = row;
  const isObject = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata);
  return { ...rest, metadata: isObject ? (metadata as SecurityEventMetadata) : {} };
}

// Constants for validation and limits
const MAX_EVENT_DESCRIPTION_LENGTH = 500;
const MAX_METADATA_SIZE = 10000; // bytes (approximate JSON size)
const MAX_USER_AGENT_LENGTH = 500;
const DEDUPLICATION_WINDOW_MS = 5000; // 5 seconds - prevent duplicate events

class SecurityActivityService {
  /**
   * Sanitize string input to prevent injection attacks
   */
  private sanitizeString(input: string | undefined, maxLength: number): string | undefined {
    if (!input) return undefined;
    // Remove control characters and limit length
    const sanitized = input.replace(/[\x00-\x1F\x7F]/g, '').trim();
    return sanitized.length > maxLength ? sanitized.substring(0, maxLength) : sanitized;
  }

  /**
   * Validate and sanitize metadata.
   *
   * A value that cannot be serialized at all (a cycle, a BigInt) is reduced
   * to `{}` here rather than reaching the `jsonb` column and failing the
   * INSERT - which, since a failed write is swallowed, would otherwise cost
   * the event silently.
   */
  private sanitizeMetadata(metadata: SecurityEventMetadata): SecurityEventMetadata {
    try {
      // Limit metadata size by stringifying and checking length
      const jsonString = JSON.stringify(metadata);
      if (jsonString.length > MAX_METADATA_SIZE) {
        logger.warn('Metadata too large, truncating', {
          component: 'SecurityActivityService',
          originalSize: jsonString.length,
        });
        // Return minimal metadata if too large
        return { truncated: true };
      }
      return metadata;
    } catch (error) {
      logger.warn('Failed to serialize metadata', {
        component: 'SecurityActivityService',
        method: 'sanitizeMetadata',
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * The event already recorded for this account inside the deduplication window,
   * if there is one.
   *
   * Returns the STORED row rather than a boolean: it is what
   * {@link SecurityActivityService.logSecurityEvent} hands back for a suppressed
   * duplicate, so the caller receives a real row instead of the fabricated one
   * the Mongo version invented (`_id: new Types.ObjectId()`) for an event that
   * was never written.
   */
  private async findDuplicateEvent(
    userId: string,
    eventType: SecurityEventType,
    deviceId?: string,
    windowMs: number = DEDUPLICATION_WINDOW_MS
  ): Promise<SecurityActivityRecord | null> {
    try {
      const windowStart = new Date(Date.now() - windowMs);
      const filters = [
        eq(securityActivities.userId, userId),
        eq(securityActivities.eventType, eventType),
        // `>=` on the EVENT time, matching the Mongo `$gte` on `timestamp` this
        // replaces — not on `created_at`, which is the row's write time.
        gte(securityActivities.occurredAt, windowStart),
      ];

      // For device-specific events, also check deviceId
      if (deviceId && (eventType === 'sign_in' || eventType === 'device_added' || eventType === 'device_removed')) {
        filters.push(eq(securityActivities.deviceId, deviceId));
      }

      const [row] = await getDb()
        .select(ACTIVITY_COLUMNS)
        .from(securityActivities)
        .where(and(...filters))
        .orderBy(desc(securityActivities.occurredAt))
        .limit(1);

      return row ? toRecord(row) : null;
    } catch (error) {
      // If deduplication check fails, allow the event (fail open)
      logger.warn('Failed to check for duplicate event', {
        component: 'SecurityActivityService',
        method: 'findDuplicateEvent',
        userId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Log a security event.
   *
   * Returns the stored row, or `null` when nothing was stored. `null` is the
   * honest answer the Mongo version could not give: it swallowed a failed write
   * and returned an unsaved document carrying an `_id` that named no record
   * anywhere. Audit logging must never break the operation it describes, so a
   * write failure is still logged and swallowed rather than thrown — the change
   * is that the caller can now tell.
   */
  async logSecurityEvent(options: LogSecurityEventOptions): Promise<SecurityActivityRecord | null> {
    const {
      userId,
      eventType,
      eventDescription,
      metadata = {},
      req,
      severity = this.getDefaultSeverity(eventType),
      deviceId,
    } = options;

    // Sanitize event description
    let sanitizedDescription = this.sanitizeString(eventDescription, MAX_EVENT_DESCRIPTION_LENGTH);
    if (!sanitizedDescription || sanitizedDescription.length === 0) {
      logger.warn('Empty event description after sanitization', {
        component: 'SecurityActivityService',
        userId,
        eventType,
      });
      // Use default description if sanitization removed everything
      sanitizedDescription = `Security event: ${eventType}`;
    }

    // Extract and sanitize user agent
    const rawUserAgent = req?.headers['user-agent'];
    const userAgent = rawUserAgent ? this.sanitizeString(rawUserAgent, MAX_USER_AGENT_LENGTH) : undefined;

    // Sanitize metadata
    const sanitizedMetadata = this.sanitizeMetadata(metadata);

    // Extract device info from request if available and not already in metadata
    let finalDeviceId = deviceId;
    if (req && !finalDeviceId) {
      // Scope the derived deviceId to this user so security-activity events
      // logged under the same UA for two different users don't collide
      // on the same device-id (security review H1).
      const deviceInfo = extractDeviceInfo(req, undefined, undefined, userId);
      finalDeviceId = deviceInfo.deviceId;
      if (!sanitizedMetadata.deviceName && deviceInfo.deviceName) {
        sanitizedMetadata.deviceName = this.sanitizeString(deviceInfo.deviceName, 100);
      }
      if (!sanitizedMetadata.deviceType && deviceInfo.deviceType) {
        sanitizedMetadata.deviceType = this.sanitizeString(deviceInfo.deviceType, 50);
      }
      if (!sanitizedMetadata.platform && deviceInfo.platform) {
        sanitizedMetadata.platform = this.sanitizeString(deviceInfo.platform, 50);
      }
    }

    // Check for duplicate events (prevent spam/rapid duplicate logging)
    const duplicate = await this.findDuplicateEvent(userId, eventType, finalDeviceId);
    if (duplicate) {
      logger.debug('Duplicate security event detected, skipping', {
        component: 'SecurityActivityService',
        userId,
        eventType,
        deviceId: finalDeviceId,
      });
      return duplicate;
    }

    const values = {
      userId,
      eventType,
      eventDescription: sanitizedDescription,
      metadata: sanitizedMetadata,
      userAgent: userAgent ?? null,
      deviceId: finalDeviceId ?? null,
      occurredAt: new Date(),
      severity,
    };

    try {
      const saved = await this.insertActivity(values);

      // Log successful event creation for monitoring (only for high-severity events to reduce noise)
      if (severity === 'high' || severity === 'critical') {
        logger.info('Security event logged', {
          component: 'SecurityActivityService',
          userId,
          eventType,
          severity,
          activityId: saved.id,
        });
      }

      return saved;
    } catch (error) {
      // Log error but don't throw - security logging should never break main operations
      // However, for critical events, we should be more aggressive about retrying
      logger.error('Failed to log security event', error instanceof Error ? error : new Error(String(error)), {
        component: 'SecurityActivityService',
        method: 'logSecurityEvent',
        userId,
        eventType,
        severity,
      });

      // For critical events, attempt one retry after a short delay
      if (severity === 'critical') {
        try {
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
          const retried = await this.insertActivity(values);
          logger.info('Critical security event logged on retry', {
            component: 'SecurityActivityService',
            userId,
            eventType,
            activityId: retried.id,
          });
          return retried;
        } catch (retryError) {
          logger.error('Retry failed for critical security event', retryError instanceof Error ? retryError : new Error(String(retryError)), {
            component: 'SecurityActivityService',
            userId,
            eventType,
          });
        }
      }

      // Nothing was stored. Say so rather than handing back a row-shaped object
      // whose id names no record.
      return null;
    }
  }

  /** Insert one event and read back exactly the columns a reader sees. */
  private async insertActivity(
    values: typeof securityActivities.$inferInsert
  ): Promise<SecurityActivityRecord> {
    const [row] = await getDb()
      .insert(securityActivities)
      .values(values)
      .returning(ACTIVITY_COLUMNS);
    return toRecord(row);
  }

  /**
   * Get user's security activity with pagination.
   *
   * The account is the caller's own, resolved from the bearer by the controller;
   * the `user_id` equality here is the other half of that isolation guarantee —
   * no request-supplied value ever widens this predicate.
   */
  async getUserSecurityActivity(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      eventType?: SecurityEventType;
    } = {}
  ): Promise<{ activities: SecurityActivityRecord[]; total: number; hasMore: boolean }> {
    // Use shared validation utility for pagination
    const { limit, offset } = validatePagination(
      options.limit,
      options.offset,
      100, // maxLimit
      50   // defaultLimit
    );

    const { eventType } = options;

    const where = eventType
      ? and(eq(securityActivities.userId, userId), eq(securityActivities.eventType, eventType))
      : eq(securityActivities.userId, userId);

    const db = getDb();
    const [rows, [totals]] = await Promise.all([
      db
        .select(ACTIVITY_COLUMNS)
        .from(securityActivities)
        .where(where)
        .orderBy(desc(securityActivities.occurredAt))
        .offset(offset)
        .limit(limit),
      db.select({ value: count() }).from(securityActivities).where(where),
    ]);

    const total = totals?.value ?? 0;
    return {
      activities: rows.map(toRecord),
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get recent security activity (last N events)
   */
  async getRecentSecurityActivity(
    userId: string,
    limit = 10
  ): Promise<SecurityActivityRecord[]> {
    // Validate and clamp limit
    const validatedLimit = Math.min(Math.max(1, limit), 100);

    const rows = await getDb()
      .select(ACTIVITY_COLUMNS)
      .from(securityActivities)
      .where(eq(securityActivities.userId, userId))
      .orderBy(desc(securityActivities.occurredAt))
      .limit(validatedLimit);

    return rows.map(toRecord);
  }

  /**
   * Get default severity for event type
   */
  private getDefaultSeverity(eventType: SecurityEventType): SecurityEventSeverity {
    return SECURITY_EVENT_SEVERITY_MAP[eventType] || 'low';
  }

  /**
   * Helper: Log sign-in event
   */
  async logSignIn(
    userId: string,
    req: Request,
    deviceId?: string,
    metadata?: SecurityEventMetadata
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'sign_in',
      eventDescription: 'User signed in',
      metadata,
      req,
      deviceId,
      severity: 'low',
    });
  }

  /**
   * Helper: Log sign-out event
   */
  async logSignOut(
    userId: string,
    req: Request,
    deviceId?: string
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'sign_out',
      eventDescription: 'User signed out',
      req,
      deviceId,
      severity: 'low',
    });
  }

  /**
   * Helper: Log email change event
   */
  async logEmailChange(
    userId: string,
    oldEmail: string,
    newEmail: string,
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'email_changed',
      eventDescription: `Email changed from ${oldEmail} to ${newEmail}`,
      metadata: {
        oldValue: oldEmail,
        newValue: newEmail,
      },
      req,
      severity: 'medium',
    });
  }

  /**
   * Helper: Log profile update event
   */
  async logProfileUpdate(
    userId: string,
    updatedFields: string[],
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'profile_updated',
      eventDescription: `Profile updated: ${updatedFields.join(', ')}`,
      metadata: {
        updatedFields,
      },
      req,
      severity: 'low',
    });
  }

  /**
   * Helper: Log device added event
   */
  async logDeviceAdded(
    userId: string,
    deviceId: string,
    deviceName: string,
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'device_added',
      eventDescription: `New device added: ${deviceName}`,
      metadata: {
        deviceName,
      },
      req,
      deviceId,
      severity: 'medium',
    });
  }

  /**
   * Helper: Log device removed event
   */
  async logDeviceRemoved(
    userId: string,
    deviceId: string,
    deviceName: string,
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'device_removed',
      eventDescription: `Device removed: ${deviceName}`,
      metadata: {
        deviceName,
      },
      req,
      deviceId,
      severity: 'medium',
    });
  }

  /**
   * Helper: Log account recovery event
   */
  async logAccountRecovery(
    userId: string,
    recoveryMethod: string,
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'account_recovery',
      eventDescription: `Account recovery via ${recoveryMethod}`,
      metadata: {
        recoveryMethod,
      },
      req,
      severity: 'high',
    });
  }

  /**
   * Helper: Log security settings change event
   */
  async logSecuritySettingsChange(
    userId: string,
    settingName: string,
    oldValue: unknown,
    newValue: unknown,
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'security_settings_changed',
      eventDescription: `Security setting changed: ${settingName}`,
      metadata: {
        settingName,
        oldValue: String(oldValue),
        newValue: String(newValue),
      },
      req,
      severity: 'medium',
    });
  }

  /**
   * Helper: Log suspicious activity event
   */
  async logSuspiciousActivity(
    userId: string,
    description: string,
    metadata?: SecurityEventMetadata,
    req?: Request
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'suspicious_activity',
      eventDescription: description,
      metadata,
      req,
      severity: 'critical',
    });
  }

  /**
   * Helper: Log private key export event
   */
  async logPrivateKeyExported(
    userId: string,
    req?: Request,
    deviceId?: string
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'private_key_exported',
      eventDescription: 'Private key exported',
      metadata: {
        exportMethod: 'printed',
      },
      req,
      deviceId,
      severity: 'high',
    });
  }

  /**
   * Helper: Log backup created event
   */
  async logBackupCreated(
    userId: string,
    req?: Request,
    deviceId?: string
  ): Promise<SecurityActivityRecord | null> {
    return this.logSecurityEvent({
      userId,
      eventType: 'backup_created',
      eventDescription: 'Encrypted backup file created',
      metadata: {
        backupType: 'encrypted_zip',
      },
      req,
      deviceId,
      severity: 'high',
    });
  }
}

export default new SecurityActivityService();
