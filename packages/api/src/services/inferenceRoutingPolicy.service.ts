/**
 * Routing Policy Service — the customer's routing configuration, and the record
 * of every allowed route switch (issue #972, workstream 6).
 *
 * Three jobs, and they are deliberately the only three:
 *
 *  1. **Write a policy version**, validating it through the CONTRACT's own
 *     refinement rather than a second, differently-worded copy of it.
 *  2. **Resolve the policy in force** for an application — its own, else its
 *     owner account's, else none.
 *  3. **Record a route switch**, refusing any substitution the customer did not
 *     authorise by name.
 *
 * Executing a policy is not here and never will be: the data plane owns routing
 * execution (ADR 0006). This module owns what the configuration IS.
 *
 * ## Validation is the contract's, not a paraphrase of it
 *
 * `routingPolicySchema` in `@oxyhq/contracts` already carries the refinement
 * that rejects contradictory policies. {@link validateRoutingPolicy} ASSEMBLES a
 * complete policy — the caller's controls plus the identity fields the server
 * owns — and runs that schema over it. Nothing here restates a rule the contract
 * already states; a second wording would be a second thing to keep true, and the
 * failure mode of two validators is that the looser one is the one a request
 * happens to reach.
 *
 * What storage adds ON TOP is not a re-check of the same rules but the
 * constraints a flat wire object cannot express — one currency column instead of
 * a currency per ceiling, an authorisation that exists as ROWS rather than a
 * boolean, a composite key tying a recorded switch to the version that permitted
 * it. Those live in the schema files, where they are unrepresentable rather than
 * rejected. See `db/schema/inferenceRoutingPolicyVersions.ts`.
 *
 * ## A version is appended, never edited
 *
 * Every write here appends. `is_current` moves; nothing else about a version
 * changes, and the database enforces that with a trigger
 * (`db/schema/inferenceRoutingImmutability.ts`) rather than trusting this
 * module. The next version number is allocated under a `SELECT … FOR UPDATE` on
 * the policy row, because two concurrent edits both reading `max(version)` would
 * both compute the same next number — a transaction gives atomicity, not
 * serialisation.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@oxyhq/db';
import {
  routingPolicyScopeSchema,
  routingPolicySchema,
  type RoutingPolicy,
  type RoutingPolicyScope,
  type RoutingTarget,
  type UnitPrice,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { inferenceModelRevisions } from '../db/schema/inferenceModelRevisions';
import { inferenceModels } from '../db/schema/inferenceModels';
import {
  inferenceRouteSwitchEvents,
  type RouteSwitchReason,
  type RouteSwitchScope,
} from '../db/schema/inferenceRouteSwitchEvents';
import { inferenceRoutingPolicies } from '../db/schema/inferenceRoutingPolicies';
import { inferenceRoutingPolicyFallbacks } from '../db/schema/inferenceRoutingPolicyFallbacks';
import { inferenceRoutingPolicyPriceCaps } from '../db/schema/inferenceRoutingPolicyPriceCaps';
import { inferenceRoutingPolicyVersions } from '../db/schema/inferenceRoutingPolicyVersions';
import { inferenceRoutingProfiles } from '../db/schema/inferenceRoutingProfiles';

/** The database handle a helper runs on — the pool, or an open transaction. */
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * Everything a CUSTOMER decides, and nothing the server owns.
 *
 * Derived from the contract type by subtraction rather than restated field by
 * field, so a control added to `routingPolicySchema` appears here automatically
 * and a rename fails `tsc` instead of silently dropping out of the write path.
 */
export type RoutingPolicyControls = Omit<
  RoutingPolicy,
  'schemaVersion' | 'routingPolicyId' | 'policyVersion' | 'scope' | 'updatedAt'
>;

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/** One rejected field, in the shape a 400 body carries. */
export interface RoutingPolicyIssue {
  readonly path: string;
  readonly message: string;
}

export type RoutingPolicyValidation =
  | { readonly status: 'valid'; readonly policy: RoutingPolicy }
  | { readonly status: 'invalid'; readonly issues: readonly RoutingPolicyIssue[] };

/**
 * Assemble a complete policy from a caller's controls and run the CONTRACT's
 * schema over it — including the refinement that rejects a policy no route could
 * ever satisfy.
 *
 * The identity fields are supplied by the server, never by the request: a caller
 * does not choose its own policy id or version number, and letting the body
 * carry either would make the version counter a thing a client could rewind.
 */
export function validateRoutingPolicy(input: {
  readonly routingPolicyId: string;
  readonly policyVersion: number;
  readonly scope: RoutingPolicyScope;
  readonly controls: RoutingPolicyControls;
  readonly updatedAt: Date;
}): RoutingPolicyValidation {
  const parsed = routingPolicySchema.safeParse({
    schemaVersion: 1,
    routingPolicyId: input.routingPolicyId,
    policyVersion: input.policyVersion,
    scope: input.scope,
    updatedAt: input.updatedAt.toISOString(),
    ...input.controls,
  });

  if (!parsed.success) {
    return {
      status: 'invalid',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  return { status: 'valid', policy: parsed.data };
}

/* -------------------------------------------------------------------------- */
/*  Catalogue reference resolution                                            */
/* -------------------------------------------------------------------------- */

/**
 * A model reference resolved to the catalogue row it names.
 *
 * The two arms are the two forms the grammar admits, and they mean different
 * things: an unpinned `<publisher>/<model>` follows the model line as revisions
 * ship, a pinned `<publisher>/<model>@<revision>` names exactly those weights.
 * Resolving to a ROW rather than storing the string is what makes "this policy
 * points at a model that is not in the catalogue" a write-time failure instead
 * of a request that quietly resolves to nothing.
 */
export type ResolvedModelReference =
  | { readonly kind: 'model'; readonly modelId: string }
  | { readonly kind: 'revision'; readonly modelRevisionId: string };

async function resolveModelReference(
  db: Executor,
  reference: string
): Promise<ResolvedModelReference | undefined> {
  const at = reference.indexOf('@');
  const modelId = at === -1 ? reference : reference.slice(0, at);
  const revision = at === -1 ? undefined : reference.slice(at + 1);

  const [model] = await db
    .select({ id: inferenceModels.id })
    .from(inferenceModels)
    .where(eq(inferenceModels.modelId, modelId))
    .limit(1);
  if (!model) return undefined;

  if (revision === undefined) {
    return { kind: 'model', modelId: model.id };
  }

  const [row] = await db
    .select({ id: inferenceModelRevisions.id })
    .from(inferenceModelRevisions)
    .where(
      and(
        eq(inferenceModelRevisions.modelId, model.id),
        eq(inferenceModelRevisions.revision, revision)
      )
    )
    .limit(1);
  return row ? { kind: 'revision', modelRevisionId: row.id } : undefined;
}

/** Resolve a routing-profile slug to its catalogue row. */
async function resolveRoutingProfile(
  db: Executor,
  slug: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: inferenceRoutingProfiles.id })
    .from(inferenceRoutingProfiles)
    .where(eq(inferenceRoutingProfiles.slug, slug))
    .limit(1);
  return row?.id;
}

