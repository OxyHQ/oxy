/** Pure validation of the exact Kaana inventory reviewed for the first bootstrap. */

import {
  KAANA_INITIAL_INVENTORY_SNAPSHOT_ID,
  KAANA_INITIAL_MODEL_REFERENCE,
  KAANA_INITIAL_PROVIDERS,
} from './kaanaInitialCatalogue';

const MAX_INVENTORY_AGE_MS = 60 * 60 * 1_000;

export interface KaanaInitialInventoryAttestation {
  readonly snapshotId: string;
  readonly issuedAt: string;
  readonly versionId: string;
  readonly deployments: readonly unknown[];
}

/** The production lane is role-only; local operators may use AWS_PROFILE. */
export function assertKaanaInventoryCredentialSource(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (
    env.AWS_ACCESS_KEY_ID !== undefined ||
    env.AWS_SECRET_ACCESS_KEY !== undefined ||
    env.AWS_SESSION_TOKEN !== undefined
  ) {
    throw new Error(
      'Static AWS credential env is refused; use the dedicated catalogue-bootstrap task role or a named local AWS profile'
    );
  }
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

function unattestedRegions(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * Validate a versioned S3 object, never a caller-authored list of route names.
 *
 * IDs are only looked up by their complete opaque value. Provider/model fields
 * are assertions about that already-found identity; they are never lookup keys,
 * sort keys or ingredients from which an ID is reconstructed.
 */
export function validateKaanaInitialInventory(
  decoded: unknown,
  versionIdValue: unknown,
  nowMs: number
): KaanaInitialInventoryAttestation {
  const versionId = exactString(versionIdValue, 'Kaana inventory S3 VersionId');
  const inventory = objectOf(decoded, 'Kaana inventory');
  const snapshotId = exactString(inventory.snapshotId, 'Kaana inventory.snapshotId');
  if (snapshotId !== KAANA_INITIAL_INVENTORY_SNAPSHOT_ID) {
    throw new Error(
      `Kaana inventory snapshot ${snapshotId} was not the routing content reviewed for this bootstrap`
    );
  }
  const issuedAt = exactString(inventory.issuedAt, 'Kaana inventory.issuedAt');
  const issuedAtMs = Date.parse(issuedAt);
  if (
    !Number.isFinite(issuedAtMs) ||
    issuedAtMs > nowMs + 5 * 60 * 1_000 ||
    nowMs - issuedAtMs > MAX_INVENTORY_AGE_MS
  ) {
    throw new Error(`Kaana inventory ${snapshotId} is stale or has an invalid issuedAt`);
  }
  if (!Array.isArray(inventory.deployments)) {
    throw new Error('Kaana inventory.deployments must be an array');
  }

  const deployments = inventory.deployments.map((value, index) =>
    objectOf(value, `Kaana inventory.deployments[${index}]`)
  );
  const exactIds = deployments.map((deployment, index) =>
    exactString(deployment.deploymentId, `Kaana inventory.deployments[${index}].deploymentId`)
  );
  if (new Set(exactIds).size !== exactIds.length) {
    throw new Error(`Kaana inventory ${snapshotId} contains a deployment ID collision`);
  }

  for (const expected of KAANA_INITIAL_PROVIDERS) {
    const matches = deployments.filter(
      (deployment) => deployment.deploymentId === expected.deploymentId
    );
    if (matches.length !== 1) {
      throw new Error(
        `Kaana inventory ${snapshotId} must contain exact deployment ${expected.deploymentId} once; found ${matches.length}`
      );
    }
    const [deployment] = matches;
    if (
      deployment === undefined ||
      deployment.provider !== expected.slug ||
      deployment.modelReference !== KAANA_INITIAL_MODEL_REFERENCE ||
      deployment.upstreamModelId !== expected.upstreamModelId ||
      deployment.current !== true ||
      !unattestedRegions(deployment.regions)
    ) {
      throw new Error(
        `Kaana inventory ${snapshotId} does not attest the reviewed identity bound to ${expected.deploymentId}`
      );
    }
  }

  return {
    snapshotId,
    issuedAt,
    versionId,
    deployments: inventory.deployments,
  };
}
