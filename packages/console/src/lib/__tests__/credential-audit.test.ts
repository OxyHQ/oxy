import { describe, expect, it } from 'vitest';
import type { CredentialAuditEvent } from '@/hooks/use-applications';
import {
  credentialAuditAttribution,
  credentialAuditVariant,
  humaniseAuditToken,
} from '@/lib/credential-audit';

/**
 * The fixtures are the endpoint's OWN captured response, not a shape invented
 * here — which is the whole reason this UI waited for the route to land. A
 * fixture authored from an assumption would assert the assumption.
 *
 * Captured from `GET /applications/:appId/credentials/:credId/audit`:
 *
 *     {"data":[{"eventType":"validation_failed","reason":"scope_missing",
 *               "actorUserId":null,"environment":"development",
 *               "createdAt":"2026-08-17T15:06:17.413Z","effectiveUntil":null},
 *              {"eventType":"rotated","reason":null,
 *               "actorUserId":"01a01042-…","environment":"development",
 *               "createdAt":"2026-08-17T15:06:17.407Z","effectiveUntil":null}],
 *      "count":3}
 *
 * Note there is no `metadata` key to omit: the server's wire type has no such
 * property, so its absence here reflects the contract rather than a projection.
 */
const REFUSAL: CredentialAuditEvent = {
  eventType: 'validation_failed',
  reason: 'scope_missing',
  actorUserId: null,
  environment: 'development',
  createdAt: '2026-08-17T15:06:17.413Z',
  effectiveUntil: null,
};

const ROTATION: CredentialAuditEvent = {
  eventType: 'rotated',
  reason: null,
  actorUserId: '01a01042-0000-7000-8000-000000000000',
  environment: 'development',
  createdAt: '2026-08-17T15:06:17.407Z',
  effectiveUntil: null,
};

describe('credentialAuditAttribution', () => {
  /**
   * The bug this function exists to prevent. `actorUserId` is null on a refusal,
   * so reading a null actor as "by a service credential" would invent an actor
   * for an event that has none, and would report a turned-away request as a
   * machine having rotated a key.
   *
   * The BYOK trail beside this one used to make exactly that inference, and this
   * comment used to call it correct there. It was not: a `platform` event is also
   * null-actored, and every `used` event is one. That trail now reads `actorKind`
   * (`lib/provider-connection.ts`), so neither surface infers an actor from a
   * null id.
   */
  it('never attributes a refused validation to an actor, even though its actor is null', () => {
    expect(REFUSAL.actorUserId).toBeNull();
    expect(credentialAuditAttribution(REFUSAL)).toBe('a refused request');
    expect(credentialAuditAttribution(REFUSAL)).not.toContain('service');
    expect(credentialAuditAttribution(REFUSAL)).not.toContain('member');
  });

  /**
   * The positive control: a transition IS attributed to a member. Without it,
   * a function that returned "a refused request" for everything would satisfy
   * the assertion above.
   */
  it('attributes every transition to a member', () => {
    expect(credentialAuditAttribution(ROTATION)).toBe('by a member');
    for (const eventType of ['created', 'rotated', 'revoked'] as const) {
      expect(credentialAuditAttribution({ eventType })).toBe('by a member');
    }
  });

  /**
   * Keyed off `eventType`, not off the nullness of `actorUserId` — asserted by
   * feeding the two fields in DISAGREEMENT. A correct implementation ignores the
   * actor entirely; one that read the actor would answer differently here.
   */
  it('reads the event type rather than the actor', () => {
    expect(credentialAuditAttribution({ eventType: 'validation_failed' })).toBe(
      'a refused request'
    );
    expect(credentialAuditAttribution({ eventType: 'revoked' })).toBe('by a member');
  });
});

describe('credentialAuditVariant', () => {
  it('marks only a refused validation as a problem', () => {
    expect(credentialAuditVariant(REFUSAL)).toBe('destructive');
    for (const eventType of ['created', 'rotated', 'revoked'] as const) {
      expect(credentialAuditVariant({ eventType })).toBe('outline');
    }
  });
});

describe('humaniseAuditToken', () => {
  it('renders every value of both closed enums legibly', () => {
    // Both enums, in full, from the server's own tuples. A value added to either
    // one renders through the same rule rather than needing a mapping entry.
    expect(
      ['created', 'rotated', 'revoked', 'validation_failed'].map(humaniseAuditToken)
    ).toEqual(['created', 'rotated', 'revoked', 'validation failed']);
    expect(
      [
        'secret_mismatch',
        'not_usable',
        'environment_mismatch',
        'application_inactive',
        'scope_missing',
      ].map(humaniseAuditToken)
    ).toEqual([
      'secret mismatch',
      'not usable',
      'environment mismatch',
      'application inactive',
      'scope missing',
    ]);
  });

  it('does not invent a friendlier name than the API uses', () => {
    // The rendered words stay the words a support conversation will quote, so
    // only the separator changes.
    expect(humaniseAuditToken('scope_missing')).toBe('scope missing');
    expect(humaniseAuditToken('scope_missing')).not.toBe('Missing scope');
  });
});
