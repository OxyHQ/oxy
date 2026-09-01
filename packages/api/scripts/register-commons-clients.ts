#!/usr/bin/env bun
/**
 * Idempotent admin script: register the two production `Application` client ids
 * required by the "Sign in with Oxy" feature —
 *
 *   1. Commons by Oxy  — the native self-sovereign identity wallet whose
 *      `OxyProvider clientId` (`EXPO_PUBLIC_OXY_CLIENT_ID` in
 *      `packages/commons/constants/oxy.ts`) must be a real registered public
 *      `ApplicationCredential`.
 *   2. Oxy Auth        — the third-party OAuth IdP app, which ALSO acts as its
 *      own Relying Party for the Sign-in-with-Oxy QR handoff and therefore
 *      needs a public client id + its own redirect origins.
 *
 * Both Applications live in the production "Oxy" team workspace, owned by the
 * platform user `oxy`. For each app this UPSERTS (never duplicates on re-run):
 *   - Application       keyed by (name + createdByUserId = oxyId)
 *   - a single owner AccountMember for oxy on the Oxy org account (app access
 *     derives from it — no per-app member row)
 *   - ApplicationCredential  type:'public', environment:'production',
 *                            publicKey minted EXACTLY like the real create route
 *                            (`oxy_dk_` + 24 random bytes hex). A `public`
 *                            credential carries NO secret. Existing active public
 *                            production credentials are REUSED — never re-minted.
 *
 * It also grants Commons the staff-only `identity:approval` capability, which is
 * what makes its installs eligible targets for
 * `POST /auth/session/deliver/:authorizeCode` (automatic push delivery of a
 * pending sign-in request). Capabilities are UNIONed into an existing record,
 * never stripped.
 *
 * The "Oxy Auth" app is the SAME record seeded by
 * `scripts/seed-oxy-applications.ts` (idempotency key is name + owner). This
 * script reuses that record and its credential; the only delta is that it UNIONS
 * the auth-RP redirect origins into `redirectUris` (the seed currently sets them
 * to `[]` because historically the IdP did not consume its own callback — see
 * the report note about keeping the seed in sync).
 *
 * Safety:
 *   - No deletes, no drops. Existing redirectUris/scopes are UNIONed, never
 *     stripped. No modification of unrelated documents.
 *   - Re-running performs 0 inserts/updates once registered.
 *   - DRY_RUN=1 (or DRY_RUN=true) reports the plan without writing.
 *   - Verifies the known production workspace + owner ids exist before writing;
 *     aborts with a clear error if either is missing or mismatched (guards
 *     against pointing at the wrong database/environment).
 *
 * DRY RUN == REAL RUN (by construction). The reconciliation decision lives in
 * `src/scripts/registerCommonsClientsPlan.ts` and is computed UNCONDITIONALLY,
 * on both paths; `DRY_RUN` gates only whether the plan is written. The plan is
 * reported field by field (`changes: [{ field, from, to }]`), so an operator
 * sees WHICH field would change, not just a count. This is not a nicety: a dry
 * run that reported `appsUpdated: 0` immediately before a real run that granted
 * `identity:approval` and reported `appsUpdated: 2` is exactly the failure this
 * structure makes impossible.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/register-commons-clients.ts
 * Or via the npm script (from packages/api):
 *   bun run register:commons-clients
 *
 * Env:
 *   MONGODB_URI   required (injected by ECS from SSM)
 *   DRY_RUN=1     plan only, no writes
 *
 * Output (non-secret client ids — safe to log and parse from ECS task logs):
 *   COMMONS_CLIENT_ID=<oxy_dk_...>
 *   AUTH_IDP_CLIENT_ID=<oxy_dk_...>
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import { Application, type IApplication } from '../src/models/Application';
import { ApplicationCredential } from '../src/models/ApplicationCredential';
import AccountMember from '../src/models/AccountMember';
import { User } from '../src/models/User';
import { permissionsForAccountRole } from '../src/utils/accountRoles';
import { logger } from '../src/utils/logger';
import type { ApplicationScope } from '../src/utils/applicationScopes';
import {
  IDENTITY_APPROVAL_CAPABILITY,
  type ApplicationCapability,
} from '../src/utils/applicationCapabilities';
import {
  applyApplicationPlan,
  computeApplicationPlan,
  readApplicationState,
  type PlannedFieldChange,
} from '../src/scripts/registerCommonsClientsPlan';

// ── Mirror routes/applications.ts credential generation EXACTLY ──────────────
const CREDENTIAL_PUBLIC_KEY_PREFIX = 'oxy_dk_';
const PUBLIC_KEY_RANDOM_BYTES = 24;

function generatePublicKey(): string {
  return CREDENTIAL_PUBLIC_KEY_PREFIX + crypto.randomBytes(PUBLIC_KEY_RANDOM_BYTES).toString('hex');
}

// ── Known production identifiers (the Oxy team workspace + platform owner) ───
// These are verified to exist before any write so the script fails loudly if it
// is ever pointed at the wrong database/environment.
const OXY_OWNER_USER_ID = '69b2d3df5d12f58c9800d651';
const OXY_OWNER_USERNAME = 'oxy';

type ClientKey = 'COMMONS_CLIENT_ID' | 'AUTH_IDP_CLIENT_ID';

interface ClientSpec {
  /** Output env key printed at the end. */
  key: ClientKey;
  /** Idempotency key (with createdByUserId = oxyId). DO NOT rename casually. */
  name: string;
  description: string;
  websiteUrl?: string;
  type: IApplication['type'];
  redirectUris: string[];
  scopes: ApplicationScope[];
  /**
   * Staff-only platform capability flags. UNIONed into an existing record, never
   * stripped. This is what makes a platform behaviour registry-driven instead of
   * keyed off a hardcoded client id.
   */
  capabilities: ApplicationCapability[];
}