/* -------------------------------------------------------------------------- */
/*  Writing a version                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Outcome of a policy write.
 *
 * `unknown-catalogue-reference` is its own arm rather than a validation issue
 * because the two are different failures with different fixes: an invalid policy
 * is a policy nothing could serve, while a reference Oxy does not hold is a
 * policy that would be perfectly valid on a platform that carried that model.
 * Collapsing them would tell a customer their configuration is contradictory
 * when it is merely ahead of the catalogue.
 */
export type RoutingPolicyWriteResult =
  | { readonly status: 'written'; readonly policy: RoutingPolicy }
  | { readonly status: 'invalid'; readonly issues: readonly RoutingPolicyIssue[] }
  | { readonly status: 'unknown-catalogue-reference'; readonly reference: string }
  | { readonly status: 'unknown-policy'; readonly routingPolicyId: string }
  | { readonly status: 'archived-policy'; readonly routingPolicyId: string }
  | { readonly status: 'scope-taken'; readonly scope: RoutingPolicyScope };

/** What a policy governs, as the caller states it. */
export type RoutingPolicyTarget =
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'application'; readonly accountId: string; readonly applicationId: string };

/**
 * Build a scope through the CONTRACT's own schema.
 *
 * `accountId` is branded (`oxyAccountIdSchema`), and the brand is load-bearing:
 * a delegated end-user id can never be substituted for an account id, which is
 * ADR 0007's rule made into a type. The only sanctioned way to obtain a branded
 * value is to parse one, so this parses rather than casting — a cast here would
 * be exactly the hole the brand exists to close.
 */
function scopeOf(target: RoutingPolicyTarget): RoutingPolicyScope {
  return routingPolicyScopeSchema.parse(
    target.kind === 'account'
      ? { kind: 'account', accountId: target.accountId }
      : {
          kind: 'application',
          accountId: target.accountId,
          applicationId: target.applicationId,
        }
  );
}

/**
 * The column values one version row carries, given resolved catalogue ids.
 *
 * Built explicitly, field by field, from the VALIDATED policy — never spread
 * from a request body. A spread is how a column nobody meant to expose becomes
 * writable, and the columns here include the fallback flags that the
 * cross-model authorisation key depends on.
 */
function versionValues(
  policy: RoutingPolicy,
  resolved: {
    readonly target?: ResolvedModelReference | { readonly kind: 'profile'; readonly id: string };
    readonly currency: string | null;
  }
) {
  const target = resolved.target;
  return {
    version: policy.policyVersion,
    defaultTargetKind:
      target === undefined ? null : target.kind === 'profile' ? ('routing_profile' as const) : ('model' as const),
    defaultModelId: target !== undefined && target.kind === 'model' ? target.modelId : null,
    defaultModelRevisionId:
      target !== undefined && target.kind === 'revision' ? target.modelRevisionId : null,
    defaultRoutingProfileId: target !== undefined && target.kind === 'profile' ? target.id : null,
    providerAllowlist: [...policy.providerAllowlist],
    providerDenylist: [...policy.providerDenylist],
    allowedRegions: [...policy.allowedRegions],
    deniedRegions: [...policy.deniedRegions],
    requireZeroDataRetention: policy.requireZeroDataRetention,
    prohibitTrainingOnCustomerData: policy.prohibitTrainingOnCustomerData,
    priceCeilingCurrency: resolved.currency,
    maxPricePerRequestAmount: policy.maxPricePerRequest?.amount ?? null,
    optimiseFor: policy.optimiseFor,
    oxyHostedOnly: policy.oxyHostedOnly,
    allowedLicenseIds: [...policy.allowedLicenseIds],
    requireCommercialUseRights: policy.requireCommercialUseRights,
    fallbackDisabled: policy.fallback.disabled,
    sameModelDeploymentFallback: policy.fallback.sameModelDeployment,
    byokPreference: policy.byokPreference,
    dedicatedCapacity: policy.dedicatedCapacity,
  };
}

/**
 * The one currency every ceiling on a version is quoted in, or `null` when the
 * version sets no ceiling at all.
 *
 * The contract's refinement has already established that the ceilings agree, so
 * reading the first is reading all of them — and the column is what makes them
 * unable to disagree once stored.
 */
function ceilingCurrency(policy: RoutingPolicy): string | null {
  if (policy.maxPricePerRequest !== undefined) return policy.maxPricePerRequest.currency;
  return policy.maxPricePerUnit[0]?.currency ?? null;
}

