import { describe, expect, it } from 'vitest';
import { providerConnectionSchema, providerConnectionScopeSchema } from '@oxyhq/contracts';
import type { ProviderConnection } from '@oxyhq/contracts';
import {
  KAANA_CREDENTIAL_CONTROL_UNAVAILABLE,
  connectionAppliesToApplication,
  connectionStatusVariant,
  isKaanaCredentialControlUnavailable,
  providerConnectionAuditAttribution,
  providerConnectionScopeLabel,
  shortFingerprint,
  toProviderConnectionView,
} from '@/lib/provider-connection';

/**
 * The connection is built through the CONTRACT's own schema rather than as a
 * hand-written literal.
 *
 * That is the point of the test: a field the contract adds appears here without
 * anybody editing the fixture, so the "no Kaana handle reaches the view" assertion
 * below is made against the real shape and not against a copy that stopped
 * matching it.
 *
 * The Kaana handle is opaque and valid only as a paired handle/revision.
 */
function connection(overrides: Record<string, unknown> = {}): ProviderConnection {
  const fields = {
    schemaVersion: 1,
    connectionId: 'conn_1',
    provider: 'example-provider',
    ownerAccountId: 'acct_1',
    scope: { kind: 'application', accountId: 'acct_1', applicationId: 'app_1' },
    environment: 'production',
    status: 'active',
    custodyState: 'ready',
    credentialHandle: `kcred_${'a'.repeat(26)}`,
    credentialRevision: 1,
    keyPrefix: 'sk-live-abc',
    fingerprint: 'a'.repeat(64),
    validation: { state: 'valid', lastValidatedAt: '2026-08-01T00:00:00.000Z' },
    upstreamBillsCustomerDirectly: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };

  return providerConnectionSchema.parse(fields);
}

