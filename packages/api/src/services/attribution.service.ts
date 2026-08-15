/**
 * Attribution Service — who is responsible for a request.
 *
 * Four resolutions the rest of the platform needs before it can bill, meter or
 * authorise anything against an application:
 *
 *  1. **application → owner account** ({@link resolveApplicationOwnerAccount})
 *  2. **credential → application → owner account** ({@link resolveCredentialAttribution})
 *  3. **caller → effective account role** ({@link resolveCallerAccountAccess},
 *     and its application-scoped composition {@link resolveCallerApplicationAccess})
 *  4. **owner account → billing profile** ({@link resolveAccountBillingProfile})
 *
 * Resolution 2 is the chain ADR 0007 fixes as the ONE direction attribution may
 * travel (`docs/adr/0007-canonical-request-attribution.md`): presented credential
 * → `application_credentials` row → `application_id` → `owner_account_id`. The
 * ADR's rule that a request which cannot complete that chain is refused rather
 * than falling back to "the signed-in user's personal account" is why nothing
 * here returns a nullable value a caller could quietly treat as "nobody to
 * charge".
 *
 * ## Why this exists rather than four call sites doing it inline
 *
 * Hops 1 and 3 are already performed, by hand, at FOUR separate places — the
 * application RBAC middleware (`routes/applications.ts`), the OTA admin gate
 * (`routes/updatesAdmin.ts`), the store publisher-reply gate
 * (`services/store.service.ts`) and the recommendation `clientId` gate
 * (`routes/profiles.ts`). Each spells out the same `select ownerAccountId` →
 * `accountService.resolveEffectiveAccess` → `appPermissionsForAccountRole`
 * chain. Four copies of an authorization chain is four places for the answers to
 * diverge, and the direction they diverge in is not symmetric: one copy that
 * forgets the `status <> 'deleted'` filter admits an app the others 404.
 *
 * Hop 2 has NO implementation today outside the service-token mint's own inline
 * lookup, and hop 4 has none at all — the billing routes never resolve an owner
 * account, they read the bearer's own subject. See
 * `docs/audits/2026-08-15-account-and-application-ownership.md`.
 *
 * ## Every resolution is a DISCRIMINATED RESULT, never a bare null
 *
 * The same reasoning `ServiceTokenVerification` (`middleware/serviceToken.ts`)
 * follows: "no answer" has several causes, and a caller that has to bill or
 * refuse needs to know which. `null` collapses "this application does not
 * exist", "this credential is revoked" and "this account has never been billed"
 * into one value, and the cheapest way to handle that value is to treat it as
 * "nothing to charge" — which is the exact failure the epic's attribution
 * checkboxes exist to prevent.
 *
 * `resolveAccountBillingProfile` is the sharpest case: there is no
 * account-scoped billing PROVISIONING path in this codebase yet, so
 * `not-provisioned` is the common answer for every non-personal account. It is
 * a value the caller must handle, not an `undefined` that reads as zero.
 *
 * ## This module is READ-ONLY
 *
 * Nothing here inserts, updates or upserts. In particular it does NOT call
 * `getOrCreateUserCredits` — provisioning a balance is a decision with billing
 * consequences and belongs to whoever is charging, not to a resolver that a gate
 * may call on every request.
 *
 * ## One membership reader
 *
 * Role resolution goes through {@link AccountService.resolveEffectiveAccess},
 * the same call `verifyActingAs`, `operatesAccount` and the account RBAC
 * middleware use — so this cannot come to a different answer about a person than
 * the switch endpoint does. Inheritance, per-member grants/revokes and the
 * archived-account refusal all come for free, and there is deliberately no
 * second membership model and no per-application membership.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import type { ApplicationCredentialStatus } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import type { ApplicationStatus } from '../db/schema/applications';
import { userCredits } from '../db/schema/userCredits';
import { users } from '../db/schema/users';
import type { AccountKind } from '../db/schema/users';
import { accountService } from './account.service';
import {
  appPermissionsForAccountRole,
  type AccountPermission,
  type AccountRole,
  type ApplicationPermission,
} from '../utils/accountRoles';
import { isCredentialUsable } from '../utils/credentialUsability';

/** A stored `application_credentials` row, as this module reads its enums from. */
type ApplicationCredentialRow = typeof applicationCredentials.$inferSelect;