/** Write the caps and cross-model authorisations belonging to one version. */
async function writeVersionChildren(
  tx: Tx,
  versionId: string,
  policy: RoutingPolicy,
  currency: string | null,
  fallbackTargets: readonly ResolvedModelReference[]
): Promise<void> {
  if (policy.maxPricePerUnit.length > 0) {
    // `currency` is non-null whenever a ceiling exists — the contract's
    // refinement guarantees the agreement and `ceilingCurrency` reads it off the
    // same array. The composite foreign key refuses the row otherwise, so a bug
    // here is a constraint failure rather than a mis-priced policy.
    await tx.insert(inferenceRoutingPolicyPriceCaps).values(
      policy.maxPricePerUnit.map((ceiling: UnitPrice) => ({
        versionId,
        unit: ceiling.unit,
        currency: currency ?? ceiling.currency,
        amount: ceiling.amount,
        per: ceiling.per,
      }))
    );
  }

  if (fallbackTargets.length > 0) {
    await tx.insert(inferenceRoutingPolicyFallbacks).values(
      fallbackTargets.map((target, position) => ({
        versionId,
        fallbackDisabled: false,
        modelId: target.kind === 'model' ? target.modelId : null,
        modelRevisionId: target.kind === 'revision' ? target.modelRevisionId : null,
        position,
      }))
    );
  }
}

/**
 * Resolve every catalogue reference a policy names, in one place.
 *
 * Returns the FIRST unresolvable reference rather than a list, because the
 * caller's next action is identical either way and naming one is what a customer
 * can act on.
 */
async function resolveReferences(
  tx: Tx,
  policy: RoutingPolicy
): Promise<
  | {
      readonly status: 'resolved';
      readonly target?: ResolvedModelReference | { readonly kind: 'profile'; readonly id: string };
      readonly fallbacks: readonly ResolvedModelReference[];
    }
  | { readonly status: 'unknown'; readonly reference: string }
> {
  let target:
    | ResolvedModelReference
    | { readonly kind: 'profile'; readonly id: string }
    | undefined;

  const declared: RoutingTarget | undefined = policy.defaultTarget;
  if (declared !== undefined) {
    if (declared.kind === 'model') {
      const resolvedTarget = await resolveModelReference(tx, declared.modelReference);
      if (!resolvedTarget) return { status: 'unknown', reference: declared.modelReference };
      target = resolvedTarget;
    } else {
      const profileId = await resolveRoutingProfile(tx, declared.routingProfile);
      if (profileId === undefined) return { status: 'unknown', reference: declared.routingProfile };
      target = { kind: 'profile', id: profileId };
    }
  }

  const fallbacks: ResolvedModelReference[] = [];
  for (const reference of policy.fallback.authorizedCrossModel) {
    const resolvedFallback = await resolveModelReference(tx, reference);
    if (!resolvedFallback) return { status: 'unknown', reference };
    fallbacks.push(resolvedFallback);
  }

  return { status: 'resolved', target, fallbacks };
}

/**
 * Create a policy for a scope that has none, together with its first version.
 *
 * `scope-taken` rather than a raw unique violation: one ACTIVE policy per scope
 * is a product rule a customer can act on ("edit the one you have"), and a 500
 * carrying SQLSTATE 23505 is not.
 */
export async function createRoutingPolicy(input: {
  readonly target: RoutingPolicyTarget;
  readonly controls: RoutingPolicyControls;
  readonly createdByUserId: string;
}): Promise<RoutingPolicyWriteResult> {
  const routingPolicyId = uuidv7();
  const scope = scopeOf(input.target);
  const validation = validateRoutingPolicy({
    routingPolicyId,
    policyVersion: 1,
    scope,
    controls: input.controls,
    updatedAt: new Date(),
  });
  if (validation.status === 'invalid') return validation;

  const policy = validation.policy;

  return getDb().transaction(async (tx): Promise<RoutingPolicyWriteResult> => {
    const existing = await tx
      .select({ id: inferenceRoutingPolicies.id })
      .from(inferenceRoutingPolicies)
      .where(
        and(
          eq(inferenceRoutingPolicies.status, 'active'),
          input.target.kind === 'application'
            ? eq(inferenceRoutingPolicies.applicationId, input.target.applicationId)
            : and(
                eq(inferenceRoutingPolicies.accountId, input.target.accountId),
                eq(inferenceRoutingPolicies.scopeKind, 'account')
              )
        )
      )
      .limit(1);
    if (existing.length > 0) return { status: 'scope-taken', scope };

    const references = await resolveReferences(tx, policy);
    if (references.status === 'unknown') {
      return { status: 'unknown-catalogue-reference', reference: references.reference };
    }

    await tx.insert(inferenceRoutingPolicies).values({
      id: routingPolicyId,
      scopeKind: input.target.kind,
      accountId: input.target.accountId,
      applicationId: input.target.kind === 'application' ? input.target.applicationId : null,
      status: 'active',
      createdByUserId: input.createdByUserId,
    });

    const currency = ceilingCurrency(policy);
    const [version] = await tx
      .insert(inferenceRoutingPolicyVersions)
      .values({
        routingPolicyId,
        isCurrent: true,
        createdByUserId: input.createdByUserId,
        ...versionValues(policy, { target: references.target, currency }),
      })
      .returning({ id: inferenceRoutingPolicyVersions.id });

    await writeVersionChildren(tx, version.id, policy, currency, references.fallbacks);

    return { status: 'written', policy };
  });
}

/**
 * Append the next version of an existing policy and make it current.
 *
 * The previous version is left exactly as it was — that is the point of the
 * whole table — so a receipt naming it still resolves to the constraints that
 * were applied when the charge was incurred.
 */
