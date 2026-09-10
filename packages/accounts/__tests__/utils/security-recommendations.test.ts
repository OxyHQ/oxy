import type { ClientSession, SecurityActivity } from '@oxy.so/core';
import {
  selectSecurityRecommendations,
  countStaleSessions,
  countSuspiciousActivity,
  STALE_SESSION_DAYS,
  MANY_DEVICES_THRESHOLD,
  type SecurityRecommendationInput,
} from '@/utils/security-recommendations';

const NOW = Date.UTC(2026, 0, 1);
const DAY_MS = 1000 * 60 * 60 * 24;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function session(partial: Partial<ClientSession>): ClientSession {
  return { lastActive: daysAgo(1), isCurrent: true, ...partial } as ClientSession;
}

function activity(partial: Partial<SecurityActivity>): SecurityActivity {
  return {
    id: 'a',
    eventType: 'sign_in',
    eventDescription: 'Signed in',
    severity: 'low',
    timestamp: daysAgo(0),
    ...partial,
  } as SecurityActivity;
}

function baseInput(overrides: Partial<SecurityRecommendationInput> = {}): SecurityRecommendationInput {
  return {
    canEnableBiometric: false,
    biometricEnabled: false,
    biometricLoading: false,
    hasRecoveryEmail: true,
    sessions: [],
    deviceCount: 0,
    securityActivities: [],
    ...overrides,
  };
}

describe('countStaleSessions', () => {
  it('returns 0 for undefined or empty sessions', () => {
    expect(countStaleSessions(undefined, NOW)).toBe(0);
    expect(countStaleSessions([], NOW)).toBe(0);
  });

  it('counts only sessions older than the stale threshold', () => {
    const sessions = [
      session({ lastActive: daysAgo(STALE_SESSION_DAYS + 1) }),
      session({ lastActive: daysAgo(STALE_SESSION_DAYS - 1) }),
      session({ lastActive: daysAgo(STALE_SESSION_DAYS + 100) }),
    ];
    expect(countStaleSessions(sessions, NOW)).toBe(2);
  });

  it('ignores sessions with no lastActive or an invalid date', () => {
    const sessions = [
      session({ lastActive: undefined }),
      session({ lastActive: 'not-a-date' }),
    ];
    expect(countStaleSessions(sessions, NOW)).toBe(0);
  });
});

describe('countSuspiciousActivity', () => {
  it('counts critical-severity and suspicious_activity events', () => {
    const activities = [
      activity({ severity: 'critical' }),
      activity({ eventType: 'suspicious_activity', severity: 'low' }),
      activity({ severity: 'low' }),
    ];
    expect(countSuspiciousActivity(activities)).toBe(2);
  });

  it('returns 0 when there is nothing suspicious', () => {
    expect(countSuspiciousActivity([activity({ severity: 'low' })])).toBe(0);
  });
});

describe('selectSecurityRecommendations', () => {
  it('returns nothing for a fully-secured account', () => {
    expect(selectSecurityRecommendations(baseInput(), NOW)).toEqual([]);
  });

  it('recommends biometric only when it can be enabled, is off, and is not loading', () => {
    expect(
      selectSecurityRecommendations(
        baseInput({ canEnableBiometric: true, biometricEnabled: false, biometricLoading: false }),
        NOW,
      ).map((r) => r.id),
    ).toContain('biometric');

    expect(
      selectSecurityRecommendations(
        baseInput({ canEnableBiometric: true, biometricEnabled: false, biometricLoading: true }),
        NOW,
      ).map((r) => r.id),
    ).not.toContain('biometric');

    expect(
      selectSecurityRecommendations(
        baseInput({ canEnableBiometric: true, biometricEnabled: true }),
        NOW,
      ).map((r) => r.id),
    ).not.toContain('biometric');
  });

  it('recommends adding a recovery email when none is set', () => {
    const recs = selectSecurityRecommendations(baseInput({ hasRecoveryEmail: false }), NOW);
    expect(recs.map((r) => r.id)).toContain('recovery-email');
  });

  it('carries the stale-session count on the old-sessions recommendation', () => {
    const recs = selectSecurityRecommendations(
      baseInput({
        sessions: [
          session({ lastActive: daysAgo(STALE_SESSION_DAYS + 5) }),
          session({ lastActive: daysAgo(STALE_SESSION_DAYS + 5) }),
        ],
      }),
      NOW,
    );
    const old = recs.find((r) => r.id === 'old-sessions');
    expect(old?.count).toBe(2);
  });

  it('recommends reviewing devices only above the many-devices threshold', () => {
    expect(
      selectSecurityRecommendations(baseInput({ deviceCount: MANY_DEVICES_THRESHOLD }), NOW)
        .map((r) => r.id),
    ).not.toContain('many-devices');

    const recs = selectSecurityRecommendations(
      baseInput({ deviceCount: MANY_DEVICES_THRESHOLD + 1 }),
      NOW,
    );
    const many = recs.find((r) => r.id === 'many-devices');
    expect(many?.count).toBe(MANY_DEVICES_THRESHOLD + 1);
  });

  it('surfaces suspicious activity with its count', () => {
    const recs = selectSecurityRecommendations(
      baseInput({ securityActivities: [activity({ severity: 'critical' })] }),
      NOW,
    );
    const suspicious = recs.find((r) => r.id === 'suspicious-activity');
    expect(suspicious?.count).toBe(1);
  });

  it('orders recommendations by ascending priority, preserving push order within a tier', () => {
    // Trigger every recommendation at once.
    const recs = selectSecurityRecommendations(
      baseInput({
        canEnableBiometric: true, // priority 1, pushed first
        biometricEnabled: false,
        hasRecoveryEmail: false, // priority 1, pushed second
        sessions: [session({ lastActive: daysAgo(STALE_SESSION_DAYS + 5) })], // priority 2
        deviceCount: MANY_DEVICES_THRESHOLD + 1, // priority 3
        securityActivities: [activity({ severity: 'critical' })], // priority 0, pushed last
      }),
      NOW,
    );

    expect(recs.map((r) => r.id)).toEqual([
      'suspicious-activity',
      'biometric',
      'recovery-email',
      'old-sessions',
      'many-devices',
    ]);
    expect(recs.map((r) => r.priority)).toEqual([0, 1, 1, 2, 3]);
  });
});
