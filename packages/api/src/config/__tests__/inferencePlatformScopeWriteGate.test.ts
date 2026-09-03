import {
  assertPlatformScopeWriteRolloutComplete,
  PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS,
  taskDefinitionArnFromMetadata,
} from '../inferencePlatformScopeWriteGate';

const SERVICE_TASK_DEFINITION = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:207';
const BOOTSTRAP_TASK_DEFINITION = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-kaana-catalogue-bootstrap:12';
const IMAGE = `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:${'a'.repeat(64)}`;
const METADATA_URI = 'http://169.254.170.2/v4/fixture-id';
const NOW = Date.parse('2026-09-03T10:05:00.000Z');
const METADATA = {
  TaskARN: 'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/exact-task-id',
  Family: 'oxy-kaana-catalogue-bootstrap',
  Revision: '12',
  Containers: [{ Name: 'kaana-catalogue-bootstrap', Image: IMAGE }],
};
const VALID_ENV = {
  ECS_CONTAINER_METADATA_URI_V4: METADATA_URI,
  KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ARN: SERVICE_TASK_DEFINITION,
  KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ARN: BOOTSTRAP_TASK_DEFINITION,
  KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE: IMAGE,
  KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT: '2026-09-03T10:00:00.000Z',
  KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER: 'oxy-cluster',
  KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE: 'oxy-api',
};

describe('the platform-internal write rollout gate', () => {
  it('allows dry runs without an ECS rollout attestation', async () => {
    const reader = jest.fn();
    await expect(assertPlatformScopeWriteRolloutComplete(false, {}, reader)).resolves.toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('derives the dedicated immutable task-definition ARN from exact ECS metadata', () => {
    expect(taskDefinitionArnFromMetadata(METADATA)).toBe(BOOTSTRAP_TASK_DEFINITION);
  });

  it('allows APPLY only when a fresh attestation matches the executing task and image', async () => {
    const reader = jest.fn(async () => METADATA);
    await expect(
      assertPlatformScopeWriteRolloutComplete(true, VALID_ENV, reader, () => NOW),
    ).resolves.toBeUndefined();
    expect(reader).toHaveBeenCalledWith(`${METADATA_URI}/task`, expect.any(AbortSignal));
  });

  it.each([
    [
      'missing live-service attestation',
      { ...VALID_ENV, KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ARN: undefined },
      /SERVICE_TASK_DEFINITION_ARN/,
    ],
    [
      'non-ECS metadata URI',
      { ...VALID_ENV, ECS_CONTAINER_METADATA_URI_V4: 'https://example.com/v4/fixture-id' },
      /local ECS v4 metadata endpoint/,
    ],
    [
      'different dedicated task definition',
      {
        ...VALID_ENV,
        KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ARN:
          'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-kaana-catalogue-bootstrap:11',
      },
      /does not match the bootstrap task definition/,
    ],
    [
      'mutable image tag',
      { ...VALID_ENV, KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE: 'example.invalid/oxy-api:latest' },
      /immutable image URI/,
    ],
    [
      'different immutable image',
      { ...VALID_ENV, KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE: `${IMAGE.slice(0, -64)}${'b'.repeat(64)}` },
      /does not match the bootstrap image/,
    ],
    [
      'different cluster',
      { ...VALID_ENV, KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER: 'other-cluster' },
      /must identify the exact production cluster/,
    ],
    [
      'different service',
      { ...VALID_ENV, KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE: 'other-service' },
      /must identify the exact production service/,
    ],
    [
      'different service task family',
      {
        ...VALID_ENV,
        KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ARN:
          'arn:aws:ecs:us-west-2:237343248947:task-definition/other-api:207',
      },
      /exact production service family/,
    ],
    [
      'different bootstrap task family',
      {
        ...VALID_ENV,
        KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ARN:
          'arn:aws:ecs:us-west-2:237343248947:task-definition/other-bootstrap:12',
      },
      /exact production one-shot family/,
    ],
    [
      'different immutable image repository',
      {
        ...VALID_ENV,
        KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE:
          `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/other@sha256:${'a'.repeat(64)}`,
      },
      /immutable image URI/,
    ],
  ])('refuses APPLY with %s', async (_label, env, expected) => {
    await expect(
      assertPlatformScopeWriteRolloutComplete(true, env, async () => METADATA, () => NOW),
    ).rejects.toThrow(expected);
  });

  it('refuses a stale attestation before consulting task metadata', async () => {
    const reader = jest.fn(async () => METADATA);
    await expect(assertPlatformScopeWriteRolloutComplete(
      true,
      VALID_ENV,
      reader,
      () => Date.parse(VALID_ENV.KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT)
        + PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS + 1,
    )).rejects.toThrow(/stale or from the future/);
    expect(reader).not.toHaveBeenCalled();
  });
});