export async function appendRoutingPolicyVersion(input: {
  readonly routingPolicyId: string;
  readonly controls: RoutingPolicyControls;
  readonly createdByUserId: string;
}): Promise<RoutingPolicyWriteResult> {
  return getDb().transaction(async (tx): Promise<RoutingPolicyWriteResult> => {
    /**
     * `FOR UPDATE` on the policy row, not just a transaction. Two concurrent
     * edits would otherwise both read the same `max(version)` under READ
     * COMMITTED and both try to write it; the unique constraint would catch the
     * loser, but as a 500 rather than as a second version. Serialising on the
     * parent makes the second edit wait and then see the first.
     */
    const [policyRow] = await tx
      .select({
        id: inferenceRoutingPolicies.id,
        scopeKind: inferenceRoutingPolicies.scopeKind,
        accountId: inferenceRoutingPolicies.accountId,
        applicationId: inferenceRoutingPolicies.applicationId,
        status: inferenceRoutingPolicies.status,
      })
      .from(inferenceRoutingPolicies)
      .where(eq(inferenceRoutingPolicies.id, input.routingPolicyId))
      .limit(1)
      .for('update');

    if (!policyRow) {
      return { status: 'unknown-policy', routingPolicyId: input.routingPolicyId };
    }
    if (policyRow.status === 'archived') {
      return { status: 'archived-policy', routingPolicyId: input.routingPolicyId };
    }

    const [latest] = await tx
      .select({ version: inferenceRoutingPolicyVersions.version })
      .from(inferenceRoutingPolicyVersions)
      .where(eq(inferenceRoutingPolicyVersions.routingPolicyId, policyRow.id))
      .orderBy(desc(inferenceRoutingPolicyVersions.version))
      .limit(1);

    const scope: RoutingPolicyScope =
      policyRow.scopeKind === 'application' && policyRow.applicationId !== null
        ? scopeOf({
            kind: 'application',
            accountId: policyRow.accountId,
            applicationId: policyRow.applicationId,
          })
        : scopeOf({ kind: 'account', accountId: policyRow.accountId });

    const validation = validateRoutingPolicy({
      routingPolicyId: policyRow.id,
      policyVersion: (latest?.version ?? 0) + 1,
      scope,
      controls: input.controls,
      updatedAt: new Date(),
    });
    if (validation.status === 'invalid') return validation;
    const policy = validation.policy;

    const references = await resolveReferences(tx, policy);
    if (references.status === 'unknown') {
      return { status: 'unknown-catalogue-reference', reference: references.reference };
    }

    // Clear the flag before setting the new one: the partial unique index
    // permits exactly one current version per policy, and both statements run in
    // this transaction so no reader ever sees zero.
    await tx
      .update(inferenceRoutingPolicyVersions)
      .set({ isCurrent: false })
      .where(
        and(
          eq(inferenceRoutingPolicyVersions.routingPolicyId, policyRow.id),
          eq(inferenceRoutingPolicyVersions.isCurrent, true)
        )
      );

    const currency = ceilingCurrency(policy);
    const [version] = await tx
      .insert(inferenceRoutingPolicyVersions)
      .values({
        routingPolicyId: policyRow.id,
        isCurrent: true,
        createdByUserId: input.createdByUserId,
        ...versionValues(policy, { target: references.target, currency }),
      })
      .returning({ id: inferenceRoutingPolicyVersions.id });

    await writeVersionChildren(tx, version.id, policy, currency, references.fallbacks);

    return { status: 'written', policy };
  });
}

export type ArchiveRoutingPolicyResult =
  | { readonly status: 'archived'; readonly routingPolicyId: string }
  | { readonly status: 'already-archived'; readonly routingPolicyId: string }
  | { readonly status: 'unknown-policy'; readonly routingPolicyId: string };

/**
 * Retire a policy without deleting anything.
 *
 * There is no hard delete, and that is a decision rather than a missing feature:
 * a settled receipt names a policy version, and a customer must not be able to
 * make a past charge unexplainable by tidying up. Archiving frees the scope — the
 * uniqueness indexes are scoped to `active` — so a replacement policy can be
 * created immediately.
 */
