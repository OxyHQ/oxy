/**
 * The routing-policy side of power levels: an allowed-profile list, the
 * same-model failover default, and route-switch records authorized by a
 * routing profile or (for a deployment switch) by the platform default.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import {
  createRoutingPolicy,
  getRoutingPolicy,
  recordRouteSwitch,
  type RoutingPolicyControls,
} from '../inferenceRoutingPolicy.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const tag = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

async function accountAndApplication(): Promise<{ accountId: string; applicationId: string }> {
  const t = tag();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `rpp-${t}`, email: `rpp-${t}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `RPP ${t}`, ownerAccountId: account.id })
    .returning({ id: applications.id });
  return { accountId: account.id, applicationId: application.id };
}

function controls(overrides: Partial<RoutingPolicyControls> = {}): RoutingPolicyControls {
  return {
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    optimiseFor: 'price',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: { disabled: false, authorizedCrossModel: [] },
    allowedRoutingProfileIds: [],
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
    ...overrides,
  };
}

describe('allowedRoutingProfileIds', () => {
  it('round-trips, with the default level inside the list', async () => {
    const { accountId, applicationId } = await accountAndApplication();
    const written = await createRoutingPolicy({
      target: { kind: 'application', accountId, applicationId },
      controls: controls({
        defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-instant' },
        allowedRoutingProfileIds: ['power-instant', 'power-medium'],
      }),
      createdByUserId: accountId,
    });
    expect(written.status).toBe('written');
    if (written.status !== 'written') return;
    const read = await getRoutingPolicy(written.policy.routingPolicyId);
    expect(read?.policy.allowedRoutingProfileIds).toEqual(['power-instant', 'power-medium']);
    expect(read?.policy.defaultTarget).toEqual({
      kind: 'routing_profile_id',
      routingProfileId: 'power-instant',
    });
  });

  it('refuses a default level the list itself forbids', async () => {
    const { accountId, applicationId } = await accountAndApplication();
    const result = await createRoutingPolicy({
      target: { kind: 'application', accountId, applicationId },
      controls: controls({
        defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-high' },
        allowedRoutingProfileIds: ['power-instant'],
      }),
      createdByUserId: accountId,
    });
    expect(result.status).toBe('invalid');
  });

  it('refuses an id that is not a routing profile', async () => {
    const { accountId, applicationId } = await accountAndApplication();
    const result = await createRoutingPolicy({
      target: { kind: 'application', accountId, applicationId },
      controls: controls({ allowedRoutingProfileIds: ['power-nonexistent'] }),
      createdByUserId: accountId,
    });
    expect(result.status).not.toBe('written');
  });
});

describe('same-model deployment failover', () => {
  it('is stored ON when a policy omits it, and OFF when the policy says so', async () => {
    const omitted = await accountAndApplication();
    const on = await createRoutingPolicy({
      target: { kind: 'application', ...omitted },
      controls: controls(),
      createdByUserId: omitted.accountId,
    });
    const optedOut = await accountAndApplication();
    const off = await createRoutingPolicy({
      target: { kind: 'application', ...optedOut },
      controls: controls({
        fallback: { disabled: false, sameModelDeployment: false, authorizedCrossModel: [] },
      }),
      createdByUserId: optedOut.accountId,
    });
    if (on.status !== 'written' || off.status !== 'written') throw new Error('not written');
    expect(
      (await getRoutingPolicy(on.policy.routingPolicyId))?.policy.fallback.sameModelDeployment,
    ).toBe(true);
    expect(
      (await getRoutingPolicy(off.policy.routingPolicyId))?.policy.fallback.sameModelDeployment,
    ).toBe(false);
  });
});

describe('route switches authorized by a profile or the platform default', () => {
  const base = async () => {
    const { accountId, applicationId } = await accountAndApplication();
    return {
      requestId: `req-${tag()}`,
      sequence: 0,
      accountId,
      applicationId,
      environment: 'development' as const,
      reason: 'provider_error' as const,
      occurredAt: new Date(),
    };
  };

  it('records a model switch onto a line the profile signed', async () => {
    const result = await recordRouteSwitch({
      ...(await base()),
      routingProfile: {
        routingProfileId: 'power-instant',
        authorizedModelLines: ['pub/a', 'pub/b'],
      },
      detail: {
        scope: 'model',
        requestedModelId: 'pub/a',
        fromModelReference: 'pub/a@r1',
        toModelReference: 'pub/b@r1',
        toProvider: 'prv',
      },
    });
    expect(result.status).toBe('recorded');
  });

  it('refuses a model switch onto a line the profile did not sign', async () => {
    const result = await recordRouteSwitch({
      ...(await base()),
      routingProfile: { routingProfileId: 'power-instant', authorizedModelLines: ['pub/a'] },
      detail: {
        scope: 'model',
        requestedModelId: 'pub/a',
        fromModelReference: 'pub/a@r1',
        toModelReference: 'pub/c@r1',
        toProvider: 'prv',
      },
    });
    expect(result.status).toBe('unauthorized-substitution');
  });

  it('records a platform-default deployment switch, and refuses a platform-default model switch', async () => {
    const deployment = await recordRouteSwitch({
      ...(await base()),
      detail: { scope: 'deployment', modelReference: 'pub/a@r1', toProvider: 'prv' },
    });
    expect(deployment.status).toBe('recorded');
    const model = await recordRouteSwitch({
      ...(await base()),
      detail: {
        scope: 'model',
        requestedModelId: 'pub/a',
        fromModelReference: 'pub/a@r1',
        toModelReference: 'pub/b@r1',
        toProvider: 'prv',
      },
    });
    expect(model.status).toBe('unauthorized-substitution');
  });
});