describe('toProviderConnectionView', () => {
  it('drops the Kaana handle and revision entirely', () => {
    const view = toProviderConnectionView(connection());

    expect(Object.hasOwn(view, 'credentialHandle')).toBe(false);
    expect(Object.hasOwn(view, 'credentialRevision')).toBe(false);
    // The whole point: no property anywhere on the view holds the reference,
    // however it might have been renamed on the way through.
    expect(JSON.stringify(view)).not.toContain('kcred_');
  });

  it('keeps the two fields the contract exists to make showable', () => {
    const view = toProviderConnectionView(connection());

    expect(view.keyPrefix).toBe('sk-live-abc');
    expect(view.fingerprint).toBe('a'.repeat(64));
    expect(view.validation.state).toBe('valid');
  });

  it('carries the optional fields through when the connection has them', () => {
    const view = toProviderConnectionView(
      connection({
        rotatedAt: '2026-08-02T00:00:00.000Z',
        termsAcknowledgedAt: '2026-07-01T00:00:00.000Z',
      })
    );

    expect(view.rotatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(view.termsAcknowledgedAt).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('isKaanaCredentialControlUnavailable', () => {
  it('is true only for the API code, never for a lookalike message', () => {
    const refused = Object.assign(new Error('no store configured'), {
      code: KAANA_CREDENTIAL_CONTROL_UNAVAILABLE,
    });
    const somethingElse = Object.assign(
      new Error('kaana_credential_control_unavailable happened, apparently'),
      { code: 'internal_error' }
    );

    expect(isKaanaCredentialControlUnavailable(refused)).toBe(true);
    expect(isKaanaCredentialControlUnavailable(somethingElse)).toBe(false);
    expect(isKaanaCredentialControlUnavailable(new Error('boom'))).toBe(false);
    expect(isKaanaCredentialControlUnavailable('kaana_credential_control_unavailable')).toBe(false);
    expect(isKaanaCredentialControlUnavailable(undefined)).toBe(false);
  });
});

describe('connectionAppliesToApplication', () => {
  const app = 'app_1';
  const owner = 'acct_1';

  it('matches an application-scoped connection only for its own application', () => {
    const own = toProviderConnectionView(connection());
    const other = toProviderConnectionView(
      connection({ scope: { kind: 'application', accountId: owner, applicationId: 'app_2' } })
    );

    expect(connectionAppliesToApplication(own, app, owner)).toBe(true);
    expect(connectionAppliesToApplication(other, app, owner)).toBe(false);
  });

  it('matches account- and project-scoped connections on the owning account', () => {
    const accountScoped = toProviderConnectionView(
      connection({ scope: { kind: 'account', accountId: owner } })
    );
    const projectScoped = toProviderConnectionView(
      connection({ scope: { kind: 'project', accountId: owner } })
    );
    const elsewhere = toProviderConnectionView(
      connection({ ownerAccountId: 'acct_2', scope: { kind: 'account', accountId: 'acct_2' } })
    );

    expect(connectionAppliesToApplication(accountScoped, app, owner)).toBe(true);
    expect(connectionAppliesToApplication(projectScoped, app, owner)).toBe(true);
    expect(connectionAppliesToApplication(elsewhere, app, owner)).toBe(false);
  });
});

describe('presentation helpers', () => {
  it('names each scope by what it means for inheritance', () => {
    const scope = (value: Record<string, unknown>) => providerConnectionScopeSchema.parse(value);

    expect(providerConnectionScopeLabel(scope({ kind: 'account', accountId: 'a' }))).toContain(
      'inherited'
    );
    expect(providerConnectionScopeLabel(scope({ kind: 'project', accountId: 'a' }))).toBe(
      'Project only'
    );
    expect(
      providerConnectionScopeLabel(
        scope({ kind: 'application', accountId: 'a', applicationId: 'b' })
      )
    ).toBe('This application only');
  });

  it('tones a revoked connection differently from a disabled one', () => {
    expect(connectionStatusVariant('active')).toBe('default');
    expect(connectionStatusVariant('revoked')).toBe('destructive');
    expect(connectionStatusVariant('disabled')).toBe('secondary');
    expect(connectionStatusVariant('pending_validation')).toBe('secondary');
  });

  it('shortens a fingerprint without ever lengthening it', () => {
    const full = 'a'.repeat(64);
    expect(shortFingerprint(full)).toHaveLength(12);
    expect(full.startsWith(shortFingerprint(full))).toBe(true);
  });
});

/**
 * Attribution in the BYOK audit trail (#972, #1057).
 *
 * These fixtures are the SERVER's shapes, taken from the pairs
 * `inference_provider_connection_audit_events`' CHECK admits — `('user', <id>)`,
 * `('service', null)`, `('platform', null)` and, for rows predating `0049`,
 * `(null, …)`. The `platform` case is the one that was rendered wrongly, so it
 * is the one these assertions are built around: a suite that exercised only
 * `user` and `service` would pass with the fix reverted, which is the same
 * failure the label itself had.
 */
describe('providerConnectionAuditAttribution', () => {
  it('does not call the platform a service credential, though both have a null actor id', () => {
    const platform = { actorKind: 'platform', actorUserId: null } as const;
    const service = { actorKind: 'service', actorUserId: null } as const;

    // The premise of the old inference: these two are indistinguishable by id.
    expect(platform.actorUserId).toBeNull();
    expect(service.actorUserId).toBeNull();

    // And they must still read differently, which is what the id cannot give.
    expect(providerConnectionAuditAttribution(platform)).toBe('by the platform');
    expect(providerConnectionAuditAttribution(service)).toBe('by a service credential');
    expect(providerConnectionAuditAttribution(platform)).not.toBe(
      providerConnectionAuditAttribution(service)
    );
  });

  it('reads the KIND, not the id: a user row with no id is still a member', () => {
    // Not a state the server's CHECK permits — deliberately. It is the control
    // that proves the label comes from `actorKind`: under the old null-check
    // this returns "by a service credential", so this assertion fails if the
    // function ever goes back to reading the id first.
    expect(providerConnectionAuditAttribution({ actorKind: 'user', actorUserId: null })).toBe(
      'by a member'
    );
  });

  it('attributes a member action to a member', () => {
    expect(
      providerConnectionAuditAttribution({ actorKind: 'user', actorUserId: 'usr_1' })
    ).toBe('by a member');
  });

  it('falls back to the id only for rows written before the column existed', () => {
    expect(providerConnectionAuditAttribution({ actorKind: null, actorUserId: null })).toBe(
      'by a service credential'
    );
    expect(providerConnectionAuditAttribution({ actorKind: null, actorUserId: 'usr_1' })).toBe(
      'by a member'
    );
  });
});
