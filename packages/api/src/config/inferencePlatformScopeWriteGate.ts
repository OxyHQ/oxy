/**
 * Rolling-release gate for the first `platform_internal` catalogue writes.
 *
 * A dedicated catalogue-bootstrap task has narrower AWS authority than the
 * live API service, so its task-definition ARN cannot equal the service's.
 * The supported production workflow proves the rollout first and serializes
 * with API deploys. The dedicated task then repeats the complete proof with its
 * own IAM identity before opening PostgreSQL and immediately before commit, so
 * caller-authored overrides can never stand in for live ECS state.
 */

import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';

export const KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ENV =
  'KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ARN' as const;
export const KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ENV =
  'KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ARN' as const;
export const KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE_ENV =
  'KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE' as const;
export const KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT_ENV =
  'KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT' as const;
export const KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER_ENV =
  'KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER' as const;
export const KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_ENV =
  'KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE' as const;

const ECS_TASK_METADATA_ORIGIN = 'http://169.254.170.2';
const ECS_TASK_METADATA_TIMEOUT_MS = 5_000;
const BOOTSTRAP_CONTAINER_NAME = 'kaana-catalogue-bootstrap';
const PRODUCTION_PARTITION = 'aws';
const PRODUCTION_REGION = 'us-west-2';
const PRODUCTION_ACCOUNT_ID = '237343248947';
const PRODUCTION_CLUSTER = 'oxy-cluster';
const PRODUCTION_SERVICE = 'oxy-api';
const PRODUCTION_SERVICE_CONTAINER = 'oxy-api';
const PRODUCTION_SERVICE_TASK_FAMILY = 'oxy-oxy-api';
const PRODUCTION_BOOTSTRAP_TASK_FAMILY = 'oxy-kaana-catalogue-bootstrap';
const PRODUCTION_IMAGE_PREFIX =
  '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:';
const ROLLOUT_CONFIRM_DELAY_MS = 5_000;
const ECS_DESCRIBE_TASKS_BATCH_SIZE = 100;
export const PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS = 10 * 60_000;
const PLATFORM_SCOPE_ROLLOUT_ATTESTATION_FUTURE_TOLERANCE_MS = 30_000;

type Environment = Readonly<Record<string, string | undefined>>;
type TaskMetadataReader = (url: string, signal: AbortSignal) => Promise<unknown>;

export interface PlatformScopeRolloutReader {
  describeServices(): Promise<unknown>;
  listTasks(nextToken: string | undefined): Promise<unknown>;
  describeTasks(taskArns: readonly string[]): Promise<unknown>;
  close(): void;
}