// ===========================================================================
// 1. application → owner account
// ===========================================================================

/**
 * An application and the account that owns it — the principal that is
 * administratively and financially responsible for everything the application
 * does.
 *
 * `applicationStatus` is CARRIED rather than filtered on, because the four
 * existing gates disagree about it: two refuse a `deleted` application and two
 * do not, and both readings are defensible for their own question (an RBAC gate
 * must 404 a deleted app; a historical usage report must still be able to name
 * its owner). Returning the status makes each caller state which it wants
 * instead of inheriting whichever the resolver happened to pick.
 */
export interface ApplicationOwnerAccount {
  applicationId: string;
  applicationName: string;
  applicationStatus: ApplicationStatus;
  /** The owning account — a `users` row of any {@link AccountKind}. */
  ownerAccountId: string;
  ownerAccountKind: AccountKind;
}

/**
 * Outcome of {@link resolveApplicationOwnerAccount}.
 *
 * There is no `no-owner` arm: `applications.owner_account_id` is NOT NULL with a
 * real foreign key, so an application without a live owning account cannot be
 * stored. An arm for it would be a branch no input can reach.
 */
export type ApplicationOwnerResolution =
  | { status: 'resolved'; application: ApplicationOwnerAccount }
  | { status: 'unknown-application'; applicationId: string };

/** Resolve an application's owning account. */
export async function resolveApplicationOwnerAccount(
  applicationId: string
): Promise<ApplicationOwnerResolution> {
  if (!applicationId) {
    return { status: 'unknown-application', applicationId };
  }

  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      applicationName: applications.name,
      applicationStatus: applications.status,
      ownerAccountId: applications.ownerAccountId,
      ownerAccountKind: users.kind,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .where(eq(applications.id, applicationId))
    .limit(1);

  if (!row) {
    return { status: 'unknown-application', applicationId };
  }
  return { status: 'resolved', application: row };
}

// ===========================================================================
// 2. credential → application → owner account
// ===========================================================================

/**
 * A credential, the application it belongs to, and that application's owning
 * account — the full chain from the bearer material a machine caller presents to
 * the principal its usage is charged to.
 *
 * `credentialScopes` and `applicationScopes` are both carried because a
 * credential's effective authority is their INTERSECTION (`intersectScopes`, the
 * rule the service-token mint applies at `routes/auth.ts`), and a consumer that
 * received only one of them would have to re-read the other to know what the
 * credential may actually do.
 */
export interface CredentialAttribution {
  credentialId: string;
  /** The public identifier (`oxy_dk_…`) — the OAuth `client_id`. NEVER a secret. */
  credentialPublicKey: string;
  credentialType: ApplicationCredentialRow['type'];
  credentialEnvironment: ApplicationCredentialRow['environment'];
  credentialScopes: string[];
  applicationScopes: string[];
  application: ApplicationOwnerAccount;
}

/**
 * Outcome of {@link resolveCredentialAttribution}.
 *
 * `unusable-credential` is a separate arm from `unknown-credential` on purpose.
 * A revoked or grace-expired credential must not authenticate — but it is also
 * the one case where a caller may legitimately want to know WHICH application it
 * belonged to (revocation auditing, "your key was rotated" messaging), and a
 * single `null` would make that impossible without a second query that reproduces
 * this one minus the predicate.
 *
 * There is no `unknown-application` arm: `application_credentials.application_id`
 * is NOT NULL with an `ON DELETE CASCADE` foreign key, so a credential whose
 * application is gone is a credential that is gone.
 */
export type CredentialAttributionResolution =
  | { status: 'resolved'; attribution: CredentialAttribution }
  | { status: 'unknown-credential'; clientId: string }
  | {
      status: 'unusable-credential';
      clientId: string;
      credentialId: string;
      credentialStatus: ApplicationCredentialStatus;
      /** Still resolvable — the credential row names its application. */
      applicationId: string;
    };