export async function archiveRoutingPolicy(
  routingPolicyId: string
): Promise<ArchiveRoutingPolicyResult> {
  const [row] = await getDb()
    .update(inferenceRoutingPolicies)
    .set({ status: 'archived' })
    .where(
      and(
        eq(inferenceRoutingPolicies.id, routingPolicyId),
        eq(inferenceRoutingPolicies.status, 'active')
      )
    )
    .returning({ id: inferenceRoutingPolicies.id });

  if (row) return { status: 'archived', routingPolicyId };

  const [existing] = await getDb()
    .select({ id: inferenceRoutingPolicies.id })
    .from(inferenceRoutingPolicies)
    .where(eq(inferenceRoutingPolicies.id, routingPolicyId))
    .limit(1);

  return existing
    ? { status: 'already-archived', routingPolicyId }
    : { status: 'unknown-policy', routingPolicyId };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/** A stored policy version, projected back into the wire contract's shape. */
export interface StoredRoutingPolicy {
  readonly routingPolicyId: string;
  readonly versionId: string;
  readonly status: 'active' | 'archived';
  readonly policy: RoutingPolicy;
}

/**
 * A whole version row.
 *
 * Derived from the table rather than restated as a structural type, so a column
 * added to the schema and left out of `VERSION_COLUMNS` fails `tsc` here instead
 * of silently dropping out of every projection. The behavioural half of the same
 * gate is `__tests__/inferenceRoutingPolicy.service.test.ts`, which writes a
 * policy with EVERY control set to a non-default value and asserts the read
 * returns it unchanged — a control that does not survive that round trip is a
 * column that is not being projected.
 */
type VersionRow = typeof inferenceRoutingPolicyVersions.$inferSelect;

async function readVersion(
  db: Executor,
  row: VersionRow,
  scope: RoutingPolicyScope
): Promise<RoutingPolicy> {
  const target = await readTarget(db, row);

  const caps = await db
    .select({
      unit: inferenceRoutingPolicyPriceCaps.unit,
      amount: inferenceRoutingPolicyPriceCaps.amount,
      per: inferenceRoutingPolicyPriceCaps.per,
      currency: inferenceRoutingPolicyPriceCaps.currency,
    })
    .from(inferenceRoutingPolicyPriceCaps)
    .where(eq(inferenceRoutingPolicyPriceCaps.versionId, row.id))
    .orderBy(inferenceRoutingPolicyPriceCaps.unit);

  const authorized = await readAuthorizedCrossModel(db, row.id);

  const candidate = {
    schemaVersion: 1,
    routingPolicyId: row.routingPolicyId,
    policyVersion: row.version,
    scope,
    defaultTarget: target,
    providerAllowlist: row.providerAllowlist,
    providerDenylist: row.providerDenylist,
    allowedRegions: row.allowedRegions,
    deniedRegions: row.deniedRegions,
    requireZeroDataRetention: row.requireZeroDataRetention,
    prohibitTrainingOnCustomerData: row.prohibitTrainingOnCustomerData,
    maxPricePerUnit: caps,
    maxPricePerRequest:
      row.maxPricePerRequestAmount === null || row.priceCeilingCurrency === null
        ? undefined
        : { amount: row.maxPricePerRequestAmount, currency: row.priceCeilingCurrency },
    optimiseFor: row.optimiseFor,
    oxyHostedOnly: row.oxyHostedOnly,
    allowedLicenseIds: row.allowedLicenseIds,
    requireCommercialUseRights: row.requireCommercialUseRights,
    fallback: {
      disabled: row.fallbackDisabled,
      sameModelDeployment: row.sameModelDeploymentFallback,
      authorizedCrossModel: authorized,
    },
    byokPreference: row.byokPreference,
    dedicatedCapacity: row.dedicatedCapacity,
    updatedAt: row.createdAt.toISOString(),
  };

  /**
   * Parsed on the way OUT as well as on the way in. The server validates its own
   * output against the contract, so a projection that drifts from the schema —
   * a column renamed, a currency lost, a fallback list rebuilt wrongly — fails
   * here rather than reaching a customer as a shape their SDK cannot parse.
   */
  return routingPolicySchema.parse(candidate);
}

async function readTarget(db: Executor, row: VersionRow): Promise<RoutingTarget | undefined> {
  if (row.defaultTargetKind === null) return undefined;

  if (row.defaultTargetKind === 'routing_profile' && row.defaultRoutingProfileId !== null) {
    const [profile] = await db
      .select({ slug: inferenceRoutingProfiles.slug })
      .from(inferenceRoutingProfiles)
      .where(eq(inferenceRoutingProfiles.id, row.defaultRoutingProfileId))
      .limit(1);
    return profile ? { kind: 'routing_profile', routingProfile: profile.slug } : undefined;
  }

  if (row.defaultModelId !== null) {
    const [model] = await db
      .select({ modelId: inferenceModels.modelId })
      .from(inferenceModels)
      .where(eq(inferenceModels.id, row.defaultModelId))
      .limit(1);
    // `inference_models.model_id` is a GENERATED column, so drizzle types it
    // nullable even though its expression concatenates two NOT NULL columns.
    // Narrowed rather than asserted — the assertion would be correct today and
    // would stop being checked the moment the expression changed.
    return model?.modelId ? { kind: 'model', modelReference: model.modelId } : undefined;
  }

  if (row.defaultModelRevisionId !== null) {
    const reference = await revisionReference(db, row.defaultModelRevisionId);
    return reference === undefined ? undefined : { kind: 'model', modelReference: reference };
  }

  return undefined;
}

/** `<publisher>/<model>@<revision>` for one revision row. */
async function revisionReference(db: Executor, revisionId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ modelId: inferenceModels.modelId, revision: inferenceModelRevisions.revision })
    .from(inferenceModelRevisions)
    .innerJoin(inferenceModels, eq(inferenceModels.id, inferenceModelRevisions.modelId))
    .where(eq(inferenceModelRevisions.id, revisionId))
    .limit(1);
  // Narrowed, not asserted — see `readTarget` for why the generated column is
  // typed nullable. A template string over a null would silently produce the
  // reference `null@2026-05-01`, which is the failure this guard exists for.
  return row?.modelId ? `${row.modelId}@${row.revision}` : undefined;
}

/**
 * The authorised substitutions of one version, in the customer's own order.
 *
 * One query rather than one per row: each authorisation names a model OR a
 * revision, so both are LEFT JOINed and exactly one side is non-null per row.
 * `revisionModels` is an alias of `inference_models` because the same table is
 * reached twice — once directly, once through the revision.
 */
async function readAuthorizedCrossModel(db: Executor, versionId: string): Promise<string[]> {
  const revisionModels = alias(inferenceModels, 'revision_models');

  const rows = await db
    .select({
      modelReference: inferenceModels.modelId,
      revisionModelReference: revisionModels.modelId,
      revision: inferenceModelRevisions.revision,
    })
    .from(inferenceRoutingPolicyFallbacks)
    .leftJoin(inferenceModels, eq(inferenceModels.id, inferenceRoutingPolicyFallbacks.modelId))
    .leftJoin(
      inferenceModelRevisions,
      eq(inferenceModelRevisions.id, inferenceRoutingPolicyFallbacks.modelRevisionId)
    )
    .leftJoin(revisionModels, eq(revisionModels.id, inferenceModelRevisions.modelId))
    .where(eq(inferenceRoutingPolicyFallbacks.versionId, versionId))
    .orderBy(inferenceRoutingPolicyFallbacks.position);

  const references: string[] = [];
  for (const row of rows) {
    if (row.modelReference !== null) {
      references.push(row.modelReference);
      continue;
    }
    if (row.revisionModelReference !== null && row.revision !== null) {
      references.push(`${row.revisionModelReference}@${row.revision}`);
    }
  }
  return references;
}

/**
 * Every column of a version row, so a select over these produces a
 * {@link VersionRow}. Named explicitly rather than selecting the whole table
 * because every read here JOINS, and a bare `select()` over a join returns
 * nested objects the projection would then have to unwrap.
 */
