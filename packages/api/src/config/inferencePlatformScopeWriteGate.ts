/**
 * Rolling-release gate for the first `platform_internal` catalogue writes.
 *
 * A dedicated catalogue-bootstrap task has narrower AWS authority than the
 * live API service, so its task-definition ARN cannot equal the service's.
 * The supported production workflow instead proves twice that the exact live
 * service revision is fully drained, serializes with API deploys, and attests
 * the immutable image used by both task definitions. This process then binds
 * that fresh attestation to its own ECS metadata before opening PostgreSQL.
 */

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
const PRODUCTION_SERVICE_TASK_FAMILY = 'oxy-oxy-api';
const PRODUCTION_BOOTSTRAP_TASK_FAMILY = 'oxy-kaana-catalogue-bootstrap';
const PRODUCTION_IMAGE_PREFIX =
  '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:';
export const PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS = 10 * 60_000;
const PLATFORM_SCOPE_ROLLOUT_ATTESTATION_FUTURE_TOLERANCE_MS = 30_000;

type Environment = Readonly<Record<string, string | undefined>>;
type TaskMetadataReader = (url: string, signal: AbortSignal) => Promise<unknown>;

interface ParsedTaskMetadata {
  readonly partition: string;
  readonly region: string;
  readonly accountId: string;
  readonly cluster: string;
  readonly taskDefinitionArn: string;
  readonly image: string;
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

/**
 * Dry runs remain safe anywhere. APPLY runs fail closed unless a fresh
 * workflow attestation matches this exact dedicated task and immutable image.
 */
export async function assertPlatformScopeWriteRolloutComplete(
  apply: boolean,
  env: Environment,
  reader: TaskMetadataReader = readTaskMetadata,
  now: () => number = Date.now,
): Promise<void> {
  if (!apply) return;

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
  const attestationAge = now() - attestedAtMs;
  if (
    attestationAge > PLATFORM_SCOPE_ROLLOUT_ATTESTATION_MAX_AGE_MS
    || attestationAge < -PLATFORM_SCOPE_ROLLOUT_ATTESTATION_FUTURE_TOLERANCE_MS
  ) {
    throw new Error('The platform-scope ECS rollout attestation is stale or from the future');
  }

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
}