/**
 * Resolve a credential's public identifier (`clientId`) to the account that is
 * responsible for it.
 *
 * Usability is decided by {@link isCredentialUsable} — the SAME predicate all
 * three auth resolution sites use (OAuth authorize, OAuth token, service-token
 * mint), so an attribution decision can never accept a credential those three
 * would refuse, nor refuse one they accept.
 *
 * `secretHash` is never selected, so it cannot reach a caller of this function
 * even by accident.
 */
export async function resolveCredentialAttribution(
  clientId: string
): Promise<CredentialAttributionResolution> {
  if (!clientId) {
    return { status: 'unknown-credential', clientId };
  }

  const [row] = await getDb()
    .select({
      credentialId: applicationCredentials.id,
      credentialPublicKey: applicationCredentials.publicKey,
      credentialType: applicationCredentials.type,
      credentialEnvironment: applicationCredentials.environment,
      credentialScopes: applicationCredentials.scopes,
      credentialStatus: applicationCredentials.status,
      credentialExpiresAt: applicationCredentials.expiresAt,
      applicationScopes: applications.scopes,
      applicationId: applications.id,
      applicationName: applications.name,
      applicationStatus: applications.status,
      ownerAccountId: applications.ownerAccountId,
      ownerAccountKind: users.kind,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .innerJoin(users, eq(users.id, applications.ownerAccountId))
    .where(eq(applicationCredentials.publicKey, clientId))
    .limit(1);

  if (!row) {
    return { status: 'unknown-credential', clientId };
  }

  if (!isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })) {
    return {
      status: 'unusable-credential',
      clientId,
      credentialId: row.credentialId,
      credentialStatus: row.credentialStatus,
      applicationId: row.applicationId,
    };
  }

  return {
    status: 'resolved',
    attribution: {
      credentialId: row.credentialId,
      credentialPublicKey: row.credentialPublicKey,
      credentialType: row.credentialType,
      credentialEnvironment: row.credentialEnvironment,
      credentialScopes: row.credentialScopes,
      applicationScopes: row.applicationScopes,
      application: {
        applicationId: row.applicationId,
        applicationName: row.applicationName,
        applicationStatus: row.applicationStatus,
        ownerAccountId: row.ownerAccountId,
        ownerAccountKind: row.ownerAccountKind,
      },
    },
  };
}

// ===========================================================================
// 3. caller → effective account role
// ===========================================================================

/**
 * What a caller may do over one account, in BOTH vocabularies.
 *
 * `accountPermissions` is what `accountService.resolveEffectiveAccess` already
 * returns — the role's baseline adjusted by the membership row's own grants and
 * revokes. `applicationPermissions` is the part every existing gate recomputes
 * for itself: the application-level rights that account role confers over apps
 * the account owns (`appPermissionsForAccountRole`). Carrying both is the whole
 * reason this type exists; a caller holding only one of them has to reach for the
 * role and re-derive the other, which is the duplication this replaces.
 */
export interface CallerAccountAccess {
  accountId: string;
  role: AccountRole;
  accountPermissions: AccountPermission[];
  applicationPermissions: ApplicationPermission[];
  /** `self` = the caller's own account; otherwise a direct or inherited membership row. */
  source: 'self' | 'direct' | 'inherited';
}

/** Outcome of {@link resolveCallerAccountAccess}. */
export type CallerAccountAccessResolution =
  | { status: 'resolved'; access: CallerAccountAccess }
  | { status: 'no-access'; accountId: string };

/**
 * Resolve a caller's effective role over one account, with the application
 * permissions it confers.
 *
 * Delegates the membership question WHOLE to
 * `accountService.resolveEffectiveAccess`, which is the single membership reader
 * in this package: nearest-row-wins over `[accountId, ...ancestors]`, ancestor
 * rows cascading only when `inherit` is true, per-member revokes beating grants,
 * an archived account resolving to nothing, and a caller over their own account
 * being an implicit owner. None of that is re-implemented here, so a change to
 * the inheritance rules cannot leave attribution behind.
 */
