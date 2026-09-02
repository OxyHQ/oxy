import {
  KAANA_INITIAL_INVENTORY_SNAPSHOT_ID,
  KAANA_INITIAL_MODEL_REFERENCE,
  KAANA_INITIAL_PROVIDERS,
} from '../kaanaInitialCatalogue';
import {
  assertKaanaInventoryCredentialSource,
  validateKaanaInitialInventory,
} from '../kaanaInitialInventory';

const NOW = Date.parse('2026-09-02T06:00:00.000Z');

function inventory(): Record<string, unknown> {
  return {
    snapshotId: KAANA_INITIAL_INVENTORY_SNAPSHOT_ID,
    issuedAt: '2026-09-02T05:55:43.571Z',
    deployments: [
      ...KAANA_INITIAL_PROVIDERS.map((provider) => ({
        deploymentId: provider.deploymentId,
        provider: provider.slug,
        modelReference: KAANA_INITIAL_MODEL_REFERENCE,
        upstreamModelId: provider.upstreamModelId,
        current: true,
      })),
      {
        deploymentId: 'dep_unrelated_exact_id',
        provider: 'another-provider',
        modelReference: 'another/model@revision',
        upstreamModelId: 'upstream-id',
        current: true,
        regions: ['us-west-2'],
      },
    ],
  };
}

describe('the versioned live Kaana inventory bootstrap gate', () => {
  it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])(
    'refuses static credential env %s',
    (name) => {
      expect(() => assertKaanaInventoryCredentialSource({ [name]: 'static-secret' })).toThrow(
        /Static AWS credential env/
      );
    }
  );

  it('allows a named local profile or the implicit ECS task-role provider', () => {
    expect(() => assertKaanaInventoryCredentialSource({ AWS_PROFILE: 'oxy' })).not.toThrow();
    expect(() =>
      assertKaanaInventoryCredentialSource({
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
      })
    ).not.toThrow();
  });

  it('accepts the reviewed exact identities and unrelated routes', () => {
    expect(validateKaanaInitialInventory(inventory(), 'version-1', NOW)).toMatchObject({
      snapshotId: KAANA_INITIAL_INVENTORY_SNAPSHOT_ID,
      versionId: 'version-1',
    });
  });

  it.each([
    ['snapshot', (value: Record<string, unknown>) => (value.snapshotId = 'snap_changed')],
    [
      'missing exact ID',
      (value: Record<string, unknown>) =>
        ((value.deployments as Record<string, unknown>[])[0]!.deploymentId = 'dep_missing'),
    ],
    [
      'provider mismatch',
      (value: Record<string, unknown>) =>
        ((value.deployments as Record<string, unknown>[])[0]!.provider = 'groq'),
    ],
    [
      'model mismatch',
      (value: Record<string, unknown>) =>
        ((value.deployments as Record<string, unknown>[])[0]!.modelReference = 'wrong/model@rev'),
    ],
    [
      'upstream mismatch',
      (value: Record<string, unknown>) =>
        ((value.deployments as Record<string, unknown>[])[0]!.upstreamModelId = 'moving-alias'),
    ],
    [
      'not current',
      (value: Record<string, unknown>) =>
        ((value.deployments as Record<string, unknown>[])[0]!.current = false),
    ],
    [
      'region claimed',
      (value: Record<string, unknown>) =>
        ((value.deployments as Record<string, unknown>[])[0]!.regions = ['us-west-2']),
    ],
    [
      'duplicate exact ID',
      (value: Record<string, unknown>) => {
        const deployments = value.deployments as Record<string, unknown>[];
        deployments.push({ ...deployments[0] });
      },
    ],
  ])('refuses %s before PostgreSQL is opened', (_label, mutate) => {
    const value = inventory();
    mutate(value);
    expect(() => validateKaanaInitialInventory(value, 'version-1', NOW)).toThrow();
  });

  it('refuses stale objects and an absent immutable S3 VersionId', () => {
    const stale = inventory();
    stale.issuedAt = '2026-09-02T04:59:59.999Z';
    expect(() => validateKaanaInitialInventory(stale, 'version-1', NOW)).toThrow(/stale/);
    expect(() => validateKaanaInitialInventory(inventory(), undefined, NOW)).toThrow(/VersionId/);
  });
});
