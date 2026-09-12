import type { applications, users } from '../db/schema';

const DATABASE_ERROR_CODES = new Set([
  '28P01',
  '3D000',
  'ECONNREFUSED',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

type NativeProductAgentBootstrapGenericFailureCode =
  | 'database_unavailable'
  | 'manifest_binding_mismatch'
  | 'bootstrap_lock_failed'
  | 'plan_rejected'
  | 'service_credential_invalid'
  | 'identity_collision'
  | 'required_record_missing'
  | 'live_state_drift'
  | 'bootstrap_failed';

export type NativeProductAgentAccountProjection = Pick<
  typeof users.$inferSelect,
  | 'id'
  | 'kind'
  | 'type'
  | 'parentAccountId'
  | 'rootAccountId'
  | 'accountStatus'
  | 'privacyIsPrivateAccount'
>;

export type NativeProductAgentBoundApplication = Pick<
  typeof applications.$inferSelect,
  | 'id'
  | 'ownerAccountId'
  | 'type'
  | 'status'
  | 'isOfficial'
  | 'isInternal'
  | 'createdByUserId'
>;

export const NATIVE_PRODUCT_AGENT_DRIFT_TARGETS = [
  'oxy_organization',
  'homiio_project_account',
  'homiio_project_ancestry',
  'homiio_bot_account',
  'homiio_bot_ancestry',
  'clarity_project_account',
  'clarity_project_ancestry',
  'clarity_bot_account',
  'clarity_bot_ancestry',
  'homiio_cost_center',
  'clarity_cost_center',
  'homiio_application',
  'sindi_service_credential',
  'clarity_application',
  'clarity_public_credential',
  'clarity_backend_application',
  'clarity_backend_credential',
] as const;

export type NativeProductAgentDriftTarget =
  (typeof NATIVE_PRODUCT_AGENT_DRIFT_TARGETS)[number];

export const NATIVE_PRODUCT_AGENT_DRIFT_FIELDS = [
  'id',
  'username',
  'nameDisplay',
  'kind',
  'type',
  'parentAccountId',
  'rootAccountId',
  'accountStatus',
  'privacyIsPrivateAccount',
  'path',
  'accountId',
  'slug',
  'label',
  'status',
  'isOfficial',
  'isInternal',
  'applicationId',
  'name',
  'publicKey',
  'secretHash',
  'secretHashPresent',
  'environment',
  'scopes',
  'websiteUrl',
  'capabilities',
  'redirectUris',
  'ownerAccountId',
  'createdByUserId',
] as const;

export type NativeProductAgentDriftField =
  (typeof NATIVE_PRODUCT_AGENT_DRIFT_FIELDS)[number];

export class NativeProductAgentStateDriftError extends Error {
  constructor(
    readonly target: NativeProductAgentDriftTarget,
    readonly field: NativeProductAgentDriftField,
  ) {
    super('native product-agent state drift');
    this.name = 'NativeProductAgentStateDriftError';
  }
}

export class NativeProductAgentUsernameCollisionError extends Error {
  readonly expectedAccountId: string;
  readonly holder: NativeProductAgentAccountProjection;
  readonly boundApplication: NativeProductAgentBoundApplication | null;

  constructor(
    expectedAccountId: string,
    holder: NativeProductAgentAccountProjection,
    boundApplication: NativeProductAgentBoundApplication | null = null,
  ) {
    super('native product-agent username collision');
    this.name = 'NativeProductAgentUsernameCollisionError';
    this.expectedAccountId = expectedAccountId;
    this.holder = {
      id: holder.id,
      kind: holder.kind,
      type: holder.type,
      parentAccountId: holder.parentAccountId,
      rootAccountId: holder.rootAccountId,
      accountStatus: holder.accountStatus,
      privacyIsPrivateAccount: holder.privacyIsPrivateAccount,
    };
    this.boundApplication =
      boundApplication === null
        ? null
        : {
            id: boundApplication.id,
            ownerAccountId: boundApplication.ownerAccountId,
            type: boundApplication.type,
            status: boundApplication.status,
            isOfficial: boundApplication.isOfficial,
            isInternal: boundApplication.isInternal,
            createdByUserId: boundApplication.createdByUserId,
          };
  }
}

export class NativeProductAgentAccountAdoptionReviewError extends Error {
  readonly expectedAccountId: string;
  readonly account: NativeProductAgentAccountProjection;
  readonly canonicalPresentationMatches: boolean;
  readonly ancestryMatches: boolean;
  readonly boundApplication: NativeProductAgentBoundApplication | null;

  constructor(
    expectedAccountId: string,
    account: NativeProductAgentAccountProjection,
    canonicalPresentationMatches: boolean,
    ancestryMatches: boolean,
    boundApplication: NativeProductAgentBoundApplication | null,
  ) {
    super('native product-agent account adoption requires review');
    this.name = 'NativeProductAgentAccountAdoptionReviewError';
    this.expectedAccountId = expectedAccountId;
    this.account = {
      id: account.id,
      kind: account.kind,
      type: account.type,
      parentAccountId: account.parentAccountId,
      rootAccountId: account.rootAccountId,
      accountStatus: account.accountStatus,
      privacyIsPrivateAccount: account.privacyIsPrivateAccount,
    };
    this.canonicalPresentationMatches = canonicalPresentationMatches;
    this.ancestryMatches = ancestryMatches;
    this.boundApplication =
      boundApplication === null
        ? null
        : {
            id: boundApplication.id,
            ownerAccountId: boundApplication.ownerAccountId,
            type: boundApplication.type,
            status: boundApplication.status,
            isOfficial: boundApplication.isOfficial,
            isInternal: boundApplication.isInternal,
            createdByUserId: boundApplication.createdByUserId,
          };
  }
}

export type NativeProductAgentBootstrapFailureResult =
  | Readonly<{
      status: 'failed';
      code: 'username_collision';
      expectedAccountId: string;
      holder: NativeProductAgentAccountProjection;
      boundApplication: NativeProductAgentBoundApplication | null;
    }>
  | Readonly<{
      status: 'failed';
      code: 'account_adoption_review';
      expectedAccountId: string;
      account: NativeProductAgentAccountProjection;
      canonicalPresentationMatches: boolean;
      ancestryMatches: boolean;
      boundApplication: NativeProductAgentBoundApplication | null;
    }>
  | Readonly<{
      status: 'failed';
      code: 'live_state_drift';
      target: NativeProductAgentDriftTarget;
      field: NativeProductAgentDriftField;
    }>
  | Readonly<{
      status: 'failed';
      code: NativeProductAgentBootstrapGenericFailureCode;
    }>;

function nativeProductAgentBootstrapGenericFailureCode(
  error: unknown,
): NativeProductAgentBootstrapGenericFailureCode {
  const record =
    error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = error instanceof Error ? error.message : '';

  if (
    DATABASE_ERROR_CODES.has(code) ||
    /DATABASE_URL|PostgreSQL|connect ECONN|connection (?:refused|terminated)|timeout expired/i.test(
      message,
    )
  ) {
    return 'database_unavailable';
  }
  if (/EXPECTED_.*does not match this image|workflow identity/i.test(message)) {
    return 'manifest_binding_mismatch';
  }
  if (/advisory lock/i.test(message)) return 'bootstrap_lock_failed';
  if (/EXPECTED_PLAN_SHA256|BOOTSTRAP_ACTOR|BOOTSTRAP_REASON/i.test(message)) {
    return 'plan_rejected';
  }
  if (/service secret|secret hash|service-secret/i.test(message)) {
    return 'service_credential_invalid';
  }
  if (/collision/i.test(message)) return 'identity_collision';
  if (/organization .*does not exist|application .*not found/i.test(message)) {
    return 'required_record_missing';
  }
  if (/drifted|unexpected owner/i.test(message)) return 'live_state_drift';
  return 'bootstrap_failed';
}

/**
 * Project only the one reviewed collision diagnostic. Every other exception
 * becomes an opaque stable code so database details and free-form messages
 * never cross the task-result boundary.
 */
export function nativeProductAgentBootstrapFailureResult(
  error: unknown,
): NativeProductAgentBootstrapFailureResult {
  if (error instanceof NativeProductAgentAccountAdoptionReviewError) {
    return {
      status: 'failed',
      code: 'account_adoption_review',
      expectedAccountId: error.expectedAccountId,
      account: error.account,
      canonicalPresentationMatches: error.canonicalPresentationMatches,
      ancestryMatches: error.ancestryMatches,
      boundApplication: error.boundApplication,
    };
  }
  if (error instanceof NativeProductAgentUsernameCollisionError) {
    return {
      status: 'failed',
      code: 'username_collision',
      expectedAccountId: error.expectedAccountId,
      holder: error.holder,
      boundApplication: error.boundApplication,
    };
  }
  if (error instanceof NativeProductAgentStateDriftError) {
    return {
      status: 'failed',
      code: 'live_state_drift',
      target: error.target,
      field: error.field,
    };
  }
  return {
    status: 'failed',
    code: nativeProductAgentBootstrapGenericFailureCode(error),
  };
}
