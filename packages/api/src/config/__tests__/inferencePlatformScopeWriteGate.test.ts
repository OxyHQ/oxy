import {
  assertPlatformScopeWriteRolloutComplete,
  PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS,
  taskDefinitionArnFromMetadata,
  type PlatformScopeRolloutReader,
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
const TASK_ARNS = [
  'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/task-1',
  'arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/task-2',
] as const;

function serviceResponse(options: {
  readonly desiredCount?: number;
  readonly oldRunningCount?: number;
  readonly rolloutState?: string;
} = {}): unknown {
  const desiredCount = options.desiredCount ?? 2;
  return {
    failures: [],
    services: [
      {
        status: 'ACTIVE',
        taskDefinition: SERVICE_TASK_DEFINITION,
        desiredCount,
        runningCount: desiredCount,
        pendingCount: 0,
        deployments: [
          {
            taskDefinition: SERVICE_TASK_DEFINITION,
            status: 'PRIMARY',
            rolloutState: options.rolloutState ?? 'COMPLETED',
            desiredCount,
            runningCount: desiredCount,
            pendingCount: 0,
          },
          {
            taskDefinition:
              'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:206',
            status: 'ACTIVE',
            rolloutState: 'COMPLETED',
            desiredCount: 0,
            runningCount: options.oldRunningCount ?? 0,
            pendingCount: 0,
          },
        ],
      },
    ],
  };
}

function createRolloutReader(options: {
  readonly serviceForCall?: (call: number) => unknown;
  readonly taskArnsForCall?: (call: number) => readonly string[];
  readonly image?: string;
} = {}): PlatformScopeRolloutReader {
  let serviceCalls = 0;
  let listCalls = 0;
  return {
    describeServices: jest.fn(async () => {
      serviceCalls += 1;
      return options.serviceForCall?.(serviceCalls) ?? serviceResponse();
    }),
    listTasks: jest.fn(async () => {
      listCalls += 1;
      return { taskArns: options.taskArnsForCall?.(listCalls) ?? TASK_ARNS };
    }),
    describeTasks: jest.fn(async (taskArns) => ({
      failures: [],
      tasks: taskArns.map((taskArn) => ({
        taskArn,
        lastStatus: 'RUNNING',
        desiredStatus: 'RUNNING',
        taskDefinitionArn: SERVICE_TASK_DEFINITION,
        containers: [
          {
            name: 'oxy-api',
            image: options.image ?? IMAGE,
            lastStatus: 'RUNNING',
          },
        ],
      })),
    })),
    close: jest.fn(),
  };
}

const NO_DELAY = () => Promise.resolve();

describe('the platform-internal write rollout gate', () => {
  it('allows dry runs without an ECS rollout attestation', async () => {
    const reader = jest.fn();
    const createLiveReader = jest.fn();
    const guard = await assertPlatformScopeWriteRolloutComplete(false, {}, reader, Date.now, {
      createRolloutReader: createLiveReader,
    });
    await expect(guard.assertStillComplete()).resolves.toBeUndefined();
    guard.close();
    expect(reader).not.toHaveBeenCalled();
    expect(createLiveReader).not.toHaveBeenCalled();
  });

  it('derives the dedicated immutable task-definition ARN from exact ECS metadata', () => {
    expect(taskDefinitionArnFromMetadata(METADATA)).toBe(BOOTSTRAP_TASK_DEFINITION);
  });

  it('allows APPLY only when a fresh attestation matches the executing task and image', async () => {
    const reader = jest.fn(async () => METADATA);
    const liveReader = createRolloutReader();
    const guard = await assertPlatformScopeWriteRolloutComplete(
      true,
      VALID_ENV,
      reader,
      () => NOW,
      { createRolloutReader: () => liveReader, delay: NO_DELAY },
    );
    await expect(guard.assertStillComplete()).resolves.toBeUndefined();
    guard.close();
    expect(reader).toHaveBeenCalledWith(`${METADATA_URI}/task`, expect.any(AbortSignal));
    expect(liveReader.describeServices).toHaveBeenCalledTimes(4);
    expect(liveReader.listTasks).toHaveBeenCalledTimes(4);
    expect(liveReader.describeTasks).toHaveBeenCalledTimes(4);
    expect(liveReader.close).toHaveBeenCalledTimes(1);
  });

  it('refuses caller-authored metadata when live ECS still has an old task', async () => {
    const liveReader = createRolloutReader({
      serviceForCall: () => serviceResponse({ oldRunningCount: 1 }),
    });
    await expect(
      assertPlatformScopeWriteRolloutComplete(
        true,
        VALID_ENV,
        async () => METADATA,
        () => NOW,
        { createRolloutReader: () => liveReader, delay: NO_DELAY },
      ),
    ).rejects.toThrow(/non-primary deployment tasks/);
    expect(liveReader.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an incomplete PRIMARY rollout',
      createRolloutReader({
        serviceForCall: () => serviceResponse({ rolloutState: 'IN_PROGRESS' }),
      }),
      /PRIMARY rollout is not completely stable/,
    ],
    [
      'a live service container at a different image',
      createRolloutReader({ image: `${IMAGE.slice(0, -64)}${'b'.repeat(64)}` }),
      /not RUNNING at the attested image/,
    ],
  ])('refuses APPLY with %s', async (_label, liveReader, expected) => {
    await expect(
      assertPlatformScopeWriteRolloutComplete(
        true,
        VALID_ENV,
        async () => METADATA,
        () => NOW,
        { createRolloutReader: () => liveReader, delay: NO_DELAY },
      ),
    ).rejects.toThrow(expected);
    expect(liveReader.close).toHaveBeenCalledTimes(1);
  });

  it('refuses a service mutation between its two complete live observations', async () => {
    const liveReader = createRolloutReader({
      serviceForCall: (call) => serviceResponse({ desiredCount: call === 1 ? 2 : 1 }),
      taskArnsForCall: (call) => (call === 1 ? TASK_ARNS : TASK_ARNS.slice(0, 1)),
    });
    await expect(
      assertPlatformScopeWriteRolloutComplete(
        true,
        VALID_ENV,
        async () => METADATA,
        () => NOW,
        { createRolloutReader: () => liveReader, delay: NO_DELAY },
      ),
    ).rejects.toThrow(/changed between complete rollout observations/);
  });

  it('rechecks live ECS after the initial proof and fails a pre-commit old-task race', async () => {
    const liveReader = createRolloutReader({
      serviceForCall: (call) =>
        call <= 2 ? serviceResponse() : serviceResponse({ oldRunningCount: 1 }),
    });
    const guard = await assertPlatformScopeWriteRolloutComplete(
      true,
      VALID_ENV,
      async () => METADATA,
      () => NOW,
      { createRolloutReader: () => liveReader, delay: NO_DELAY },
    );
    await expect(guard.assertStillComplete()).rejects.toThrow(/non-primary deployment tasks/);
    guard.close();
  });

  it('rechecks workflow-attestation freshness immediately before the final proof', async () => {
    let clock = NOW;
    const liveReader = createRolloutReader();
    const guard = await assertPlatformScopeWriteRolloutComplete(
      true,
      VALID_ENV,
      async () => METADATA,
      () => clock,
      { createRolloutReader: () => liveReader, delay: NO_DELAY },
    );
    clock =
      Date.parse(VALID_ENV.KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT) +
      PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS +
      1;
    await expect(guard.assertStillComplete()).rejects.toThrow(/stale or from the future/);
    expect(liveReader.describeServices).toHaveBeenCalledTimes(2);
    guard.close();
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
