/**
 * End the device sign-ins a NON-official application received before #2215.
 *
 * Until #2215, `POST /auth/session/create` accepted any active application, a
 * third party included. Its device sign-in (the Commons QR) was approved into a
 * session WITHOUT an application binding (`sessions.application_id` NULL) on a
 * fresh, claim-only device, and `/auth/session/claim` handed the third party
 * that session's access token plus the device's restore secret
 * (`device_credentials`). A NULL application reads as "an official Oxy app's
 * device", so those sessions pass `requireFirstPartyDeviceAccess` (identity
 * backup writes, key history, the device lane), and the restore secret mints
 * more bearers for every account on that device. #2215 stops new ones; this
 * ends the ones already handed out. An OWNER step, run once against
 * production by `scripts/revoke-third-party-device-signins.ts`.
 *
 * ## Which sign-ins
 *
 * An application is official per the registry's own rule for a device
 * sign-in (`deviceSignInApplicationIsTrusted`): `status = 'active'` and
 * `isTrustedApplication`. Every other application's device sign-ins are found
 * from two records:
 *
 *  - `auth_sessions` (precise): a CLAIMED (`consumed`) device sign-in of such an
 *    application, and the device of the session its approval minted. These
 *    rows are swept an hour after their five-minute deadline (`db/expiry.ts`),
 *    so only the most recent ones are still there.
 *  - the sign-in's durable traces (`signInRecords`): every approval path names
 *    the session it mints `"<application name> App"` on a fresh device (Commons
 *    sends no device name), and `createSession` records that device as
 *    `device_added` on the account's security trail (kept two years), with the
 *    same name. A session (`application_id` NULL) or a `device_added` entry
 *    with the label of a non-official application names its claim-only device.
 *    A label an OFFICIAL application also produces (two applications of the
 *    same name) is ambiguous and skipped, so an official app's QR sign-in is
 *    never touched by a name; those are counted (`ambiguousLabels`). A
 *    third party renamed since, or a sign-in whose approver chose a device
 *    name, is not found by a label.
 *
 * ## What ending one does
 *
 * The DEVICE is ended, because the restore secret is the device's: every
 * account is signed out of it (`deviceSessionService.signout(all)`, which also
 * deletes every holder credential, its join codes and its background secret),
 * and every still-active session row on it is ended through the revocation
 * choke point (`revokeSessions`, which announces to every cache). A
 * third party's claim never joined another device (the join was an official
 * application's only), so the device is the claim-only one the approval made.
 * Each account that had a session, a context or the original sign-in on a
 * device that still held anything gets one `device_removed` entry on its
 * security trail.
 *
 * Dry run unless `apply`. Idempotent: a device with nothing left on it is
 * counted and left alone, and writes no audit entry. The report is COUNTS only
 * — never an account, device, session, key or token.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { authSessions } from '../db/schema/authSessions';
import { deviceAccountContexts } from '../db/schema/deviceAccountContexts';
import { deviceCredentials } from '../db/schema/deviceCredentials';
import { deviceSessions } from '../db/schema/deviceSessions';
import { securityActivities } from '../db/schema/securityActivities';
import { sessions } from '../db/schema/sessions';
import { isTrustedApplication } from '../utils/trustedApplication';
import { deviceSessionService } from './deviceSession.service';
import securityActivityService from './securityActivityService';
import { revokeSessions } from './sessionRevocation.service';

/** The device name every device-sign-in approval gives the session it mints. */
export function deviceSignInLabel(applicationName: string): string {
  return `${applicationName} App`;
}

/** Why the audit entry was written; in its metadata. */
export const THIRD_PARTY_DEVICE_SIGN_IN_REVOKED = 'third_party_device_sign_in_revoked';

export interface ThirdPartyDeviceSignInReport {
  apply: boolean;
  /** Applications that are not official per the registry's device-sign-in rule. */
  nonOfficialApplications: number;
  /** Their session labels also produced by an official application: skipped. */
  ambiguousLabels: number;
  found: {
    /** Claimed device sign-ins still in `auth_sessions`. */
    authSessions: number;
    /** Sessions and `device_added` entries carrying a non-official label. */
    signInRecords: number;
  };
  /** Distinct claim-only devices those name. */
  devices: number;
  /** Of them, the ones that still hold a session, an account or a credential. */
  devicesWithAccess: number;
  /** Active session rows on those devices (ended, with `apply`). */
  sessions: number;
  /** Device restore secrets (holder credentials) and background secrets on them (revoked). */
  restoreSecrets: number;
  /** Accounts signed in to (or that signed in through) those devices. */
  accounts: number;
  /** Security-trail entries written (one per account and device, with `apply`). */
  auditEntries: number;
}

interface DeviceFinding {
  /** Accounts the sign-in records name for this device. */
  userIds: Set<string>;
  /** The session label, for the audit entry (no secret: an application's name). */
  label: string | null;
}

/** What a device still holds that the third party can use. */
interface DeviceAccess {
  deviceSessionId: string | null;
  activeSessionUserIds: string[];
  contextAccountIds: string[];
  credentials: number;
}

async function readAccess(db: DatabaseOrTransaction, deviceId: string): Promise<DeviceAccess> {
  const active = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.deviceId, deviceId), eq(sessions.isActive, true)));
  const [device] = await db
    .select({ id: deviceSessions.id, background: deviceSessions.backgroundSecretHash })
    .from(deviceSessions)
    .where(eq(deviceSessions.deviceId, deviceId))
    .limit(1);
  if (!device) {
    return {
      deviceSessionId: null,
      activeSessionUserIds: active.map((row) => row.userId),
      contextAccountIds: [],
      credentials: 0,
    };
  }
  const contexts = await db
    .select({ accountId: deviceAccountContexts.accountId })
    .from(deviceAccountContexts)
    .where(
      and(
        eq(deviceAccountContexts.deviceSessionId, device.id),
        isNull(deviceAccountContexts.revokedAt),
      ),
    );
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deviceCredentials)
    .where(
      and(eq(deviceCredentials.deviceSessionId, device.id), isNull(deviceCredentials.pendingUntil)),
    );
  return {
    deviceSessionId: device.id,
    activeSessionUserIds: active.map((row) => row.userId),
    contextAccountIds: contexts.map((row) => row.accountId),
    credentials: count + (device.background ? 1 : 0),
  };
}