const CLIENTS: ClientSpec[] = [
  {
    key: 'COMMONS_CLIENT_ID',
    name: 'Commons by Oxy',
    description:
      'Official Oxy Commons app — self-sovereign identity wallet and Sign-in-with-Oxy approvals (native).',
    type: 'first_party',
    // Commons is a native-only app (no web). Its public client id (this
    // credential's publicKey) is what wires into OxyProvider; the redirect
    // surface is the app's two deep-link schemes from packages/commons/app.json.
    redirectUris: ['commons://', 'oxycommons://'],
    scopes: ['user:read'],
    // Commons IS the identity vault: it holds the local key and signs approvals,
    // so its installs are the ones an authorization request may be pushed to.
    // `POST /auth/session/deliver/:authorizeCode` resolves its targets from this
    // capability — never from a hardcoded client id or bundle id.
    capabilities: [IDENTITY_APPROVAL_CAPABILITY],
  },
  {
    key: 'AUTH_IDP_CLIENT_ID',
    name: 'Oxy Auth',
    description:
      'Official Oxy authentication app and third-party OAuth Identity Provider, acting as its own Relying Party for Sign in with Oxy.',
    websiteUrl: 'https://auth.oxy.so',
    type: 'first_party',
    // The IdP now consumes Sign-in-with-Oxy as an RP, so it registers its own
    // origin as the redirect surface. UNIONed into any existing redirectUris.
    redirectUris: ['https://auth.oxy.so'],
    scopes: ['user:read'],
    // The IdP is a browser shell, not an identity vault — it never holds a key
    // and must never be a push-approval target.
    capabilities: [],
  },
];

/**
 * What this run does (or, under DRY_RUN, WOULD do) to one client. Identical on
 * both paths — the only difference is whether the writes were executed.
 */
type RecordAction = 'create' | 'update' | 'unchanged';

interface MappingRow {
  key: ClientKey;
  app: string;
  type: IApplication['type'];
  applicationId: string;
  clientId: string;
  /** Effective AFTER this run (the union), not the pre-run value. */
  redirectUris: string[];
  applicationAction: RecordAction;
  /** Field-level diff — which fields change, from what, to what. */
  changes: PlannedFieldChange[];
  credentialAction: 'create' | 'reuse';
}

interface ResolvedTargets {
  oxyId: mongoose.Types.ObjectId;
  /**
   * `null` ONLY under DRY_RUN when the Oxy organization account does not exist
   * yet — a dry run cannot know the id a real run would mint, and inventing a
   * placeholder id (as this script used to) makes the plan report a change to a
   * value that will never exist. A real run always resolves a concrete id.
   */
  ownerAccountId: mongoose.Types.ObjectId | null;
  ownerAccountAction: RecordAction;
  ownerMembershipAction: RecordAction;
}

/**
 * Resolve and validate the production Oxy owner, and resolve (minting if
 * absent) the Oxy `kind:'organization'` account that owns the official apps.
 * Aborts (throws) if the owner is missing/inconsistent, so the script never
 * writes into the wrong database.
 *
 * Under DRY_RUN the same reads run and the same actions are reported; only the
 * two writes (the organization account and its owner membership) are skipped.
 */