export interface PlatformScopeWriteGateDependencies {
  readonly createRolloutReader?: () => PlatformScopeRolloutReader;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export interface PlatformScopeWriteRolloutGuard {
  assertStillComplete(): Promise<void>;
  close(): void;
}

interface ParsedTaskMetadata {
  readonly partition: string;
  readonly region: string;
  readonly accountId: string;
  readonly cluster: string;
  readonly taskDefinitionArn: string;
  readonly image: string;
}

interface LiveServiceSnapshot {
  readonly taskDefinitionArn: string;
  readonly desiredCount: number;
  readonly taskArns: readonly string[];
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function arrayOf(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requiredEnvironment(env: Environment, key: string): string {
  return exactString(env[key], key);
}

function parseTaskDefinitionArn(value: string, label: string): {
  readonly partition: string;
  readonly region: string;
  readonly accountId: string;
  readonly family: string;
} {
  const match = /^arn:([^:]+):ecs:([^:]+):(\d{12}):task-definition\/([A-Za-z0-9_-]{1,255}):[1-9][0-9]*$/.exec(value);
  if (match === null) throw new Error(`${label} is invalid`);
  const [, partition, region, accountId, family] = match;
  return { partition, region, accountId, family };
}

function parseTaskMetadata(value: unknown): ParsedTaskMetadata {
  const metadata = objectOf(value, 'ECS task metadata');
  const taskArn = exactString(metadata.TaskARN, 'ECS task metadata TaskARN');
  const family = exactString(metadata.Family, 'ECS task metadata Family');
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(family)) {
    throw new Error('ECS task metadata Family is invalid');
  }

  const revisionValue = metadata.Revision;
  const revision =
    typeof revisionValue === 'number' && Number.isSafeInteger(revisionValue)
      ? String(revisionValue)
      : exactString(revisionValue, 'ECS task metadata Revision');
  if (!/^[1-9][0-9]*$/.test(revision)) {
    throw new Error('ECS task metadata Revision must be a positive integer');
  }

  const match = /^arn:([^:]+):ecs:([^:]+):(\d{12}):task\/([^/]+)\/[^/]+$/.exec(taskArn);
  if (match === null) {
    throw new Error('ECS task metadata TaskARN is invalid');
  }
  const [, partition, region, accountId, cluster] = match;

  if (!Array.isArray(metadata.Containers)) {
    throw new Error('ECS task metadata Containers must be an array');
  }
  const containers = metadata.Containers.map((container, index) =>
    objectOf(container, `ECS task metadata Containers[${index}]`));
  const matchingContainers = containers.filter(
    (container) => container.Name === BOOTSTRAP_CONTAINER_NAME,
  );
  if (matchingContainers.length !== 1) {
    throw new Error(`ECS task metadata must contain exactly one ${BOOTSTRAP_CONTAINER_NAME} container`);
  }
  const image = exactString(
    matchingContainers[0].Image,
    `ECS task metadata ${BOOTSTRAP_CONTAINER_NAME} Image`,
  );

  return {
    partition,
    region,
    accountId,
    cluster,
    taskDefinitionArn: `arn:${partition}:ecs:${region}:${accountId}:task-definition/${family}:${revision}`,
    image,
  };
}

/** Derive the immutable task-definition ARN from the local ECS task document. */
export function taskDefinitionArnFromMetadata(value: unknown): string {
  return parseTaskMetadata(value).taskDefinitionArn;
}

async function readTaskMetadata(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`ECS task metadata returned HTTP ${response.status}`);
  }
  return response.json();
}

