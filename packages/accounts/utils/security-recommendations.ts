import type { ClientSession, SecurityActivity } from '@oxy.so/core';

/** Stable identifier for each security recommendation the app can surface. */
export type SecurityRecommendationId =
  | 'biometric'
  | 'recovery-email'
  | 'old-sessions'
  | 'many-devices'
  | 'suspicious-activity';

/** A recommendation the app should surface, with its sort priority and any computed count. */
export interface SecurityRecommendationDescriptor {
  id: SecurityRecommendationId;
  /** Lower numbers sort first (more urgent). */
  priority: number;
  /** Count associated with the recommendation (e.g. old sessions, suspicious events). */
  count?: number;
}

/** Inputs that drive which security recommendations are surfaced. */
export interface SecurityRecommendationInput {
  canEnableBiometric: boolean;
  biometricEnabled: boolean;
  biometricLoading: boolean;
  hasRecoveryEmail: boolean;
  sessions: ClientSession[] | undefined;
  deviceCount: number;
  securityActivities: SecurityActivity[];
}

/** Sessions older than this many days are flagged as stale. */
export const STALE_SESSION_DAYS = 30;
/** A device count above this is surfaced as an informational recommendation. */
export const MANY_DEVICES_THRESHOLD = 5;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Counts sessions whose `lastActive` is older than {@link STALE_SESSION_DAYS}.
 * Sessions without a `lastActive` timestamp are not counted.
 *
 * @param now - Current epoch millis (injectable for deterministic tests).
 */
export function countStaleSessions(
  sessions: ClientSession[] | undefined,
  now: number = Date.now(),
): number {
  if (!sessions) return 0;
  return sessions.filter((s) => {
    if (!s.lastActive) return false;
    const lastActive = new Date(s.lastActive).getTime();
    if (Number.isNaN(lastActive)) return false;
    return (now - lastActive) / MS_PER_DAY > STALE_SESSION_DAYS;
  }).length;
}

/** Counts recent activities that are critical or flagged as suspicious. */
export function countSuspiciousActivity(securityActivities: SecurityActivity[]): number {
  if (!securityActivities) return 0;
  return securityActivities.filter(
    (activity) =>
      activity.severity === 'critical' ||
      activity.eventType === 'suspicious_activity',
  ).length;
}

/**
 * Pure decision logic for the security screen's recommendations: decides which
 * recommendations to surface and in what order (ascending priority), without
 * any knowledge of icons, colors, copy, or navigation.
 *
 * Extracted from the security screen so the "what & in what order" logic — the
 * most branching-heavy part of the screen — can be unit tested in isolation.
 * The hook (`useSecurityRecommendations`) maps each descriptor to a rendered
 * `GroupedSection` row.
 *
 * @param now - Current epoch millis (injectable for deterministic tests).
 */
export function selectSecurityRecommendations(
  input: SecurityRecommendationInput,
  now: number = Date.now(),
): SecurityRecommendationDescriptor[] {
  const recommendations: SecurityRecommendationDescriptor[] = [];

  // 1. Biometric available but not enabled (high priority).
  if (input.canEnableBiometric && !input.biometricEnabled && !input.biometricLoading) {
    recommendations.push({ id: 'biometric', priority: 1 });
  }

  // 2. Recovery email missing (high priority).
  if (!input.hasRecoveryEmail) {
    recommendations.push({ id: 'recovery-email', priority: 1 });
  }

  // 3. Old/inactive sessions (medium priority).
  const oldSessionsCount = countStaleSessions(input.sessions, now);
  if (oldSessionsCount > 0) {
    recommendations.push({ id: 'old-sessions', priority: 2, count: oldSessionsCount });
  }

  // 4. Many devices (low priority - informational).
  if (input.deviceCount > MANY_DEVICES_THRESHOLD) {
    recommendations.push({ id: 'many-devices', priority: 3, count: input.deviceCount });
  }

  // 5. Suspicious activity (critical priority).
  const suspiciousCount = countSuspiciousActivity(input.securityActivities);
  if (suspiciousCount > 0) {
    recommendations.push({ id: 'suspicious-activity', priority: 0, count: suspiciousCount });
  }

  // Sort by priority (lower number = higher priority). Stable per spec in V8.
  return recommendations.sort((a, b) => a.priority - b.priority);
}