async function resolveTargets(dryRun: boolean): Promise<ResolvedTargets> {
  const owner = await User.findById(OXY_OWNER_USER_ID).select('_id username').lean();
  if (!owner?._id) {
    throw new Error(
      `Owner user _id ${OXY_OWNER_USER_ID} (username "${OXY_OWNER_USERNAME}") not found — ` +
        'refusing to register clients. Wrong database/environment?'
    );
  }
  if (owner.username !== OXY_OWNER_USERNAME) {
    throw new Error(
      `Owner user _id ${OXY_OWNER_USER_ID} resolved to username "${owner.username}", ` +
        `expected "${OXY_OWNER_USERNAME}" — refusing to register clients.`
    );
  }
  const oxyId = owner._id as mongoose.Types.ObjectId;
  const oxyAccountName = process.env.OXY_ACCOUNT_NAME || 'Oxy';

  // Resolve (or mint) the Oxy organization account that owns the official apps,
  // parented under the `oxy` user. Idempotent: keyed by (parentAccountId, kind,
  // name.first). This is the same account the data migration (Phase 2) mints.
  let oxyOrg = await User.findOne({
    parentAccountId: oxyId,
    kind: 'organization',
    'name.first': oxyAccountName,
  });
  const ownerAccountAction: RecordAction = oxyOrg ? 'unchanged' : 'create';

  if (!oxyOrg && !dryRun) {
    const baseUsername = `${OXY_OWNER_USERNAME}-org`;
    let username = baseUsername;
    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const taken = await User.findOne({ username }).select('_id').lean();
      if (!taken) break;
      username = `${baseUsername}${suffix}`;
    }
    oxyOrg = await User.create({
      username,
      name: { first: oxyAccountName },
      kind: 'organization',
      type: 'local',
      verified: true,
      authMethods: [],
      parentAccountId: oxyId,
      ancestors: [oxyId],
      rootAccountId: oxyId,
      accountStatus: 'active',
    });
  }
  const ownerAccountId = oxyOrg?._id ?? null;

  // Owner AccountMember for oxy on the org (idempotent). When the org itself
  // does not exist yet (dry run), the membership cannot exist either.
  let ownerMembershipAction: RecordAction = 'create';
  if (oxyOrg) {
    const existingOwner = await AccountMember.findOne({
      accountId: oxyOrg._id,
      memberUserId: oxyId,
    });
    ownerMembershipAction = existingOwner ? 'unchanged' : 'create';
    if (!existingOwner && !dryRun) {
      await AccountMember.create({
        accountId: oxyOrg._id,
        memberUserId: oxyId,
        role: 'owner',
        permissions: permissionsForAccountRole('owner'),
        inherit: true,
        status: 'active',
        joinedAt: new Date(),
      });
    }
  }

  logger.info('Resolved production targets', {
    dryRun,
    oxyId: oxyId.toString(),
    ownerUsername: OXY_OWNER_USERNAME,
    ownerAccountId: ownerAccountId?.toString() ?? '(would be minted by this run)',
    ownerAccountAction,
    ownerMembershipAction,
  });

  return { oxyId, ownerAccountId, ownerAccountAction, ownerMembershipAction };
}

