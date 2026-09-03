#!/usr/bin/env bun
/**
 * Provision the fixed Oxy identities needed by the Sindi and Clarity Alia
 * agents. Dry-run is the default and executes the same PostgreSQL writes before
 * rolling the single transaction back.
 *
 * Apply an observed plan only after review:
 *   APPLY=1 BOOTSTRAP_ACTOR=... BOOTSTRAP_REASON=... \
 *   EXPECTED_PLAN_SHA256=... bun run bootstrap:native-product-agents
 *
 * Emergency retirement is non-destructive:
 *   ROLLBACK=1 [the same APPLY approval variables] bun run ...
 */

import { asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  NATIVE_PRODUCT_AGENTS,
  aliaNativeAgentBootstrapManifest,
} from "../src/config/nativeProductAgents";
import {
  closePostgres,
  connectPostgres,
  getDb,
  type Transaction,
} from "../src/config/postgres";
import {
  applicationCredentials,
  applications,
  internalCostCenters,
  securityActivities,
  userAncestors,
  users,
} from "../src/db/schema";
import {
  nativeProductBootstrapPlanSha256,
  nativeProductAgentRollbackOperations,
  requireExistingServiceCredentialSecretHash,
  requireNativeProductBootstrapApproval,
  type NativeProductBootstrapPlan,
} from "../src/scripts/nativeProductAgentsBootstrapPlan";
import {
  NATIVE_PRODUCT_AGENT_DRIFT_FIELDS,
  type NativeProductAgentBoundApplication,
  type NativeProductAgentDriftField,
  type NativeProductAgentDriftTarget,
  NativeProductAgentStateDriftError,
  NativeProductAgentUsernameCollisionError,
  nativeProductAgentBootstrapFailureResult,
} from "../src/scripts/nativeProductAgentBootstrapFailure";

const APPLY = process.env.APPLY === "1";
const ROLLBACK = process.env.ROLLBACK === "1";
const LOCK_NAME = "oxy:native-product-agents:v1";

class DryRunRollback extends Error {
  constructor(readonly report: BootstrapReport) {
    super("dry-run rollback");
  }
}

interface AccountSpec {
  id: string;
  username: string;
  displayName: string;
  kind: "project" | "bot";
  parentAccountId: string;
  rootAccountId: string;
  ancestors: readonly string[];
}

interface AccountObservation {
  spec: AccountSpec;
  exists: boolean;
}

interface CostCenterSpec {
  accountId: string;
  slug: string;
  label: string;
}

interface CostCenterObservation {
  spec: CostCenterSpec;
  exists: boolean;
}

interface BootstrapObservations {
  accounts: AccountObservation[];
  costCenters: CostCenterObservation[];
  homiioOwnerAccountId: string;
  homiioApplicationScopes: string[];
  homiioSindiCredentialExists: boolean;
  homiioSindiCredentialBefore: unknown;
  homiioApplicationBefore: unknown;
  clarityApplicationExists: boolean;
  clarityCredentialExists: boolean;
  clarityBackendApplicationExists: boolean;
  clarityBackendCredentialExists: boolean;
  clarityApplicationBefore: unknown;
  clarityCredentialBefore: unknown;
  clarityBackendApplicationBefore: unknown;
  clarityBackendCredentialBefore: unknown;
}

interface BootstrapReport {
  mode: "dry-run" | "apply";
  direction: "bootstrap" | "rollback";
  planSha256: string;
  plan: NativeProductBootstrapPlan;
  aliaManifest: ReturnType<typeof aliaNativeAgentBootstrapManifest>;
  serviceCredentialState?: {
    homiioSindiExists: boolean;
    clarityBackendExists: boolean;
  };
}

interface ServiceSecretHashes {
  homiioSindi: string;
  clarityBackend: string;
}