const VERSION_COLUMNS = {
  id: inferenceRoutingPolicyVersions.id,
  routingPolicyId: inferenceRoutingPolicyVersions.routingPolicyId,
  version: inferenceRoutingPolicyVersions.version,
  isCurrent: inferenceRoutingPolicyVersions.isCurrent,
  createdByUserId: inferenceRoutingPolicyVersions.createdByUserId,
  defaultTargetKind: inferenceRoutingPolicyVersions.defaultTargetKind,
  defaultModelId: inferenceRoutingPolicyVersions.defaultModelId,
  defaultModelRevisionId: inferenceRoutingPolicyVersions.defaultModelRevisionId,
  defaultRoutingProfileId: inferenceRoutingPolicyVersions.defaultRoutingProfileId,
  providerAllowlist: inferenceRoutingPolicyVersions.providerAllowlist,
  providerDenylist: inferenceRoutingPolicyVersions.providerDenylist,
  allowedRegions: inferenceRoutingPolicyVersions.allowedRegions,
  deniedRegions: inferenceRoutingPolicyVersions.deniedRegions,
  requireZeroDataRetention: inferenceRoutingPolicyVersions.requireZeroDataRetention,
  prohibitTrainingOnCustomerData: inferenceRoutingPolicyVersions.prohibitTrainingOnCustomerData,
  priceCeilingCurrency: inferenceRoutingPolicyVersions.priceCeilingCurrency,
  maxPricePerRequestAmount: inferenceRoutingPolicyVersions.maxPricePerRequestAmount,
  optimiseFor: inferenceRoutingPolicyVersions.optimiseFor,
  oxyHostedOnly: inferenceRoutingPolicyVersions.oxyHostedOnly,
  allowedLicenseIds: inferenceRoutingPolicyVersions.allowedLicenseIds,
  requireCommercialUseRights: inferenceRoutingPolicyVersions.requireCommercialUseRights,
  fallbackDisabled: inferenceRoutingPolicyVersions.fallbackDisabled,
  sameModelDeploymentFallback: inferenceRoutingPolicyVersions.sameModelDeploymentFallback,
  byokPreference: inferenceRoutingPolicyVersions.byokPreference,
  dedicatedCapacity: inferenceRoutingPolicyVersions.dedicatedCapacity,
  createdAt: inferenceRoutingPolicyVersions.createdAt,
} as const;

const POLICY_COLUMNS = {
  policyId: inferenceRoutingPolicies.id,
  scopeKind: inferenceRoutingPolicies.scopeKind,
  accountId: inferenceRoutingPolicies.accountId,
  applicationId: inferenceRoutingPolicies.applicationId,
  policyStatus: inferenceRoutingPolicies.status,
} as const;

function scopeFromRow(row: {
  scopeKind: string;
  accountId: string;
  applicationId: string | null;
}): RoutingPolicyScope {
  return row.scopeKind === 'application' && row.applicationId !== null
    ? scopeOf({
        kind: 'application',
        accountId: row.accountId,
        applicationId: row.applicationId,
      })
    : scopeOf({ kind: 'account', accountId: row.accountId });
}

/** One policy at a specific version, or its current one when none is named. */
export async function getRoutingPolicy(
  routingPolicyId: string,
  policyVersion?: number
): Promise<StoredRoutingPolicy | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ ...POLICY_COLUMNS, ...VERSION_COLUMNS })
    .from(inferenceRoutingPolicyVersions)
    .innerJoin(
      inferenceRoutingPolicies,
      eq(inferenceRoutingPolicies.id, inferenceRoutingPolicyVersions.routingPolicyId)
    )
    .where(
      and(
        eq(inferenceRoutingPolicyVersions.routingPolicyId, routingPolicyId),
        policyVersion === undefined
          ? eq(inferenceRoutingPolicyVersions.isCurrent, true)
          : eq(inferenceRoutingPolicyVersions.version, policyVersion)
      )
    )
    .limit(1);

  if (!row) return undefined;

  return {
    routingPolicyId: row.policyId,
    versionId: row.id,
    status: row.policyStatus,
    policy: await readVersion(db, row, scopeFromRow(row)),
  };
}

/** Every version of one policy, newest first — the customer's own audit trail. */
export async function listRoutingPolicyVersions(
  routingPolicyId: string
): Promise<StoredRoutingPolicy[]> {
  const db = getDb();
  const rows = await db
    .select({ ...POLICY_COLUMNS, ...VERSION_COLUMNS })
    .from(inferenceRoutingPolicyVersions)
    .innerJoin(
      inferenceRoutingPolicies,
      eq(inferenceRoutingPolicies.id, inferenceRoutingPolicyVersions.routingPolicyId)
    )
    .where(eq(inferenceRoutingPolicyVersions.routingPolicyId, routingPolicyId))
    .orderBy(desc(inferenceRoutingPolicyVersions.version));

  const stored: StoredRoutingPolicy[] = [];
  for (const row of rows) {
    stored.push({
      routingPolicyId: row.policyId,
      versionId: row.id,
      status: row.policyStatus,
      policy: await readVersion(db, row, scopeFromRow(row)),
    });
  }
  return stored;
}

/** Every ACTIVE policy an account owns, at its current version. */
export async function listRoutingPoliciesForAccount(
  accountId: string
): Promise<StoredRoutingPolicy[]> {
  const db = getDb();
  const rows = await db
    .select({ ...POLICY_COLUMNS, ...VERSION_COLUMNS })
    .from(inferenceRoutingPolicies)
    .innerJoin(
      inferenceRoutingPolicyVersions,
      and(
        eq(inferenceRoutingPolicyVersions.routingPolicyId, inferenceRoutingPolicies.id),
        eq(inferenceRoutingPolicyVersions.isCurrent, true)
      )
    )
    .where(
      and(
        eq(inferenceRoutingPolicies.accountId, accountId),
        eq(inferenceRoutingPolicies.status, 'active')
      )
    )
    .orderBy(desc(inferenceRoutingPolicies.createdAt));

  const stored: StoredRoutingPolicy[] = [];
  for (const row of rows) {
    stored.push({
      routingPolicyId: row.policyId,
      versionId: row.id,
      status: row.policyStatus,
      policy: await readVersion(db, row, scopeFromRow(row)),
    });
  }
  return stored;
}

/**
 * Which policy governs an application's requests, and where it came from.
 *
 * The application's own policy wins; failing that the owner account's policy is
 * the floor its applications inherit. `none` is a real answer — an application
 * with no policy configured is served under the platform default, which is the
 * data plane's business and not a policy row.
 */
export type EffectiveRoutingPolicyResolution =
  | {
      readonly status: 'resolved';
      readonly source: 'application' | 'account';
      readonly stored: StoredRoutingPolicy;
    }
  | { readonly status: 'none'; readonly applicationId: string }
  | { readonly status: 'unknown-application'; readonly applicationId: string };