export async function resolveCallerAccountAccess(
  userId: string,
  accountId: string
): Promise<CallerAccountAccessResolution> {
  if (!userId || !accountId) {
    return { status: 'no-access', accountId };
  }

  const access = await accountService.resolveEffectiveAccess(userId, accountId);
  if (!access) {
    return { status: 'no-access', accountId };
  }

  return {
    status: 'resolved',
    access: {
      accountId,
      role: access.role,
      accountPermissions: access.permissions,
      applicationPermissions: appPermissionsForAccountRole(access.role),
      source: access.source,
    },
  };
}

/** A caller's effective access to one application, via its owning account. */
export interface CallerApplicationAccess {
  application: ApplicationOwnerAccount;
  access: CallerAccountAccess;
}

/**
 * Outcome of {@link resolveCallerApplicationAccess}. The three arms map exactly
 * onto the three answers an application gate has to give — 404, 403, and go
 * ahead — so a gate written against this cannot accidentally turn a missing
 * application into a permission error or the reverse.
 */
export type CallerApplicationAccessResolution =
  | { status: 'resolved'; access: CallerApplicationAccess }
  | { status: 'unknown-application'; applicationId: string }
  | { status: 'no-access'; applicationId: string; ownerAccountId: string };

/**
 * Resolve a caller's effective access to an application through its owning
 * account — hop 1 and hop 3 composed, which is the chain every application gate
 * in this package performs.
 *
 * `includeDeleted` decides whether a soft-deleted application is visible, and it
 * defaults to `false` because every AUTHORIZATION caller wants the stricter
 * reading: `routes/applications.ts` and `routes/updatesAdmin.ts` both filter
 * `status <> 'deleted'` today. A reporting caller that must still attribute a
 * deleted application's history passes `true` and says so at the call site.
 */
export async function resolveCallerApplicationAccess(
  userId: string,
  applicationId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<CallerApplicationAccessResolution> {
  const resolved = await resolveApplicationOwnerAccount(applicationId);
  if (resolved.status === 'unknown-application') {
    return resolved;
  }

  const { application } = resolved;
  if (!options.includeDeleted && application.applicationStatus === 'deleted') {
    return { status: 'unknown-application', applicationId };
  }

  const accountAccess = await resolveCallerAccountAccess(userId, application.ownerAccountId);
  if (accountAccess.status === 'no-access') {
    return {
      status: 'no-access',
      applicationId,
      ownerAccountId: application.ownerAccountId,
    };
  }

  return {
    status: 'resolved',
    access: { application, access: accountAccess.access },
  };
}

// ===========================================================================
// 4. owner account → billing profile
// ===========================================================================

/**
 * An account's billing profile: its spendable balances and its link to the
 * payment processor.
 *
 * This is `user_credits` read as what its own header says it is — "one
 * API-credit balance per account", keyed on `users.id`, which IS an account id
 * of any kind. Nothing about the TABLE is personal-only.
 *
 * What is personal-only is the way rows come into existence. Every writer
 * (`routes/credits.ts`, `routes/billing.ts`) keys on the bearer's own subject,
 * so a row exists for an account only if somebody held a session AS that account
 * and touched a billing route. For an organization or project that requires
 * `account:act_as` plus a deliberate switch, and for a `channel` account it is
 * impossible — channels cannot be switched into at all. See
 * {@link BillingProfileResolution}.
 */
export interface AccountBillingProfile {
  accountId: string;
  /** Free credits currently held. Refreshed to `freeCreditLimit` at most daily. */
  freeCredits: number;
  freeCreditLimit: number;
  /** Purchased credits. Spent before free credits. */
  paidCredits: number;
  /** The displayed daily allowance. */
  dailyRefresh: number;
  lastRefreshAt: Date;
  /** `null` when the account has never transacted with Stripe. */
  stripeCustomerId: string | null;
}

/**
 * Outcome of {@link resolveAccountBillingProfile}.
 *
 * **`not-provisioned` is the epic's open gap, made into a value.** It means the
 * account exists and is a perfectly valid owner of applications, but no billing
 * profile row has ever been created for it — so it has no balance, no spending
 * limit and no Stripe customer, and there is no code path in this package that
 * would create one for it other than a human switching INTO the account and
 * loading a billing page.
 *
 * It is deliberately NOT collapsed into `resolved` with zeroed balances. A zero
 * balance is a real, chargeable state that means "this account has spent
 * everything"; an absent profile means "nobody has decided who pays for this
 * account yet". Billing them the same way is exactly the mistake the epic's
 * "financially responsible principal" checkbox is about.
 */
export type BillingProfileResolution =
  | { status: 'resolved'; profile: AccountBillingProfile }
  | { status: 'not-provisioned'; accountId: string }
  | { status: 'unknown-account'; accountId: string };

/**
 * Resolve an account's billing profile. READ-ONLY — it never provisions one.
 *
 * The two absent arms are distinguished by a second query rather than inferred
 * from the first, because they are not the same fact and the safe handling of
 * them differs: an unknown account is a bug or a stale id in the caller, while an
 * unprovisioned one is the ordinary state of every organization account on the
 * platform today.
 */
export async function resolveAccountBillingProfile(
  accountId: string
): Promise<BillingProfileResolution> {
  if (!accountId) {
    return { status: 'unknown-account', accountId };
  }

  const db = getDb();
  const [row] = await db
    .select({
      accountId: userCredits.userId,
      freeCredits: userCredits.creditsFree,
      freeCreditLimit: userCredits.creditsFreeLimit,
      paidCredits: userCredits.creditsPaid,
      dailyRefresh: userCredits.creditsDailyRefresh,
      lastRefreshAt: userCredits.creditsLastRefresh,
      stripeCustomerId: userCredits.stripeCustomerId,
    })
    .from(userCredits)
    .where(eq(userCredits.userId, accountId))
    .limit(1);

  if (row) {
    return { status: 'resolved', profile: row };
  }

  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);

  return account
    ? { status: 'not-provisioned', accountId }
    : { status: 'unknown-account', accountId };
}

