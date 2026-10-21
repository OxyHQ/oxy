import {
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SERVICE_EVENTS_HEARTBEAT_MS,
  OXY_SERVICE_EVENTS_NAMESPACE,
  OXY_SERVICE_EVENTS_STALE_AFTER_MS,
  OXY_SESSION_REVOKED_EVENT,
  oxyServiceEventsHeartbeatSchema,
  oxySessionRevocationEventSchema,
} from '../index';

describe('@oxy.so/contracts sessionRevocation', () => {
  it('pins the wire names', () => {
    // oxy-api and every SDK release in the field address each other by these
    // literals; a rename is a feed that silently never arrives.
    expect(OXY_SERVICE_EVENTS_NAMESPACE).toBe('/service-events');
    expect(OXY_SESSION_REVOKED_EVENT).toBe('session:revoked');
    expect(OXY_SERVICE_EVENTS_HEARTBEAT_EVENT).toBe('heartbeat');
  });

  it('declares a feed stale only after more than two missed heartbeats', () => {
    expect(OXY_SERVICE_EVENTS_STALE_AFTER_MS).toBeGreaterThan(2 * OXY_SERVICE_EVENTS_HEARTBEAT_MS);
  });

  it('accepts a session-level and a user-level revocation', () => {
    expect(
      oxySessionRevocationEventSchema.safeParse({ sessionId: 's-1', userId: 'u-1', at: 1 }).success,
    ).toBe(true);
    expect(oxySessionRevocationEventSchema.safeParse({ userId: 'u-1', at: 1 }).success).toBe(true);
  });

  it('rejects a revocation without an account, or with an empty session id', () => {
    expect(oxySessionRevocationEventSchema.safeParse({ sessionId: 's-1', at: 1 }).success).toBe(
      false,
    );
    expect(
      oxySessionRevocationEventSchema.safeParse({ sessionId: '', userId: 'u-1', at: 1 }).success,
    ).toBe(false);
    expect(oxySessionRevocationEventSchema.safeParse({ userId: 'u-1', at: -1 }).success).toBe(
      false,
    );
  });

  it('parses a heartbeat', () => {
    expect(oxyServiceEventsHeartbeatSchema.safeParse({ at: 5 }).success).toBe(true);
    expect(oxyServiceEventsHeartbeatSchema.safeParse({}).success).toBe(false);
  });
});
