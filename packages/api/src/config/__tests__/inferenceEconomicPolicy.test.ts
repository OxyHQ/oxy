/**
 * The economic treatment decision (#1526, I09) is a pure function of the
 * AUTHENTICATED principal. These cases pin what selects `internal_metered` and,
 * more importantly, everything that does not.
 */

import {
  ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
  INFERENCE_ECONOMIC_POLICY_VERSION,
  INTERNAL_METERED_RELATIONSHIPS,
  resolveEconomicTreatment,
  type EconomicTreatmentPrincipal,
} from '../inferenceEconomicPolicy';
import { ALIA_APPLICATION_ID } from '../../scripts/seedOxyApplicationsSpecs';

const alia: EconomicTreatmentPrincipal = {
  lane: 'service_token',
  applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
  environment: 'production',
  applicationIsInternal: true,
};

describe('resolveEconomicTreatment', () => {
  it('pins the same Alia application id the seed provisions', () => {
    expect(ALIA_INFERENCE_CONSUMER_APPLICATION_ID).toBe(ALIA_APPLICATION_ID);
  });

  it('treats the configured Alia → Kaana relationship as internal_metered, stamped with the policy version', () => {
    const decision = resolveEconomicTreatment(alia);
    expect(decision).toMatchObject({
      treatment: 'internal_metered',
      policyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
      relationship: { relationshipId: 'alia-kaana', consumerProduct: 'alia', providerProduct: 'kaana' },
    });
  });

  it('is commercial for every principal the policy does not name', () => {
    expect(resolveEconomicTreatment({ ...alia, applicationId: 'some-customer-app' }).treatment).toBe('commercial');
  });

  it('is commercial on any lane other than the service-token lane, for the same application', () => {
    expect(resolveEconomicTreatment({ ...alia, lane: 'machine_credential' }).treatment).toBe('commercial');
    expect(resolveEconomicTreatment({ ...alia, lane: 'product_session' }).treatment).toBe('commercial');
  });

  it('is commercial in an environment the relationship does not list', () => {
    expect(resolveEconomicTreatment({ ...alia, environment: 'development' }).treatment).toBe('commercial');
    expect(resolveEconomicTreatment({ ...alia, environment: 'staging' }).treatment).toBe('commercial');
  });

  it('is commercial the moment the application stops being internal, whatever the file says', () => {
    expect(resolveEconomicTreatment({ ...alia, applicationIsInternal: false }).treatment).toBe('commercial');
    expect(resolveEconomicTreatment({ ...alia, applicationIsInternal: null }).treatment).toBe('commercial');
  });

  it('ignores request-borne facts even when a caller smuggles them onto the principal object', () => {
    const customer = { ...alia, applicationId: 'some-customer-app' };
    const forged = {
      ...customer,
      economicTreatment: 'internal_metered',
      accountKind: 'bot',
      agentId: 'agent-1',
      delegatedUserId: 'alia-owner',
      applicationType: 'internal',
    } as EconomicTreatmentPrincipal;
    expect(resolveEconomicTreatment(forged).treatment).toBe('commercial');
  });

  it('declares technical capacity for every internal relationship', () => {
    for (const relationship of INTERNAL_METERED_RELATIONSHIPS) {
      expect(relationship.capacity.maxConcurrentRequests).toBeGreaterThan(0);
      expect(relationship.capacity.maxRequestsPerUtcDay).toBeGreaterThan(0);
    }
  });
});