/**
 * The billing profile of the account an APPLICATION is charged to — hops 1 and 4
 * composed.
 *
 * This is the whole "which balance does this application spend from" question in
 * one call, and today the answer for almost every organization-owned application
 * is `not-provisioned`. That is the finding, not a bug in this function.
 *
 * A soft-deleted application still resolves: its owner account is still the
 * principal responsible for what it already spent.
 */
export async function resolveApplicationBillingProfile(
  applicationId: string
): Promise<
  | { status: 'resolved'; application: ApplicationOwnerAccount; profile: AccountBillingProfile }
  | { status: 'unknown-application'; applicationId: string }
  | { status: 'not-provisioned'; application: ApplicationOwnerAccount }
> {
  const resolved = await resolveApplicationOwnerAccount(applicationId);
  if (resolved.status === 'unknown-application') {
    return resolved;
  }

  const { application } = resolved;
  const billing = await resolveAccountBillingProfile(application.ownerAccountId);
  if (billing.status === 'resolved') {
    return { status: 'resolved', application, profile: billing.profile };
  }

  // `unknown-account` is unreachable from here: the owner account was just read
  // through an INNER JOIN in the same request, and `owner_account_id` is a NOT
  // NULL foreign key. Both remaining arms therefore mean the same thing to this
  // caller — the responsible account has no billing profile.
  return { status: 'not-provisioned', application };
}

/**
 * Whether a caller may reach an account's balance AT ALL.
 *
 * Answers the negative half of the epic's "a user cannot view or spend another
 * account's balance through an app they cannot access" requirement, and it
 * answers it as a BOOLEAN rather than by handing back the balance and expecting
 * the caller to filter — a resolver that returns the row cannot fail closed, and
 * a future one-line mistake at any call site becomes a leak. Nothing about the
 * balance crosses this function's return type.
 *
 * The right asked for is `billing:read` over the owning account, resolved through
 * the account graph with inheritance. Note that `billing:read` is baseline for
 * `owner`, `admin`, `editor` and `billing` roles and absent from `developer` and
 * `viewer` (`utils/accountRoles.ts`), and that a per-member revoke genuinely
 * takes it away.
 */
export async function callerMayReadApplicationBalance(
  userId: string,
  applicationId: string
): Promise<boolean> {
  const resolved = await resolveCallerApplicationAccess(userId, applicationId, {
    includeDeleted: true,
  });
  if (resolved.status !== 'resolved') {
    return false;
  }
  return resolved.access.access.accountPermissions.includes('billing:read');
}