export async function resolveEffectiveRoutingPolicy(
  applicationId: string
): Promise<EffectiveRoutingPolicyResolution> {
  const db = getDb();

  const [application] = await db
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!application) return { status: 'unknown-application', applicationId };

  const [own] = await db
    .select({ ...POLICY_COLUMNS, ...VERSION_COLUMNS })
    .from(inferenceRoutingPolicies)
    .innerJoin(
      inferenceRoutingPolicyVersions,
      and(
        eq(inferenceRoutingPolicyVersions.routingPolicyId, inferenceRoutingPolicies.id),
        eq(inferenceRoutingPolicyVersions.isCurrent, true)
      )
    )
    .where(
      and(
        eq(inferenceRoutingPolicies.applicationId, applicationId),
        eq(inferenceRoutingPolicies.status, 'active')
      )
    )
    .limit(1);

  if (own) {
    return {
      status: 'resolved',
      source: 'application',
      stored: {
        routingPolicyId: own.policyId,
        versionId: own.id,
        status: own.policyStatus,
        policy: await readVersion(db, own, scopeFromRow(own)),
      },
    };
  }

  const [inherited] = await db
    .select({ ...POLICY_COLUMNS, ...VERSION_COLUMNS })
    .from(inferenceRoutingPolicies)
    .innerJoin(
      inferenceRoutingPolicyVersions,
      and(
        eq(inferenceRoutingPolicyVersions.routingPolicyId, inferenceRoutingPolicies.id),
        eq(inferenceRoutingPolicyVersions.isCurrent, true)
      )
    )
    .where(
      and(
        eq(inferenceRoutingPolicies.accountId, application.ownerAccountId),
        eq(inferenceRoutingPolicies.scopeKind, 'account'),
        isNull(inferenceRoutingPolicies.applicationId),
        eq(inferenceRoutingPolicies.status, 'active')
      )
    )
    .limit(1);

  if (inherited) {
    return {
      status: 'resolved',
      source: 'account',
      stored: {
        routingPolicyId: inherited.policyId,
        versionId: inherited.id,
        status: inherited.policyStatus,
        policy: await readVersion(db, inherited, scopeFromRow(inherited)),
      },
    };
  }

  return { status: 'none', applicationId };
}

/* -------------------------------------------------------------------------- */
/*  Route switches                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the data plane reports about a switch, in the same two shapes the stream
 * event carries.
 *
 * `model` has no `authorizedByPolicy` field, deliberately. On the wire it is a
 * `z.literal(true)`, which is a producer ASSERTING it was authorised; here the
 * authorisation is LOOKED UP against the policy version, so the caller cannot
 * assert it at all. A claim a caller makes about its own permission is not a
 * permission check.
 */
export type RouteSwitchDetail =
  | {
      readonly scope: 'deployment';
      readonly modelReference: string;
      readonly toProvider: string;
      readonly toDeploymentId?: string;
    }
  | {
      readonly scope: 'model';
      /** Unpinned by contract; a pinned request is refused, not substituted. */
      readonly requestedModelId: string;
      readonly fromModelReference: string;
      readonly toModelReference: string;
      readonly toProvider: string;
      readonly toDeploymentId?: string;
    };

export interface RecordRouteSwitchInput {
  readonly requestId: string;
  readonly sequence: number;
  readonly accountId: string;
  readonly applicationId: string;
  readonly environment: 'development' | 'staging' | 'production';
  readonly routingPolicyVersionId: string;
  readonly reason: RouteSwitchReason;
  readonly detail: RouteSwitchDetail;
  readonly occurredAt: Date;
}

export type RecordRouteSwitchResult =
  | { readonly status: 'recorded'; readonly eventId: string; readonly scope: RouteSwitchScope }
  | { readonly status: 'already-recorded'; readonly requestId: string; readonly sequence: number }
  | { readonly status: 'unknown-policy-version'; readonly routingPolicyVersionId: string }
  | {
      readonly status: 'pinned-revision-not-substitutable';
      readonly requestedModel: string;
    }
  | {
      readonly status: 'fallback-disabled';
      readonly routingPolicyVersionId: string;
    }
  | {
      readonly status: 'unauthorized-substitution';
      readonly requestedModelId: string;
      readonly toModelReference: string;
    };

/**
 * Record a route switch, and refuse to record a substitution the customer never
 * authorised.
 *
 * Three refusals, in the order a reader should think about them:
 *
 *  - **A pinned request is never substituted.** A `requestedModelId` containing
 *    `@` is refused here, and the column's own CHECK refuses it again if this
 *    function is ever bypassed. Two layers because they fail differently: this
 *    one names the model in an answer a caller can act on, the CHECK is the one
 *    that still holds for a writer that never came through here.
 *  - **Fallback disabled means fail, not re-route.** A version with no
 *    authorisations cannot produce one, so this is the answer a policy that
 *    turned fallback off gets.
 *  - **A destination must be named in the policy.** The authorisation is looked
 *    up by the model the switch went TO; not finding one is
 *    `unauthorized-substitution`, and the event is not written.
 *
 * A deployment switch needs none of this: it serves the same weights from
 * elsewhere, which is an availability decision the customer already made with
 * `sameModelDeployment`.
 */