function createAwsRolloutReader(): PlatformScopeRolloutReader {
  const client = new ECSClient({ region: PRODUCTION_REGION });
  return {
    describeServices: () =>
      client.send(
        new DescribeServicesCommand({
          cluster: PRODUCTION_CLUSTER,
          services: [PRODUCTION_SERVICE],
        }),
      ),
    listTasks: (nextToken) =>
      client.send(
        new ListTasksCommand({
          cluster: PRODUCTION_CLUSTER,
          serviceName: PRODUCTION_SERVICE,
          desiredStatus: 'RUNNING',
          maxResults: ECS_DESCRIBE_TASKS_BATCH_SIZE,
          nextToken,
        }),
      ),
    describeTasks: (taskArns) =>
      client.send(
        new DescribeTasksCommand({
          cluster: PRODUCTION_CLUSTER,
          tasks: [...taskArns],
        }),
      ),
    close: () => client.destroy(),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertNoEcsFailures(value: unknown, label: string): void {
  if (value === undefined) return;
  if (arrayOf(value, `${label}.failures`).length !== 0) {
    throw new Error(`${label} returned ECS failures`);
  }
}

async function captureLiveServiceSnapshot(
  reader: PlatformScopeRolloutReader,
  expectedTaskDefinition: string,
  expectedImage: string,
): Promise<LiveServiceSnapshot> {
  const serviceResponse = objectOf(await reader.describeServices(), 'ECS DescribeServices');
  assertNoEcsFailures(serviceResponse.failures, 'ECS DescribeServices');
  const services = arrayOf(serviceResponse.services, 'ECS DescribeServices.services');
  if (services.length !== 1) {
    throw new Error('ECS DescribeServices must return exactly one production service');
  }
  const service = objectOf(services[0], 'ECS production service');
  if (exactString(service.status, 'ECS production service.status') !== 'ACTIVE') {
    throw new Error('The production service is not ACTIVE');
  }
  if (
    exactString(service.taskDefinition, 'ECS production service.taskDefinition') !==
    expectedTaskDefinition
  ) {
    throw new Error('The production service task definition changed');
  }

  const desiredCount = nonNegativeInteger(
    service.desiredCount,
    'ECS production service.desiredCount',
  );
  if (desiredCount === 0) throw new Error('The production service desired count must be positive');
  if (
    nonNegativeInteger(service.runningCount, 'ECS production service.runningCount') !== desiredCount
  ) {
    throw new Error('The production service running count does not equal desired count');
  }
  if (nonNegativeInteger(service.pendingCount, 'ECS production service.pendingCount') !== 0) {
    throw new Error('The production service still has pending tasks');
  }

  const deployments = arrayOf(service.deployments, 'ECS production service.deployments').map(
    (deployment, index) =>
      objectOf(deployment, `ECS production service.deployments[${index}]`),
  );
  const primaryDeployments = deployments.filter(
    (deployment) => deployment.status === 'PRIMARY',
  );
  if (primaryDeployments.length !== 1) {
    throw new Error('The production service must have exactly one PRIMARY deployment');
  }
  const primary = primaryDeployments[0];
  if (primary === undefined) {
    throw new Error('The production service PRIMARY deployment is missing');
  }
  if (
    exactString(primary.taskDefinition, 'ECS PRIMARY taskDefinition') !== expectedTaskDefinition ||
    exactString(primary.rolloutState, 'ECS PRIMARY rolloutState') !== 'COMPLETED' ||
    nonNegativeInteger(primary.desiredCount, 'ECS PRIMARY desiredCount') !== desiredCount ||
    nonNegativeInteger(primary.runningCount, 'ECS PRIMARY runningCount') !== desiredCount ||
    nonNegativeInteger(primary.pendingCount, 'ECS PRIMARY pendingCount') !== 0
  ) {
    throw new Error('The production service PRIMARY rollout is not completely stable');
  }
  for (const [index, deployment] of deployments.entries()) {
    exactString(deployment.taskDefinition, `ECS deployment ${index} taskDefinition`);
    const runningCount = nonNegativeInteger(
      deployment.runningCount,
      `ECS deployment ${index} runningCount`,
    );
    const pendingCount = nonNegativeInteger(
      deployment.pendingCount,
      `ECS deployment ${index} pendingCount`,
    );
    if (deployment !== primary && runningCount + pendingCount !== 0) {
      throw new Error('The production service still has non-primary deployment tasks');
    }
  }

  const taskArns: string[] = [];
  const paginationTokens = new Set<string>();
  let nextToken: string | undefined;
  do {
    const listResponse = objectOf(await reader.listTasks(nextToken), 'ECS ListTasks');
    const pageTaskArns = arrayOf(listResponse.taskArns, 'ECS ListTasks.taskArns').map(
      (taskArn, index) => exactString(taskArn, `ECS ListTasks.taskArns[${index}]`),
    );
    taskArns.push(...pageTaskArns);
    if (listResponse.nextToken === undefined) {
      nextToken = undefined;
    } else {
      nextToken = exactString(listResponse.nextToken, 'ECS ListTasks.nextToken');
      if (paginationTokens.has(nextToken)) {
        throw new Error('ECS ListTasks repeated a pagination token');
      }
      paginationTokens.add(nextToken);
    }
  } while (nextToken !== undefined);

  if (taskArns.length !== desiredCount || new Set(taskArns).size !== desiredCount) {
    throw new Error('The exact RUNNING task set does not equal the production desired count');
  }
  const expectedTaskArnPrefix =
    `arn:${PRODUCTION_PARTITION}:ecs:${PRODUCTION_REGION}:${PRODUCTION_ACCOUNT_ID}:` +
    `task/${PRODUCTION_CLUSTER}/`;
  if (taskArns.some((taskArn) => !taskArn.startsWith(expectedTaskArnPrefix))) {
    throw new Error('The RUNNING task set contains an identity outside the production cluster');
  }

  const describedTasks: Record<string, unknown>[] = [];
  for (let index = 0; index < taskArns.length; index += ECS_DESCRIBE_TASKS_BATCH_SIZE) {
    const batch = taskArns.slice(index, index + ECS_DESCRIBE_TASKS_BATCH_SIZE);
    const taskResponse = objectOf(await reader.describeTasks(batch), 'ECS DescribeTasks');
    assertNoEcsFailures(taskResponse.failures, 'ECS DescribeTasks');
    describedTasks.push(
      ...arrayOf(taskResponse.tasks, 'ECS DescribeTasks.tasks').map((task, taskIndex) =>
        objectOf(task, `ECS DescribeTasks.tasks[${taskIndex}]`),
      ),
    );
  }
  if (describedTasks.length !== desiredCount) {
    throw new Error('ECS DescribeTasks did not return every RUNNING task');
  }

  const describedTaskArns = describedTasks.map((task, index) =>
    exactString(task.taskArn, `ECS task ${index}.taskArn`),
  );
  if (
    new Set(describedTaskArns).size !== desiredCount ||
    JSON.stringify([...describedTaskArns].sort()) !== JSON.stringify([...taskArns].sort())
  ) {
    throw new Error('The described task identities differ from the RUNNING task list');
  }
  for (const [index, task] of describedTasks.entries()) {
    if (
      exactString(task.lastStatus, `ECS task ${index}.lastStatus`) !== 'RUNNING' ||
      exactString(task.desiredStatus, `ECS task ${index}.desiredStatus`) !== 'RUNNING' ||
      exactString(task.taskDefinitionArn, `ECS task ${index}.taskDefinitionArn`) !==
        expectedTaskDefinition
    ) {
      throw new Error('The RUNNING task set contains an old or stopping task');
    }
    const containers = arrayOf(task.containers, `ECS task ${index}.containers`).map(
      (container, containerIndex) =>
        objectOf(container, `ECS task ${index}.containers[${containerIndex}]`),
    );
    const serviceContainers = containers.filter(
      (container) => container.name === PRODUCTION_SERVICE_CONTAINER,
    );
    if (serviceContainers.length !== 1) {
      throw new Error(`ECS task ${index} must contain exactly one production service container`);
    }
    const serviceContainer = serviceContainers[0];
    if (
      serviceContainer === undefined ||
      exactString(serviceContainer.lastStatus, `ECS task ${index} service container status`) !==
        'RUNNING' ||
      exactString(serviceContainer.image, `ECS task ${index} service container image`) !==
        expectedImage
    ) {
      throw new Error('A production service container is not RUNNING at the attested image');
    }
  }

  return {
    taskDefinitionArn: expectedTaskDefinition,
    desiredCount,
    taskArns: [...taskArns].sort(),
  };
}

async function assertStableLiveServiceRollout(
  reader: PlatformScopeRolloutReader,
  expectedTaskDefinition: string,
  expectedImage: string,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const before = await captureLiveServiceSnapshot(reader, expectedTaskDefinition, expectedImage);
  await delay(ROLLOUT_CONFIRM_DELAY_MS);
  const after = await captureLiveServiceSnapshot(reader, expectedTaskDefinition, expectedImage);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('The production service changed between complete rollout observations');
  }
}

/**
 * Dry runs remain safe anywhere. APPLY runs fail closed unless a fresh
 * workflow attestation matches this exact dedicated task and immutable image,
 * and two live ECS observations prove the production service fully drained.
 * The caller must run `assertStillComplete` as its last awaited operation
 * inside the write transaction, then always close the returned guard.
 */
export async function assertPlatformScopeWriteRolloutComplete(
  apply: boolean,
  env: Environment,
  reader: TaskMetadataReader = readTaskMetadata,
  now: () => number = Date.now,
  dependencies: PlatformScopeWriteGateDependencies = {},
): Promise<PlatformScopeWriteRolloutGuard> {
  if (!apply) {
    return {
      assertStillComplete: () => Promise.resolve(),
      close: () => undefined,
    };
  }

  const serviceTaskDefinition = requiredEnvironment(
    env,
    KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ENV,
  );
  const bootstrapTaskDefinition = requiredEnvironment(
    env,
    KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ENV,
  );
  const expectedImage = requiredEnvironment(env, KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE_ENV);
  const attestedAt = requiredEnvironment(env, KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT_ENV);
  const expectedCluster = requiredEnvironment(env, KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER_ENV);
  const expectedService = requiredEnvironment(env, KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_ENV);

  if (expectedCluster !== PRODUCTION_CLUSTER) {
    throw new Error(`${KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER_ENV} must identify the exact production cluster`);
  }
  if (expectedService !== PRODUCTION_SERVICE) {
    throw new Error(`${KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_ENV} must identify the exact production service`);
  }
  if (
    !expectedImage.startsWith(PRODUCTION_IMAGE_PREFIX)
    || !/^[a-f0-9]{64}$/.test(expectedImage.slice(PRODUCTION_IMAGE_PREFIX.length))
  ) {
    throw new Error(`${KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE_ENV} must be an immutable image URI`);
  }
  const serviceArn = parseTaskDefinitionArn(
    serviceTaskDefinition,
    KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ENV,
  );
  const bootstrapArn = parseTaskDefinitionArn(
    bootstrapTaskDefinition,
    KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ENV,
  );
  if (
    serviceArn.partition !== PRODUCTION_PARTITION
    || serviceArn.region !== PRODUCTION_REGION
    || serviceArn.accountId !== PRODUCTION_ACCOUNT_ID
    || serviceArn.family !== PRODUCTION_SERVICE_TASK_FAMILY
  ) {
    throw new Error('Service task definition must identify the exact production service family');
  }
  if (
    bootstrapArn.partition !== PRODUCTION_PARTITION
    || bootstrapArn.region !== PRODUCTION_REGION
    || bootstrapArn.accountId !== PRODUCTION_ACCOUNT_ID
    || bootstrapArn.family !== PRODUCTION_BOOTSTRAP_TASK_FAMILY
  ) {
    throw new Error('Bootstrap task definition must identify the exact production one-shot family');
  }
  if (serviceTaskDefinition === bootstrapTaskDefinition) {
    throw new Error('The catalogue bootstrap must use its dedicated task definition');
  }

  const attestedAtMs = Date.parse(attestedAt);
  if (!Number.isFinite(attestedAtMs) || new Date(attestedAtMs).toISOString() !== attestedAt) {
    throw new Error(`${KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT_ENV} must be an exact ISO timestamp`);
  }
  const assertFreshWorkflowAttestation = () => {
    const attestationAge = now() - attestedAtMs;
    if (
      attestationAge > PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS ||
      attestationAge < -PLATFORM_SCOPE_ROLLOUT_ATTESTATION_FUTURE_TOLERANCE_MS
    ) {
      throw new Error('The platform-scope ECS rollout attestation is stale or from the future');
    }
  };
  assertFreshWorkflowAttestation();

  const metadataUri = env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri === undefined || metadataUri.length === 0) {
    throw new Error('ECS_CONTAINER_METADATA_URI_V4 is required for an APPLY bootstrap');
  }
  const metadataUrl = new URL(metadataUri);
  if (
    metadataUrl.origin !== ECS_TASK_METADATA_ORIGIN
    || !metadataUrl.pathname.startsWith('/v4/')
    || metadataUrl.username.length > 0
    || metadataUrl.password.length > 0
  ) {
    throw new Error('ECS_CONTAINER_METADATA_URI_V4 must be the local ECS v4 metadata endpoint');
  }
  metadataUrl.pathname = `${metadataUrl.pathname.replace(/\/$/, '')}/task`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ECS_TASK_METADATA_TIMEOUT_MS);
  let metadata: unknown;
  try {
    metadata = await reader(metadataUrl.toString(), controller.signal);
  } finally {
    clearTimeout(timeout);
  }

  const executing = parseTaskMetadata(metadata);
  if (bootstrapTaskDefinition !== executing.taskDefinitionArn) {
    throw new Error(
      `${KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ENV} does not match the bootstrap task definition`,
    );
  }
  if (expectedCluster !== executing.cluster) {
    throw new Error(`${KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER_ENV} does not match the bootstrap task cluster`);
  }
  if (
    executing.partition !== PRODUCTION_PARTITION
    || executing.region !== PRODUCTION_REGION
    || executing.accountId !== PRODUCTION_ACCOUNT_ID
  ) {
    throw new Error('ECS task metadata does not match the attested ECS authority');
  }
  if (expectedImage !== executing.image) {
    throw new Error(
      `${KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE_ENV} does not match the bootstrap image`,
    );
  }

  const rolloutReader = (dependencies.createRolloutReader ?? createAwsRolloutReader)();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rolloutReader.close();
  };
  const assertStillComplete = async () => {
    if (closed) throw new Error('The platform-scope rollout guard is already closed');
    assertFreshWorkflowAttestation();
    await assertStableLiveServiceRollout(
      rolloutReader,
      serviceTaskDefinition,
      expectedImage,
      dependencies.delay ?? wait,
    );
    assertFreshWorkflowAttestation();
  };
  try {
    await assertStillComplete();
  } catch (error) {
    close();
    throw error;
  }
  return { assertStillComplete, close };
}