async function register(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  if (dryRun) {
    logger.info('DRY RUN — no writes will be performed');
  }

  const { oxyId, ownerAccountId, ownerAccountAction, ownerMembershipAction } =
    await resolveTargets(dryRun);
  const mapping: MappingRow[] = [];

  /**
   * The owning account id, for a path that is about to WRITE it. `null` is only
   * reachable under DRY_RUN (a real run mints the account first), so reaching
   * here without one is a bug, not an operational condition.
   */
  const requireOwnerAccountId = (): mongoose.Types.ObjectId => {
    if (!ownerAccountId) {
      throw new Error('Owner organization account was not resolved — refusing to write');
    }
    return ownerAccountId;
  };

  for (const spec of CLIENTS) {
    // ── Application: upsert keyed by (name, createdByUserId) ──
    let application = await Application.findOne({ name: spec.name, createdByUserId: oxyId });

    // ONE plan, computed on both paths. Non-destructive by construction: array
    // fields are UNIONed with what the record already has.
    const plan = computeApplicationPlan(
      application ? readApplicationState(application) : null,
      {
        type: spec.type,
        redirectUris: spec.redirectUris,
        scopes: spec.scopes,
        capabilities: spec.capabilities,
        ownerAccountId: ownerAccountId?.toString() ?? null,
      }
    );

    const applicationAction: RecordAction = plan.creates
      ? 'create'
      : plan.changes.length > 0
        ? 'update'
        : 'unchanged';

    if (!dryRun) {
      if (plan.creates) {
        application = await Application.create({
          name: spec.name,
          description: spec.description,
          websiteUrl: spec.websiteUrl,
          createdByUserId: oxyId,
          ownerAccountId: requireOwnerAccountId(),
          status: plan.desired.status,
          type: plan.desired.type,
          isOfficial: plan.desired.isOfficial,
          isInternal: plan.desired.isInternal,
          capabilities: plan.desired.capabilities,
          redirectUris: plan.desired.redirectUris,
          scopes: plan.desired.scopes,
        });
      } else if (application && plan.changes.length > 0) {
        applyApplicationPlan(application, plan, requireOwnerAccountId());
        await application.save();
      }
    }

    logger.info(
      dryRun ? 'Application registration plan (dry run — not written)' : 'Application registration applied',
      {
        dryRun,
        app: spec.name,
        action: applicationAction,
        // WHICH fields, from what, to what — not just how many.
        changes: plan.changes,
      }
    );

    // ── ApplicationCredential: reuse an existing active public prod cred ──
    // A not-yet-created application has no credential to look up, so the plan is
    // "create" without querying for a document that cannot exist.
    let credential = application
      ? await ApplicationCredential.findOne({
          applicationId: application._id,
          type: 'public',
          environment: 'production',
          status: 'active',
        })
      : null;

    const credentialAction: 'create' | 'reuse' = credential ? 'reuse' : 'create';

    if (!credential && !dryRun && application) {
      credential = await ApplicationCredential.create({
        applicationId: application._id,
        name: 'Production',
        publicKey: generatePublicKey(),
        // public client → NO secret / secretHash (mirrors routes/applications.ts)
        type: 'public',
        environment: 'production',
        // The SPEC's scopes, deliberately — a credential is minted with exactly
        // the scopes this registration asks for, never widened to whatever the
        // application happens to carry.
        scopes: spec.scopes,
        status: 'active',
        createdByUserId: oxyId,
      });
    }

    if (!dryRun && !credential) {
      throw new Error(`No production credential resolved for "${spec.name}"`);
    }

    mapping.push({
      key: spec.key,
      app: spec.name,
      type: spec.type,
      // Both fallbacks are reachable ONLY under DRY_RUN: a real run has either
      // found or just created the document by this point (and throws otherwise).
      applicationId: application?._id.toString() ?? '(dry-run-would-create)',
      clientId: credential?.publicKey ?? '(dry-run-would-mint)',
      // The EFFECTIVE post-run value (the union), not the pre-run one — a dry
      // run reports the list the record will actually end up with.
      redirectUris: plan.desired.redirectUris,
      applicationAction,
      changes: plan.changes,
      credentialAction,
    });
  }

  const countAction = (action: RecordAction): number =>
    mapping.filter((row) => row.applicationAction === action).length;

  logger.info('Registration summary', {
    dryRun,
    clients: CLIENTS.length,
    appsCreated: countAction('create'),
    appsUpdated: countAction('update'),
    appsUnchanged: countAction('unchanged'),
    fieldChanges: mapping.reduce((total, row) => total + row.changes.length, 0),
    credentialsCreated: mapping.filter((row) => row.credentialAction === 'create').length,
    credentialsReused: mapping.filter((row) => row.credentialAction === 'reuse').length,
    ownerAccountAction,
    ownerMembershipAction,
  });

  // ── Emit the two non-secret client ids in a stable, parseable format ──
  const byKey = (key: ClientKey): string =>
    mapping.find((m) => m.key === key)?.clientId ?? 'ERROR-missing';

  /* eslint-disable no-console */
  console.log(`COMMONS_CLIENT_ID=${byKey('COMMONS_CLIENT_ID')}`);
  console.log(`AUTH_IDP_CLIENT_ID=${byKey('AUTH_IDP_CLIENT_ID')}`);
  // Self-describing: the parsed artifact carries whether it was a plan or a
  // performed run, so it can never be mistaken for the other.
  console.log('OXY_SIGNIN_CLIENTS_JSON=' + JSON.stringify({ dryRun, clients: mapping }));
  /* eslint-enable no-console */
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  logger.info('Connected to MongoDB');

  try {
    await register();
  } finally {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  }
}

main().catch((error) => {
  logger.error('Client registration failed', error instanceof Error ? error : new Error(String(error)), {
    component: 'register-commons-clients',
    method: 'main',
  });
  process.exit(1);
});