export async function recordRouteSwitch(
  input: RecordRouteSwitchInput
): Promise<RecordRouteSwitchResult> {
  const db = getDb();

  const [version] = await db
    .select({
      id: inferenceRoutingPolicyVersions.id,
      fallbackDisabled: inferenceRoutingPolicyVersions.fallbackDisabled,
      sameModelDeploymentFallback:
        inferenceRoutingPolicyVersions.sameModelDeploymentFallback,
    })
    .from(inferenceRoutingPolicyVersions)
    .where(eq(inferenceRoutingPolicyVersions.id, input.routingPolicyVersionId))
    .limit(1);

  if (!version) {
    return {
      status: 'unknown-policy-version',
      routingPolicyVersionId: input.routingPolicyVersionId,
    };
  }
  if (version.fallbackDisabled) {
    return { status: 'fallback-disabled', routingPolicyVersionId: version.id };
  }

  let authorizationId: string | null = null;
  let fromModelReference: string;
  let toModelReference: string;
  let requestedModelId: string | null = null;

  if (input.detail.scope === 'deployment') {
    fromModelReference = input.detail.modelReference;
    toModelReference = input.detail.modelReference;
  } else {
    if (input.detail.requestedModelId.includes('@')) {
      return {
        status: 'pinned-revision-not-substitutable',
        requestedModel: input.detail.requestedModelId,
      };
    }

    const authorization = await findAuthorization(
      db,
      version.id,
      input.detail.toModelReference
    );
    if (authorization === undefined) {
      return {
        status: 'unauthorized-substitution',
        requestedModelId: input.detail.requestedModelId,
        toModelReference: input.detail.toModelReference,
      };
    }

    authorizationId = authorization;
    requestedModelId = input.detail.requestedModelId;
    fromModelReference = input.detail.fromModelReference;
    toModelReference = input.detail.toModelReference;
  }

  const [row] = await db
    .insert(inferenceRouteSwitchEvents)
    .values({
      requestId: input.requestId,
      sequence: input.sequence,
      accountId: input.accountId,
      applicationId: input.applicationId,
      environment: input.environment,
      routingPolicyVersionId: version.id,
      scope: input.detail.scope,
      reason: input.reason,
      fromModelReference,
      toModelReference,
      toProvider: input.detail.toProvider,
      toDeploymentId: input.detail.toDeploymentId ?? null,
      requestedModelId,
      authorizationId,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: inferenceRouteSwitchEvents.id });

  if (!row) {
    return {
      status: 'already-recorded',
      requestId: input.requestId,
      sequence: input.sequence,
    };
  }

  return { status: 'recorded', eventId: row.id, scope: input.detail.scope };
}

/**
 * The authorisation row permitting a substitution TO `reference`, if any.
 *
 * A policy that authorised the unpinned `openai/gpt-5` permits any revision of
 * it, so an authorisation on the MODEL matches a destination that named a
 * revision of that model. The reverse does not hold: a policy that pinned
 * `openai/gpt-5@2026-05-01` authorised exactly those weights and does not
 * license a different revision.
 */
async function findAuthorization(
  db: Executor,
  versionId: string,
  reference: string
): Promise<string | undefined> {
  const resolved = await resolveModelReference(db, reference);
  if (resolved === undefined) return undefined;

  if (resolved.kind === 'revision') {
    const [exact] = await db
      .select({ id: inferenceRoutingPolicyFallbacks.id })
      .from(inferenceRoutingPolicyFallbacks)
      .where(
        and(
          eq(inferenceRoutingPolicyFallbacks.versionId, versionId),
          eq(inferenceRoutingPolicyFallbacks.modelRevisionId, resolved.modelRevisionId)
        )
      )
      .limit(1);
    if (exact) return exact.id;

    const [byModel] = await db
      .select({ id: inferenceRoutingPolicyFallbacks.id })
      .from(inferenceRoutingPolicyFallbacks)
      .innerJoin(
        inferenceModelRevisions,
        eq(inferenceModelRevisions.modelId, inferenceRoutingPolicyFallbacks.modelId)
      )
      .where(
        and(
          eq(inferenceRoutingPolicyFallbacks.versionId, versionId),
          eq(inferenceModelRevisions.id, resolved.modelRevisionId)
        )
      )
      .limit(1);
    return byModel?.id;
  }

  const [byModel] = await db
    .select({ id: inferenceRoutingPolicyFallbacks.id })
    .from(inferenceRoutingPolicyFallbacks)
    .where(
      and(
        eq(inferenceRoutingPolicyFallbacks.versionId, versionId),
        eq(inferenceRoutingPolicyFallbacks.modelId, resolved.modelId)
      )
    )
    .limit(1);
  return byModel?.id;
}

/** One recorded switch, as a customer is shown it. */
export interface RouteSwitchEventView {
  readonly eventId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly applicationId: string;
  readonly routingPolicyVersionId: string;
  readonly scope: RouteSwitchScope;
  readonly reason: RouteSwitchReason;
  readonly requestedModelId: string | null;
  readonly fromModelReference: string;
  readonly toModelReference: string;
  readonly toProvider: string;
  readonly occurredAt: Date;
}

/**
 * The switches recorded for one application, newest first.
 *
 * `to_deployment_id` is deliberately NOT projected: which concrete endpoint
 * served a request is the data plane's operational topology, and the catalogue's
 * serving boundary already says a customer sees the model and the provider, not
 * the route.
 */
export async function listRouteSwitchEventsForApplication(
  applicationId: string,
  limit = 100
): Promise<RouteSwitchEventView[]> {
  const rows = await getDb()
    .select({
      eventId: inferenceRouteSwitchEvents.id,
      requestId: inferenceRouteSwitchEvents.requestId,
      sequence: inferenceRouteSwitchEvents.sequence,
      applicationId: inferenceRouteSwitchEvents.applicationId,
      routingPolicyVersionId: inferenceRouteSwitchEvents.routingPolicyVersionId,
      scope: inferenceRouteSwitchEvents.scope,
      reason: inferenceRouteSwitchEvents.reason,
      requestedModelId: inferenceRouteSwitchEvents.requestedModelId,
      fromModelReference: inferenceRouteSwitchEvents.fromModelReference,
      toModelReference: inferenceRouteSwitchEvents.toModelReference,
      toProvider: inferenceRouteSwitchEvents.toProvider,
      occurredAt: inferenceRouteSwitchEvents.occurredAt,
    })
    .from(inferenceRouteSwitchEvents)
    .where(eq(inferenceRouteSwitchEvents.applicationId, applicationId))
    .orderBy(desc(inferenceRouteSwitchEvents.occurredAt), desc(inferenceRouteSwitchEvents.sequence))
    .limit(limit);

  return rows;
}
