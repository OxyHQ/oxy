import {
  NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS,
  nativeProductAgentRollbackOperations,
  nativeProductBootstrapPlanSha256,
  requireNativeProductBootstrapApproval,
  retiredServiceCredentialDecision,
  type NativeProductBootstrapPlan,
} from '../nativeProductAgentsBootstrapPlan';

const plan: NativeProductBootstrapPlan = {
  manifestVersion: 1,
  direction: 'bootstrap',
  desired: { scopes: ['user:read'], redirectUris: ['https://example.test'] },
  before: { app: null },
  after: {
    app: { scopes: ['user:read'], redirectUris: ['https://example.test'] },
  },
  aliaManifest: { agents: [{ id: 'agent-1', applicationId: 'app-1' }] },
  operations: ['insert account by pk', 'move app by pk'],
};

describe('native product agent bootstrap approval', () => {
  it('hashes the reviewed plan deterministically', () => {
    expect(nativeProductBootstrapPlanSha256(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeProductBootstrapPlanSha256(plan)).toBe(
      nativeProductBootstrapPlanSha256({
        ...plan,
        operations: [...plan.operations],
      }),
    );
  });

  it('changes the approval hash when permissions, redirects or Alia bindings change', () => {
    const hash = nativeProductBootstrapPlanSha256(plan);
    expect(
      nativeProductBootstrapPlanSha256({
        ...plan,
        desired: {
          scopes: ['user:read', 'inference:invoke'],
          redirectUris: ['https://example.test'],
        },
      }),
    ).not.toBe(hash);
    expect(
      nativeProductBootstrapPlanSha256({
        ...plan,
        desired: { scopes: ['user:read'], redirectUris: ['example://'] },
      }),
    ).not.toBe(hash);
    expect(
      nativeProductBootstrapPlanSha256({
        ...plan,
        aliaManifest: { agents: [{ id: 'agent-1', applicationId: 'app-2' }] },
      }),
    ).not.toBe(hash);
  });

  it('requires exact actor, reason and observed plan hash for apply', () => {
    const hash = nativeProductBootstrapPlanSha256(plan);
    expect(
      requireNativeProductBootstrapApproval(hash, {
        BOOTSTRAP_ACTOR: 'release-bot',
        BOOTSTRAP_REASON: 'OPS-123 reviewed bootstrap',
        EXPECTED_PLAN_SHA256: hash,
      }),
    ).toEqual({ actor: 'release-bot', reason: 'OPS-123 reviewed bootstrap' });
  });

  it.each([
    {},
    {
      BOOTSTRAP_ACTOR: ' release-bot',
      BOOTSTRAP_REASON: 'OPS-123',
      EXPECTED_PLAN_SHA256: 'x',
    },
    {
      BOOTSTRAP_ACTOR: 'release-bot',
      BOOTSTRAP_REASON: 'OPS-123 ',
      EXPECTED_PLAN_SHA256: 'x',
    },
    {
      BOOTSTRAP_ACTOR: 'release-bot',
      BOOTSTRAP_REASON: 'OPS-123',
      EXPECTED_PLAN_SHA256: '0'.repeat(64),
    },
  ])('fails closed for incomplete or mismatched apply approval: %j', (env) => {
    expect(() => requireNativeProductBootstrapApproval('1'.repeat(64), env)).toThrow();
  });

  it('keeps product projects and the existing Homiio application out of rollback', () => {
    expect(NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS).toEqual([
      'archive-private-bot',
      'suspend-created-clarity-app',
      'revoke-created-clarity-credential',
      'deactivate-alia-agent',
    ]);
    expect(NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS).not.toContain('archive-project' as never);
    expect(NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS).not.toContain(
      'suspend-homiio-app' as never,
    );
    const operations = nativeProductAgentRollbackOperations({
      homiioBotId: 'sindi-bot',
      homiioSindiCredentialId: 'sindi-credential',
      clarityBotId: 'clarity-bot',
      clarityApplicationId: 'clarity-app',
      clarityCredentialId: 'clarity-credential',
      clarityBackendApplicationId: 'clarity-backend-app',
      clarityBackendCredentialId: 'clarity-backend-credential',
      homiioAgentId: 'sindi-agent',
      clarityAgentId: 'clarity-agent',
    });
    expect(operations.join('\n')).not.toContain('homiio-project');
    expect(operations.join('\n')).not.toContain('homiio-app');
    expect(operations).toEqual([
      'archive-private account sindi-bot',
      'revoke credential sindi-credential',
      'archive-private account clarity-bot',
      'suspend application clarity-app',
      'revoke credential clarity-credential',
      'suspend application clarity-backend-app',
      'revoke credential clarity-backend-credential',
      'deactivate-in-alia agent sindi-agent',
      'deactivate-in-alia agent clarity-agent',
    ]);
  });

  describe('retiring a native-agent service credential (ADR 0026)', () => {
    const SINDI_SCOPES = ['inference:invoke', 'acting-as:offline'];
    const liveWith = (scopes: readonly string[]) => ({ live: true as const, scopes });

    it('revokes a live credential once its workload is bound live with every scope it carried', () => {
      for (const status of ['active', 'deprecated', 'pending']) {
        expect(
          retiredServiceCredentialDecision({
            credentialStatus: status,
            workload: liveWith(['inference:invoke', 'acting-as:offline', 'user:read']),
            requiredScopes: SINDI_SCOPES,
          }),
        ).toEqual({ disposition: 'revoke' });
      }
    });

    /**
     * The order ADR 0026 makes a precondition: bind with scopes, THEN remove the
     * pair. Revoking first is how Mention lost `federation:write` in production.
     */
    it('refuses to revoke while the replacing workload is not live', () => {
      expect(
        retiredServiceCredentialDecision({
          credentialStatus: 'active',
          workload: { live: false },
          requiredScopes: SINDI_SCOPES,
        }),
      ).toEqual({ refusal: 'workload_not_live' });
    });

    it('refuses to revoke while the workload lacks a scope the credential carried', () => {
      expect(
        retiredServiceCredentialDecision({
          credentialStatus: 'active',
          workload: liveWith(['inference:invoke']),
          requiredScopes: SINDI_SCOPES,
        }),
      ).toEqual({ refusal: 'workload_missing_scope' });
    });

    /**
     * Nothing to protect, so nothing to require: a fresh environment, where the
     * Clarity backend application (and so any binding to it) is created by this
     * very run, must still bootstrap — and it never creates the credential.
     */
    it('leaves an absent credential absent and a revoked one revoked, whatever the workload', () => {
      for (const workload of [{ live: false } as const, liveWith([])]) {
        expect(
          retiredServiceCredentialDecision({
            credentialStatus: null,
            workload,
            requiredScopes: SINDI_SCOPES,
          }),
        ).toEqual({ disposition: 'absent' });
        expect(
          retiredServiceCredentialDecision({
            credentialStatus: 'revoked',
            workload,
            requiredScopes: SINDI_SCOPES,
          }),
        ).toEqual({ disposition: 'already_revoked' });
      }
    });
  });
});