/**
 * Find (and with `apply`, end) every device sign-in a non-official application
 * holds. `authSessionsOnly` skips the label records, for an operator who wants
 * the precise source alone.
 */
export async function revokeThirdPartyDeviceSignIns(
  db: DatabaseOrTransaction,
  options: { apply: boolean; authSessionsOnly?: boolean },
): Promise<ThirdPartyDeviceSignInReport> {
  const registry = await db
    .select({
      id: applications.id,
      name: applications.name,
      status: applications.status,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applications);
  // The registry's own rule for a device sign-in (`deviceSignInApplicationIsTrusted`).
  const official = (app: (typeof registry)[number]) =>
    app.status === 'active' && isTrustedApplication(app);
  const nonOfficial = registry.filter((app) => !official(app));
  const officialLabels = new Set(
    registry.filter(official).map((app) => deviceSignInLabel(app.name)),
  );
  const candidateLabels = new Set(nonOfficial.map((app) => deviceSignInLabel(app.name)));
  const labels = [...candidateLabels].filter((label) => !officialLabels.has(label));

  const report: ThirdPartyDeviceSignInReport = {
    apply: options.apply,
    nonOfficialApplications: nonOfficial.length,
    ambiguousLabels: candidateLabels.size - labels.length,
    found: { authSessions: 0, signInRecords: 0 },
    devices: 0,
    devicesWithAccess: 0,
    sessions: 0,
    restoreSecrets: 0,
    accounts: 0,
    auditEntries: 0,
  };

  const devices = new Map<string, DeviceFinding>();
  const note = (deviceId: string | null, userId: string, label: string | null) => {
    if (!deviceId) return;
    const finding = devices.get(deviceId) ?? { userIds: new Set<string>(), label: null };
    finding.userIds.add(userId);
    finding.label ??= label;
    devices.set(deviceId, finding);
  };

  // 1. The precise record: a claimed device sign-in of a non-official application.
  const nonOfficialIds = nonOfficial.map((app) => app.id);
  if (nonOfficialIds.length > 0) {
    const claimed = await db
      .select({
        userId: sessions.userId,
        deviceId: sessions.deviceId,
        label: sessions.deviceName,
      })
      .from(authSessions)
      .innerJoin(sessions, eq(sessions.sessionId, authSessions.authorizedSessionId))
      .where(
        and(
          eq(authSessions.purpose, 'device_sign_in'),
          eq(authSessions.status, 'consumed'),
          inArray(authSessions.applicationId, nonOfficialIds),
        ),
      );
    report.found.authSessions = claimed.length;
    for (const row of claimed) note(row.deviceId, row.userId, row.label);
  }

  // 2. The durable traces: the session the approval minted, and its `device_added`.
  if (!options.authSessionsOnly && labels.length > 0) {
    const minted = await db
      .select({ userId: sessions.userId, deviceId: sessions.deviceId, label: sessions.deviceName })
      .from(sessions)
      .where(and(isNull(sessions.applicationId), inArray(sessions.deviceName, labels)));
    const added = await db
      .select({
        userId: securityActivities.userId,
        deviceId: securityActivities.deviceId,
        label: sql<string>`${securityActivities.metadata}->>'deviceName'`,
      })
      .from(securityActivities)
      .where(
        and(
          eq(securityActivities.eventType, 'device_added'),
          sql`${securityActivities.metadata}->>'deviceName' in (${sql.join(
            labels.map((label) => sql`${label}`),
            sql`, `,
          )})`,
        ),
      );
    report.found.signInRecords = minted.length + added.length;
    for (const row of [...minted, ...added]) note(row.deviceId, row.userId, row.label);
  }

  report.devices = devices.size;
  const accounts = new Set<string>();
  for (const [deviceId, finding] of devices) {
    const access = await readAccess(db, deviceId);
    const live =
      access.activeSessionUserIds.length > 0 ||
      access.contextAccountIds.length > 0 ||
      access.credentials > 0;
    if (!live) continue;
    report.devicesWithAccess += 1;
    report.sessions += access.activeSessionUserIds.length;
    report.restoreSecrets += access.credentials;
    const affected = new Set<string>([
      ...finding.userIds,
      ...access.activeSessionUserIds,
      ...access.contextAccountIds,
    ]);
    for (const userId of affected) accounts.add(userId);
    if (!options.apply) continue;

    // Every account off the device, and its holder credentials, join codes and
    // background secret with them; then any session row the device still has.
    if (access.deviceSessionId) await deviceSessionService.signout(deviceId, { all: true });
    await revokeSessions(eq(sessions.deviceId, deviceId));

    for (const userId of affected) {
      const entry = await securityActivityService.logSecurityEvent({
        userId,
        eventType: 'device_removed',
        eventDescription: `Signed out of ${finding.label ?? 'a device sign-in'}: device sign-in is for official Oxy apps only`,
        metadata: {
          reason: THIRD_PARTY_DEVICE_SIGN_IN_REVOKED,
          ...(finding.label ? { deviceName: finding.label } : {}),
        },
        deviceId,
        severity: 'high',
      });
      if (entry) report.auditEntries += 1;
    }
  }
  report.accounts = accounts.size;
  return report;
}