function assertWorkflowIdentityBindings(): void {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  const bindings: ReadonlyArray<readonly [string, string]> = [
    ["EXPECTED_OXY_ORGANIZATION_ID", NATIVE_PRODUCT_AGENTS.oxyOrganizationId],
    ["EXPECTED_HOMIIO_PROJECT_ID", homiio.project.id],
    ["EXPECTED_HOMIIO_BOT_ID", homiio.bot.id],
    ["EXPECTED_HOMIIO_APPLICATION_ID", homiio.applicationId],
    ["EXPECTED_HOMIIO_SINDI_CREDENTIAL_ID", homiio.sindiServiceCredential.id],
    ["EXPECTED_HOMIIO_SINDI_CLIENT_ID", homiio.sindiServiceCredential.clientId],
    ["EXPECTED_HOMIIO_SINDI_AGENT_ID", homiio.aliaAgent.id],
    ["EXPECTED_CLARITY_PROJECT_ID", clarity.project.id],
    ["EXPECTED_CLARITY_BOT_ID", clarity.bot.id],
    ["EXPECTED_CLARITY_APPLICATION_ID", clarity.application.id],
    ["EXPECTED_CLARITY_PUBLIC_CREDENTIAL_ID", clarity.publicCredential.id],
    ["EXPECTED_CLARITY_BACKEND_APPLICATION_ID", clarity.backendApplication.id],
    [
      "EXPECTED_CLARITY_BACKEND_CREDENTIAL_ID",
      clarity.backendServiceCredential.id,
    ],
    [
      "EXPECTED_CLARITY_BACKEND_CLIENT_ID",
      clarity.backendServiceCredential.clientId,
    ],
    ["EXPECTED_CLARITY_AGENT_ID", clarity.aliaAgent.id],
  ];
  for (const [envName, canonical] of bindings) {
    const supplied = process.env[envName];
    if (supplied !== undefined && supplied !== canonical) {
      throw new Error(
        `${envName} does not match this image's exact native-agent manifest`,
      );
    }
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExact(
  target: NativeProductAgentDriftTarget,
  label: string,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (!same(actual[field], expectedValue)) {
      if (
        !NATIVE_PRODUCT_AGENT_DRIFT_FIELDS.includes(
          field as NativeProductAgentDriftField,
        )
      ) {
        throw new Error(`${label} has an unregistered drift field`);
      }
      throw new NativeProductAgentStateDriftError(
        target,
        field as NativeProductAgentDriftField,
      );
    }
  }
}

function accountDriftTarget(
  accountId: string,
  ancestry: boolean,
): NativeProductAgentDriftTarget {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  const suffix = ancestry ? "ancestry" : "account";
  if (accountId === homiio.project.id) return `homiio_project_${suffix}`;
  if (accountId === homiio.bot.id) return `homiio_bot_${suffix}`;
  if (accountId === clarity.project.id) return `clarity_project_${suffix}`;
  if (accountId === clarity.bot.id) return `clarity_bot_${suffix}`;
  throw new Error("Unregistered native product-agent account identity");
}

function costCenterDriftTarget(
  accountId: string,
): NativeProductAgentDriftTarget {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  if (accountId === homiio.project.id) return "homiio_cost_center";
  if (accountId === clarity.project.id) return "clarity_cost_center";
  throw new Error("Unregistered native product-agent cost centre identity");
}

async function requireOxyOrganization(tx: Transaction): Promise<void> {
  const id = NATIVE_PRODUCT_AGENTS.oxyOrganizationId;
  const [row] = await tx
    .select({
      id: users.id,
      kind: users.kind,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(eq(users.id, id))
    .for("update");
  if (!row) throw new Error(`Reserved Oxy organization ${id} does not exist`);
  assertExact("oxy_organization", "Oxy organization", row, {
    id,
    kind: "organization",
    accountStatus: "active",
  });
}

async function observeAccount(
  tx: Transaction,
  spec: AccountSpec,
  boundApplicationId: string | null = null,
): Promise<AccountObservation> {
  const [row] = await tx
    .select({
      id: users.id,
      username: users.username,
      nameDisplay: users.nameDisplay,
      kind: users.kind,
      type: users.type,
      parentAccountId: users.parentAccountId,
      rootAccountId: users.rootAccountId,
      accountStatus: users.accountStatus,
      privacyIsPrivateAccount: users.privacyIsPrivateAccount,
    })
    .from(users)
    .where(eq(users.id, spec.id))
    .for("update");

  const usernameHolders = await tx
    .select({
      id: users.id,
      kind: users.kind,
      type: users.type,
      parentAccountId: users.parentAccountId,
      rootAccountId: users.rootAccountId,
      accountStatus: users.accountStatus,
      privacyIsPrivateAccount: users.privacyIsPrivateAccount,
    })
    .from(users)
    .where(
      sql`lower(btrim(${users.username})) = lower(btrim(${spec.username}))`,
    )
    .for("update");
  if (usernameHolders.length > 1) {
    throw new Error("users_lower_username_key uniqueness is not enforced");
  }
  const usernameHolder = usernameHolders[0];
  if (usernameHolder && usernameHolder.id !== spec.id) {
    let boundApplication: NativeProductAgentBoundApplication | null = null;
    if (boundApplicationId !== null) {
      const [row] = await tx
        .select({
          id: applications.id,
          ownerAccountId: applications.ownerAccountId,
          type: applications.type,
          status: applications.status,
          isOfficial: applications.isOfficial,
          isInternal: applications.isInternal,
          createdByUserId: applications.createdByUserId,
        })
        .from(applications)
        .where(eq(applications.id, boundApplicationId))
        .limit(1)
        .for("update");
      boundApplication = row ?? null;
    }
    throw new NativeProductAgentUsernameCollisionError(
      spec.id,
      usernameHolder,
      boundApplication,
    );
  }
  if (!row) return { spec, exists: false };

  assertExact(accountDriftTarget(spec.id, false), `Account ${spec.id}`, row, {
    id: spec.id,
    username: spec.username,
    nameDisplay: spec.displayName,
    kind: spec.kind,
    type: spec.kind === "bot" ? "automated" : "local",
    parentAccountId: spec.parentAccountId,
    rootAccountId: spec.rootAccountId,
    accountStatus: "active",
    privacyIsPrivateAccount: spec.kind === "bot",
  });
  const path = await tx
    .select({
      depth: userAncestors.depth,
      ancestorId: userAncestors.ancestorId,
    })
    .from(userAncestors)
    .where(eq(userAncestors.userId, spec.id))
    .orderBy(asc(userAncestors.depth));
  assertExact(
    accountDriftTarget(spec.id, true),
    `Account ${spec.id} ancestry`,
    { path },
    {
      path: spec.ancestors.map((ancestorId, depth) => ({ depth, ancestorId })),
    },
  );
  return { spec, exists: true };
}

async function insertAccount(
  tx: Transaction,
  observation: AccountObservation,
): Promise<void> {
  if (observation.exists) return;
  const spec = observation.spec;
  await tx.insert(users).values({
    id: spec.id,
    username: spec.username,
    nameDisplay: spec.displayName,
    kind: spec.kind,
    type: spec.kind === "bot" ? "automated" : "local",
    parentAccountId: spec.parentAccountId,
    rootAccountId: spec.rootAccountId,
    accountStatus: "active",
    privacyIsPrivateAccount: spec.kind === "bot",
    verified: true,
  });
  await tx
    .insert(userAncestors)
    .values(
      spec.ancestors.map((ancestorId, depth) => ({
        userId: spec.id,
        depth,
        ancestorId,
      })),
    );
}

async function observeCostCenter(
  tx: Transaction,
  spec: CostCenterSpec,
): Promise<CostCenterObservation> {
  const [row] = await tx
    .select({
      accountId: internalCostCenters.accountId,
      slug: internalCostCenters.slug,
      label: internalCostCenters.label,
      status: internalCostCenters.status,
    })
    .from(internalCostCenters)
    .where(eq(internalCostCenters.accountId, spec.accountId))
    .for("update");
  const [slugHolder] = await tx
    .select({ accountId: internalCostCenters.accountId })
    .from(internalCostCenters)
    .where(eq(internalCostCenters.slug, spec.slug))
    .limit(1)
    .for("update");
  if (slugHolder && slugHolder.accountId !== spec.accountId) {
    throw new Error(
      `Cost-centre slug collision for ${spec.slug}: held by ${slugHolder.accountId}`,
    );
  }
  if (!row) return { spec, exists: false };
  assertExact(
    costCenterDriftTarget(spec.accountId),
    `Cost centre ${spec.accountId}`,
    row,
    {
      ...spec,
      status: "active",
    },
  );
  return { spec, exists: true };
}

async function insertCostCenter(
  tx: Transaction,
  observation: CostCenterObservation,
): Promise<void> {
  if (observation.exists) return;
  await tx
    .insert(internalCostCenters)
    .values({ ...observation.spec, status: "active" });
}

async function observeBootstrap(
  tx: Transaction,
  serviceSecretHashes: ServiceSecretHashes,
): Promise<BootstrapObservations> {
  await requireOxyOrganization(tx);
  const root = NATIVE_PRODUCT_AGENTS.oxyOrganizationId;
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  const accountSpecs: AccountSpec[] = [
    {
      ...homiio.project,
      kind: "project",
      parentAccountId: root,
      rootAccountId: root,
      ancestors: [root],
    },
    {
      ...homiio.bot,
      kind: "bot",
      parentAccountId: homiio.project.id,
      rootAccountId: root,
      ancestors: [root, homiio.project.id],
    },
    {
      ...clarity.project,
      kind: "project",
      parentAccountId: root,
      rootAccountId: root,
      ancestors: [root],
    },
    {
      ...clarity.bot,
      kind: "bot",
      parentAccountId: clarity.project.id,
      rootAccountId: root,
      ancestors: [root, clarity.project.id],
    },
  ];
  const accounts: AccountObservation[] = [];
  for (const spec of accountSpecs) {
    accounts.push(
      await observeAccount(
        tx,
        spec,
        spec.id === homiio.project.id ? homiio.applicationId : null,
      ),
    );
  }

  const costCenters: CostCenterObservation[] = [];
  for (const spec of [
    {
      accountId: homiio.project.id,
      slug: homiio.project.costCenterSlug,
      label: homiio.project.displayName,
    },
    {
      accountId: clarity.project.id,
      slug: clarity.project.costCenterSlug,
      label: clarity.project.displayName,
    },
  ]) {
    costCenters.push(await observeCostCenter(tx, spec));
  }

  const [homiioApplication] = await tx
    .select({
      id: applications.id,
      ownerAccountId: applications.ownerAccountId,
      type: applications.type,
      status: applications.status,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      scopes: applications.scopes,
    })
    .from(applications)
    .where(eq(applications.id, homiio.applicationId))
    .for("update");
  if (!homiioApplication) {
    throw new Error(
      `Existing Homiio application ${homiio.applicationId} was not found`,
    );
  }
  if (
    homiioApplication.ownerAccountId !== root &&
    homiioApplication.ownerAccountId !== homiio.project.id
  ) {
    throw new Error(
      `Homiio application ${homiio.applicationId} has unexpected owner ${homiioApplication.ownerAccountId}; expected ${root} or ${homiio.project.id}`,
    );
  }
  assertExact(
    "homiio_application",
    `Homiio application ${homiio.applicationId}`,
    homiioApplication,
    {
      id: homiio.applicationId,
      type: "first_party",
      status: "active",
      isOfficial: true,
      isInternal: false,
    },
  );
  const [homiioSindiCredential] = await tx
    .select({
      id: applicationCredentials.id,
      applicationId: applicationCredentials.applicationId,
      name: applicationCredentials.name,
      publicKey: applicationCredentials.publicKey,
      secretHash: applicationCredentials.secretHash,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      scopes: applicationCredentials.scopes,
      status: applicationCredentials.status,
      createdByUserId: applicationCredentials.createdByUserId,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, homiio.sindiServiceCredential.id))
    .for("update");
  const [homiioClientIdHolder] = await tx
    .select({ id: applicationCredentials.id })
    .from(applicationCredentials)
    .where(
      eq(
        applicationCredentials.publicKey,
        homiio.sindiServiceCredential.clientId,
      ),
    )
    .limit(1)
    .for("update");
  if (
    homiioClientIdHolder &&
    homiioClientIdHolder.id !== homiio.sindiServiceCredential.id
  ) {
    throw new Error(
      `Sindi client-id collision: held by credential ${homiioClientIdHolder.id}`,
    );
  }
  if (homiioSindiCredential) {
    assertExact(
      "sindi_service_credential",
      `Sindi credential ${homiio.sindiServiceCredential.id}`,
      {
        ...homiioSindiCredential,
        secretHashPresent: homiioSindiCredential.secretHash !== null,
      },
      {
        id: homiio.sindiServiceCredential.id,
        applicationId: homiio.applicationId,
        name: "Sindi production service",
        publicKey: homiio.sindiServiceCredential.clientId,
        secretHashPresent: true,
        type: "service",
        environment: "production",
        scopes: [...homiio.sindiServiceCredential.scopes],
        status: "active",
        createdByUserId: root,
      },
    );
    if (!/^[a-f0-9]{64}$/.test(homiioSindiCredential.secretHash ?? "")) {
      throw new Error("Sindi service credential secret hash is malformed");
    }
    if (APPLY) {
      requireExistingServiceCredentialSecretHash({
        label: `Sindi credential ${homiio.sindiServiceCredential.id}`,
        existingSecretHash: homiioSindiCredential.secretHash,
        suppliedSecretHash: serviceSecretHashes.homiioSindi,
      });
    }
  }

  const [clarityApplication] = await tx
    .select({
      id: applications.id,
      name: applications.name,
      websiteUrl: applications.websiteUrl,
      type: applications.type,
      status: applications.status,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      capabilities: applications.capabilities,
      redirectUris: applications.redirectUris,
      scopes: applications.scopes,
      ownerAccountId: applications.ownerAccountId,
      createdByUserId: applications.createdByUserId,
    })
    .from(applications)
    .where(eq(applications.id, clarity.application.id))
    .for("update");
  const [clarityNameHolder] = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(
      sql`lower(btrim(${applications.name})) = lower(btrim(${clarity.application.name}))`,
    )
    .limit(1)
    .for("update");
  if (clarityNameHolder && clarityNameHolder.id !== clarity.application.id) {
    throw new Error(
      `Application name collision for Clarity: held by ${clarityNameHolder.id}`,
    );
  }
  if (clarityApplication) {
    assertExact(
      "clarity_application",
      `Clarity application ${clarity.application.id}`,
      clarityApplication,
      {
        id: clarity.application.id,
        name: clarity.application.name,
        websiteUrl: clarity.application.websiteUrl,
        type: "first_party",
        status: "active",
        isOfficial: true,
        isInternal: false,
        capabilities: [],
        redirectUris: [...clarity.application.redirectUris],
        scopes: [...clarity.application.scopes],
        ownerAccountId: clarity.project.id,
        createdByUserId: root,
      },
    );
  }

  const [clarityCredential] = await tx
    .select({
      id: applicationCredentials.id,
      applicationId: applicationCredentials.applicationId,
      name: applicationCredentials.name,
      publicKey: applicationCredentials.publicKey,
      secretHash: applicationCredentials.secretHash,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      scopes: applicationCredentials.scopes,
      status: applicationCredentials.status,
      createdByUserId: applicationCredentials.createdByUserId,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, clarity.publicCredential.id))
    .for("update");
  const [clientIdHolder] = await tx
    .select({ id: applicationCredentials.id })
    .from(applicationCredentials)
    .where(
      eq(applicationCredentials.publicKey, clarity.publicCredential.clientId),
    )
    .limit(1)
    .for("update");
  if (clientIdHolder && clientIdHolder.id !== clarity.publicCredential.id) {
    throw new Error(
      `Clarity client-id collision: held by credential ${clientIdHolder.id}`,
    );
  }
  if (clarityCredential) {
    assertExact(
      "clarity_public_credential",
      `Clarity credential ${clarity.publicCredential.id}`,
      clarityCredential,
      {
        id: clarity.publicCredential.id,
        applicationId: clarity.application.id,
        name: "Production public client",
        publicKey: clarity.publicCredential.clientId,
        secretHash: null,
        type: "public",
        environment: "production",
        scopes: ["user:read"],
        status: "active",
        createdByUserId: root,
      },
    );
  }

  const [clarityBackendApplication] = await tx
    .select({
      id: applications.id,
      name: applications.name,
      type: applications.type,
      status: applications.status,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
      capabilities: applications.capabilities,
      redirectUris: applications.redirectUris,
      scopes: applications.scopes,
      ownerAccountId: applications.ownerAccountId,
      createdByUserId: applications.createdByUserId,
    })
    .from(applications)
    .where(eq(applications.id, clarity.backendApplication.id))
    .for("update");
  const [clarityBackendNameHolder] = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(
      sql`lower(btrim(${applications.name})) = lower(btrim(${clarity.backendApplication.name}))`,
    )
    .limit(1)
    .for("update");
  if (
    clarityBackendNameHolder &&
    clarityBackendNameHolder.id !== clarity.backendApplication.id
  ) {
    throw new Error(
      `Application name collision for Clarity Backend: held by ${clarityBackendNameHolder.id}`,
    );
  }
  if (clarityBackendApplication) {
    assertExact(
      "clarity_backend_application",
      `Clarity backend application ${clarity.backendApplication.id}`,
      clarityBackendApplication,
      {
        id: clarity.backendApplication.id,
        name: clarity.backendApplication.name,
        type: clarity.backendApplication.type,
        status: "active",
        isOfficial: true,
        isInternal: true,
        capabilities: [],
        redirectUris: [],
        scopes: [...clarity.backendApplication.scopes],
        ownerAccountId: clarity.project.id,
        createdByUserId: root,
      },
    );
  }

  const [clarityBackendCredential] = await tx
    .select({
      id: applicationCredentials.id,
      applicationId: applicationCredentials.applicationId,
      name: applicationCredentials.name,
      publicKey: applicationCredentials.publicKey,
      secretHash: applicationCredentials.secretHash,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      scopes: applicationCredentials.scopes,
      status: applicationCredentials.status,
      createdByUserId: applicationCredentials.createdByUserId,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, clarity.backendServiceCredential.id))
    .for("update");
  const [clarityBackendClientIdHolder] = await tx
    .select({ id: applicationCredentials.id })
    .from(applicationCredentials)
    .where(
      eq(
        applicationCredentials.publicKey,
        clarity.backendServiceCredential.clientId,
      ),
    )
    .limit(1)
    .for("update");
  if (
    clarityBackendClientIdHolder &&
    clarityBackendClientIdHolder.id !== clarity.backendServiceCredential.id
  ) {
    throw new Error(
      `Clarity backend client-id collision: held by credential ${clarityBackendClientIdHolder.id}`,
    );
  }
  if (clarityBackendCredential) {
    assertExact(
      "clarity_backend_credential",
      `Clarity backend credential ${clarity.backendServiceCredential.id}`,
      {
        ...clarityBackendCredential,
        secretHashPresent: clarityBackendCredential.secretHash !== null,
      },
      {
        id: clarity.backendServiceCredential.id,
        applicationId: clarity.backendApplication.id,
        name: "Clarity backend production service",
        publicKey: clarity.backendServiceCredential.clientId,
        secretHashPresent: true,
        type: "service",
        environment: "production",
        scopes: [...clarity.backendServiceCredential.scopes],
        status: "active",
        createdByUserId: root,
      },
    );
    if (!/^[a-f0-9]{64}$/.test(clarityBackendCredential.secretHash ?? "")) {
      throw new Error("Clarity backend credential secret hash is malformed");
    }
    if (APPLY) {
      requireExistingServiceCredentialSecretHash({
        label: `Clarity backend credential ${clarity.backendServiceCredential.id}`,
        existingSecretHash: clarityBackendCredential.secretHash,
        suppliedSecretHash: serviceSecretHashes.clarityBackend,
      });
    }
  }

  return {
    accounts,
    costCenters,
    homiioOwnerAccountId: homiioApplication.ownerAccountId,
    homiioApplicationScopes: homiioApplication.scopes,
    homiioSindiCredentialExists: homiioSindiCredential !== undefined,
    homiioSindiCredentialBefore: homiioSindiCredential
      ? {
          ...homiioSindiCredential,
          secretHash: undefined,
          secretHashPresent: homiioSindiCredential.secretHash !== null,
        }
      : null,
    homiioApplicationBefore: homiioApplication,
    clarityApplicationExists: clarityApplication !== undefined,
    clarityCredentialExists: clarityCredential !== undefined,
    clarityBackendApplicationExists: clarityBackendApplication !== undefined,
    clarityBackendCredentialExists: clarityBackendCredential !== undefined,
    clarityApplicationBefore: clarityApplication ?? null,
    clarityCredentialBefore: clarityCredential
      ? { ...clarityCredential, secretHash: undefined }
      : null,
    clarityBackendApplicationBefore: clarityBackendApplication ?? null,
    clarityBackendCredentialBefore: clarityBackendCredential
      ? {
          ...clarityBackendCredential,
          secretHash: undefined,
          secretHashPresent: clarityBackendCredential.secretHash !== null,
        }
      : null,
  };
}

function bootstrapOperations(observed: BootstrapObservations): string[] {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  return [
    ...observed.accounts.map(
      (item) => `${item.exists ? "assert" : "insert"} account ${item.spec.id}`,
    ),
    ...observed.costCenters.map(
      (item) =>
        `${item.exists ? "assert" : "insert"} cost-center ${item.spec.accountId}`,
    ),
    observed.homiioOwnerAccountId === homiio.project.id
      ? `assert application-owner ${homiio.applicationId}=${homiio.project.id}`
      : `move application ${homiio.applicationId} owner ${observed.homiioOwnerAccountId}->${homiio.project.id}`,
    ...homiio.sindiServiceCredential.scopes.map((scope) =>
      observed.homiioApplicationScopes.includes(scope)
        ? `assert application-scope ${homiio.applicationId}:${scope}`
        : `grant application-scope ${homiio.applicationId}:${scope}`,
    ),
    `${observed.homiioSindiCredentialExists ? "assert" : "insert"} credential ${homiio.sindiServiceCredential.id}`,
    `${observed.clarityApplicationExists ? "assert" : "insert"} application ${clarity.application.id}`,
    `${observed.clarityCredentialExists ? "assert" : "insert"} credential ${clarity.publicCredential.id}`,
    `${observed.clarityBackendApplicationExists ? "assert" : "insert"} application ${clarity.backendApplication.id}`,
    `${observed.clarityBackendCredentialExists ? "assert" : "insert"} credential ${clarity.backendServiceCredential.id}`,
  ];
}

function readServiceSecretHash(envName: string): string {
  if (!APPLY) return "0".repeat(64);
  const path = process.env[envName];
  if (!path || path.trim() !== path) {
    throw new Error(
      `Creating this service credential requires exact ${envName} (use a protected file; never argv/env plaintext)`,
    );
  }
  const secret = readFileSync(path, "utf8");
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error(
      `${envName} must contain exactly 32 random bytes encoded as lowercase hex`,
    );
  }
  return createHash("sha256").update(secret).digest("hex");
}

async function applyBootstrap(
  tx: Transaction,
  observed: BootstrapObservations,
  serviceSecretHashes: ServiceSecretHashes,
): Promise<void> {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  for (const account of observed.accounts) await insertAccount(tx, account);
  for (const costCenter of observed.costCenters)
    await insertCostCenter(tx, costCenter);
  if (observed.homiioOwnerAccountId !== homiio.project.id) {
    await tx
      .update(applications)
      .set({ ownerAccountId: homiio.project.id })
      .where(eq(applications.id, homiio.applicationId));
  }
  const missingHomiioAppScopes = homiio.sindiServiceCredential.scopes.filter(
    (scope) => !observed.homiioApplicationScopes.includes(scope),
  );
  if (missingHomiioAppScopes.length > 0) {
    await tx
      .update(applications)
      .set({
        scopes: [
          ...observed.homiioApplicationScopes,
          ...missingHomiioAppScopes,
        ],
      })
      .where(eq(applications.id, homiio.applicationId));
  }
  if (!observed.homiioSindiCredentialExists) {
    await tx.insert(applicationCredentials).values({
      id: homiio.sindiServiceCredential.id,
      applicationId: homiio.applicationId,
      name: "Sindi production service",
      publicKey: homiio.sindiServiceCredential.clientId,
      secretHash: serviceSecretHashes.homiioSindi,
      type: "service",
      environment: "production",
      scopes: [...homiio.sindiServiceCredential.scopes],
      status: "active",
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  }
  if (!observed.clarityApplicationExists) {
    await tx.insert(applications).values({
      id: clarity.application.id,
      name: clarity.application.name,
      description: "Official Clarity product client",
      websiteUrl: clarity.application.websiteUrl,
      type: "first_party",
      status: "active",
      isOfficial: true,
      isInternal: false,
      capabilities: [],
      redirectUris: [...clarity.application.redirectUris],
      scopes: [...clarity.application.scopes],
      ownerAccountId: clarity.project.id,
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  }
  if (!observed.clarityCredentialExists) {
    await tx.insert(applicationCredentials).values({
      id: clarity.publicCredential.id,
      applicationId: clarity.application.id,
      name: "Production public client",
      publicKey: clarity.publicCredential.clientId,
      secretHash: null,
      type: "public",
      environment: "production",
      scopes: ["user:read"],
      status: "active",
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  }
  if (!observed.clarityBackendApplicationExists) {
    await tx.insert(applications).values({
      id: clarity.backendApplication.id,
      name: clarity.backendApplication.name,
      description: "Internal service identity for the Clarity Alia agent",
      type: clarity.backendApplication.type,
      status: "active",
      isOfficial: true,
      isInternal: true,
      capabilities: [],
      redirectUris: [],
      scopes: [...clarity.backendApplication.scopes],
      ownerAccountId: clarity.project.id,
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  }
  if (!observed.clarityBackendCredentialExists) {
    await tx.insert(applicationCredentials).values({
      id: clarity.backendServiceCredential.id,
      applicationId: clarity.backendApplication.id,
      name: "Clarity backend production service",
      publicKey: clarity.backendServiceCredential.clientId,
      secretHash: serviceSecretHashes.clarityBackend,
      type: "service",
      environment: "production",
      scopes: [...clarity.backendServiceCredential.scopes],
      status: "active",
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  }
}

function rollbackOperations(): string[] {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  return nativeProductAgentRollbackOperations({
    homiioBotId: homiio.bot.id,
    homiioSindiCredentialId: homiio.sindiServiceCredential.id,
    clarityBotId: clarity.bot.id,
    clarityApplicationId: clarity.application.id,
    clarityCredentialId: clarity.publicCredential.id,
    clarityBackendApplicationId: clarity.backendApplication.id,
    clarityBackendCredentialId: clarity.backendServiceCredential.id,
    homiioAgentId: homiio.aliaAgent.id,
    clarityAgentId: clarity.aliaAgent.id,
  });
}

async function applyRollback(tx: Transaction): Promise<void> {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  for (const id of [homiio.bot.id, clarity.bot.id]) {
    await tx
      .update(users)
      .set({ accountStatus: "archived", privacyIsPrivateAccount: true })
      .where(eq(users.id, id));
  }
  await tx
    .update(applicationCredentials)
    .set({ status: "revoked" })
    .where(eq(applicationCredentials.id, homiio.sindiServiceCredential.id));
  await tx
    .update(applications)
    .set({ status: "suspended", redirectUris: [] })
    .where(eq(applications.id, clarity.application.id));
  await tx
    .update(applicationCredentials)
    .set({ status: "revoked" })
    .where(eq(applicationCredentials.id, clarity.publicCredential.id));
  await tx
    .update(applications)
    .set({ status: "suspended", redirectUris: [] })
    .where(eq(applications.id, clarity.backendApplication.id));
  await tx
    .update(applicationCredentials)
    .set({ status: "revoked" })
    .where(eq(applicationCredentials.id, clarity.backendServiceCredential.id));
}

async function execute(): Promise<BootstrapReport> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAME}, 0))`,
    );

    // Retirement deliberately addresses only the reserved primary keys. It is
    // idempotent: an absent/already-retired optional row remains a no-op, while
    // the immutable Oxy organization is still required for the audit record.
    const serviceSecretHashes: ServiceSecretHashes | null = ROLLBACK
      ? null
      : {
          homiioSindi: readServiceSecretHash(
            "HOMIIO_SINDI_SERVICE_SECRET_FILE",
          ),
          clarityBackend: readServiceSecretHash(
            "CLARITY_BACKEND_SERVICE_SECRET_FILE",
          ),
        };
    const observed = ROLLBACK
      ? null
      : await observeBootstrap(tx, serviceSecretHashes!);
    if (ROLLBACK) await requireOxyOrganization(tx);
    const aliaManifest = aliaNativeAgentBootstrapManifest();
    const desired = {
      identities: NATIVE_PRODUCT_AGENTS,
      homiioApplication: {
        id: NATIVE_PRODUCT_AGENTS.products.homiio.applicationId,
        ownerAccountId: NATIVE_PRODUCT_AGENTS.products.homiio.project.id,
        type: "first_party",
        status: "active",
        isOfficial: true,
        isInternal: false,
        requiredApplicationScopes: [
          ...NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential
            .scopes,
        ],
        serviceCredential:
          NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential,
      },
      clarityPublicApplication: {
        ...NATIVE_PRODUCT_AGENTS.products.clarity.application,
        ownerAccountId: NATIVE_PRODUCT_AGENTS.products.clarity.project.id,
        type: "first_party",
        status: "active",
        isOfficial: true,
        isInternal: false,
        capabilities: [],
      },
      clarityPublicCredential: {
        ...NATIVE_PRODUCT_AGENTS.products.clarity.publicCredential,
        applicationId: NATIVE_PRODUCT_AGENTS.products.clarity.application.id,
        type: "public",
        environment: "production",
        scopes: ["user:read"],
        status: "active",
      },
      clarityBackendApplication: {
        ...NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication,
        ownerAccountId: NATIVE_PRODUCT_AGENTS.products.clarity.project.id,
        status: "active",
        isOfficial: true,
        isInternal: true,
        capabilities: [],
        redirectUris: [],
      },
      clarityBackendServiceCredential: {
        ...NATIVE_PRODUCT_AGENTS.products.clarity.backendServiceCredential,
        applicationId:
          NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication.id,
        type: "service",
        environment: "production",
        status: "active",
        secretHashPresent: true,
      },
    };
    const plan: NativeProductBootstrapPlan = {
      manifestVersion: NATIVE_PRODUCT_AGENTS.manifestVersion,
      direction: ROLLBACK ? "rollback" : "bootstrap",
      desired,
      before: observed,
      after: ROLLBACK
        ? {
            bots: { accountStatus: "archived", privacyIsPrivateAccount: true },
            clarityApplication: { status: "suspended", redirectUris: [] },
            clarityCredential: { status: "revoked" },
            projectsAndHomiioApplication: "unchanged",
          }
        : desired,
      aliaManifest,
      operations: ROLLBACK
        ? rollbackOperations()
        : bootstrapOperations(observed!),
    };
    const planSha256 = nativeProductBootstrapPlanSha256(plan);
    const approval = APPLY
      ? requireNativeProductBootstrapApproval(planSha256, process.env)
      : null;

    if (ROLLBACK) await applyRollback(tx);
    else await applyBootstrap(tx, observed!, serviceSecretHashes!);

    if (APPLY) {
      await tx.insert(securityActivities).values({
        userId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
        eventType: "security_settings_changed",
        eventDescription: ROLLBACK
          ? "Native product agents retired without deletion"
          : "Native product agent identities bootstrapped",
        severity: "high",
        metadata: {
          operation: ROLLBACK
            ? "rollback_native_product_agents"
            : "bootstrap_native_product_agents",
          actor: approval!.actor,
          reason: approval!.reason,
          planSha256,
          operations: plan.operations,
        },
      });
    }

    const report: BootstrapReport = {
      mode: APPLY ? "apply" : "dry-run",
      direction: plan.direction,
      planSha256,
      plan,
      aliaManifest,
      ...(observed === null
        ? {}
        : {
            serviceCredentialState: {
              homiioSindiExists: observed.homiioSindiCredentialExists,
              clarityBackendExists: observed.clarityBackendCredentialExists,
            },
          }),
    };
    if (!APPLY) throw new DryRunRollback(report);
    return report;
  });
}

async function main(): Promise<void> {
  assertWorkflowIdentityBindings();
  await connectPostgres();
  try {
    let report: BootstrapReport;
    try {
      report = await execute();
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
      report = error.report;
    }
    process.stdout.write(
      `NATIVE_PRODUCT_AGENTS_RESULT=${JSON.stringify({
        mode: report.mode,
        direction: report.direction,
        planSha256: report.planSha256,
        ...(report.serviceCredentialState === undefined
          ? {}
          : { serviceCredentialState: report.serviceCredentialState }),
      })}\n`,
    );
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  process.stdout.write(
    `NATIVE_PRODUCT_AGENTS_RESULT=${JSON.stringify(
      nativeProductAgentBootstrapFailureResult(error),
    )}\n`,
  );
  process.exitCode = 1;
});
