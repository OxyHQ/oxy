#!/usr/bin/env bun
/**
 * Provision the fixed Oxy identities needed by the Sindi and Clarity Alia
 * agents. Dry-run is the default and executes the same PostgreSQL writes before
 * rolling the single transaction back.
 *
 * No secret enters this process. Both product backends prove what they are by
 * attesting their ECS task roles (ADR 0026), so the two service credentials
 * that used to identify them are RETIRED: never created, never re-secreted, and
 * revoked here only once the replacing workload binding is live with every
 * scope the credential carried.
 *
 * Apply an observed plan only after review:
 *   APPLY=1 BOOTSTRAP_ACTOR=... BOOTSTRAP_REASON=... \
 *   EXPECTED_PLAN_SHA256=... bun run bootstrap:native-product-agents
 *
 * Emergency retirement is non-destructive:
 *   ROLLBACK=1 [the same APPLY approval variables] bun run ...
 */

import { and, asc, eq, sql } from "drizzle-orm";
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
  applicationWorkloadIdentities,
  applications,
  internalCostCenters,
  securityActivities,
  userAncestors,
  users,
} from "../src/db/schema";
import {
  nativeProductBootstrapPlanSha256,
  nativeProductAgentRollbackOperations,
  requireNativeProductBootstrapApproval,
  retiredServiceCredentialDecision,
  type NativeProductAgentWorkloadReadiness,
  type NativeProductBootstrapPlan,
} from "../src/scripts/nativeProductAgentsBootstrapPlan";
import { resolveLiveAgencyWorkload } from "../src/services/agencyServicePrincipal.service";
import type { AttestationProvider } from "../src/services/workloadAttestation.service";
import {
  classifyNativeProductAgentDisplayName,
} from "../src/scripts/nativeProductAgentAccountPlan";
import {
  NATIVE_PRODUCT_AGENT_DRIFT_FIELDS,
  type NativeProductAgentBoundApplication,
  type NativeProductAgentDriftField,
  type NativeProductAgentDriftTarget,
  NativeProductAgentStateDriftError,
  NativeProductAgentAccountAdoptionReviewError,
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
  normalizesLegacyDisplayName: boolean;
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

/**
 * A service credential this bootstrap used to mint, and now only retires.
 *
 * The product backend it identified attests its ECS task role instead (ADR
 * 0026), so the credential's one remaining state change is `revoked`, and that
 * only once `workload` is bound live to the same application with every scope
 * in `scopes`.
 */
interface RetiredServiceCredentialSpec {
  target: "sindi_service_credential" | "clarity_backend_credential";
  bindingTarget: "homiio_workload_binding" | "clarity_workload_binding";
  label: string;
  id: string;
  clientId: string;
  applicationId: string;
  name: string;
  scopes: readonly string[];
  workload: { provider: AttestationProvider; subject: string };
}

interface RetiredServiceCredentialObservation {
  spec: RetiredServiceCredentialSpec;
  /** Non-secret projection of the row, or null when it does not exist. */
  before: Record<string, unknown> | null;
  workload: { provider: AttestationProvider; subject: string } & NativeProductAgentWorkloadReadiness;
  disposition: "absent" | "already_revoked" | "revoke";
}

interface BootstrapObservations {
  accounts: AccountObservation[];
  costCenters: CostCenterObservation[];
  homiioOwnerAccountId: string;
  homiioApplicationScopes: string[];
  homiioApplicationCapabilities: string[];
  homiioImportWorkloads: { id: string; scopes: string[]; expiresAt: Date | null }[];
  homiioSindiCredential: RetiredServiceCredentialObservation;
  homiioApplicationBefore: unknown;
  clarityApplicationExists: boolean;
  clarityCredentialExists: boolean;
  clarityBackendApplicationExists: boolean;
  clarityBackendApplicationScopes: string[];
  /** The backend's live workload binding, when there is one to widen. */
  clarityBackendWorkload: { id: string; scopes: string[] } | null;
  clarityBackendWebhookUrl: string | null;
  clarityBackendCredential: RetiredServiceCredentialObservation;
  clarityApplicationBefore: unknown;
  clarityCredentialBefore: unknown;
  clarityBackendApplicationBefore: unknown;
}

interface BootstrapReport {
  mode: "dry-run" | "apply";
  direction: "bootstrap" | "rollback";
  planSha256: string;
  plan: NativeProductBootstrapPlan;
  aliaManifest: ReturnType<typeof aliaNativeAgentBootstrapManifest>;
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

async function observeBoundApplication(
  tx: Transaction,
  applicationId: string,
): Promise<NativeProductAgentBoundApplication | null> {
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
    .where(eq(applications.id, applicationId))
    .limit(1)
    .for("update");
  return row ?? null;
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
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
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
    const boundApplication =
      boundApplicationId === null
        ? null
        : await observeBoundApplication(tx, boundApplicationId);
    throw new NativeProductAgentUsernameCollisionError(
      spec.id,
      usernameHolder,
      boundApplication,
    );
  }
  if (!row) {
    return { spec, exists: false, normalizesLegacyDisplayName: false };
  }

  const displayNameDisposition = classifyNativeProductAgentDisplayName({
    adoptedLegacyAccount:
      spec.id === NATIVE_PRODUCT_AGENTS.products.homiio.project.id,
    expectedDisplayName: spec.displayName,
    storedDisplayName: row.nameDisplay,
    storedFirstName: row.nameFirst,
    storedLastName: row.nameLast,
  });
  const path = await tx
    .select({
      depth: userAncestors.depth,
      ancestorId: userAncestors.ancestorId,
    })
    .from(userAncestors)
    .where(eq(userAncestors.userId, spec.id))
    .orderBy(asc(userAncestors.depth));
  const canonicalPresentationMatches =
    row.username === spec.username && displayNameDisposition !== "drift";
  const accountStructureMatches = same(
    {
      id: row.id,
      kind: row.kind,
      type: row.type,
      parentAccountId: row.parentAccountId,
      rootAccountId: row.rootAccountId,
      accountStatus: row.accountStatus,
      privacyIsPrivateAccount: row.privacyIsPrivateAccount,
    },
    {
      id: spec.id,
      kind: spec.kind,
      type: spec.kind === "bot" ? "automated" : "local",
      parentAccountId: spec.parentAccountId,
      rootAccountId: spec.rootAccountId,
      accountStatus: "active",
      privacyIsPrivateAccount: spec.kind === "bot",
    },
  );
  const ancestryMatches = same(
    path,
    spec.ancestors.map((ancestorId, depth) => ({ depth, ancestorId })),
  );
  if (
    boundApplicationId !== null &&
    (!canonicalPresentationMatches ||
      !accountStructureMatches ||
      !ancestryMatches)
  ) {
    throw new NativeProductAgentAccountAdoptionReviewError(
      spec.id,
      row,
      canonicalPresentationMatches,
      ancestryMatches,
      await observeBoundApplication(tx, boundApplicationId),
    );
  }

  assertExact(accountDriftTarget(spec.id, false), `Account ${spec.id}`, row, {
    id: spec.id,
    username: spec.username,
    kind: spec.kind,
    type: spec.kind === "bot" ? "automated" : "local",
    parentAccountId: spec.parentAccountId,
    rootAccountId: spec.rootAccountId,
    accountStatus: "active",
    privacyIsPrivateAccount: spec.kind === "bot",
  });
  if (displayNameDisposition === "drift") {
    throw new NativeProductAgentStateDriftError(
      accountDriftTarget(spec.id, false),
      "nameDisplay",
    );
  }
  assertExact(
    accountDriftTarget(spec.id, true),
    `Account ${spec.id} ancestry`,
    { path },
    {
      path: spec.ancestors.map((ancestorId, depth) => ({ depth, ancestorId })),
    },
  );
  return {
    spec,
    exists: true,
    normalizesLegacyDisplayName:
      displayNameDisposition === "normalize_legacy",
  };
}

async function applyAccount(
  tx: Transaction,
  observation: AccountObservation,
): Promise<void> {
  const spec = observation.spec;
  if (observation.exists) {
    if (observation.normalizesLegacyDisplayName) {
      await tx
        .update(users)
        .set({ nameDisplay: spec.displayName })
        .where(eq(users.id, spec.id));
    }
    return;
  }
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

/**
 * Observe a retired service credential and decide its fate, without ever
 * reading its secret hash.
 *
 * The row, when present, must still be the exact credential this manifest
 * reserved — anything else is drift, exactly as before. Its STATUS is no longer
 * asserted: `revoked` is the goal, and any other status is what this run
 * changes. The replacing binding is read through `resolveLiveAgencyWorkload`,
 * the same live ceiling an attested Sindi caller is re-read against on every
 * requester-assertion mint, so "live" here means what it means at runtime.
 */
async function observeRetiredServiceCredential(
  tx: Transaction,
  spec: RetiredServiceCredentialSpec,
): Promise<RetiredServiceCredentialObservation> {
  const [row] = await tx
    .select({
      id: applicationCredentials.id,
      applicationId: applicationCredentials.applicationId,
      name: applicationCredentials.name,
      publicKey: applicationCredentials.publicKey,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      scopes: applicationCredentials.scopes,
      status: applicationCredentials.status,
      createdByUserId: applicationCredentials.createdByUserId,
    })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, spec.id))
    .for("update");
  const [clientIdHolder] = await tx
    .select({ id: applicationCredentials.id })
    .from(applicationCredentials)
    .where(eq(applicationCredentials.publicKey, spec.clientId))
    .limit(1)
    .for("update");
  if (clientIdHolder && clientIdHolder.id !== spec.id) {
    throw new Error(
      `${spec.label} client-id collision: held by credential ${clientIdHolder.id}`,
    );
  }
  if (row) {
    assertExact(spec.target, `${spec.label} ${spec.id}`, row, {
      id: spec.id,
      applicationId: spec.applicationId,
      name: spec.name,
      publicKey: spec.clientId,
      type: "service",
      environment: "production",
      scopes: [...spec.scopes],
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  }

  const live = await resolveLiveAgencyWorkload(
    spec.applicationId,
    spec.workload.provider,
    spec.workload.subject,
    new Date(),
    tx,
  );
  const readiness: NativeProductAgentWorkloadReadiness =
    live === null ? { live: false } : { live: true, scopes: [...live.scopes] };
  const decision = retiredServiceCredentialDecision({
    credentialStatus: row?.status ?? null,
    workload: readiness,
    requiredScopes: spec.scopes,
  });
  if ("refusal" in decision) {
    throw new NativeProductAgentStateDriftError(
      spec.bindingTarget,
      decision.refusal === "workload_not_live" ? "subject" : "scopes",
    );
  }
  return {
    spec,
    before: row ?? null,
    workload: { ...spec.workload, ...readiness },
    disposition: decision.disposition,
  };
}

async function observeBootstrap(
  tx: Transaction,
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
      capabilities: applications.capabilities,
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
  const homiioSindiCredential = await observeRetiredServiceCredential(tx, {
    target: "sindi_service_credential",
    bindingTarget: "homiio_workload_binding",
    label: "Sindi credential",
    id: homiio.sindiServiceCredential.id,
    clientId: homiio.sindiServiceCredential.clientId,
    applicationId: homiio.applicationId,
    name: "Sindi production service",
    scopes: homiio.sindiServiceCredential.scopes,
    workload: homiio.workload,
  });

  const homiioImportWorkloads: BootstrapObservations["homiioImportWorkloads"] = [];
  for (const workload of [homiio.organizationImport.workerWorkload]) {
    const [binding] = await tx
      .select({ id: applicationWorkloadIdentities.id, scopes: applicationWorkloadIdentities.scopes,
        expiresAt: applicationWorkloadIdentities.expiresAt, applicationId: applicationWorkloadIdentities.applicationId })
      .from(applicationWorkloadIdentities)
      .where(and(eq(applicationWorkloadIdentities.provider, workload.provider), eq(applicationWorkloadIdentities.subject, workload.subject)))
      .for("update");
    if (!binding || binding.applicationId !== homiio.applicationId ||
        (binding.expiresAt && binding.expiresAt <= new Date())) {
      throw new NativeProductAgentStateDriftError("homiio_workload_binding", "subject");
    }
    homiioImportWorkloads.push(binding);
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
      {
        ...clarityApplication,
        // Sets, not sequences: the same URIs, scopes or capabilities in another
        // order are the same authority and must not read as drift.
        capabilities: [...clarityApplication.capabilities].sort(),
        redirectUris: [...clarityApplication.redirectUris].sort(),
        scopes: [...clarityApplication.scopes].sort(),
      },
      {
        id: clarity.application.id,
        name: clarity.application.name,
        websiteUrl: clarity.application.websiteUrl,
        type: "first_party",
        status: "active",
        isOfficial: true,
        isInternal: false,
        capabilities: [],
        redirectUris: [...clarity.application.redirectUris].sort(),
        scopes: [...clarity.application.scopes].sort(),
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
      webhookUrl: applications.webhookUrl,
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
  if (clarityBackendApplication?.webhookUrl && clarityBackendApplication.webhookUrl !== clarity.backendApplication.webhookUrl) {
    throw new Error("Clarity backend already declares another webhook; review its routing before replacing it");
  }
  const clarityFileScopes: readonly string[] = clarity.backendApplication.fileScopes;
  if (clarityBackendApplication) {
    assertExact(
      "clarity_backend_application",
      `Clarity backend application ${clarity.backendApplication.id}`,
      {
        ...clarityBackendApplication,
        // The reviewed file grant (ADR 0041) is the one addition the bootstrap
        // makes to an existing row; any OTHER scope is drift, as before.
        scopes: clarityBackendApplication.scopes.filter(
          (scope) => !clarityFileScopes.includes(scope),
        ),
      },
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

  // The backend's live workload binding (ADR 0026), widened by the same file
  // grant. Absent (a fresh environment, or not yet bound) leaves nothing to
  // widen: the operator's bind names every scope (the runbook).
  const clarityBinding = clarityBackendApplication
    ? await resolveLiveAgencyWorkload(
        clarity.backendApplication.id,
        clarity.workload.provider,
        clarity.workload.subject,
        new Date(),
        tx,
      )
    : null;
  let clarityBackendWorkload: BootstrapObservations["clarityBackendWorkload"] = null;
  if (clarityBinding) {
    const [bindingRow] = await tx
      .select({ id: applicationWorkloadIdentities.id, scopes: applicationWorkloadIdentities.scopes })
      .from(applicationWorkloadIdentities)
      .where(
        and(
          eq(applicationWorkloadIdentities.provider, clarity.workload.provider),
          eq(applicationWorkloadIdentities.subject, clarity.workload.subject),
          eq(applicationWorkloadIdentities.applicationId, clarity.backendApplication.id),
        ),
      )
      .for("update");
    if (bindingRow) clarityBackendWorkload = { id: bindingRow.id, scopes: [...bindingRow.scopes] };
  }

  // Observed after its application: a credential row cannot exist without it,
  // and on a fresh database neither does the binding — which is fine, because
  // a credential that was never created needs no replacement to stay absent.
  const clarityBackendCredential = await observeRetiredServiceCredential(tx, {
    target: "clarity_backend_credential",
    bindingTarget: "clarity_workload_binding",
    label: "Clarity backend credential",
    id: clarity.backendServiceCredential.id,
    clientId: clarity.backendServiceCredential.clientId,
    applicationId: clarity.backendApplication.id,
    name: "Clarity backend production service",
    scopes: clarity.backendServiceCredential.scopes,
    workload: clarity.workload,
  });

  return {
    accounts,
    costCenters,
    homiioOwnerAccountId: homiioApplication.ownerAccountId,
    homiioApplicationScopes: homiioApplication.scopes,
    homiioApplicationCapabilities: homiioApplication.capabilities,
    homiioImportWorkloads,
    homiioSindiCredential,
    homiioApplicationBefore: homiioApplication,
    clarityApplicationExists: clarityApplication !== undefined,
    clarityCredentialExists: clarityCredential !== undefined,
    clarityBackendApplicationExists: clarityBackendApplication !== undefined,
    clarityBackendApplicationScopes: [...(clarityBackendApplication?.scopes ?? [])],
    clarityBackendWorkload,
    clarityBackendWebhookUrl: clarityBackendApplication?.webhookUrl ?? null,
    clarityBackendCredential,
    clarityApplicationBefore: clarityApplication ?? null,
    clarityCredentialBefore: clarityCredential
      ? { ...clarityCredential, secretHash: undefined }
      : null,
    clarityBackendApplicationBefore: clarityBackendApplication ?? null,
  };
}

function retiredCredentialOperation(
  observed: RetiredServiceCredentialObservation,
): string {
  const { spec, disposition } = observed;
  if (disposition === "absent") return `assert absent credential ${spec.id}`;
  if (disposition === "already_revoked")
    return `assert revoked credential ${spec.id}`;
  return `revoke credential ${spec.id} superseded-by workload ${spec.workload.provider}:${spec.workload.subject}`;
}

function bootstrapOperations(observed: BootstrapObservations): string[] {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  return [
    ...observed.accounts.flatMap((item) => [
      `${item.exists ? "assert" : "insert"} account ${item.spec.id}`,
      ...(item.normalizesLegacyDisplayName
        ? [`normalize legacy-display-name account ${item.spec.id}`]
        : []),
    ]),
    ...observed.costCenters.map(
      (item) =>
        `${item.exists ? "assert" : "insert"} cost-center ${item.spec.accountId}`,
    ),
    observed.homiioOwnerAccountId === homiio.project.id
      ? `assert application-owner ${homiio.applicationId}=${homiio.project.id}`
      : `move application ${homiio.applicationId} owner ${observed.homiioOwnerAccountId}->${homiio.project.id}`,
    ...[...homiio.sindiServiceCredential.scopes, homiio.organizationImport.scope].map((scope) =>
      observed.homiioApplicationScopes.includes(scope)
        ? `assert application-scope ${homiio.applicationId}:${scope}`
        : `grant application-scope ${homiio.applicationId}:${scope}`,
    ),
    `${observed.homiioApplicationCapabilities.includes(homiio.organizationImport.capability) ? "assert" : "grant"} application-capability ${homiio.applicationId}:${homiio.organizationImport.capability}`,
    ...observed.homiioImportWorkloads.map(binding => `${binding.scopes.includes(homiio.organizationImport.scope) ? "assert" : "grant"} workload-scope ${binding.id}:${homiio.organizationImport.scope}`),
    retiredCredentialOperation(observed.homiioSindiCredential),
    `${observed.clarityApplicationExists ? "assert" : "insert"} application ${clarity.application.id}`,
    `${observed.clarityCredentialExists ? "assert" : "insert"} credential ${clarity.publicCredential.id}`,
    `${observed.clarityBackendApplicationExists ? "assert" : "insert"} application ${clarity.backendApplication.id}`,
    ...clarity.backendApplication.fileScopes.map((scope) =>
      observed.clarityBackendApplicationExists &&
      observed.clarityBackendApplicationScopes.includes(scope)
        ? `assert application-scope ${clarity.backendApplication.id}:${scope}`
        : `grant application-scope ${clarity.backendApplication.id}:${scope}`,
    ),
    ...(observed.clarityBackendWorkload
      ? clarity.backendApplication.fileScopes.map(
          (scope) =>
            `${observed.clarityBackendWorkload?.scopes.includes(scope) ? "assert" : "grant"} workload-scope ${observed.clarityBackendWorkload?.id}:${scope}`,
        )
      : []),
    `${observed.clarityBackendWebhookUrl ? "assert" : "register"} webhook ${clarity.backendApplication.id}=${clarity.backendApplication.webhookUrl}`,
    retiredCredentialOperation(observed.clarityBackendCredential),
  ];
}

async function applyBootstrap(
  tx: Transaction,
  observed: BootstrapObservations,
): Promise<void> {
  const { homiio, clarity } = NATIVE_PRODUCT_AGENTS.products;
  for (const account of observed.accounts) await applyAccount(tx, account);
  for (const costCenter of observed.costCenters)
    await insertCostCenter(tx, costCenter);
  if (observed.homiioOwnerAccountId !== homiio.project.id) {
    await tx
      .update(applications)
      .set({ ownerAccountId: homiio.project.id })
      .where(eq(applications.id, homiio.applicationId));
  }
  const missingHomiioAppScopes = [...homiio.sindiServiceCredential.scopes, homiio.organizationImport.scope].filter(
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
  if (!observed.homiioApplicationCapabilities.includes(homiio.organizationImport.capability)) {
    await tx.update(applications).set({ capabilities: [...observed.homiioApplicationCapabilities, homiio.organizationImport.capability] }).where(eq(applications.id, homiio.applicationId));
  }
  for (const binding of observed.homiioImportWorkloads) {
    if (!binding.scopes.includes(homiio.organizationImport.scope)) {
      await tx.update(applicationWorkloadIdentities).set({ scopes: [...binding.scopes, homiio.organizationImport.scope] }).where(eq(applicationWorkloadIdentities.id, binding.id));
    }
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
      webhookUrl: clarity.backendApplication.webhookUrl,
      description: "Internal service identity for the Clarity Alia agent",
      type: clarity.backendApplication.type,
      status: "active",
      isOfficial: true,
      isInternal: true,
      capabilities: [],
      redirectUris: [],
      scopes: [...clarity.backendApplication.scopes, ...clarity.backendApplication.fileScopes],
      ownerAccountId: clarity.project.id,
      createdByUserId: NATIVE_PRODUCT_AGENTS.oxyOrganizationId,
    });
  } else {
    const missing = clarity.backendApplication.fileScopes.filter(
      (scope) => !observed.clarityBackendApplicationScopes.includes(scope),
    );
    if (missing.length > 0) {
      await tx
        .update(applications)
        .set({ scopes: [...observed.clarityBackendApplicationScopes, ...missing] })
        .where(eq(applications.id, clarity.backendApplication.id));
    }
  }
  if (observed.clarityBackendWorkload) {
    const binding = observed.clarityBackendWorkload;
    const missing = clarity.backendApplication.fileScopes.filter(
      (scope) => !binding.scopes.includes(scope),
    );
    if (missing.length > 0) {
      await tx
        .update(applicationWorkloadIdentities)
        .set({ scopes: [...binding.scopes, ...missing] })
        .where(eq(applicationWorkloadIdentities.id, binding.id));
    }
  }
  if (observed.clarityBackendApplicationExists && observed.clarityBackendWebhookUrl === null) {
    await tx.update(applications).set({webhookUrl:clarity.backendApplication.webhookUrl}).where(eq(applications.id,clarity.backendApplication.id));
  }
  // Last, so a backend application this run creates already exists — though a
  // credential this run could revoke can only belong to one that did.
  for (const retired of [
    observed.homiioSindiCredential,
    observed.clarityBackendCredential,
  ]) {
    if (retired.disposition !== "revoke") continue;
    await tx
      .update(applicationCredentials)
      .set({ status: "revoked" })
      .where(
        and(
          eq(applicationCredentials.id, retired.spec.id),
          eq(applicationCredentials.applicationId, retired.spec.applicationId),
        ),
      );
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
    const observed = ROLLBACK ? null : await observeBootstrap(tx);
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
        requiredCapabilities: [NATIVE_PRODUCT_AGENTS.products.homiio.organizationImport.capability],
        importWorkloads: [NATIVE_PRODUCT_AGENTS.products.homiio.organizationImport.workerWorkload],
        requiredWorkloadScopes: [NATIVE_PRODUCT_AGENTS.products.homiio.organizationImport.scope],
        requiredApplicationScopes: [
          NATIVE_PRODUCT_AGENTS.products.homiio.organizationImport.scope,
          ...NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential
            .scopes,
        ],
        workload: NATIVE_PRODUCT_AGENTS.products.homiio.workload,
        retiredServiceCredential: {
          ...NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential,
          // Absent is equally final: the bootstrap never creates it.
          status: "revoked",
          retiredOnlyWhileWorkloadReaches: [
            ...NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential
              .scopes,
          ],
        },
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
      clarityBackendWorkload: NATIVE_PRODUCT_AGENTS.products.clarity.workload,
      clarityBackendRetiredServiceCredential: {
        ...NATIVE_PRODUCT_AGENTS.products.clarity.backendServiceCredential,
        applicationId:
          NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication.id,
        type: "service",
        environment: "production",
        // Absent is equally final: the bootstrap never creates it.
        status: "revoked",
        retiredOnlyWhileWorkloadReaches: [
          ...NATIVE_PRODUCT_AGENTS.products.clarity.backendServiceCredential
            .scopes,
        ],
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
    else await applyBootstrap(tx, observed!);

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
          actor: approval?.actor,
          reason: approval?.reason,
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
        plan: report.plan,
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
